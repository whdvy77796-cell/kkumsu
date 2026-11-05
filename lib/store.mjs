import {AppError,fail,seal,unseal,hmac} from './core.mjs';

export const RESERVE=`-- insosoe:reserve
local prior=redis.call('GET',KEYS[1])
if prior then
 local old=cjson.decode(prior)
 if old.hash~=ARGV[1] then return {'conflict'} end
 if old.status=='done' then local cached=redis.call('GET',KEYS[7]);if cached then return {'cached',cached} else return {'expired'} end end
 if old.status=='failed' then return {'failed'} end
 if redis.call('EXISTS',KEYS[5])==1 then return {'busy'} end
end
if redis.call('EXISTS',KEYS[6])==1 then return {'used'} end
if redis.call('EXISTS',KEYS[5])==1 then return {'busy'} end
local cost=tonumber(ARGV[2]);local current=tonumber(redis.call('GET',KEYS[2]) or '0')
if current+cost>tonumber(ARGV[3]) then return {'budget'} end
if tonumber(redis.call('GET',KEYS[8]) or '0')+cost>tonumber(ARGV[7]) then return {'totalbudget'} end
if tonumber(redis.call('GET',KEYS[3]) or '0')>=tonumber(ARGV[4]) then return {'quota'} end
if tonumber(redis.call('GET',KEYS[4]) or '0')>=tonumber(ARGV[5]) then return {'quota'} end
redis.call('INCRBY',KEYS[2],cost);redis.call('EXPIRE',KEYS[2],172800)
redis.call('INCRBY',KEYS[8],cost)
redis.call('INCR',KEYS[3]);redis.call('EXPIRE',KEYS[3],172800)
redis.call('INCR',KEYS[4]);redis.call('EXPIRE',KEYS[4],172800)
redis.call('SET',KEYS[5],ARGV[6],'EX',270)
redis.call('SET',KEYS[1],cjson.encode({hash=ARGV[1],status='pending'}),'EX',300)
return {'ok'}`;
export const FINISH=`-- insosoe:finish
if redis.call('GET',KEYS[2])~=ARGV[1] then return {'lost'} end
local prior=redis.call('GET',KEYS[1])
if not prior then return {'lost'} end
local state=cjson.decode(prior)
if state.hash~=ARGV[2] or state.status~='pending' then return {'lost'} end
local refund=tonumber(ARGV[6])-tonumber(ARGV[7])
if refund>0 then
 if tonumber(redis.call('GET',KEYS[6]) or '0')<refund or tonumber(redis.call('GET',KEYS[7]) or '0')<refund then return {'lost'} end
 redis.call('DECRBY',KEYS[6],refund)
 redis.call('DECRBY',KEYS[7],refund)
elseif refund<0 then
 redis.call('INCRBY',KEYS[6],-refund)
 redis.call('INCRBY',KEYS[7],-refund)
end
if ARGV[3]=='done' then
 redis.call('SET',KEYS[3],ARGV[4],'EX',900)
 redis.call('SADD',KEYS[5],KEYS[3]);redis.call('EXPIRE',KEYS[5],900)
 if ARGV[5]=='generate' then redis.call('SET',KEYS[4],'1') end
end
redis.call('SET',KEYS[1],cjson.encode({hash=ARGV[2],status=ARGV[3]}),'EX',172800)
redis.call('DEL',KEYS[2]);return {'ok'}`;
export const DELETE_CACHE=`-- insosoe:delete
local items=redis.call('SMEMBERS',KEYS[1]);for _,key in ipairs(items) do redis.call('DEL',key) end
redis.call('DEL',KEYS[1]);return {'ok'}`;
export class Store {
 constructor(c,fetcher=fetch){this.c=c;this.fetcher=fetcher;}
 async command(command){try{const url=new URL(this.c.redisURL);if(url.protocol!=='https:')throw Error();const r=await this.fetcher(url,{method:'POST',headers:{Authorization:'Bearer '+this.c.redisToken,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(6000)});if(!r.ok)throw Error();const j=await r.json();if(j.error)throw Error();return j.result;}catch{fail('REDIS_UNAVAILABLE','이용량 확인에 실패했습니다. 요청을 안전하게 중단했습니다.',503,true);}}
 keys(sid,ip,id){const day=new Date().toISOString().slice(0,10),b='insosoe:v2:';return [b+'request:'+sid+':'+id,b+'budget:'+day,b+'ip:'+day+':'+ip,b+'session:'+day+':'+sid,b+'lock:'+sid,b+'used:'+sid,b+'cache:'+sid+':'+id,b+'budget:total'];}
 async free(sid){return !(await this.command(['EXISTS','insosoe:v2:used:'+sid]));}
 async reserve(sid,ip,data,cost){const keys=this.keys(sid,ip,data.requestId),hash=hmac(this.c.secret,JSON.stringify(data)),token=data.requestId;const result=await this.command(['EVAL',RESERVE,8,...keys,hash,String(cost),String(this.c.dailyBudget),String(this.c.ipLimit),String(this.c.sessionLimit),token,String(this.c.totalBudget)]);const status=result?.[0];if(status==='cached')return {cached:unseal(this.c,sid,result[1])};const errors={totalbudget:['TOTAL_BUDGET','서비스의 누적 AI 비용 한도에 도달했습니다. 운영자 확인이 필요합니다.',429,false],conflict:['IDEMPOTENCY_CONFLICT','같은 요청 ID에 다른 내용을 보낼 수 없습니다.',409,false],expired:['RESULT_EXPIRED','결과가 만료되었습니다. 이 요청은 다시 실행하지 않습니다.',409,false],failed:['REQUEST_FAILED','이미 실패한 요청입니다. 새 요청 ID로 다시 시도해주세요.',409,true],busy:['REQUEST_IN_PROGRESS','처리 중입니다. 잠시 후 같은 요청으로 다시 시도해주세요.',409,true],used:['FREE_ALREADY_USED','이 브라우저의 무료 작성이 이미 완료되었습니다.',403,false],budget:['DAILY_BUDGET','오늘의 서비스 AI 비용 한도에 도달했습니다.',429,true],quota:['RATE_LIMIT','오늘의 이용 횟수 한도에 도달했습니다.',429,true]};if(errors[status])throw new AppError(...errors[status]);if(status!=='ok')fail('REDIS_UNAVAILABLE','이용량 예약을 확인할 수 없습니다.',503,true);return {keys,hash,token,sid,cost};}
 async finish(r,status,result,action,measuredCost){const actual=Number.isSafeInteger(measuredCost)&&measuredCost>=0?measuredCost:r.cost;const keys=[r.keys[0],r.keys[4],r.keys[6],r.keys[5],'insosoe:v2:cache-index:'+r.sid,r.keys[1],r.keys[7]];const out=await this.command(['EVAL',FINISH,7,...keys,r.token,r.hash,status,status==='done'?seal(this.c,r.sid,result):'',action,String(r.cost),String(actual)]);if(out?.[0]!=='ok')fail('REQUEST_EXPIRED','처리 시간이 초과되었습니다.',503);}
 async clear(sid){await this.command(['EVAL',DELETE_CACHE,1,'insosoe:v2:cache-index:'+sid]);}
}
