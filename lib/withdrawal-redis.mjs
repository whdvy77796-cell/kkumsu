/**
 * EXPERIMENTAL, UNINTEGRATED. Base 0194b8821a617f2dc9e41577b6b413517f05187c.
 * INTEGRATION CONTRACT / RELEASE BLOCKERS:
 * Trusted adapter verifies provider/issuer/clientId/subject and accountId using
 * YB_IDENTITY_KEY, NOT rotating YB_AUTH_SECRET. This module derives NO identity.
 * Owner tuple = namespace/origin/provider/accountId/incarnation. Legacy accountId
 * alone is ambiguous: quarantine/migrate, NEVER carry owners across incarnation.
 * Embed ACTIVE_GUARD_LUA in the SAME EVAL as session/barrier checks and ALL record
 * and index writes. Standalone CHECK is NOT authority for a later write. TIME is
 * Redis execution-time evidence, not proof of a fresh wall clock at each call:
 * servers may cache time within EVAL. Bound execution and define expiry policy
 * conservatively before integration. Password proof binds immutable
 * verifiedRaw + revision + owner tuple; compare all in that EVAL. A conflict ends
 * that operation: never swap a fresh password proof inside automatic retries.
 * Every callback/session issuance, claim, legacy password update/report/create
 * retry, restore/import/backfill/admin writer and queue replay must obey barrier.
 * Existing schema: yb:auth:v1:sha256(origin|namespace|MAC(session-secret,...)):
 * session:sha256(token); oa_HMAC(identityKey,[account,origin,namespace,provider,
 * clientId,subject]); namespace:record:id; namespace:owner:sha256(accountId) zset;
 * namespace:directory zset, namespace:reports:id hash. No incarnation currently.
 * Existing keys CANNOT join this account hash slot in Cluster without reviewed
 * migration. Shared directory needs redesign or single-primary Redis, never
 * cross-slot check then write. No global registry, account cap, or all-user logout.
 * Persistent per-account state is authority. Missing/wrong type/corrupt authority
 * or missing session fails closed. Ordinary login MUST NOT recreate missing state.
 * PROVISION consumes externally verified first-enrollment permit; its producer is
 * BLOCKED until independent durable enrollment/key-loss recovery is designed.
 * Redis ACL must prevent untrusted state/permit/worker/receipt writes. Permits,
 * grants and receipts are TRUSTED Redis values, not cryptographically signed
 * attestations. Their secure issuer/verifier and any multi-writer ACL design are
 * NOT provided; copying client claims into them would be an authorization bug.
 * Cleanup must FULL SCAN every record namespace/shard, not index/manifest. Empty,
 * missing/corrupt indexes/manifests NEVER prove completeness. First fence ALL
 * matching-owner attachment/preservation/restore paths. Idempotent per-item detach
 * validates full owner tuple + exact raw CAS. Ambiguous/corrupt records block a
 * page, never skip. Duplicates and empty SCAN pages are normal; cursors are decimal
 * STRINGS. Cursor is durable only AFTER every page item succeeds and a trusted
 * future detach transaction creates an attested receipt. Crash repeats page.
 * COUNT is a hint: independently bound page items/bytes and stage oversized pages.
 * SCAN all masters; reshard/failover/restore requires new scan epoch/restart '0'.
 * Checkpoint consumes one bounded receipt but is NOT its producer or cleanup.
 * Actual record detach, callbacks, webhook/API/UI, worker grants/receipts, provider
 * unlink, session issuance and re-enrollment integration remain BLOCKED. No script
 * here produces deleted. Cursor '0', a plan, or claimed success cannot finalize.
 * Future deleted transition requires authenticated cleanup/provider attestations,
 * covered writers, durable scan epoch and retention policy. Unknown unlink stays
 * pending. Imported deleted tombstone is NOT permission to re-enroll/reuse owners.
 * Lua atomicity is NOT rollback. Preflight types/payload/size and encode before
 * writes. OOM/ACL/runtime/network/failover errors can be indeterminate: reconcile
 * with SAME op/proof, never new identity. Replication/backup durability not provided.
 * Restoring stale authority can resurrect access: stop writers, reconcile epochs.
 * Pure JS tests are NOT Redis tests; real Redis tests use synthetic keys only and
 * establish no service integration safety. No production/provider access exists.
 */
