import {Store,FINISH} from './store.mjs';
import {seal,fail} from './core.mjs';
export const CLEAR_REVISION_CACHE=`-- revision:clear
local pending=redis.call('GET',KEYS[2])
if pending then redis.call('SET',ARGV[1]..pending,'1','EX',600) end
local items=redis.call('SMEMBERS',KEYS[1]);for _,key in ipairs(items) do redis.call('DEL',key) end
redis.call('DEL',KEYS[1]);return {'ok'}`;
export const FINISH_REVISION=FINISH.replace('-- insosoe:finish','-- revision:finish').replace("if ARGV[3]=='done' then","if ARGV[3]=='done' and redis.call('EXISTS',KEYS[8])==0 then");
// New product entitlement only. Lifetime/day spend, IP/session quotas and lock are shared with V3.
export class RevisionStore extends Store {
 keys(sid,ip,id){const keys=super.keys(sid,ip,id);keys[0]='insosoe:v4:request:'+sid+':'+id;keys[5]='insosoe:v4:used:'+sid;keys[6]='insosoe:v4:cache:'+sid+':'+id;return keys;}
 async free(sid){return !(await this.command(['EXISTS','insosoe:v4:used:'+sid]));}
 cancelKey(sid,id){return 'insosoe:v4:cancel:'+sid+':'+id;}
 async isCancelled(sid,id){return !!(await this.command(['EXISTS',this.cancelKey(sid,id)]));}
 async clear(sid){const r=await this.command(['EVAL',CLEAR_REVISION_CACHE,2,'insosoe:v2:cache-index:'+sid,'insosoe:v2:lock:'+sid,'insosoe:v4:cancel:'+sid+':']);if(r?.[0]!=='ok')fail('REDIS_UNAVAILABLE','임시 데이터 삭제를 확인할 수 없습니다.',503,true);}
 async finish(r,status,result,action,measuredCost){const actual=Number.isSafeInteger(measuredCost)&&measuredCost>=0?measuredCost:r.cost;const keys=[r.keys[0],r.keys[4],r.keys[6],r.keys[5],'insosoe:v2:cache-index:'+r.sid,r.keys[1],r.keys[7],this.cancelKey(r.sid,r.token)];const out=await this.command(['EVAL',FINISH_REVISION,8,...keys,r.token,r.hash,status,status==='done'?seal(this.c,r.sid,result):'',action,String(r.cost),String(actual)]);if(out?.[0]!=='ok')fail('REQUEST_EXPIRED','처리 시간이 초과되었습니다.',503);}
}
