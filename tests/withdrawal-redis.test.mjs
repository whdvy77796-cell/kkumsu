// REAL Redis Lua test, opt-in LOCAL disposable Redis only. No production config.
// WITHDRAWAL_TEST_REDIS_PORT=16379 WITHDRAWAL_TEST_REDIS_ACK=synthetic-only
// node --test tests/withdrawal-redis.test.mjs
// Never FLUSHDB. Keys use a unique synthetic account; cleanup only created keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {accountKeys,newIncarnation,newOperationId,CHECK_LUA,BEGIN_LUA,PROVISION_LUA,CHECKPOINT_LUA,FINALIZE_LUA,ACTIVE_GUARD_LUA} from '../lib/withdrawal-redis.mjs';
const enabled=process.env.WITHDRAWAL_TEST_REDIS_ACK==='synthetic-only';
const port=Number(process.env.WITHDRAWAL_TEST_REDIS_PORT);
function parse(b,at=0){
 const end=b.indexOf('\r\n',at);if(end<0)return null;const type=String.fromCharCode(b[at]),text=b.subarray(at+1,end).toString(),pos=end+2;
 if(type==='+')return {value:text,end:pos};if(type==='-')return {error:Error(text),end:pos};if(type===':')return {value:Number(text),end:pos};
 if(type==='$'){const n=Number(text);if(n===-1)return {value:null,end:pos};if(b.length<pos+n+2)return null;return {value:b.subarray(pos,pos+n).toString(),end:pos+n+2};}
 if(type==='*'){const count=Number(text);if(count===-1)return {value:null,end:pos};let next=pos;const value=[];for(let i=0;i<count;i++){const r=parse(b,next);if(!r)return null;if(r.error)return r;value.push(r.value);next=r.end;}return {value,end:next};}throw Error('RESP');
}
function cmd(...args){return new Promise((resolve,reject)=>{
 const socket=net.connect({host:'127.0.0.1',port});let data=Buffer.alloc(0),done=false;const finish=(e,v)=>{if(done)return;done=true;socket.destroy();e?reject(e):resolve(v);};
 socket.setTimeout(5000,()=>finish(Error('local Redis timeout')));socket.on('error',finish);socket.on('data',b=>{data=Buffer.concat([data,b]);try{const r=parse(data);if(r)finish(r.error,r.value);}catch(e){finish(e);}});
 socket.on('connect',()=>socket.write('*'+args.length+'\r\n'+args.map(v=>{const s=String(v);return '$'+Buffer.byteLength(s)+'\r\n'+s+'\r\n';}).join('')));
 });}