import { createHash, randomBytes } from 'node:crypto';
export const BASE_COMMIT='0194b8821a617f2dc9e41577b6b413517f05187c';
export const LIMITS=Object.freeze({authorityBytes:8192,retryMs:300000,maxAttempts:4,maxPages:1000000,maxFence:1000000000000});
export const BLOCKED=Object.freeze(['record-detach','receipt-producer','worker-authorization','callback','webhook','API','provider-unlink','session-issuance','re-enrollment','deleted-transition']);
export const TRANSITIONS=Object.freeze({active:Object.freeze(['deleting']),deleting:Object.freeze([]),deleted:Object.freeze([])});
const opaque=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
export const newIncarnation=()=>randomBytes(32).toString('base64url');
export const newOperationId=()=>randomBytes(32).toString('base64url');
export function validCursor(v){return typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n;}
export function accountKeys(t){
 if(!t||!/^oa_[A-Za-z0-9_-]{43}$/.test(t.accountId)||!['kakao','naver','google'].includes(t.provider)||typeof t.namespace!=='string'||!t.namespace||Buffer.byteLength(t.namespace,'utf8')>256||/[\x00-\x1f]/.test(t.namespace))throw Error('TUPLE');
 const u=new URL(t.origin);if(u.protocol!=='https:'||u.origin!==t.origin||t.origin.length>512)throw Error('ORIGIN');
 const tag=createHash('sha256').update(JSON.stringify([t.namespace,t.origin,t.provider,t.accountId])).digest('hex');
 const base='yb:withdrawal:v1:{'+tag+'}';
 return Object.freeze({base,state:base+':state',permit:base+':permit',worker:base+':worker',receipt:base+':receipt',session(token){if(!opaque(token))throw Error('TOKEN');return base+':session:'+createHash('sha256').update(token).digest('hex');}});
}
// Retries carry the same immutable wire payload; no proof refresh or hidden clock.
export async function boundedRetry(command,send,retryable=r=>r?.status==='retry'){
 const wire=JSON.stringify(command);let result;
 for(let i=0;i<LIMITS.maxAttempts;i++){result=await send(JSON.parse(wire));if(!retryable(result))return result;}
 return {status:'retry-exhausted',last:result};
}
const COMMON=String.raw`
local function result(status,extra) local r=extra or {};r.status=status;return cjson.encode(r) end
local function nowms() local t=redis.call('TIME');return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000) end
local function integer(v) return type(v)=='number' and v>=0 and v<=9007199254740991 and v==math.floor(v) end
local function opaque(v) return type(v)=='string' and #v==43 and string.match(v,'^[%w_-]+$') end
local function cursor(v) return type(v)=='string' and (#v<20 or (#v==20 and v<='18446744073709551615')) and (v=='0' or string.match(v,'^[1-9]%d*$')) end
local function typeis(k,t) return redis.call('TYPE',k).ok==t end
local function read(k) if not typeis(k,'string') then return nil end;local raw=redis.call('GET',k);if not raw or #raw>8192 then return nil end;local ok,v=pcall(cjson.decode,raw);if ok and type(v)=='table' then return v,raw end end
local function tuple(a,b) return a.accountId==b.accountId and a.provider==b.provider and a.origin==b.origin and a.namespace==b.namespace end
local function validtuple(s) return type(s.accountId)=='string' and #s.accountId==46 and string.match(s.accountId,'^oa_[%w_-]+$') and (s.provider=='kakao' or s.provider=='naver' or s.provider=='google') and type(s.origin)=='string' and #s.origin<=512 and string.match(s.origin,'^https://') and type(s.namespace)=='string' and #s.namespace>0 and #s.namespace<=256 end
local function authority(k)
 local s=read(k)
 if not s or s.v~=1 or not validtuple(s) or not opaque(s.incarnation) or not integer(s.fence) or s.fence<1 or s.fence>1000000000000 or type(s.base)~='string' or #s.base~=83 or not string.match(s.base,'^yb:withdrawal:v1:{%x+}$') or k~=s.base..':state' or redis.call('PTTL',k)~=-1 then return nil end
 if s.state~='active' and s.state~='deleting' and s.state~='deleted' then return nil end
 if s.state=='deleting' and (not opaque(s.operationId) or not integer(s.beginFence) or s.fence~=s.beginFence+1 or not integer(s.retryUntil) or not opaque(s.beginBinding) or type(s.beginSession)~='string' or not cursor(s.cursor) or not integer(s.page) or s.page>1000000 or s.providerUnlink~='pending' or s.cleanup~='blocked') then return nil end
 return s
end
local function request()
 if #ARGV~=1 or #ARGV[1]>8192 then return nil end
 local ok,p=pcall(cjson.decode,ARGV[1]);if not ok or type(p)~='table' or not validtuple(p) or not opaque(p.incarnation) or not integer(p.fence) then return nil end
 return p
end
local function session(s,key,p,now,expectedFence)
 if type(key)~='string' or string.sub(key,1,#s.base+9)~=s.base..':session:' or #key~=#s.base+9+64 or not string.match(string.sub(key,-64),'^%x+$') then return nil end
 local v=read(key);if not v or redis.call('PTTL',key)<=0 or not tuple(s,p) or not tuple(s,v) or p.incarnation~=s.incarnation or v.incarnation~=s.incarnation or p.fence~=expectedFence or v.fence~=expectedFence or not opaque(v.binding) or v.binding~=p.binding or not integer(v.issuedAt) or not integer(v.expiresAt) or v.issuedAt>now or v.expiresAt<=now or v.expiresAt-v.issuedAt>604800000 then return nil end
 return v
end
local function active(stateKey,sessionKey,p)
 local s=authority(stateKey);if not s then return nil,'authority-missing-or-corrupt' end
 if s.state~='active' then return nil,'barrier' end
 if not session(s,sessionKey,p,nowms(),s.fence) then return nil,'session' end
 return s
end
`;
// Fragment only: invoke active again immediately before record/index mutations.
export const ACTIVE_GUARD_LUA=COMMON;
export const CHECK_LUA=COMMON+String.raw`
if #KEYS~=2 or KEYS[1]==KEYS[2] then return result('invalid') end
local p=request();if not p then return result('invalid') end
local s,e=active(KEYS[1],KEYS[2],p);if not s then return result(e) end
return result('active',{incarnation=s.incarnation,fence=s.fence,readOnly=true})
`;
export const PROVISION_LUA=COMMON+String.raw`
if #KEYS~=2 or KEYS[1]==KEYS[2] then return result('invalid') end
local p=request();if not p then return result('invalid') end
if not typeis(KEYS[1],'none') then return result('existing-authority') end
local permit=read(KEYS[2]);if not permit or permit.kind~='verified-first-enrollment' or permit.v~=1 or not tuple(permit,p) or permit.incarnation~=p.incarnation or not opaque(permit.incarnation) or type(permit.base)~='string' or #permit.base~=83 or not string.match(permit.base,'^yb:withdrawal:v1:{%x+}$') or KEYS[1]~=permit.base..':state' or KEYS[2]~=permit.base..':permit' or not integer(permit.expiresAt) or not integer(permit.issuedAt) or permit.issuedAt>nowms() or permit.expiresAt-permit.issuedAt>300000 or redis.call('PTTL',KEYS[2])<=0 or p.fence~=1 then return result('enrollment-authority') end
local s={v=1,base=permit.base,accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,state='active'}
local encoded=cjson.encode(s)
if permit.expiresAt<=nowms() then return result('expired') end
-- Consume the permit first. A later SET failure leaves no authority and cannot
-- replay the same permit; enrollment recovery remains deliberately external.
redis.call('DEL',KEYS[2]);redis.call('SET',KEYS[1],encoded);return result('active')
`;
export const BEGIN_LUA=COMMON+String.raw`
if #KEYS~=2 or KEYS[1]==KEYS[2] then return result('invalid') end
local p=request();if not p or not opaque(p.operationId) then return result('invalid') end
local s=authority(KEYS[1]);if not s then return result('authority-missing-or-corrupt') end
if s.state=='deleted' then return result('barrier') end
local expected=s.state=='deleting' and s.beginFence or s.fence
if not session(s,KEYS[2],p,nowms(),expected) then return result('session') end
if s.state=='deleting' then
 if s.operationId~=p.operationId or s.beginBinding~=p.binding or s.beginSession~=KEYS[2] then return result('busy') end
 if nowms()>=s.retryUntil then return result('retry-expired') end
 return result('deleting',{operationId=s.operationId,fence=s.fence,replay=true})
end
if s.fence>=1000000000000 then return result('fence-exhausted') end
s.state='deleting';s.operationId=p.operationId;s.beginFence=s.fence;s.fence=s.fence+1;s.beginBinding=p.binding;s.beginSession=KEYS[2];s.retryUntil=nowms()+300000;s.cursor='0';s.page=0;s.cleanup='blocked';s.providerUnlink='pending'
local encoded=cjson.encode(s)
if #encoded>8192 then return result('authority-size') end
-- Recheck inside the same EVAL. Redis may cache TIME within an execution unit;
-- this is not a guarantee that wall-clock expiry is freshly sampled at mutation.
if not session(s,KEYS[2],p,nowms(),s.beginFence) then return result('session') end
redis.call('SET',KEYS[1],encoded)
return result('deleting',{operationId=s.operationId,fence=s.fence,replay=false})
`;
export const CHECKPOINT_LUA=COMMON+String.raw`
if #KEYS~=3 or KEYS[1]==KEYS[2] or KEYS[1]==KEYS[3] or KEYS[2]==KEYS[3] then return result('invalid') end
local p=request();if not p or not opaque(p.operationId) or not opaque(p.workerBinding) or not opaque(p.receiptId) then return result('invalid') end
local s=authority(KEYS[1]);if not s then return result('authority-missing-or-corrupt') end
if s.state~='deleting' or not tuple(s,p) or s.incarnation~=p.incarnation or s.fence~=p.fence or s.operationId~=p.operationId then return result('barrier') end
if KEYS[2]~=s.base..':worker' or KEYS[3]~=s.base..':receipt' then return result('invalid') end
local w=read(KEYS[2]);local r=read(KEYS[3])
local function authorized(now) return w and w.kind=='cleanup-worker' and tuple(w,s) and w.incarnation==s.incarnation and w.operationId==s.operationId and w.fence==s.fence and w.binding==p.workerBinding and integer(w.expiresAt) and w.expiresAt>now and redis.call('PTTL',KEYS[2])>0 end
if not authorized(nowms()) then return result('worker-authority') end
if not r or r.kind~='page-applied' or not tuple(r,s) or r.incarnation~=s.incarnation or r.operationId~=s.operationId or r.fence~=s.fence or r.receiptId~=p.receiptId or not opaque(r.receiptId) or not cursor(r.from) or not cursor(r.next) or not integer(r.page) or not integer(r.expiresAt) or r.expiresAt<=nowms() or redis.call('PTTL',KEYS[3])<=0 then return result('unattested-page') end
if s.lastReceipt==r.receiptId then return result('deleting',{cursor=s.cursor,page=s.page,replay=true,cleanup='blocked'}) end
if r.from~=s.cursor or r.page~=s.page+1 or s.page>=1000000 or (s.page>0 and s.cursor=='0') then return result('cursor-conflict') end
s.cursor=r.next;s.page=r.page;s.lastReceipt=r.receiptId
local encoded=cjson.encode(s)
if #encoded>8192 then return result('authority-size') end
if not authorized(nowms()) or r.expiresAt<=nowms() then return result('expired') end
redis.call('SET',KEYS[1],encoded)
return result('deleting',{cursor=s.cursor,page=s.page,cleanup='blocked',providerUnlink='pending'})
`;
export const FINALIZE_LUA=COMMON+String.raw`
if #KEYS~=1 then return result('invalid') end
local p=request();if not p then return result('invalid') end
local s=authority(KEYS[1]);if not s then return result('authority-missing-or-corrupt') end
if not tuple(s,p) or s.incarnation~=p.incarnation or s.fence~=p.fence or s.operationId~=p.operationId then return result('barrier') end
return result('blocked',{reason='cleanup-and-provider-unlink-not-integrated',state=s.state})
`;
