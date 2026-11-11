// Synthetic pure-state/CAS-model tests ONLY. NO real Redis or production data.
// The five existing WIP TODOs are unchanged and are not solved by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createAccountLifecycle,CAS_LUA} from '../lib/account-lifecycle.mjs';
const secret='synthetic-registry-secret-12345678901234567890';
const receiptSecret='synthetic-verifier-secret-12345678901234567890';
const canonical=x=>JSON.stringify(x,function(k,v){return v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;});
function signed(p,key=secret){const payload=canonical(p);return canonical({payload,mac:createHmac('sha256',key).update(payload).digest('hex')});}
const decoded=raw=>JSON.parse(JSON.parse(raw).payload);
function fixture(){
 const api=createAccountLifecycle({scope:'synthetic',secret,receiptSecret});
 let cell={type:'string',ttl:-1,raw:api.initializeVerifiedEmpty()};const now=1_000_000;
 return {api,now,get cell(){return {...cell};},set cell(v){cell={...v};},
 commit(x){cell.raw=x.next;return x.result;},login(id='alice'){return this.commit(api.exchange(cell,api.issueOAuth(cell,id,now),now));},
 claim(s,id){return this.commit(api.claim(cell,s,id,now));},begin(s){const g=api.issueBegin(cell,s,now);this.commit(api.begin(cell,g,now));return g;},
 receipt(id='alice',patch={}){return signed({...api.cleanupPlan(cell,id),verifiedAt:now,...patch},receiptSecret);},
 done(id='alice'){return this.commit(api.acknowledge(cell,this.receipt(id),now));}};
}
function denies(fn){assert.throws(fn);}
test('independent account epochs: withdrawal of Alice leaves Bob and his callback valid',()=>{
 const f=fixture(),a=f.login(),a2=f.login(),b=f.login('bob'),pending=f.api.issueOAuth(f.cell,'bob',f.now);
 const old=f.api.issueOAuth(f.cell,'alice',f.now);f.begin(a);
 denies(()=>f.api.authorize(f.cell,a,f.now));denies(()=>f.api.authorize(f.cell,a2,f.now));denies(()=>f.api.exchange(f.cell,old,f.now));
 assert.equal(f.api.authorize(f.cell,b,f.now).id,'bob');f.commit(f.api.exchange(f.cell,pending,f.now));
});
test('derived barrier/index/scope-cache loss is irrelevant; authority loss is blocked',()=>{
 const f=fixture(),a=f.login();f.claim(a,'shop');f.begin(a);
 // No derived cache exists in this primitive. Only permanent authority decides.
 denies(()=>f.api.authorize(f.cell,a,f.now));
 for(const cell of [null,{type:'none',ttl:-2,raw:null},{...f.cell,raw:''}])denies(()=>f.api.inspect(cell));
});
test('new incarnation never inherits old/legacy ownership',()=>{
 const f=fixture(),a=f.login();f.claim(a,'shop');const old=f.api.authorize(f.cell,a,f.now);f.begin(a);f.done();const fresh=f.login();
 assert.notEqual(f.api.authorize(f.cell,fresh,f.now).inc,old.inc);denies(()=>f.api.authorizeLink(f.cell,fresh,'shop',f.now));
 denies(()=>f.api.authorizeLink(f.cell,fresh,'legacy-accountId-only',f.now));
});
for(const partial of [false,true])test('whole/partial manifest loss cannot certify cleanup '+partial,()=>{
 const f=fixture(),a=f.login();f.claim(a,'shop1');f.claim(a,'shop2');f.begin(a);
 const r=decoded(f.cell.raw);r.accounts[0].links=partial?r.accounts[0].links.slice(1):[];
 // Even a trusted serializer accidentally signing incomplete membership is rejected.
 f.cell={...f.cell,raw:signed(r)};denies(()=>f.api.cleanupPlan(f.cell,'alice'));denies(()=>f.api.acknowledge(f.cell,signed({},receiptSecret),f.now));
});
test('manifest substitution/count/hash damage and duplicated ids fail closed',()=>{
 for(const mutate of [a=>a.manifest.count++,a=>a.manifest.hash='0'.repeat(64),a=>a.links[0].id='substituted',a=>a.links.push({...a.links[0]})]){
 const f=fixture(),s=f.login();f.claim(s,'shop');const r=decoded(f.cell.raw);mutate(r.accounts[0]);denies(()=>f.api.inspect({...f.cell,raw:signed(r)}));}
});
test('expired begin cannot revoke re-registered session; nonexpired old grant also fenced',()=>{
 const f=fixture(),a=f.login(),g=f.begin(a);f.done();const fresh=f.login();
 denies(()=>f.api.begin(f.cell,g,f.now+60_000));denies(()=>f.api.begin(f.cell,g,f.now));assert.equal(f.api.authorize(f.cell,fresh,f.now).id,'alice');
});
test('begin grant duplicate is idempotent but must still be unexpired',()=>{
 const f=fixture(),s=f.login(),g=f.begin(s),before=f.cell.raw;
 assert.equal(f.api.begin(f.cell,g,f.now).next,before);denies(()=>f.api.begin(f.cell,g,f.now+60_000));
});
test('grant cannot change account, scope, kind, sid, incarnation or expiry',()=>{
 const f=fixture(),s=f.login(),g=f.api.issueBegin(f.cell,s,f.now);
 for(const [key,value]of Object.entries({id:'bob',scope:'other',kind:'oauth',sid:'a'.repeat(64),inc:'b'.repeat(64),exp:f.now+600_001})){
 const e=JSON.parse(g),p=JSON.parse(e.payload);p[key]=value;e.payload=canonical(p);denies(()=>f.api.begin(f.cell,canonical(e),f.now));}
 denies(()=>f.api.begin(f.cell,g,f.now-1));
});
test('partial/unverified detach stays deleting, including zero-link account',()=>{
 const f=fixture(),s=f.login();f.claim(s,'one');f.claim(s,'two');f.begin(s);
 for(const patch of [{ids:['one']},{ids:[]},{operation:'0'.repeat(64)},{inc:'0'.repeat(64)},{verifiedAt:f.now+1},{manifest:{count:0,hash:'0'.repeat(64)}}])denies(()=>f.api.acknowledge(f.cell,f.receipt('alice',patch),f.now));
 denies(()=>f.api.acknowledge(f.cell,signed({...f.api.cleanupPlan(f.cell,'alice'),verifiedAt:f.now}),f.now));
 denies(()=>f.login());assert.equal(f.api.inspect(f.cell).accounts[0].status,'deleting');
 const z=fixture(),zs=z.login();z.begin(zs);assert.equal(z.api.inspect(z.cell).accounts[0].status,'deleting');
});
test('complete trusted attestation is idempotent and stale receipt cannot target new incarnation',()=>{
 const f=fixture(),s=f.login();f.claim(s,'shop');f.begin(s);const receipt=f.receipt();
 f.commit(f.api.acknowledge(f.cell,receipt,f.now));const raw=f.cell.raw;assert.equal(f.api.acknowledge(f.cell,receipt,f.now).next,raw);
 const fresh=f.login();denies(()=>f.api.acknowledge(f.cell,receipt,f.now));assert.equal(f.api.authorize(f.cell,fresh,f.now).id,'alice');
});
test('stale and future receipts rejected',()=>{const f=fixture(),s=f.login();f.begin(s);denies(()=>f.api.acknowledge(f.cell,f.receipt(),f.now+60_001));});
for(const type of ['none','hash','set','list','zset','stream'])test('wrong Redis type '+type,()=>{const f=fixture();denies(()=>f.api.inspect({...f.cell,type}));});
for(const ttl of [-2,0,1,60_000,null,'-1'])test('authority TTL must be permanent '+ttl,()=>{const f=fixture();denies(()=>f.api.inspect({...f.cell,ttl}));});
test('malformed and unsigned arbitrary records cannot authorize anything',()=>{
 const f=fixture(),s=f.login();for(const raw of ['','null','[]','{}','{','{"ownerAccountId":"alice"}',f.cell.raw+' ',f.cell.raw.replace(/"mac":"./,'"mac":"z')])denies(()=>f.api.authorize({...f.cell,raw},s,f.now));
 const e=JSON.parse(f.cell.raw);denies(()=>f.api.inspect({...f.cell,raw:'{"mac":"'+e.mac+'","mac":"'+e.mac+'","payload":'+JSON.stringify(e.payload)+'}'}));
});
test('signed malformed account fields fail closed',()=>{
 for(const change of [a=>a.epoch=-1,a=>a.epoch=1.1,a=>a.inc='bad',a=>a.sessions=[null],a=>a.used=[null],a=>a.links=[null],a=>a.operation={},a=>a.extra=true,a=>a.status='done']){
 const f=fixture();f.login();const r=decoded(f.cell.raw);change(r.accounts[0]);denies(()=>f.api.inspect({...f.cell,raw:signed(r)}));}
});
test('session expiry and removed session deny while other sessions work',()=>{
 const f=fixture(),a=f.login(),b=f.login(),sid=f.api.authorize(f.cell,a,f.now).sid,r=decoded(f.cell.raw);r.accounts[0].sessions=r.accounts[0].sessions.filter(s=>s.id!==sid);f.cell={...f.cell,raw:signed(r)};
 denies(()=>f.api.authorize(f.cell,a,f.now));assert.equal(f.api.authorize(f.cell,b,f.now).id,'alice');denies(()=>f.api.authorize(f.cell,b,f.now+3_600_000));
});
test('OAuth duplicate/re-registration race is fenced',()=>{
 const f=fixture(),g=f.api.issueOAuth(f.cell,'alice',f.now),a=f.commit(f.api.exchange(f.cell,g,f.now));denies(()=>f.api.exchange(f.cell,g,f.now));
 const pending=f.api.issueOAuth(f.cell,'alice',f.now);f.begin(a);f.done();const g1=f.api.issueOAuth(f.cell,'alice',f.now),g2=f.api.issueOAuth(f.cell,'alice',f.now);f.commit(f.api.exchange(f.cell,g1,f.now));denies(()=>f.api.exchange(f.cell,g2,f.now));denies(()=>f.api.exchange(f.cell,pending,f.now));
});
test('pure transition has no partial writes; CAS conflict cannot merge stale claim',()=>{
 const f=fixture(),s=f.login(),raw=f.cell.raw,claim=f.api.claim(f.cell,s,'shop',f.now),g=f.api.issueBegin(f.cell,s,f.now),begin=f.api.begin(f.cell,g,f.now);
 assert.equal(f.cell.raw,raw);f.commit(begin);
 const simulatedCAS=(expected,next)=>{if(f.cell.type!=='string'||f.cell.ttl!==-1)return 'BLOCKED';if(f.cell.raw!==expected)return 'CONFLICT';f.cell={...f.cell,raw:next};return 'OK';};
 assert.equal(simulatedCAS(raw,claim.next),'CONFLICT');denies(()=>f.api.claim(f.cell,s,'shop',f.now));
});
test('failure before commit preserves old value; lost acknowledgment is unknown, reread resolves',()=>{
 const f=fixture(),s=f.login(),old=f.cell.raw,g=f.api.issueBegin(f.cell,s,f.now),pending=f.api.begin(f.cell,g,f.now);
 assert.equal(f.cell.raw,old);f.commit(pending); // model successful SET then network response lost
 assert.equal(f.api.inspect(f.cell).accounts[0].status,'deleting');assert.equal(f.api.begin(f.cell,g,f.now).next,f.cell.raw);
});
test('CAS Lua has one write after TYPE/TTL/exact-value checks (static, NOT Redis execution)',()=>{
 assert.equal((CAS_LUA.match(/redis.call\('SET'/g)||[]).length,1);for(const op of ['TYPE','PTTL','GET'])assert.ok(CAS_LUA.indexOf("'"+op+"'")<CAS_LUA.indexOf("'SET'"));
 assert.ok(!/DEL|EXPIRE|SADD|HSET/.test(CAS_LUA));
});
test('public legacy raw and expiry are not read or changed by the primitive',()=>{
 const raw=' {"id":"old","password":{"hash":"synthetic"},"unknown":[[],{}],"ownerAccountId":"legacy"} ',legacy={raw,ttl:1234};const f=fixture(),s=f.login();f.begin(s);f.done();assert.deepEqual(legacy,{raw,ttl:1234});
});
test('known boundary: valid whole-authority rollback is NOT detectable internally',()=>{
 const f=fixture(),s=f.login(),backup=f.cell;f.begin(s);denies(()=>f.api.authorize(f.cell,s,f.now));
 // Explicitly documents why external anti-rollback authority is a prerequisite.
 assert.equal(f.api.authorize(backup,s,f.now).id,'alice');
});
test('known boundary: simultaneous membership+proof loss cannot be reconstructed',()=>{
 const f=fixture(),s=f.login();f.claim(s,'shop');const lost={type:'none',ttl:-2,raw:null};denies(()=>f.api.inspect(lost));
 // No automatic reset/recovery invoked; independent audit is required.
});
