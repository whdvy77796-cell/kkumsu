// EXPERIMENT ONLY. Emits one EVAL command for a disposable/synthetic namespace.
// Does not connect to Redis. Never run on real account or store keys.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { accountKeys, newIncarnation, newOperationId, CHECK_LUA, PROVISION_LUA, BEGIN_LUA, CHECKPOINT_LUA, FINALIZE_LUA } from '../lib/withdrawal-redis.mjs';
const opaque = () => randomBytes(32).toString('base64url');
const suffix = randomBytes(12).toString('hex');
const tuple = { accountId: 'oa_' + opaque(), provider: 'naver', origin: 'https://synthetic.invalid', namespace: 'yb:qa:withdrawal:' + suffix };
const keys = accountKeys(tuple), inc = newIncarnation(), binding = opaque(), operation = newOperationId(), workerBinding = opaque(), receiptId = opaque();
const session = keys.session(opaque());
const badKey = accountKeys({ ...tuple, accountId: 'oa_' + opaque() }).state;
const edgeTuple = { ...tuple, accountId: 'oa_' + opaque() }, edgeKeys = accountKeys(edgeTuple), edgeSession = edgeKeys.session(opaque()), edgeBinding = opaque(), edgeInc = newIncarnation(), edgeOperation = newOperationId();
const lit = s => { const b = [...Buffer.from(String(s), 'utf8')], parts = []; for (let i=0; i<b.length; i+=40) parts.push('string.char('+b.slice(i,i+40).join(',')+')'); return parts.length ? parts.join('..') : "''"; };
const pjson = lit(JSON.stringify({ ...tuple, incarnation: inc, fence: 1, binding, operationId: operation }));
const edgeP = lit(JSON.stringify({ ...edgeTuple, incarnation: edgeInc, fence: 999999999999, binding: edgeBinding, operationId: edgeOperation }));
const source = `
local realRedis=redis
local function provisionFail(KEYS,ARGV)
 local redis={call=function(cmd,...) local args={...}; if cmd=='SET' and args[1]==KEYS[1] then error('synthetic-set-failure') end; return realRedis.call(cmd,unpack(args)) end}
 ${PROVISION_LUA}
end
local function provision(KEYS,ARGV) ${PROVISION_LUA} end
local function checkActive(KEYS,ARGV) ${CHECK_LUA} end
local function begin(KEYS,ARGV) ${BEGIN_LUA} end
local function checkpoint(KEYS,ARGV) ${CHECKPOINT_LUA} end
local function finalize(KEYS,ARGV) ${FINALIZE_LUA} end
local state=${lit(keys.state)}
local permit=${lit(keys.permit)}
local worker=${lit(keys.worker)}
local receipt=${lit(keys.receipt)}
local sess=${lit(session)}
local badState=${lit(badKey)}
local edgeState=${lit(edgeKeys.state)}
local edgeSess=${lit(edgeSession)}
local edgeBase=${lit(edgeKeys.base)}
local ep=cjson.decode(${edgeP})
local base=${lit(keys.base)}
local workerBinding=${lit(workerBinding)}
local receiptId=${lit(receiptId)}
local p=cjson.decode(${pjson})
local k={state,permit,worker,receipt,sess,badState,edgeState,edgeSess}
local completed={}
local function c(v,name) if not v then error(name) end end
local function run(fn,keys,payload) return cjson.decode(fn(keys,{cjson.encode(payload)})) end
local function clock() local t=redis.call('TIME');return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000) end
if redis.call('EXISTS',unpack(k))~=0 then return cjson.encode({status='blocked-existing-key'}) end
local ok,err=pcall(function()
 local noState=run(checkActive,{state,sess},p);c(noState.status=='authority-missing-or-corrupt','missing-authority');table.insert(completed,'missing-authority')
 local noPermit=run(provision,{state,permit},p);c(noPermit.status=='enrollment-authority','missing-permit');table.insert(completed,'missing-permit')
 local now=clock()
 local permitBody={v=1,kind='verified-first-enrollment',accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,base=base,issuedAt=now-1000,expiresAt=now+120000}
 redis.call('SET',permit,cjson.encode(permitBody),'PX',120000)
 local faultOk=pcall(function()run(provisionFail,{state,permit},p)end)
 c(not faultOk and redis.call('EXISTS',state,permit)==0,'set-failure-permit-consumed');table.insert(completed,'set-failure-fails-closed')
 -- Reset synthetic fixture only; real permit issuance is deliberately unimplemented.
 redis.call('SET',permit,cjson.encode(permitBody),'PX',120000)
 local create=run(provision,{state,permit},p);c(create.status=='active' and redis.call('PTTL',state)==-1 and redis.call('EXISTS',permit)==0,'provision');table.insert(completed,'permitted-provision')
 local sessionBody={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,binding=p.binding,issuedAt=now-1000,expiresAt=now+120000}
 redis.call('SET',sess,cjson.encode(sessionBody),'PX',120000)
 local pass=run(checkActive,{state,sess},p);c(pass.status=='active' and pass.fence==1,'active-session');table.insert(completed,'active-session')
 local expiredBody={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,binding=p.binding,issuedAt=now-2000,expiresAt=now-1}
 redis.call('SET',sess,cjson.encode(expiredBody),'PX',120000)
 local before=redis.call('GET',state)
 local ex=run(begin,{state,sess},p);c(ex.status=='session' and redis.call('GET',state)==before,'expired-session');table.insert(completed,'expired-at-execution')
 redis.call('SET',sess,cjson.encode(sessionBody),'PX',120000)
 local started=run(begin,{state,sess},p);c(started.status=='deleting' and started.fence==2 and started.replay==false,'begin');table.insert(completed,'begin-barrier')
 local denied=run(checkActive,{state,sess},p);c(denied.status=='barrier','old-session');table.insert(completed,'old-session-denied')
 local replay=run(begin,{state,sess},p);c(replay.status=='deleting' and replay.replay==true and replay.fence==2,'replay');table.insert(completed,'same-operation-replay')
 local p2={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=2,operationId=p.operationId,workerBinding=workerBinding,receiptId=receiptId}
 local noWorker=run(checkpoint,{state,worker,receipt},p2);c(noWorker.status=='worker-authority','no-worker');table.insert(completed,'missing-worker-denied')
 local wb={kind='cleanup-worker',accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=2,operationId=p.operationId,binding=workerBinding,expiresAt=now+120000}
 local rb={kind='page-applied',accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=2,operationId=p.operationId,receiptId=receiptId,from='0',next='9007199254740993',page=1,expiresAt=now+120000}
 redis.call('SET',worker,cjson.encode(wb),'PX',120000);redis.call('SET',receipt,cjson.encode(rb),'PX',120000)
 local staged=run(checkpoint,{state,worker,receipt},p2);c(staged.status=='deleting' and staged.cursor=='9007199254740993' and staged.cleanup=='blocked','checkpoint');table.insert(completed,'synthetic-receipt-only')
 local again=run(checkpoint,{state,worker,receipt},p2);c(again.status=='deleting' and again.replay==true,'receipt-replay');table.insert(completed,'receipt-replay')
 local noFinish=run(finalize,{state},p2);c(noFinish.status=='blocked','no-finalize');table.insert(completed,'finalize-stays-blocked')
 local edgeAuthority={v=1,base=edgeBase,accountId=ep.accountId,provider=ep.provider,origin=ep.origin,namespace=ep.namespace,incarnation=ep.incarnation,fence=ep.fence,state='active'}
 local edgeBody={accountId=ep.accountId,provider=ep.provider,origin=ep.origin,namespace=ep.namespace,incarnation=ep.incarnation,fence=ep.fence,binding=ep.binding,issuedAt=now-1000,expiresAt=now+120000}
 redis.call('SET',edgeState,cjson.encode(edgeAuthority));redis.call('SET',edgeSess,cjson.encode(edgeBody),'PX',120000)
 local edgeStart=run(begin,{edgeState,edgeSess},ep);c(edgeStart.status=='deleting' and edgeStart.fence==1000000000000,'high-fence-increment')
 local edgeBlock=run(checkActive,{edgeState,edgeSess},ep);c(edgeBlock.status=='barrier','high-fence-authority-valid');table.insert(completed,'high-fence-roundtrip')
 edgeAuthority.fence=1000000000000;edgeBody.fence=1000000000000;ep.fence=1000000000000
 redis.call('SET',edgeState,cjson.encode(edgeAuthority));redis.call('SET',edgeSess,cjson.encode(edgeBody),'PX',120000)
 local edgeRaw=redis.call('GET',edgeState);local exhausted=run(begin,{edgeState,edgeSess},ep)
 c(exhausted.status=='fence-exhausted' and redis.call('GET',edgeState)==edgeRaw,'fence-exhausted');table.insert(completed,'max-fence-fails-closed')
 redis.call('SET',badState,'not-json','PX',120000)
 local bad=run(checkActive,{badState,sess},p);c(bad.status=='authority-missing-or-corrupt','bad-authority');table.insert(completed,'corrupt-authority-denied')
 redis.call('DEL',badState);redis.call('LPUSH',badState,'x');redis.call('PEXPIRE',badState,120000)
 local wrong=run(checkActive,{badState,sess},p);c(wrong.status=='authority-missing-or-corrupt','wrongtype');table.insert(completed,'wrongtype-denied')
end)
local removed=redis.call('DEL',unpack(k))
local left=redis.call('EXISTS',unpack(k))
return cjson.encode({status=ok and 'ok' or 'failed',error=ok and cjson.null or tostring(err),completed=completed,removed=removed,left=left})
`;
function minify(s){let i=0,out='';const white=/\s/;while(i<s.length){let c=s[i];if(white.test(c)){while(i<s.length&&white.test(s[i]))i++;out+='--[[]]';continue}if(c==="'"||c==='"'){let q=c;out+=c;i++;while(i<s.length){c=s[i++];out+=c;if(c==='\\'&&i<s.length){out+=s[i++];continue}if(c===q)break}continue}if(s.startsWith('--',i)){const m=s.slice(i+2).match(/^\[(=*)\[/);if(m){const end=']'+m[1]+']';const j=s.indexOf(end,i+2+m[0].length);if(j<0)throw Error('comment');i=j+end.length}else{const j=s.indexOf('\n',i);i=j<0?s.length:j}out+='--[[]]';continue}const lm=c==='['&&s.slice(i).match(/^\[(=*)\[/);if(lm){const end=']'+lm[1]+']';const j=s.indexOf(end,i+lm[0].length);if(j<0)throw Error('longstring');out+=s.slice(i,j+end.length);i=j+end.length;continue}out+=c;i++}return out}
const compact=minify(source);
if(/\s/.test(compact)||/redis\.call\s*\(\s*['"](?:FLUSH|SCAN|KEYS)/i.test(source)||!tuple.namespace.startsWith('yb:qa:withdrawal:'))throw Error('unsafe harness');
await writeFile(new URL('./withdrawal-synth-redis-v2.txt',import.meta.url),'EVAL '+compact+' 0','utf8');
console.log(JSON.stringify({syntheticKeys:kCount(),scriptLength:compact.length,checks:17}));
function kCount(){return 8;}