test('real Redis synthetic Lua primitives (not integrated service)',{skip:!enabled},async t=>{
 assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535,'explicit disposable loopback port required');
 const run=newOperationId(),tuple={accountId:'oa_'+newIncarnation(),provider:'google',origin:'https://synthetic.invalid',namespace:'synthetic:withdrawal:'+run};
 const k=accountKeys(tuple),sessionKey=k.session(newIncarnation()),probe=k.base+':callback-probe',manifest=k.base+':manifest',index=k.base+':index';
 const keys=[k.state,k.permit,k.worker,k.receipt,sessionKey,probe,manifest,index];
 const inc=newIncarnation(),binding=newIncarnation(),op=newOperationId();
 const p={...tuple,incarnation:inc,fence:1,binding,operationId:op};
 const time=async()=>{const [s,u]=await cmd('TIME');return Number(s)*1000+Math.floor(Number(u)/1000);};
 const ev=async(lua,ks,body=p)=>JSON.parse(await cmd('EVAL',lua,ks.length,...ks,JSON.stringify(body)));
 const put=async(key,v,ttl)=>cmd('SET',key,JSON.stringify(v),...(ttl?['PX',ttl]:[]));
 const seed=async()=>{await cmd('DEL',...keys);const now=await time();await put(k.state,{v:1,base:k.base,...tuple,incarnation:inc,fence:1,state:'active'});await put(sessionKey,{...p,issuedAt:now-10,expiresAt:now+60000},60000);};
 const begin=()=>ev(BEGIN_LUA,[k.state,sessionKey]);
 try{
 await t.test('first enrollment requires independent permit; key loss cannot self-enroll',async()=>{
  await cmd('DEL',...keys);assert.equal((await ev(PROVISION_LUA,[k.state,k.permit])).status,'enrollment-authority');const now=await time();await put(k.permit,{v:1,kind:'verified-first-enrollment',base:k.base,...tuple,incarnation:inc,issuedAt:now,expiresAt:now+60000},60000);assert.equal((await ev(PROVISION_LUA,[k.state,k.permit])).status,'active');assert.equal(await cmd('EXISTS',k.permit),0);await cmd('DEL',k.state);assert.equal((await ev(PROVISION_LUA,[k.state,k.permit])).status,'enrollment-authority');
 });
 await t.test('session expiry at actual EVAL ignores stale request clock and positive TTL',async()=>{
  await seed();assert.equal((await ev(CHECK_LUA,[k.state,sessionKey])).status,'active');const now=await time();await put(sessionKey,{...p,issuedAt:now-1000,expiresAt:now-1},60000);assert.equal((await ev(BEGIN_LUA,[k.state,sessionKey],{...p,now:1})).status,'session');assert.equal(JSON.parse(await cmd('GET',k.state)).state,'active');
 });
 await t.test('session key deleted for logout fails closed',async()=>{await seed();await cmd('DEL',sessionKey);assert.equal((await begin()).status,'session');});
 await t.test('begin retries idempotent; another operation is busy; own-account fence only',async()=>{
  await seed();const first=await begin(),again=await begin();assert.equal(first.status,'deleting');assert.equal(first.fence,2);assert.equal(again.replay,true);assert.equal((await ev(BEGIN_LUA,[k.state,sessionKey],{...p,operationId:newOperationId()})).status,'busy');assert.equal((await ev(CHECK_LUA,[k.state,sessionKey])).status,'barrier');
 });
 await t.test('retry expiry does not reset deletion or issue a fresh operation',async()=>{
  await seed();await begin();const s=JSON.parse(await cmd('GET',k.state));s.retryUntil=(await time())-1;await put(k.state,s);assert.equal((await begin()).status,'retry-expired');assert.equal(JSON.parse(await cmd('GET',k.state)).state,'deleting');
 });
 await t.test('stale sessions and callbacks after synthetic re-enrollment cannot inherit owner',async()=>{
  await seed();const s=JSON.parse(await cmd('GET',k.state));s.incarnation=newIncarnation();await put(k.state,s);assert.equal((await begin()).status,'session');assert.equal((await ev(CHECK_LUA,[k.state,sessionKey])).status,'session');
 });
 await t.test('concurrent begin and synthetic callback gate serialize, then callback is barred',async()=>{
  await seed();const callback=ACTIVE_GUARD_LUA+"\nlocal p=request();if not p then return result('invalid') end;local s,e=active(KEYS[1],KEYS[2],p);if not s then return result(e) end;redis.call('SET',KEYS[3],'synthetic');return result('issued')";
  const [b,c]=await Promise.all([begin(),ev(callback,[k.state,sessionKey,probe])]);assert.equal(b.status,'deleting');assert.ok(['issued','barrier'].includes(c.status));assert.equal((await ev(callback,[k.state,sessionKey,probe])).status,'barrier');
 });
 await t.test('authority key loss and wrong types cannot authorize writes',async()=>{
  await seed();await cmd('DEL',k.state);assert.equal((await begin()).status,'authority-missing-or-corrupt');await cmd('LPUSH',k.state,'bad');assert.equal((await begin()).status,'authority-missing-or-corrupt');await seed();await cmd('DEL',sessionKey);await cmd('LPUSH',sessionKey,'bad');assert.equal((await begin()).status,'session');
 });
 await t.test('corrupt/oversized/expiring authority fails closed before any write',async()=>{
  for(const bad of ['{bad','x'.repeat(9000),'[]']){await seed();await cmd('SET',k.state,bad);assert.equal((await begin()).status,'authority-missing-or-corrupt');assert.equal(await cmd('GET',k.state),bad);}
  await seed();await cmd('PEXPIRE',k.state,60000);assert.equal((await begin()).status,'authority-missing-or-corrupt');
 });
 await t.test('provider unlink pending and missing/corrupt manifest/index never complete',async()=>{
  await seed();await begin();for(const v of [null,'{bad','{"complete":true}']){if(v===null)await cmd('DEL',manifest,index);else{await cmd('SET',manifest,v);await cmd('SET',index,v);}assert.equal((await ev(FINALIZE_LUA,[k.state],{...p,fence:2,cleanup:'complete',providerUnlink:'complete'})).status,'blocked');}
  const s=JSON.parse(await cmd('GET',k.state));assert.equal(s.providerUnlink,'pending');assert.equal(s.cleanup,'blocked');assert.equal(s.state,'deleting');
 });
 await t.test('checkpoint requires worker authority and attested page, not a plan',async()=>{
  await seed();await begin();const workerBinding=newIncarnation(),receiptId=newOperationId(),wp={...p,fence:2,workerBinding,receiptId};assert.equal((await ev(CHECKPOINT_LUA,[k.state,k.worker,k.receipt],wp)).status,'worker-authority');const now=await time();await put(k.worker,{kind:'cleanup-worker',...wp,binding:workerBinding,expiresAt:now+60000},60000);assert.equal((await ev(CHECKPOINT_LUA,[k.state,k.worker,k.receipt],wp)).status,'unattested-page');await cmd('LPUSH',k.receipt,'bad');assert.equal((await ev(CHECKPOINT_LUA,[k.state,k.worker,k.receipt],wp)).status,'unattested-page');await cmd('DEL',k.receipt);
  const receipt={kind:'page-applied',...wp,from:'0',next:'9007199254740993',page:1,expiresAt:now+60000};await put(k.receipt,receipt,60000);const r=await ev(CHECKPOINT_LUA,[k.state,k.worker,k.receipt],wp);assert.equal(r.cursor,'9007199254740993');assert.equal(r.page,1);assert.equal((await ev(CHECKPOINT_LUA,[k.state,k.worker,k.receipt],wp)).replay,true);assert.equal((await ev(FINALIZE_LUA,[k.state],wp)).status,'blocked');
  receipt.receiptId=newOperationId();receipt.next=0;await put(k.receipt,receipt,60000);assert.equal((await ev(CHECKPOINT_LUA,[k.state,k.worker,k.receipt],{...wp,receiptId:receipt.receiptId})).status,'unattested-page');
 });
 await t.test('deleted tombstone cannot be re-enrolled or used by old session',async()=>{
  await seed();const s=JSON.parse(await cmd('GET',k.state));s.state='deleted';await put(k.state,s);assert.equal((await begin()).status,'barrier');assert.equal((await ev(PROVISION_LUA,[k.state,k.permit])).status,'existing-authority');
 });
 }finally{await cmd('DEL',...keys);}
});
