import {fail} from './core.mjs';

// Atomic content/payment transitions. Never touches any AI budget key.
export const SAVE_RESULT = `-- payment:save
local old=redis.call('GET',KEYS[1]);if old then return {'existing',old} end
if redis.call('EXISTS',KEYS[4])==1 then return {'used'} end
redis.call('SET',KEYS[2],ARGV[2],'PXAT',ARGV[3])
redis.call('SET',KEYS[1],ARGV[1],'PXAT',ARGV[3]);redis.call('SET',KEYS[3],ARGV[1],'PXAT',ARGV[3])
redis.call('SET',KEYS[4],'1');redis.call('SADD',KEYS[5],ARGV[1]);redis.call('PEXPIREAT',KEYS[5],ARGV[3])
return {'ok',ARGV[1]}`;
export const CREATE_ORDER = `-- payment:create
local raw=redis.call('GET',KEYS[1]);if not raw then return {'missing'} end
local r=cjson.decode(raw);if r.owner~=ARGV[1] then return {'missing'} end
if r.orderId then return {'existing',r.orderId} end
if tonumber(r.expiresAt)<=tonumber(ARGV[2])+60000 then return {'expired'} end
local o=cjson.decode(ARGV[4]);r.orderId=ARGV[3];r.purchaseState="checkout"
redis.call('SET',KEYS[2],ARGV[4],'PXAT',o.retentionExpiresAt)
redis.call('SET',KEYS[1],cjson.encode(r),'PXAT',r.expiresAt)
return {'ok',ARGV[3]}`;
export const REPLACE_ORDER = `-- payment:replace
local rr=redis.call('GET',KEYS[1]);local oo=redis.call('GET',KEYS[2]);if not rr or not oo then return {'missing'} end
local r=cjson.decode(rr);local o=cjson.decode(oo);local now=tonumber(ARGV[2])
if r.owner~=ARGV[1] or o.owner~=ARGV[1] or o.resultId~=r.id then return {'missing'} end
if r.orderId~=ARGV[3] then return {'existing',r.orderId} end
if tonumber(r.unpaidExpiresAt)<=now+60000 then return {'expired'} end
if o.approvedAt or o.revoked or o.deleted or o.supersededBy or not o.terminalFailure or not o.terminalUnpaidVerifiedAt or tonumber(o.terminalUnpaidVerifiedAt)<now-30000 or (o.providerStatus~='ABORTED' and o.providerStatus~='EXPIRED') then return {'revoked'} end
if o.lockUntil and tonumber(o.lockUntil)>now then return {'busy'} end
local fresh=cjson.decode(ARGV[5]);if fresh.id~=ARGV[4] or fresh.owner~=r.owner or fresh.resultId~=r.id or fresh.amount~=3000 or fresh.currency~='KRW' or fresh.mode~=o.mode or fresh.mid~=o.mid then return {'conflict'} end
if redis.call('EXISTS',KEYS[3])==1 then return {'conflict'} end
o.supersededBy=fresh.id;o.supersededAt=now;r.orderId=fresh.id;r.confirmationPending=false;r.purchaseState='checkout'
redis.call('SET',KEYS[2],cjson.encode(o),'PXAT',o.retentionExpiresAt)
redis.call('SET',KEYS[3],ARGV[5],'PXAT',fresh.retentionExpiresAt)
redis.call('SET',KEYS[1],cjson.encode(r),'PXAT',r.expiresAt)
redis.call('ZREM',KEYS[4],o.id);redis.call('ZREM',KEYS[5],o.id);redis.call('ZREM',KEYS[6],o.id)
return {'ok',fresh.id}`;
export const CHECK_CONFIRM = `-- payment:check-confirm
local rr=redis.call('GET',KEYS[1]);local oo=redis.call('GET',KEYS[2]);if not rr or not oo then return {'missing'} end
local r=cjson.decode(rr);local o=cjson.decode(oo)
if r.orderId~=o.id or r.owner~=ARGV[1] or o.owner~=ARGV[1] or o.paymentHash~=ARGV[2] then return {'conflict'} end
if o.supersededBy or o.deleted or o.revoked or o.terminalFailure or o.approvedAt then return {'revoked'} end
if o.lockToken~=ARGV[3] or tonumber(o.lockUntil or 0)<=tonumber(ARGV[4]) then return {'busy'} end
return {'ok'}`;
export const BEGIN_CONFIRM = `-- payment:begin
local rr=redis.call('GET',KEYS[1]);local oo=redis.call('GET',KEYS[2]);if not rr or not oo then return {'missing'} end
local r=cjson.decode(rr);local o=cjson.decode(oo)
if r.owner~=ARGV[1] or o.owner~=ARGV[1] or o.resultId~=r.id or r.orderId~=o.id then return {'missing'} end
if o.revoked or o.deleted or o.terminalFailure then return {'revoked'} end
if o.paymentHash and o.paymentHash~=ARGV[2] then return {'conflict'} end
local other=redis.call('GET',KEYS[3]);if other and other~=o.id then return {'conflict'} end
local now=tonumber(ARGV[4]);if o.approvedAt then return {'paid'} end
if not o.startedAt then
 if now>=tonumber(r.unpaidExpiresAt)-60000 then return {'expired'} end
 o.startedAt=now;o.leaseUntil=now+604800000
end
if now>=tonumber(o.leaseUntil)-60000 then return {'expired'} end
if o.lockUntil and tonumber(o.lockUntil)>now then return {'busy'} end
o.paymentHash=ARGV[2];o.paymentCipher=ARGV[3];o.state='processing';o.lockUntil=now+30000;o.lockToken=ARGV[5]
o.retentionExpiresAt=o.pendingRetentionExpiresAt;o.reconcileAttempts=o.reconcileAttempts or 0
r.expiresAt=o.leaseUntil;r.confirmationPending=true;r.purchaseState="pending"
-- Queue + all recovery pointers and ciphertext are durable before any charge.
redis.call('SET',KEYS[3],o.id,'PXAT',o.retentionExpiresAt)
redis.call('SET',KEYS[2],cjson.encode(o),'PXAT',o.retentionExpiresAt)
redis.call('SET',KEYS[1],cjson.encode(r),'PXAT',r.expiresAt)
redis.call('SET',KEYS[4],r.id,'PXAT',r.expiresAt);redis.call('SET',KEYS[5],r.id,'PXAT',r.expiresAt)
redis.call('SADD',KEYS[6],r.id);redis.call('PEXPIREAT',KEYS[6],r.expiresAt)
redis.call('ZADD',KEYS[7],now,o.id)
return {'ok',cjson.encode(o)}`;
export const RECORD_PAYMENT = `-- payment:record
local raw=redis.call('GET',KEYS[2]);if not raw then return {'missing'} end
local o=cjson.decode(raw);local hadApproval=o.approvedAt;local p=cjson.decode(ARGV[1]);local now=tonumber(ARGV[2])
if o.paymentHash and o.paymentHash~=p.paymentHash then return {'conflict'} end
local other=redis.call('GET',KEYS[3]);if other and other~=o.id then return {'conflict'} end
if p.approvedAt and o.approvedAt and o.approvedAt~=p.approvedAt then return {'conflict'} end
-- Refunds/failures are terminal; concurrent stale reads never regrant access.
if p.revoked then o.revoked=true end
if p.status=='ABORTED' or p.status=='EXPIRED' then o.terminalFailure=true end
if p.unpaidTerminal and not o.approvedAt and not o.revoked then o.terminalUnpaidVerifiedAt=now end
if p.approvedAt and not o.approvedAt then
 o.approvedAt=p.approvedAt;o.paidExpiresAt=p.paidExpiresAt;o.retentionExpiresAt=p.retentionExpiresAt
end
if not o.approvedAt and (o.terminalFailure or o.revoked) then o.retentionExpiresAt=o.abandonedExpiresAt end
o.paymentHash=p.paymentHash;o.paymentCipher=p.paymentCipher;o.providerStatus=p.status;o.checkedAt=now
-- Do not release an active confirmer's lock merely because a GET completed.
if o.revoked then o.state='revoked' elseif o.terminalFailure then o.state='failed' elseif o.approvedAt then o.state='paid' else o.state=p.status end
local terminal=o.revoked or o.terminalFailure or o.approvedAt
local rr=redis.call('GET',KEYS[1]);local r=rr and cjson.decode(rr) or nil
if r and r.orderId~=o.id then if o.supersededBy then r=nil else return {'conflict'} end end
local repaired=r and not o.deleted and tonumber(r.expiresAt)>now and p.status=='DONE' and not o.revoked and not o.terminalFailure
local resolved=o.deleted or p.status=='CANCELED' or (o.terminalFailure and not o.approvedAt and p.unpaidTerminal) or repaired
if resolved then redis.call('ZREM',KEYS[8],o.id);o.supportRequired=false end
if o.approvedAt and not o.deleted and not r and not resolved and (not hadApproval or tonumber(o.paidExpiresAt)>now) then
 o.supportRequired=true;o.lastReconcileCode='PAID_CONTENT_UNAVAILABLE'
end
-- A successful provider lookup clears transport/validation failure, NOT unresolved support.
redis.call('ZREM',KEYS[9],o.id)
if o.supportRequired then
 redis.call('ZADD',KEYS[8],o.retentionExpiresAt,o.id);redis.call('ZADD',KEYS[4],now+600000,o.id)
elseif terminal then redis.call('ZREM',KEYS[4],o.id) end
redis.call('SET',KEYS[3],o.id,'PXAT',o.retentionExpiresAt)
redis.call('SET',KEYS[2],cjson.encode(o),'PXAT',o.retentionExpiresAt)
if not r or o.deleted then return {'recorded',cjson.encode(o)} end
if terminal then r.confirmationPending=false end
if o.revoked then r.purchaseState='revoked' elseif o.approvedAt then r.purchaseState='paid' elseif o.terminalFailure then
 if o.terminalUnpaidVerifiedAt and tonumber(r.unpaidExpiresAt)>now+60000 then r.purchaseState='retryable' else r.purchaseState='closed' end
end
if o.approvedAt then r.expiresAt=o.paidExpiresAt
elseif o.terminalFailure or o.revoked then r.expiresAt=r.unpaidExpiresAt end
if tonumber(r.expiresAt)<=now then redis.call('DEL',KEYS[1],KEYS[6]);if redis.call('GET',KEYS[5])==r.id then redis.call('DEL',KEYS[5]) end
else
 redis.call('SET',KEYS[1],cjson.encode(r),'PXAT',r.expiresAt)
 redis.call('SET',KEYS[6],r.id,'PXAT',r.expiresAt)
 if redis.call('GET',KEYS[5])==r.id or not redis.call('GET',KEYS[5]) then redis.call('SET',KEYS[5],r.id,'PXAT',r.expiresAt) end
 redis.call('SADD',KEYS[7],r.id);redis.call('PEXPIREAT',KEYS[7],r.expiresAt)
end
return {'ok',cjson.encode(o)}`;
export const RELEASE_CONFIRM = `-- payment:release
local raw=redis.call('GET',KEYS[1]);if not raw then return {'ok'} end
local o=cjson.decode(raw);if o.lockToken==ARGV[1] then o.lockUntil=0;redis.call('SET',KEYS[1],cjson.encode(o),'PXAT',o.retentionExpiresAt) end
return {'ok'}`;
export const DELETE_RESULT = `-- payment:delete
local rr=redis.call('GET',KEYS[1]);if not rr then return {'ok'} end
local r=cjson.decode(rr);if r.owner~=ARGV[1] and ARGV[3]~='authorized' then return {'missing'} end
if r.orderId then
 local oo=redis.call('GET',KEYS[4]);if not oo then return {'conflict'} end
 local o=cjson.decode(oo)
 if o.startedAt and not o.approvedAt and not o.revoked and not o.terminalFailure and tonumber(o.leaseUntil)>tonumber(ARGV[2]) then return {'busy'} end
 o.deleted=true;redis.call('SET',KEYS[4],cjson.encode(o),'PXAT',o.retentionExpiresAt)
end
redis.call('DEL',KEYS[1],KEYS[5]);redis.call('SREM',KEYS[3],r.id)
if redis.call('GET',KEYS[2])==r.id then redis.call('DEL',KEYS[2]) end
return {'ok'}`;
export const RECONCILE_CLAIM = `-- payment:claim
-- Claim by moving due score, so concurrent workers receive disjoint batches.
local now=tonumber(ARGV[1]);local ids=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',now,'LIMIT',0,tonumber(ARGV[2]))
for _,id in ipairs(ids) do redis.call('ZADD',KEYS[1],now+120000,id) end
return ids`;
export const RECONCILE_RETRY = `-- payment:retry
local raw=redis.call('GET',KEYS[1]);if not raw then redis.call('ZREM',KEYS[2],ARGV[1]);redis.call('ZREM',KEYS[3],ARGV[1]);redis.call('ZREM',KEYS[4],ARGV[1]);return {'missing'} end
local o=cjson.decode(raw);local now=tonumber(ARGV[2]);o.reconcileAttempts=(o.reconcileAttempts or 0)+1;o.lastReconcileAt=now;o.lastReconcileCode=ARGV[3]
if ARGV[5]=='failure' then redis.call('ZADD',KEYS[4],o.retentionExpiresAt,o.id) end
if o.supportRequired then redis.call('ZADD',KEYS[2],now+tonumber(ARGV[4]),o.id)
elseif o.approvedAt or o.revoked or o.terminalFailure or o.deleted then redis.call('ZREM',KEYS[2],o.id)
elseif now>=tonumber(o.leaseUntil) then
 o.supportRequired=true;o.lastReconcileCode='PENDING_CONTENT_EXPIRED';redis.call('ZADD',KEYS[2],now+tonumber(ARGV[4]),o.id);redis.call('ZADD',KEYS[3],o.retentionExpiresAt,o.id)
else redis.call('ZADD',KEYS[2],now+tonumber(ARGV[4]),o.id) end
redis.call('SET',KEYS[1],cjson.encode(o),'PXAT',o.retentionExpiresAt)
return {'ok',cjson.encode(o)}`;
export const RECONCILE_HEARTBEAT = `-- payment:heartbeat
local now=tonumber(ARGV[1]);redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',now);redis.call('ZREMRANGEBYSCORE',KEYS[4],'-inf',now)
local raw=redis.call('GET',KEYS[1]);local h=raw and cjson.decode(raw) or {}
h.lastAttemptAt=now;h.processed=tonumber(ARGV[2]);h.lastSweepFailures=tonumber(ARGV[3]);h.pending=redis.call('ZCARD',KEYS[2]);h.supportRequired=redis.call('ZCARD',KEYS[3]);h.outstandingFailures=redis.call('ZCARD',KEYS[4])
h.failed=math.max(h.lastSweepFailures,h.supportRequired+h.outstandingFailures)
if h.failed==0 then h.lastSuccessAt=now else h.lastFailureAt=now end
redis.call('SET',KEYS[1],cjson.encode(h),'PX',2592000000)
return {'ok',cjson.encode(h)}`;
export class PaymentStore {
 constructor(store,mode){this.store=store;this.base='insosoe:v3:pay:'+mode+':';}
 key(kind,id){return this.base+kind+':'+id;}
 async get(kind,id){const raw=await this.store.command(['GET',this.key(kind,id)]);if(raw===null||raw===undefined)return null;try{return JSON.parse(raw);}catch{fail('PAYMENT_STORAGE','결제 기록을 확인할 수 없습니다.',503,true);}}
 async value(kind,id){return this.store.command(['GET',this.key(kind,id)]);}
 async eval(script,keys,args=[]){const r=await this.store.command(['EVAL',script,keys.length,...keys,...args.map(String)]);if(!Array.isArray(r))fail('PAYMENT_STORAGE','결제 기록을 확인할 수 없습니다.',503,true);return r;}
}
