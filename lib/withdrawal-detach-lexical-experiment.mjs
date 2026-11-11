/**
 * EXPERIMENT ONLY. Unintegrated synthetic single-record primitive.
 * Reviewed source: 61ed9f3258d002c87ea0671b3a181f414bf21cce.
 * No API/provider/live Redis integration, indexes, receipt producer, whole-SCAN,
 * finalization, worker/session issuers, or legacy/restore writer fences.
 * Experimental ownership schema: ownerAccountId, ownerIncarnation,
 * ownerNamespace, ownerOrigin, ownerProvider. ALL must explicitly exist.
 * Legacy accountId-only ownership NEVER adopts an incarnation.
 * Unknown fields, password, data, id, URL and expiry bytes remain unchanged.
 * Revision changes invalidate cooperative legacy revision-CAS writers only.
 * This does NOT stop an unfenced restore/import/writer restoring old bytes.
 * Complete stale-session/restore proof remains BLOCKED, not claimed.
 * Single-primary Redis only: record keys are NOT account-hash-slot keys.
 * Trusted verifier must authenticate an immutable REQUEST snapshot and return
 * exact verifiedRaw, tuple, operation, worker/session lineage and revision. After
 * withdrawal begins, an independently authorized server worker must continue
 * cleanup even if the initiating user logs out or its session expires. The
 * beginSession/beginBinding values bind lineage, NOT ongoing authorization.
 * A trusted operation-bound worker grant and its issuer are REQUIRED; a client
 * must never mint or substitute one. Verifier/issuers and Redis ACL are external.
 * Clients must have NO command/EVAL
 * access or state/worker write ACL. This factory is not an authentication API.
 * Redis scripts provide atomic isolation, NOT rollback. This script has ONE
 * write (SET XX KEEPTTL), no index/receipt writes. Adding multiwrites requires
 * preflight of every type/TTL/size/encoding; OOM/ACL/runtime/failover can still
 * leave partial effects. Network/timeout/OOM/ACL errors are uncertain: NO blind
 * retry, proof refresh or new operation. Reconcile exact old/new raw under the
 * SAME authority/operation externally. A detached response is NOT a receipt.
 * Redis TIME may be cached during EVAL, not wall-clock-at-commit proof.
 * Stale backup restoration needs durable epoch reconciliation before writers
 * restart. Single EVAL excludes interleaving ONLY while this script executes.
 */
