import {Store,FINISH,RESERVE} from './store.mjs';
import {seal,fail} from './core.mjs';
import {previewRepeat} from './preview-repeat.mjs';
export const CLEAR_REVISION_CACHE=`-- revision:clear
local pending=redis.call('GET',KEYS[2])
if pending then redis.call('SET',ARGV[1]..pending,'1','EX',600) end
local items=redis.call('SMEMBERS',KEYS[1]);for _,key in ipairs(items) do redis.call('DEL',key) end
redis.call('DEL',KEYS[1]);return {'ok'}`;
export const FINISH_REVISION=FINISH.replace('-- insosoe:finish','-- revision:finish').replace("if ARGV[3]=='done' then","if ARGV[3]=='done' and redis.call('EXISTS',KEYS[8])==0 then");
export const RESERVE_REVISION_LONG=RESERVE.replace("redis.call('SET',KEYS[5],ARGV[6],'EX',270)","redis.call('SET',KEYS[5],ARGV[6],'EX',570)").replace("status='pending'}),'EX',300)","status='pending'}),'EX',600)");
if(RESERVE_REVISION_LONG===RESERVE||!RESERVE_REVISION_LONG.includes("KEYS[5],ARGV[6],'EX',570")||!RESERVE_REVISION_LONG.includes("status='pending'}),'EX',600"))throw new Error('장시간 요청 잠금 설정을 확인하세요.');
// The stored held amount is authoritative even if the extension response is lost.
export const RESERVE_REVISION_STAGED=RESERVE_REVISION_LONG.replace("cjson.encode({hash=ARGV[1],status='pending'})","cjson.encode({hash=ARGV[1],status='pending',held=cost,phase=0,accounting='staged-v1'})");
// V4 only: admission checks that either base stage could fit before charging a draft,
// while actually reserving only the draft. The first-review hold is acquired later.
export const RESERVE_REVISION_STEPWISE=RESERVE_REVISION_STAGED.replace("local cost=tonumber(ARGV[2]);local current=tonumber(redis.call('GET',KEYS[2]) or '0')","local cost=tonumber(ARGV[2]);local current=tonumber(redis.call('GET',KEYS[2]) or '0')\nlocal floor=tonumber(ARGV[8]);if not floor or floor<0 then return {'badfloor'} end\nif tonumber(ARGV[3])~=-1 and current+floor>tonumber(ARGV[3]) then return {'budget'} end\nif tonumber(ARGV[7])~=-1 and tonumber(redis.call('GET',KEYS[8]) or '0')+floor>tonumber(ARGV[7]) then return {'totalbudget'} end");
export const FINISH_REVISION_STAGED=FINISH_REVISION.replace("local refund=tonumber(ARGV[6])-tonumber(ARGV[7])","if state.accounting~='staged-v1' or type(state.held)~='number' or state.held<0 then return {'lost'} end\nlocal refund=tonumber(state.held)-tonumber(ARGV[7])");
if(RESERVE_REVISION_STAGED===RESERVE_REVISION_LONG||RESERVE_REVISION_STEPWISE===RESERVE_REVISION_STAGED||FINISH_REVISION_STAGED===FINISH_REVISION)throw new Error('단계별 예산 설정을 확인하세요.');
export const EXTEND_REVISION_STAGED=`-- revision:extend-staged
if redis.call('GET',KEYS[2])~=ARGV[1] then return {'lost'} end
local raw=redis.call('GET',KEYS[1]);if not raw then return {'lost'} end
local s=cjson.decode(raw);if s.hash~=ARGV[2] or s.status~='pending' or s.accounting~='staged-v1' then return {'lost'} end
if redis.call('EXISTS',KEYS[5])==1 then return {'cancelled'} end
local known=tonumber(ARGV[3]);local extra=tonumber(ARGV[4]);local held=tonumber(s.held);local phase=tonumber(ARGV[7])
if not known or not extra or not held or known<0 or extra<0 or held<0 or (phase~=1 and phase~=2) then return {'invalid'} end
if s.phase==phase then if tonumber(s.known)==known and tonumber(s.extra)==extra then return {'ok',tostring(held)} else return {'lost'} end end
if s.phase~=phase-1 then return {'lost'} end
if phase==2 and (not tonumber(s.known) or known<tonumber(s.known)) then return {'invalid'} end
local want=math.max(held,known+extra);local delta=want-held
local daily=tonumber(redis.call('GET',KEYS[3]) or '0');local total=tonumber(redis.call('GET',KEYS[4]) or '0')
if delta>0 and tonumber(ARGV[5])~=-1 and daily+delta>tonumber(ARGV[5]) then return {'budget'} end
if delta>0 and tonumber(ARGV[6])~=-1 and total+delta>tonumber(ARGV[6]) then return {'totalbudget'} end
local ttl=redis.call('TTL',KEYS[1]);if ttl<1 then return {'lost'} end
if delta~=0 then redis.call('INCRBY',KEYS[3],delta);redis.call('INCRBY',KEYS[4],delta) end
s.phase=phase;s.held=want;s.known=known;s.extra=extra
redis.call('SET',KEYS[1],cjson.encode(s),'EX',ttl)
return {'ok',tostring(want)}`;
// V4 reserves the first draft only; atomically top up for its first independent review.
// A repeated identical extension is idempotent and the stored hold remains authoritative.
export const EXTEND_BASE_REVIEW=`-- revision:extend-base-review
if redis.call('GET',KEYS[2])~=ARGV[1] then return {'lost'} end
local raw=redis.call('GET',KEYS[1]);if not raw then return {'lost'} end
local s=cjson.decode(raw);if s.hash~=ARGV[2] or s.status~='pending' or s.accounting~='staged-v1' then return {'lost'} end
if redis.call('EXISTS',KEYS[5])==1 then return {'cancelled'} end
local known=tonumber(ARGV[3]);local extra=tonumber(ARGV[4]);local held=tonumber(s.held)
if not known or not extra or not held or known<0 or extra<0 or held<0 or s.phase~=0 then return {'invalid'} end
if s.baseReview then if tonumber(s.baseKnown)==known and tonumber(s.baseExtra)==extra then return {'ok',tostring(held)} else return {'lost'} end end
local want=math.max(held,known+extra);local delta=want-held
local daily=tonumber(redis.call('GET',KEYS[3]) or '0');local total=tonumber(redis.call('GET',KEYS[4]) or '0')
if delta>0 and tonumber(ARGV[5])~=-1 and daily+delta>tonumber(ARGV[5]) then return {'budget'} end
if delta>0 and tonumber(ARGV[6])~=-1 and total+delta>tonumber(ARGV[6]) then return {'totalbudget'} end
local ttl=redis.call('TTL',KEYS[1]);if ttl<1 then return {'lost'} end
if delta~=0 then redis.call('INCRBY',KEYS[3],delta);redis.call('INCRBY',KEYS[4],delta) end
s.baseReview=true;s.baseKnown=known;s.baseExtra=extra;s.held=want
redis.call('SET',KEYS[1],cjson.encode(s),'EX',ttl)
return {'ok',tostring(want)}`;
// New product entitlement only. Lifetime/day spend, IP/session quotas and lock are shared with V3.
export class RevisionStore extends Store {
 get supportsStagedRevision(){return true;}
 repeatAllowed(_sid){return previewRepeat(this.c);}
 reservationScript(data){return ['simple-v4','simple-v5'].includes(data?.clientVersion)?RESERVE_REVISION_STEPWISE:data?.clientVersion==='simple-v3'?RESERVE_REVISION_STAGED:RESERVE;}
 async reserve(sid,ip,data,cost,floor){const r=await super.reserve(sid,ip,data,cost,floor);if(!r.cached&&['simple-v3','simple-v4','simple-v5'].includes(data.clientVersion))r.staged=true;return r;}
 async reserveBaseReview(r,known,extra){if(!r?.staged||!Number.isSafeInteger(known)||known<0||!Number.isSafeInteger(extra)||extra<0||!Number.isSafeInteger(known+extra))fail('BUDGET_CONFIG','분석 비용 설정을 확인하고 있습니다.',503);const keys=[r.keys[0],r.keys[4],r.keys[1],r.keys[7],this.cancelKey(r.sid,r.token)];const out=await this.command(['EVAL',EXTEND_BASE_REVIEW,5,...keys,r.token,r.hash,String(known),String(extra),String(this.c.dailyBudget),String(this.c.totalBudget)]);const state=out?.[0];if(state==='budget')fail('DAILY_BUDGET','첫 검수를 위한 오늘의 운영 한도가 부족합니다.',429,true);if(state==='totalbudget')fail('TOTAL_BUDGET','첫 검수를 위한 잔여 운영 한도가 부족합니다.',429,false);if(state==='cancelled')fail('REQUEST_CANCELLED','삭제 요청으로 남은 AI 처리를 중단했습니다.',409);if(state!=='ok'||!/^\d+$/.test(String(out[1]))||!Number.isSafeInteger(Number(out[1])))fail('REQUEST_EXPIRED','처리 시간을 확인하지 못했습니다.',503);r.cost=Number(out[1]);}
 async reserveRepair(r,known,extra,phase){if(!r?.staged||!Number.isSafeInteger(known)||known<0||!Number.isSafeInteger(extra)||extra<0||!Number.isSafeInteger(known+extra)||![1,2].includes(phase))fail('BUDGET_CONFIG','분석 비용 설정을 확인하고 있습니다.',503);const keys=[r.keys[0],r.keys[4],r.keys[1],r.keys[7],this.cancelKey(r.sid,r.token)];const out=await this.command(['EVAL',EXTEND_REVISION_STAGED,5,...keys,r.token,r.hash,String(known),String(extra),String(this.c.dailyBudget),String(this.c.totalBudget),String(phase)]);const state=out?.[0];if(state==='budget')fail('DAILY_BUDGET','후속 검수를 위한 오늘의 운영 한도가 부족합니다.',429,true);if(state==='totalbudget')fail('TOTAL_BUDGET','후속 검수를 위한 잔여 운영 한도가 부족합니다.',429,false);if(state==='cancelled')fail('REQUEST_CANCELLED','삭제 요청으로 남은 AI 처리를 중단했습니다.',409);if(state!=='ok'||!/^\d+$/.test(String(out[1]))||!Number.isSafeInteger(Number(out[1])))fail('REQUEST_EXPIRED','처리 시간을 확인하지 못했습니다.',503);r.cost=Number(out[1]);}
 keys(sid,ip,id){const keys=super.keys(sid,ip,id);keys[0]='insosoe:v4:request:'+sid+':'+id;keys[5]='insosoe:v4:used:'+sid;keys[6]='insosoe:v4:cache:'+sid+':'+id;return keys;}
 async free(sid){return this.repeatAllowed(sid)||!(await this.command(['EXISTS','insosoe:v4:used:'+sid]));}
 cancelKey(sid,id){return 'insosoe:v4:cancel:'+sid+':'+id;}
 async isCancelled(sid,id){return !!(await this.command(['EXISTS',this.cancelKey(sid,id)]));}
 async clear(sid){const r=await this.command(['EVAL',CLEAR_REVISION_CACHE,2,'insosoe:v2:cache-index:'+sid,'insosoe:v2:lock:'+sid,'insosoe:v4:cancel:'+sid+':']);if(r?.[0]!=='ok')fail('REDIS_UNAVAILABLE','임시 데이터 삭제를 확인할 수 없습니다.',503,true);}
 async finish(r,status,result,action,measuredCost){const actual=Number.isSafeInteger(measuredCost)&&measuredCost>=0?measuredCost:r.cost;const keys=[r.keys[0],r.keys[4],r.keys[6],r.keys[5],'insosoe:v2:cache-index:'+r.sid,r.keys[1],r.keys[7],this.cancelKey(r.sid,r.token)];const out=await this.command(['EVAL',r.staged?FINISH_REVISION_STAGED:FINISH_REVISION,8,...keys,r.token,r.hash,status,status==='done'?seal(this.c,r.sid,result):'',action,String(r.cost),String(actual)]);if(out?.[0]!=='ok')fail('REQUEST_EXPIRED','처리 시간이 초과되었습니다.',503);}
}
