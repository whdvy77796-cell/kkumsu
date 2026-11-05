-- ISOLATED REAL-REDIS SMOKE HARNESS. No provider, money, credentials or live records.
-- Generated verbatim from lib/payment-store.mjs exported script strings.
-- Run as EVAL <this script> 1 insosoe:qa:<fresh-random-UUID>.
-- Uses real Redis TIME; future application timestamps simulate boundary branches.
-- A single EVAL is atomic: this does NOT test multi-client races or PG behavior.
-- No nested EVAL. Cleanup enumerates only registered keys in its own prefix.
-- SAVE_RESULT sha256=94bd0adfb779f222a15c0783454b4025463b75f9bd762484bd49e8d4c267ee5c bytes=425
-- CREATE_ORDER sha256=d134c31730f873d2c08579335ca6c6fea8dcc07acb399635d979363842908a29 bytes=516
-- REPLACE_ORDER sha256=664962d10f0e94574966b158295f30c419a5d1ace98e826ab282e0fef8c459d0 bytes=1483
-- CHECK_CONFIRM sha256=8dfa7838bf6860cb994c21e372ef694c6403279f539bbf9efcf05f39f5c096e7 bytes=527
-- BEGIN_CONFIRM sha256=4c645baf51b090bc294ea6060352718bd9ffbddcb1f483ba924835f2257112a0 bytes=1670
-- RECORD_PAYMENT sha256=d400c80b86b1b22b5e24ba26495fcf5fbe5db76ece49e04afc7b162d6cf61d5d bytes=3542
-- RELEASE_CONFIRM sha256=2b8f1d124aea9d22b2ec604b01d7b36eeae0f07dc12fce427df9f9dff8357ee6 bytes=245
-- DELETE_RESULT sha256=8a08c088031c0dde2b3753205bf773d59a15700be1c37b696a7f17bde421ed0c bytes=694
-- RECONCILE_CLAIM sha256=0a88547b7b48c2f8b140321eb218b1d3e8d41a0742fdef4a57271c943ee84d5c bytes=290
-- RECONCILE_RETRY sha256=289604b66a7e8a35782d34452edd28c4b4477010d7c3009931efc8c7e09e8918 bytes=997
-- RECONCILE_HEARTBEAT sha256=7bc24b4d108dbf5797a17378f1f604db608086bd63abab65b1565c9dd9c03879 bytes=682