import { randomBytes } from 'node:crypto';
import { rawObjectMembers, OWNER_RAW_LIMIT } from './guard.mjs';
import { ACTIVE_GUARD_LUA, accountKeys } from './withdrawal-redis.mjs';
export const DETACH_LIMIT=OWNER_RAW_LIMIT;
const ownerFields=Object.freeze({ownerAccountId:'accountId',ownerIncarnation:'incarnation',ownerNamespace:'namespace',ownerOrigin:'origin',ownerProvider:'provider'});
const opaque=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
function fail(code){throw Error(code);}
export function detachReplacement(raw,p){
 const {value:r,members,close}=rawObjectMembers(raw);
 if(!r||typeof r.id!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(r.id)||!r.data||Array.isArray(r.data)||typeof r.data!=='object'||!r.password||Array.isArray(r.password)||typeof r.password!=='object')fail('RECORD_UNSAFE');
 if(r.deleted!==undefined&&r.deleted!==false)fail('RECORD_UNSAFE');
 if(typeof r.revision!=='string'||!/^[a-f0-9]{32}$/.test(r.revision)||r.revision!==p.expectedRevision||typeof p.revision!=='string'||!/^[a-f0-9]{32}$/.test(p.revision)||p.revision===r.revision)fail('REVISION');
 for(const [key,name]of Object.entries(ownerFields)){if(!Object.hasOwn(r,key))fail('OWNERSHIP_MISSING');if(r[key]!==p[name])fail('OWNERSHIP_MISMATCH');}
 // Coordinates refer ONLY to the original raw. A non-final owner run consumes
 // its following comma; a final run consumes its preceding comma and ends at
 // the root close. Inter-member whitespace outside those ranges is untouched.
 // Lua uses the same contract, with inclusive 1-based rather than half-open
 // UTF-16 offsets. Neither implementation normalizes retained JSON lexemes.
 const entries=[...members].map(([key,span])=>({key,...span})),ranges=[];
 for(let i=0;i<entries.length;){
  if(!Object.hasOwn(ownerFields,entries[i].key)){i++;continue;}
  const start=i;while(i<entries.length&&Object.hasOwn(ownerFields,entries[i].key))i++;
  const final=i===entries.length;
  ranges.push([final&&start>0?entries[start-1].remove[1]-1:entries[start].start,final?close:entries[i-1].remove[1],'']);
 }
 const rev=members.get('revision');ranges.push([rev.first,rev.last,JSON.stringify(p.revision)]);
 ranges.sort((a,b)=>a[0]-b[0]);const parts=[];let cursor=0;
 for(const [a,b,text]of ranges){if(a<cursor||b<a)fail('RAW_UNSAFE');parts.push(raw.slice(cursor,a),text);cursor=b;}
 parts.push(raw.slice(cursor));const next=parts.join('');
 if(Buffer.byteLength(next)>DETACH_LIMIT)fail('RAW_UNSAFE');return next;
}
export const DETACH_LUA=ACTIVE_GUARD_LUA+String.raw`
-- Collect root members ONCE. cjson validates syntax before this scanner runs.
-- Native string.find skips strings, primitive bodies and whitespace in C;
-- Lua work scales with tokens/escapes, not every byte of a large plain string.
-- Redis cjson may accept NaN/Infinity/hex numbers that JSON.parse rejects.
-- Validate each non-string primitive independently without re-encoding values.
local function jsonPrimitive(token)
 if token=='true' or token=='false' or token=='null' then return true end
 local n=#token;local i=1
 if string.sub(token,i,i)=='-' then i=i+1 end
 local first=string.sub(token,i,i)
 if first=='0' then i=i+1
 elseif string.match(first,'^[1-9]$') then i=string.find(token,'[^0-9]',i+1) or n+1
 else return false end
 if string.sub(token,i,i)=='.' then
  i=i+1;if not string.match(string.sub(token,i,i),'^[0-9]$') then return false end
  i=string.find(token,'[^0-9]',i+1) or n+1
 end
 local exponent=string.sub(token,i,i)
 if exponent=='e' or exponent=='E' then
  i=i+1;local sign=string.sub(token,i,i);if sign=='+' or sign=='-' then i=i+1 end
  if not string.match(string.sub(token,i,i),'^[0-9]$') then return false end
  i=string.find(token,'[^0-9]',i+1) or n+1
 end
 return i==n+1
end
local function spans(raw)
 local n=#raw;local i=1;local m={};local ordered={};local previous=nil
 -- Defensive fail-closed budget. This is NOT a fallback for complex records.
 -- It limits interpreter work before any write; callers MUST surface and repair
 -- record-too-complex, never count it as a detached record or scan receipt.
 local steps=0;local function tick() steps=steps+1;return steps<=6000 end
 local function ws() i=string.find(raw,'[^ \t\r\n]',i) or n+1 end
 local function quoted(at)
  if string.sub(raw,at,at)~='"' then return nil end
  local j=at+1
  while j<=n do
   if not tick() then return nil,'budget' end;local hit=string.find(raw,'["\\]',j);if not hit then return nil end
   if string.sub(raw,hit,hit)=='"' then return hit end
   j=hit+2
  end
 end
 ws();if string.sub(raw,i,i)~='{' then return nil end;i=i+1
 while i<=n do
  if not tick() then return nil,'budget' end;ws();if string.sub(raw,i,i)=='}' then return m,ordered end
  local start=i;local lastkey,reason=quoted(i);if not lastkey then return nil,reason end
  local ok,key=pcall(cjson.decode,string.sub(raw,i,lastkey));if not ok or type(key)~='string' or m[key] then return nil end
  i=lastkey+1;ws();if string.sub(raw,i,i)~=':' then return nil end;i=i+1;ws()
  local first=i;local last=i-1;local depth=0
  while i<=n do
   if not tick() then return nil,'budget' end;ws();local c=string.sub(raw,i,i)
   if c=='"' then local stop,reason=quoted(i);if not stop then return nil,reason end;last=stop;i=stop+1
   elseif c=='{' or c=='[' then depth=depth+1;if depth>128 then return nil end;last=i;i=i+1
   elseif c=='}' or c==']' then if depth==0 then break end;depth=depth-1;last=i;i=i+1
   elseif c==',' then if depth==0 then break end;last=i;i=i+1
   elseif c==':' then if depth==0 then return nil end;last=i;i=i+1
   else
    local stop=string.find(raw,'[":{}%[%], \t\r\n]',i) or n+1
    if stop<=i or not jsonPrimitive(string.sub(raw,i,stop-1)) then return nil end
    last=stop-1;i=stop
   end
  end
  if last<first or depth~=0 then return nil end
  local comma=string.sub(raw,i,i)==','
  local x={key=key,start=start,first=first,last=last,comma=comma and i or nil,previous=previous,stop=i-1}
  m[key]=x;ordered[#ordered+1]=x
  if not comma then return m,ordered end;previous=i;i=i+1
 end
end
local owners={ownerAccountId=true,ownerIncarnation=true,ownerNamespace=true,ownerOrigin=true,ownerProvider=true}
local function replacement(raw,m,ordered,revision)
 local ranges={};local i=1
 while i<=#ordered do
  if not owners[ordered[i].key] then i=i+1
  else
   local first=i;while i<=#ordered and owners[ordered[i].key] do i=i+1 end
   local final=i>#ordered;local x=ordered[first];local y=ordered[i-1]
   ranges[#ranges+1]={a=final and (x.previous or x.start) or x.start,b=final and y.stop or y.comma,text=''}
  end
 end
 local rev=m.revision;if not rev then return nil end
 ranges[#ranges+1]={a=rev.first,b=rev.last,text='"'..revision..'"'}
 table.sort(ranges,function(a,b)return a.a<b.a end)
 local parts={};local cursor=1
 for _,x in ipairs(ranges) do
  if not x.a or not x.b or x.a<cursor or x.b<x.a then return nil end
  parts[#parts+1]=string.sub(raw,cursor,x.a-1);parts[#parts+1]=x.text;cursor=x.b+1
 end
 parts[#parts+1]=string.sub(raw,cursor);return table.concat(parts)
end
if #KEYS~=4 or #ARGV~=4 or #ARGV[1]>8192 then return result('invalid') end
for i=1,4 do for j=i+1,4 do if KEYS[i]==KEYS[j] then return result('invalid') end end end
local ok,p=pcall(cjson.decode,ARGV[1]);if not ok or type(p)~='table' or not validtuple(p) or not opaque(p.incarnation) or not opaque(p.operationId) or not opaque(p.binding) or not opaque(p.workerBinding) or not integer(p.fence) then return result('invalid') end
local verifiedRaw,expectedRaw,replacementRaw=ARGV[2],ARGV[3],ARGV[4]
if #verifiedRaw>1048576 or #expectedRaw>1048576 or #replacementRaw>1048576 or verifiedRaw~=expectedRaw then return result('proof-conflict') end
local s=authority(KEYS[1]);if not s then return result('authority-missing-or-corrupt') end
if s.state~='deleting' or not tuple(s,p) or s.incarnation~=p.incarnation or s.operationId~=p.operationId or s.fence~=p.fence then return result('barrier') end
if KEYS[2]~=s.beginSession or p.binding~=s.beginBinding or KEYS[3]~=s.base..':worker' then return result('session') end
-- beginSession/beginBinding identify the already-authorized operation. They
-- are not a live session requirement: logout must not strand deletion cleanup.
-- Only an independently issued, trusted server-side worker grant authorizes it.
local w=read(KEYS[3]);local function worker()
 return w and w.kind=='cleanup-worker' and tuple(w,s) and w.incarnation==s.incarnation and w.operationId==s.operationId and w.fence==s.fence and w.binding==p.workerBinding and w.beginSession==s.beginSession and w.beginBinding==s.beginBinding and integer(w.expiresAt) and w.expiresAt>nowms() and redis.call('PTTL',KEYS[3])>0
end
if not worker() then return result('worker-authority') end
if not typeis(KEYS[4],'string') then return result('record-missing-or-type') end
local ttl=redis.call('PTTL',KEYS[4]);if ttl~=-1 and ttl<=0 then return result('record-expired') end
local raw=redis.call('GET',KEYS[4]);if not raw or #raw>1048576 or raw~=expectedRaw then return result('conflict') end
-- Conservative lexical pre-scan: count structural characters and quote/escape
-- handling events, not punctuation inside a string. This is NOT a JSON parser.
-- The event limit bounds Lua iterations; cjson still validates syntax afterward.
-- Escape-heavy or structurally complex valid records may still fail closed and
-- MUST NOT be skipped or counted as complete. This is NOT a time/memory limit.
local scanAt=1;local scanBudget=0
local function scanTick() scanBudget=scanBudget+1;return scanBudget<=4096 end
while scanAt<=#raw do
 local hit=string.find(raw,'[{}%[%]":,\\]',scanAt)
 if not hit then break end
 if not scanTick() then return result('record-too-complex') end
 if string.sub(raw,hit,hit)=='"' then
  scanAt=hit+1
  while true do
   local nextHit=string.find(raw,'["\\]',scanAt)
   if not nextHit then return result('record-unsafe') end
   if not scanTick() then return result('record-too-complex') end
   if string.sub(raw,nextHit,nextHit)=='"' then scanAt=nextHit+1;break end
   scanAt=nextHit+2
  end
 else scanAt=hit+1 end
end
local decoded,r=pcall(cjson.decode,raw);if not decoded or type(r)~='table' then return result('record-unsafe') end
local scanOk,rootSpans,ordered=pcall(spans,raw)
if not scanOk then return result('record-unsafe') end
if not rootSpans then if ordered=='budget' then return result('record-too-complex') else return result('record-unsafe') end end
if r.deleted~=nil and r.deleted~=false then return result('record-deleted') end
-- Redis cjson decodes both arrays and objects as Lua tables; require the raw
-- JSON tokens for data/password to be objects, matching the trusted adapter.
if type(r.id)~='string' or #r.id~=22 or not string.match(r.id,'^[%w_-]+$') or KEYS[4]~=p.namespace..':record:'..r.id or type(r.data)~='table' or type(r.password)~='table' or not rootSpans.data or string.sub(raw,rootSpans.data.first,rootSpans.data.first)~='{' or not rootSpans.password or string.sub(raw,rootSpans.password.first,rootSpans.password.first)~='{' then return result('record-unsafe') end
if r.expiresAt~=nil and r.expiresAt~=cjson.null and (not integer(r.expiresAt) or r.expiresAt<=nowms()) then return result('record-expired') end
local fields={'ownerAccountId','ownerIncarnation','ownerNamespace','ownerOrigin','ownerProvider'}
local names={'accountId','incarnation','namespace','origin','provider'}
for i,key in ipairs(fields) do if r[key]==nil or r[key]==cjson.null then return result('ownership-missing') end;if r[key]~=p[names[i]] then return result('ownership-mismatch') end end
if type(r.revision)~='string' or #r.revision~=32 or not string.match(r.revision,'^[a-f0-9]+$') or r.revision~=p.expectedRevision or type(p.revision)~='string' or #p.revision~=32 or not string.match(p.revision,'^[a-f0-9]+$') or p.revision==r.revision then return result('revision') end
local changed=replacement(raw,rootSpans,ordered,p.revision);if not changed then return result('record-unsafe') end
if changed~=replacementRaw then return result('replacement-mismatch') end
local good,changedValue=pcall(cjson.decode,changed);if not good or type(changedValue)~='table' then return result('record-unsafe') end
local answer=result('detached',{revision=p.revision,receipt=false})
if not worker() then return result('expired') end
local finalttl=redis.call('PTTL',KEYS[4]);if finalttl~=-1 and finalttl<=0 then return result('record-expired') end
local wrote=redis.call('SET',KEYS[4],changed,'XX','KEEPTTL');if not wrote then return result('conflict') end
return answer
`;
/** Trusted server only. Verifier is NOT implemented here and must NOT trust clients. */
export function createDetachAdapter({command,verifyRequestSnapshot}){
 if(typeof command!=='function'||typeof verifyRequestSnapshot!=='function')fail('ADAPTER_REQUIRED');
 return async function detach(request){
  const supplied=await verifyRequestSnapshot(request);
  const p=JSON.parse(JSON.stringify(supplied));
  if(!p||Object.hasOwn(p,'replacementRaw')||Object.hasOwn(p,'expectedRaw'))fail('UNTRUSTED_REPLACEMENT');
  const k=accountKeys(p);
  if(!opaque(p.incarnation)||!opaque(p.operationId)||!opaque(p.binding)||!opaque(p.workerBinding)||!Number.isSafeInteger(p.fence)||p.fence<2||typeof p.sessionKey!=='string'||!p.sessionKey.startsWith(k.base+':session:')||typeof p.verifiedRaw!=='string')fail('PROOF');
  const record=rawObjectMembers(p.verifiedRaw).value;
  if(p.recordKey!==p.namespace+':record:'+record.id)fail('RECORD_KEY');
  const expectedRaw=await command(['GET',p.recordKey]);
  if(expectedRaw!==p.verifiedRaw)return {status:'conflict'};
  const revision=randomBytes(16).toString('hex');
  const replacementRaw=detachReplacement(p.verifiedRaw,{...p,revision});
  const wire=JSON.stringify({accountId:p.accountId,namespace:p.namespace,origin:p.origin,provider:p.provider,incarnation:p.incarnation,operationId:p.operationId,fence:p.fence,binding:p.binding,workerBinding:p.workerBinding,expectedRevision:p.expectedRevision,revision});
  try {const reply=await command(['EVAL',DETACH_LUA,'4',k.state,p.sessionKey,k.worker,p.recordKey,wire,p.verifiedRaw,expectedRaw,replacementRaw]);return JSON.parse(reply);}
  catch {return {status:'indeterminate',retry:false,operationId:p.operationId,revision,reason:'Reconcile same operation and exact old/new raw; no blind retry.'};}
 };
}