local function SAVE_RESULT(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT SAVE_RESULT
-- payment:save
local old=redis.call('GET',KEYS[1]);if old then return {'existing',old} end
if redis.call('EXISTS',KEYS[4])==1 then return {'used'} end
redis.call('SET',KEYS[2],ARGV[2],'PXAT',ARGV[3])
redis.call('SET',KEYS[1],ARGV[1],'PXAT',ARGV[3]);redis.call('SET',KEYS[3],ARGV[1],'PXAT',ARGV[3])
redis.call('SET',KEYS[4],'1');redis.call('SADD',KEYS[5],ARGV[1]);redis.call('PEXPIREAT',KEYS[5],ARGV[3])
return {'ok',ARGV[1]}
-- END EXACT SAVE_RESULT
end

local function CREATE_ORDER(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT CREATE_ORDER
-- payment:create
local raw=redis.call('GET',KEYS[1]);if not raw then return {'missing'} end
local r=cjson.decode(raw);if r.owner~=ARGV[1] then return {'missing'} end
if r.orderId then return {'existing',r.orderId} end
if tonumber(r.expiresAt)<=tonumber(ARGV[2])+60000 then return {'expired'} end
local o=cjson.decode(ARGV[4]);r.orderId=ARGV[3];r.purchaseState="checkout"
redis.call('SET',KEYS[2],ARGV[4],'PXAT',o.retentionExpiresAt)
redis.call('SET',KEYS[1],cjson.encode(r),'PXAT',r.expiresAt)
return {'ok',ARGV[3]}
-- END EXACT CREATE_ORDER
end

local function REPLACE_ORDER(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT REPLACE_ORDER
-- payment:replace
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
return {'ok',fresh.id}
-- END EXACT REPLACE_ORDER
end

local function CHECK_CONFIRM(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT CHECK_CONFIRM
-- payment:check-confirm
local rr=redis.call('GET',KEYS[1]);local oo=redis.call('GET',KEYS[2]);if not rr or not oo then return {'missing'} end
local r=cjson.decode(rr);local o=cjson.decode(oo)
if r.orderId~=o.id or r.owner~=ARGV[1] or o.owner~=ARGV[1] or o.paymentHash~=ARGV[2] then return {'conflict'} end
if o.supersededBy or o.deleted or o.revoked or o.terminalFailure or o.approvedAt then return {'revoked'} end
if o.lockToken~=ARGV[3] or tonumber(o.lockUntil or 0)<=tonumber(ARGV[4]) then return {'busy'} end
return {'ok'}
-- END EXACT CHECK_CONFIRM
end

local function BEGIN_CONFIRM(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT BEGIN_CONFIRM
-- payment:begin
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
return {'ok',cjson.encode(o)}
-- END EXACT BEGIN_CONFIRM
end

local function RECORD_PAYMENT(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT RECORD_PAYMENT
-- payment:record
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
return {'ok',cjson.encode(o)}
-- END EXACT RECORD_PAYMENT
end

local function RELEASE_CONFIRM(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT RELEASE_CONFIRM
-- payment:release
local raw=redis.call('GET',KEYS[1]);if not raw then return {'ok'} end
local o=cjson.decode(raw);if o.lockToken==ARGV[1] then o.lockUntil=0;redis.call('SET',KEYS[1],cjson.encode(o),'PXAT',o.retentionExpiresAt) end
return {'ok'}
-- END EXACT RELEASE_CONFIRM
end

local function DELETE_RESULT(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT DELETE_RESULT
-- payment:delete
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
return {'ok'}
-- END EXACT DELETE_RESULT
end

local function RECONCILE_CLAIM(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT RECONCILE_CLAIM
-- payment:claim
-- Claim by moving due score, so concurrent workers receive disjoint batches.
local now=tonumber(ARGV[1]);local ids=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',now,'LIMIT',0,tonumber(ARGV[2]))
for _,id in ipairs(ids) do redis.call('ZADD',KEYS[1],now+120000,id) end
return ids
-- END EXACT RECONCILE_CLAIM
end

local function RECONCILE_RETRY(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT RECONCILE_RETRY
-- payment:retry
local raw=redis.call('GET',KEYS[1]);if not raw then redis.call('ZREM',KEYS[2],ARGV[1]);redis.call('ZREM',KEYS[3],ARGV[1]);redis.call('ZREM',KEYS[4],ARGV[1]);return {'missing'} end
local o=cjson.decode(raw);local now=tonumber(ARGV[2]);o.reconcileAttempts=(o.reconcileAttempts or 0)+1;o.lastReconcileAt=now;o.lastReconcileCode=ARGV[3]
if ARGV[5]=='failure' then redis.call('ZADD',KEYS[4],o.retentionExpiresAt,o.id) end
if o.supportRequired then redis.call('ZADD',KEYS[2],now+tonumber(ARGV[4]),o.id)
elseif o.approvedAt or o.revoked or o.terminalFailure or o.deleted then redis.call('ZREM',KEYS[2],o.id)
elseif now>=tonumber(o.leaseUntil) then
 o.supportRequired=true;o.lastReconcileCode='PENDING_CONTENT_EXPIRED';redis.call('ZADD',KEYS[2],now+tonumber(ARGV[4]),o.id);redis.call('ZADD',KEYS[3],o.retentionExpiresAt,o.id)
else redis.call('ZADD',KEYS[2],now+tonumber(ARGV[4]),o.id) end
redis.call('SET',KEYS[1],cjson.encode(o),'PXAT',o.retentionExpiresAt)
return {'ok',cjson.encode(o)}
-- END EXACT RECONCILE_RETRY
end

local function RECONCILE_HEARTBEAT(keys, args)
 local KEYS, ARGV = keys, args
-- BEGIN EXACT RECONCILE_HEARTBEAT
-- payment:heartbeat
local now=tonumber(ARGV[1]);redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',now);redis.call('ZREMRANGEBYSCORE',KEYS[4],'-inf',now)
local raw=redis.call('GET',KEYS[1]);local h=raw and cjson.decode(raw) or {}
h.lastAttemptAt=now;h.processed=tonumber(ARGV[2]);h.lastSweepFailures=tonumber(ARGV[3]);h.pending=redis.call('ZCARD',KEYS[2]);h.supportRequired=redis.call('ZCARD',KEYS[3]);h.outstandingFailures=redis.call('ZCARD',KEYS[4])
h.failed=math.max(h.lastSweepFailures,h.supportRequired+h.outstandingFailures)
if h.failed==0 then h.lastSuccessAt=now else h.lastFailureAt=now end
redis.call('SET',KEYS[1],cjson.encode(h),'PX',2592000000)
return {'ok',cjson.encode(h)}
-- END EXACT RECONCILE_HEARTBEAT
end

local root=KEYS[1]
if #KEYS~=1 or type(root)~='string' or #root~=47 or not string.match(root,'^insosoe:qa:[0-9a-fA-F%-]+$') then
 return cjson.encode({ok=false,error='BAD_QA_PREFIX',cleanup=true,touched=0})
end
local all,known={},{}
local function K(suffix)
 local key=root..':'..suffix
 if string.sub(key,1,#root+1)~=root..':' then error('KEY_SCOPE',0) end
 if not known[key] then known[key]=true;all[#all+1]=key end
 return key
end
local function nowMs()
 local t=redis.call('TIME')
 return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
end
local DAY=86400000
local function leap(y) return y%4==0 and (y%100~=0 or y%400==0) end
local function monthDays(y,m)
 local sizes={31,28,31,30,31,30,31,31,30,31,30,31}
 if m==2 and leap(y) then return 29 end
 return sizes[m]
end
-- Redis Lua has no os.date; derive UTC calendar anniversaries from real Redis TIME.
-- Financial expiry is computed by caller and supplied to the exact RECORD script.
local function fiveYears(ms)
 local days=math.floor(ms/DAY);local remainder=ms-days*DAY;local y=1970
 while days>=(leap(y) and 366 or 365) do days=days-(leap(y) and 366 or 365);y=y+1 end
 local m=1
 while days>=monthDays(y,m) do days=days-monthDays(y,m);m=m+1 end
 local d=days+1;local target=y+5;d=math.min(d,monthDays(target,m))
 local total=0
 for year=1970,target-1 do total=total+(leap(year) and 366 or 365) end
 for month=1,m-1 do total=total+monthDays(target,month) end
 return (total+d-1)*DAY+remainder
end
local started=nowMs()
local pending=K('queue:pending');local support=K('queue:support');local heartbeat=K('worker:heartbeat')
local guard=K('run:guard');local otherPayment=K('payment:other');local failures=K('queue:failures')
local fixtures={}
local function fixture(label,short)
 local id='qa-result-'..label;local owner='qa-owner-'..label;local request='qa-request-'..label
 local keys={result=K(label..':result'),request=K(label..':request'),latest=K(label..':latest'),used=K(label..':fake-legacy-used'),owner=K(label..':owner'),order=K(label..':order'),payment=K(label..':payment'),alternative=K(label..':alternative-order')}
 local expiry=started+(short or DAY)
 local result={id=id,owner=owner,requestId=request,createdAt=started,unpaidExpiresAt=expiry,expiresAt=expiry,cipher='QA-ENCRYPTED-CONTENT-'..label}
 local order={id='qa-order-'..label,resultId=id,owner=owner,requestId=request,mode='test',mid='QA-NOT-A-MERCHANT',amount=3000,currency='KRW',createdAt=started,state='created',idempotencyKey='QA-IDEMPOTENCY-'..label,abandonedExpiresAt=started+30*DAY,pendingRetentionExpiresAt=fiveYears(started),retentionExpiresAt=started+30*DAY}
 local f={keys=keys,result=result,order=order,hash='QA-HASH-'..label,token='QA-LOCK-'..label}
 fixtures[label]=f
 return f
end
local A=fixture('a');local B=fixture('b');local C=fixture('c');local D=fixture('d',30000);local E=fixture('e');local F=fixture('f');local G=fixture('g');local replacementPayment=K('g:replacement-payment')
local secondRequest=K('a:second-request');local secondResult=K('a:second-result')
local assertions=0;local tests={};local current='preflight';local owned=false
local function assertThat(ok,label)
 assertions=assertions+1
 if not ok then error('ASSERT:'..label,0) end
end
local function eq(actual,expected,label)
 assertThat(actual==expected,label)
end
local function decoded(key)
 local raw=redis.call('GET',key)
 assertThat(type(raw)=='string','read-existing-json')
 return cjson.decode(raw)
end
local function expiry(key,expected,label)
 local ttl=redis.call('PTTL',key)
 assertThat(ttl>0,label..':finite-positive-ttl')
 assertThat(math.abs(nowMs()+ttl-expected)<=5000,label..':absolute-deadline')
end
local function execute(fn,keys,args)
 for _,key in ipairs(keys) do assertThat(known[key] and string.sub(key,1,#root+1)==root..':','wrapped-key-scope') end
 local strings={};for i,value in ipairs(args or {}) do strings[i]=tostring(value) end
 return fn(keys,strings)
end
local function tag(out,wanted,label) eq(out[1],wanted,label) end
local function check(label,fn)
 current=label;fn();tests[#tests+1]=label
end
local function save(f)
 local k=f.keys
 return execute(SAVE_RESULT,{k.request,k.result,k.latest,k.used,k.owner},{f.result.id,cjson.encode(f.result),f.result.expiresAt})
end
local function create(f,owner)
 local k=f.keys
 return execute(CREATE_ORDER,{k.result,k.order},{owner or f.result.owner,started,f.order.id,cjson.encode(f.order)})
end
local function begin(f,time,owner,hash,payment,token)
 local k=f.keys
 return execute(BEGIN_CONFIRM,{k.result,k.order,payment or k.payment,k.latest,k.request,k.owner,pending},{owner or f.result.owner,hash or f.hash,'QA-SEALED-PAYMENT-'..f.result.id,time or started,token or f.token})
end
local function record(f,p,time,payment)
 local k=f.keys
 return execute(RECORD_PAYMENT,{k.result,k.order,payment or k.payment,pending,k.latest,k.request,k.owner,support,failures},{cjson.encode(p),time or started})
end
local function remove(f,time,owner)
 local k=f.keys
 return execute(DELETE_RESULT,{k.result,k.latest,k.owner,k.order,k.request},{owner or f.result.owner,time or started,'owner'})
end
local function release(f,token)
 return execute(RELEASE_CONFIRM,{f.keys.order},{token})
end
local function retry(f,time,code)
 return execute(RECONCILE_RETRY,{f.keys.order,pending,support,failures},{f.order.id,time,code or 'PAYMENT_PROVIDER',600000,'failure'})
end
local function pulse(time,processed,failed)
 return execute(RECONCILE_HEARTBEAT,{heartbeat,pending,support,failures},{time,processed,failed})
end
local function approved(f,approvedAt)
 return {paymentHash=f.hash,paymentCipher='QA-SEALED-PAYMENT-'..f.result.id,status='DONE',revoked=false,approvedAt=approvedAt,paidExpiresAt=approvedAt+7*DAY,retentionExpiresAt=fiveYears(approvedAt)}
end
local function main()
 -- Refuse a colliding prefix without deleting somebody else's QA keys.
 for _,key in ipairs(all) do if redis.call('EXISTS',key)~=0 then error('PREFIX_COLLISION',0) end end
 local acquired=redis.call('SET',guard,'QA-SMOKE','NX','EX',600)
 if not acquired then error('PREFIX_COLLISION',0) end
 owned=true
 check('save-idempotence-onefree',function()
  tag(save(A),'ok','first-save');eq(redis.call('GET',A.keys.used),'1','legacy-free-consumed')
  eq(redis.call('GET',A.keys.latest),A.result.id,'latest-saved');eq(redis.call('GET',A.keys.request),A.result.id,'request-saved')
  expiry(A.keys.result,A.result.expiresAt,'unpaid-result-24h');expiry(A.keys.request,A.result.expiresAt,'unpaid-request-24h');expiry(A.keys.latest,A.result.expiresAt,'unpaid-latest-24h');expiry(A.keys.owner,A.result.expiresAt,'unpaid-owner-24h')
  eq(redis.call('PTTL',A.keys.used),-1,'free-flag-not-expiring')
  local changed={id='qa-different',owner=A.result.owner,cipher='MUST-NOT-OVERWRITE'}
  local replay=execute(SAVE_RESULT,{A.keys.request,secondResult,A.keys.latest,A.keys.used,A.keys.owner},{'qa-different',cjson.encode(changed),A.result.expiresAt})
  tag(replay,'existing','save-replay');eq(replay[2],A.result.id,'original-result-id');eq(redis.call('EXISTS',secondResult),0,'replay-no-extra-content')
  local another=execute(SAVE_RESULT,{secondRequest,secondResult,A.keys.latest,A.keys.used,A.keys.owner},{'qa-second',cjson.encode(changed),A.result.expiresAt})
  tag(another,'used','one-free-only');eq(redis.call('EXISTS',secondRequest),0,'no-second-request')
  eq(decoded(A.keys.result).cipher,A.result.cipher,'original-cipher-preserved')
 end)
 check('create-owner-reuse-abandoned-30d',function()
  tag(create(A,'qa-wrong-owner'),'missing','create-wrong-owner')
  tag(create(A),'ok','create-first');expiry(A.keys.order,A.order.abandonedExpiresAt,'abandoned-ledger-30d')
  local other={id='qa-other-order',retentionExpiresAt=started+30*DAY}
  local reused=execute(CREATE_ORDER,{A.keys.result,A.keys.alternative},{A.result.owner,started,other.id,cjson.encode(other)})
  tag(reused,'existing','same-order-reused');eq(reused[2],A.order.id,'immutable-order-id');eq(redis.call('EXISTS',A.keys.alternative),0,'no-duplicate-order')
  eq(decoded(A.keys.result).orderId,A.order.id,'result-order-bound');eq(decoded(A.keys.order).amount,3000,'fixed-order-amount')
  tag(save(D),'ok','short-save');tag(create(D),'expired','late-create-rejected');eq(redis.call('EXISTS',D.keys.order),0,'no-expired-order')
 end)
 check('begin-owner-binding-fixed-seven-days',function()
  tag(begin(A,started,'qa-wrong-owner'),'missing','begin-wrong-owner');eq(redis.call('EXISTS',A.keys.payment),0,'wrong-owner-no-binding')
  tag(begin(A),'ok','begin-authenticated');local o=decoded(A.keys.order);local r=decoded(A.keys.result)
  eq(o.leaseUntil,started+7*DAY,'pending-seven-days');eq(o.startedAt,started,'start-fixed');eq(r.confirmationPending,true,'pending-visible')
  eq(o.retentionExpiresAt,fiveYears(started),'pending-financial-five-calendar-years')
  for _,key in ipairs({A.keys.result,A.keys.request,A.keys.latest,A.keys.owner}) do expiry(key,o.leaseUntil,'all-pending-pointers-seven-days') end
  expiry(A.keys.order,o.retentionExpiresAt,'pending-financial-finite');expiry(A.keys.payment,o.retentionExpiresAt,'pending-identity-same-retention')
  eq(redis.call('GET',A.keys.payment),A.order.id,'payment-bound-to-order');eq(tonumber(redis.call('ZSCORE',pending,A.order.id)),started,'queued-before-charge')
 end)
 check('begin-replay-lock-release-cross-result',function()
  tag(begin(A,started+1000),'busy','same-key-inflight-busy')
  tag(begin(A,started+1000,nil,'QA-DIFFERENT-HASH',otherPayment),'conflict','different-key-rejected');eq(redis.call('EXISTS',otherPayment),0,'no-wrong-key-index')
  tag(release(A,'qa-wrong-token'),'ok','wrong-release-no-error');eq(decoded(A.keys.order).lockUntil,started+30000,'wrong-release-preserves-lock')
  tag(release(A,A.token),'ok','correct-release');eq(decoded(A.keys.order).lockUntil,0,'correct-release-unlocks')
  expiry(A.keys.order,fiveYears(started),'release-does-not-remove-expiry')
  tag(begin(A,started+5000,nil,nil,nil,'QA-SECOND-LOCK'),'ok','same-payment-retry')
  eq(decoded(A.keys.order).leaseUntil,started+7*DAY,'retry-no-sliding-lease');expiry(A.keys.result,started+7*DAY,'retry-no-sliding-content')
  tag(save(B),'ok','save-second-owner');tag(create(B),'ok','create-second-owner')
  tag(begin(B,started+6000,nil,A.hash,A.keys.payment),'conflict','one-payment-one-result');eq(redis.call('EXISTS',B.keys.payment),0,'no-colliding-payment-created')
  tag(begin(B,started+6000),'ok','second-distinct-payment')
  tag(save(E),'ok','save-cutoff');tag(create(E),'ok','create-cutoff')
  tag(begin(E,E.result.unpaidExpiresAt-59000),'expired','begin-sixty-second-cutoff');eq(redis.call('EXISTS',E.keys.payment),0,'late-begin-no-binding')
 end)
 local paidAt=started+30000;local paid=approved(A,paidAt)
 check('record-approval-actual-seven-days-five-years',function()
  local wrong={paymentHash='QA-WRONG',paymentCipher='QA-SEALED',status='DONE',approvedAt=paidAt,paidExpiresAt=paidAt+7*DAY,retentionExpiresAt=fiveYears(paidAt)}
  tag(record(A,wrong,paidAt,otherPayment),'conflict','record-wrong-payment-rejected')
  tag(record(A,paid,paidAt),'ok','approval-recorded');local o=decoded(A.keys.order);local r=decoded(A.keys.result)
  eq(o.approvedAt,paidAt,'actual-approval-time');eq(o.paidExpiresAt,paidAt+7*DAY,'paid-content-from-approval');eq(o.retentionExpiresAt,fiveYears(paidAt),'financial-calendar-anniversary')
  eq(o.state,'paid','paid-state');eq(r.confirmationPending,false,'pending-cleared');eq(redis.call('ZSCORE',pending,A.order.id),false,'approved-removed-from-pending')
  for _,key in ipairs({A.keys.result,A.keys.request,A.keys.latest,A.keys.owner}) do expiry(key,paid.paidExpiresAt,'approved-pointers-seven-days') end
  expiry(A.keys.order,paid.retentionExpiresAt,'paid-ledger-five-calendar-years');expiry(A.keys.payment,paid.retentionExpiresAt,'paid-identity-five-calendar-years')
  assertThat(not string.find(redis.call('GET',A.keys.order),A.result.cipher,1,true),'ledger-has-no-result-content')
  eq(fiveYears(1709208000000),1866974400000,'leap-day-calendar-clamp')
 end)
 check('record-idempotence-no-sliding-deadlines',function()
  tag(record(A,paid,paidAt+3600000),'ok','record-replay')
  expiry(A.keys.result,paid.paidExpiresAt,'paid-replay-content-fixed');expiry(A.keys.order,paid.retentionExpiresAt,'paid-replay-financial-fixed')
  local changed=approved(A,paidAt+1000)
  tag(record(A,changed,paidAt+3600001),'conflict','approval-timestamp-immutable');eq(decoded(A.keys.order).approvedAt,paidAt,'original-approval-preserved')
 end)
 check('refund-terminal-stale-done-cannot-regrant',function()
  local refund=approved(A,paidAt);refund.status='PARTIAL_CANCELED';refund.revoked=true
  tag(record(A,refund,paidAt+10000),'ok','partial-refund-recorded');eq(decoded(A.keys.order).revoked,true,'refund-revoked')
  tag(record(A,paid,paidAt+11000),'ok','stale-paid-record-accepted-safely');local o=decoded(A.keys.order)
  eq(o.revoked,true,'stale-done-keeps-revocation');eq(o.state,'revoked','revoked-state-terminal')
  tag(begin(A,paidAt+12000),'revoked','refunded-cannot-reconfirm');expiry(A.keys.order,paid.retentionExpiresAt,'refund-ledger-no-sliding')
 end)
 check('delete-owner-paid-and-pending-protection',function()
  tag(remove(B,started+7000),'busy','pending-delete-blocked');eq(redis.call('EXISTS',B.keys.result),1,'pending-content-retained')
  tag(remove(A,paidAt+13000,'qa-intruder'),'missing','delete-wrong-owner')
  tag(remove(A,paidAt+13000),'ok','paid-delete-allowed')
  for _,key in ipairs({A.keys.result,A.keys.request,A.keys.latest}) do eq(redis.call('EXISTS',key),0,'content-pointer-deleted') end
  eq(redis.call('SISMEMBER',A.keys.owner,A.result.id),0,'owner-index-content-removed');eq(redis.call('GET',A.keys.used),'1','free-limit-retained')
  eq(decoded(A.keys.order).deleted,true,'financial-delete-tombstone');expiry(A.keys.order,paid.retentionExpiresAt,'delete-preserves-finite-ledger');expiry(A.keys.payment,paid.retentionExpiresAt,'delete-preserves-payment-identity')
  tag(remove(A,paidAt+14000),'ok','delete-idempotent')
 end)
 check('queue-bounded-claim-crash-reclaim',function()
  local first=execute(RECONCILE_CLAIM,{pending},{started+10000,1});eq(#first,1,'claim-bound-one');eq(first[1],B.order.id,'claim-existing-pending')
  eq(tonumber(redis.call('ZSCORE',pending,B.order.id)),started+130000,'claim-two-minute-lease')
  local second=execute(RECONCILE_CLAIM,{pending},{started+10000,1});eq(#second,0,'same-due-time-not-reclaimed')
  local later=execute(RECONCILE_CLAIM,{pending},{started+130001,1});eq(#later,1,'expired-worker-claim-recovered')
 end)
 check('retry-counters-safe-code-fixed-retention',function()
  tag(retry(B,started+140000),'ok','retry-recorded');local o=decoded(B.keys.order)
  eq(o.reconcileAttempts,1,'retry-counter');eq(o.lastReconcileCode,'PAYMENT_PROVIDER','safe-retry-code')
  eq(o.lastReconcileAt,started+140000,'retry-observation-time');eq(tonumber(redis.call('ZSCORE',pending,B.order.id)),started+740000,'retry-backoff')
  expiry(B.keys.order,B.order.pendingRetentionExpiresAt,'retry-financial-no-sliding');expiry(B.keys.result,started+6000+7*DAY,'retry-content-no-sliding')
 end)
 check('heartbeat-aggregates-success-failure',function()
  redis.call('ZADD',support,started-1,'qa-expired-support-member')
  local unhealthy=pulse(started+145000,0,0);local uh=cjson.decode(unhealthy[2]);eq(uh.outstandingFailures,1,'outstanding-failure-persists');eq(uh.failed,1,'empty-sweep-unhealthy')
  local still=cjson.decode(pulse(started+146000,0,0)[2]);eq(still.failed,1,'overlapping-empty-still-unhealthy');eq(still.lastSuccessAt,nil,'no-false-success')
  tag(record(B,{paymentHash=B.hash,paymentCipher='QA-SEALED',status='IN_PROGRESS',revoked=false},started+149000),'ok','provider-requery-clears-failure')
  eq(redis.call('ZSCORE',failures,B.order.id),false,'failure-cleared-after-verified-requery')
  local ok=pulse(started+150000,1,0);tag(ok,'ok','success-heartbeat');local h=cjson.decode(ok[2])
  eq(h.lastSuccessAt,started+150000,'success-time');eq(h.pending,1,'pending-count');eq(h.supportRequired,0,'expired-support-pruned')
  expiry(heartbeat,nowMs()+30*DAY,'heartbeat-thirty-day-ttl')
  local failed=pulse(started+151000,1,1);tag(failed,'ok','failure-heartbeat');h=cjson.decode(failed[2])
  eq(h.lastSuccessAt,started+150000,'failure-keeps-prior-success');eq(h.lastFailureAt,started+151000,'failure-time');eq(h.failed,1,'failure-count')
 end)
 check('pending-expiry-support-visible-delete-unblocks',function()
  local deadline=decoded(B.keys.order).leaseUntil
  tag(retry(B,deadline+1),'ok','expired-pending-escalation');local o=decoded(B.keys.order)
  eq(o.supportRequired,true,'support-required');eq(o.lastReconcileCode,'PENDING_CONTENT_EXPIRED','safe-expiry-code')
  assertThat(tonumber(redis.call('ZSCORE',pending,B.order.id))~=nil,'expired-support-still-monitored');eq(tonumber(redis.call('ZSCORE',support,B.order.id)),o.retentionExpiresAt,'support-retention-score')
  local h=cjson.decode(pulse(deadline+2,1,1)[2]);eq(h.supportRequired,1,'support-aggregate-visible')
  tag(remove(B,deadline+3),'ok','delete-after-processing-deadline');expiry(B.keys.order,B.order.pendingRetentionExpiresAt,'support-ledger-finite')
 end)
 check('failed-payment-thirty-day-retention-delete',function()
  tag(save(C),'ok','failed-save');tag(create(C),'ok','failed-order');tag(begin(C,started+20000),'ok','failed-begin')
  local p={paymentHash=C.hash,paymentCipher='QA-SEALED-FAILED',status='EXPIRED',revoked=false,unpaidTerminal=true}
  tag(record(C,p,started+40000),'ok','expired-provider-record');local o=decoded(C.keys.order)
  eq(o.terminalFailure,true,'failure-terminal');eq(o.retentionExpiresAt,C.order.abandonedExpiresAt,'failed-ledger-thirty-days')
  expiry(C.keys.order,C.order.abandonedExpiresAt,'failed-ledger-ttl');expiry(C.keys.payment,C.order.abandonedExpiresAt,'failed-identity-ttl');expiry(C.keys.result,C.result.unpaidExpiresAt,'failed-content-back-to-unpaid')
  eq(redis.call('ZSCORE',pending,C.order.id),false,'failed-removed-pending');tag(remove(C,started+41000),'ok','failed-unblocks-delete-before-seven-days')
 end)
 check('paid-missing-content-support-not-resurrection',function()
  tag(save(F),'ok','missing-content-save');tag(create(F),'ok','missing-content-order');tag(begin(F,started+25000),'ok','missing-content-begin')
  redis.call('DEL',F.keys.result)
  local p=approved(F,started+35000);tag(record(F,p,started+36000),'recorded','financial-proof-recorded-without-content')
  local o=decoded(F.keys.order);eq(o.supportRequired,true,'missing-content-support');eq(o.lastReconcileCode,'PAID_CONTENT_UNAVAILABLE','missing-content-safe-code')
  eq(redis.call('EXISTS',F.keys.result),0,'record-never-resurrects-missing-content');assertThat(tonumber(redis.call('ZSCORE',pending,F.order.id))~=nil,'paid-missing-keeps-monitoring')
  expiry(F.keys.order,p.retentionExpiresAt,'missing-content-financial-finite');expiry(F.keys.payment,p.retentionExpiresAt,'missing-content-identity-finite')
 end)

 check('support-unhealthy-empty-sweep-refund-resolution',function()
  local empty=cjson.decode(pulse(started+37000,0,0)[2]);assertThat(empty.failed>=1,'empty-support-unhealthy');assertThat(empty.supportRequired>=1,'support-count-persists')
  local refund=approved(F,started+35000);refund.status='CANCELED';refund.revoked=true
  tag(record(F,refund,started+38000),'recorded','confirmed-refund-resolves-missing-content')
  eq(redis.call('ZSCORE',support,F.order.id),false,'refunded-support-cleared');eq(redis.call('ZSCORE',pending,F.order.id),false,'refunded-monitoring-removed')
  local oldPending={paymentHash=B.hash,paymentCipher='QA-SEALED',status='EXPIRED',revoked=false,unpaidTerminal=true}
  tag(record(B,oldPending,started+39000),'recorded','deleted-unpaid-support-resolved')
  local healthy=cjson.decode(pulse(started+40000,0,0)[2]);eq(healthy.supportRequired,0,'resolved-support-not-permanent-block');eq(healthy.outstandingFailures,0,'resolved-failures-cleared');eq(healthy.failed,0,'healthy-after-resolution')
 end)
 check('verified-unpaid-replacement-late-old-confirm-blocked',function()
  tag(save(G),'ok','replace-save');tag(create(G),'ok','replace-create');tag(begin(G,started+41000),'ok','replace-begin')
  local fresh={id='qa-replacement-g',resultId=G.result.id,owner=G.result.owner,requestId=G.result.requestId,mode='test',mid=G.order.mid,amount=3000,currency='KRW',createdAt=started,abandonedExpiresAt=G.order.abandonedExpiresAt,pendingRetentionExpiresAt=G.order.pendingRetentionExpiresAt,retentionExpiresAt=G.order.abandonedExpiresAt,idempotencyKey='QA-NEW-IDEMPOTENCY'}
  local keys={G.keys.result,G.keys.order,G.keys.alternative,pending,support,failures}
  local args={G.result.owner,started+42000,G.order.id,fresh.id,cjson.encode(fresh)}
  tag(execute(REPLACE_ORDER,keys,args),'revoked','ambiguous-cannot-replace')
  local terminal={paymentHash=G.hash,paymentCipher='QA-SEALED',status='EXPIRED',revoked=false,unpaidTerminal=true}
  tag(record(G,terminal,started+42000),'ok','verified-terminal-unpaid')
  tag(execute(REPLACE_ORDER,keys,args),'busy','active-lock-cannot-replace');tag(release(G,G.token),'ok','release-old-confirm')
  tag(execute(REPLACE_ORDER,keys,args),'ok','atomic-terminal-replacement');local old=decoded(G.keys.order)
  eq(old.supersededBy,fresh.id,'old-ledger-tombstone');eq(decoded(G.keys.result).orderId,fresh.id,'new-order-bound');expiry(G.keys.order,G.order.abandonedExpiresAt,'old-ledger-retained-finite')
  tag(execute(REPLACE_ORDER,keys,args),'existing','replacement-replay-one-order')
  tag(begin(G,started+43000),'missing','old-begin-cannot-bind')
  tag(execute(CHECK_CONFIRM,{G.keys.result,G.keys.order},{G.result.owner,G.hash,G.token,started+43000}),'conflict','old-final-confirm-guard-rejects')
  tag(record(G,terminal,started+43000),'recorded','late-old-event-records-own-ledger-only');eq(decoded(G.keys.result).orderId,fresh.id,'late-old-event-cannot-rebind')
  local nextKeys={result=G.keys.result,order=G.keys.alternative,payment=replacementPayment,latest=G.keys.latest,request=G.keys.request,owner=G.keys.owner}
  local nextOrder={keys=nextKeys,result=G.result,order=fresh,hash='QA-NEW-HASH',token='QA-NEW-LOCK'}
  tag(begin(nextOrder,started+44000),'ok','replacement-new-identity-begin')
  tag(execute(CHECK_CONFIRM,{G.keys.result,G.keys.alternative},{G.result.owner,nextOrder.hash,nextOrder.token,started+45000}),'ok','new-active-confirm-guard')
 end)
end
local success,err=pcall(main)
local cleanup=true;local removed=0;local remaining=0
if owned then
 for _,key in ipairs(all) do
  -- all keys were registered before first mutation; never SCAN/KEYS a broad pattern.
  local result=redis.pcall('DEL',key)
  if type(result)=='number' then removed=removed+result else cleanup=false end
 end
 for _,key in ipairs(all) do
  local result=redis.pcall('EXISTS',key)
  if type(result)~='number' then cleanup=false else remaining=remaining+result end
 end
 if remaining~=0 then cleanup=false end
end
local answer={ok=success and cleanup,passed=#tests,total=16,assertions=assertions,tests=tests,cleanup=cleanup,removed=removed,remaining=remaining,registered=#all}
if not success then
 answer.failed_test=current
 -- Only bounded synthetic assertion labels or Redis command errors, never records/secrets.
 answer.error=string.sub(tostring(err),1,180)
end
if not owned then answer.cleanup_skipped='PREFIX_NOT_ACQUIRED' end
return cjson.encode(answer)
