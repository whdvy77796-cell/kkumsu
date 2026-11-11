import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../api/owner-stores.js';
import { createHandler as legacyHandler } from '../api/stores.js';
import { MemoryStore as BaseMemoryStore, RedisStore, HttpError, OWNER_STORES_LUA, STORES_LUA } from '../lib/guard.mjs';
import { requestScope, storeKeys, hashPassword, renderStore } from '../lib/stores.mjs';
import { ownerKeys, validateOwnerRequest } from '../lib/owner-stores.mjs';
import { createHash } from 'node:crypto';
import { SESSION_BINDING, SESSION_TTL } from '../lib/owner-auth.mjs';
// Test-only authenticated session seeding. Actual Redis/MemoryStore checks stay
// enabled; this is not an alternate deployed login or an authorization bypass.
function fixtureSession(store,accountId,namespace,now=Date.now()) {
 const key='yb:auth:v1:'+createHash('sha256').update(namespace).digest('hex')+':session:'+createHash('sha256').update(accountId).digest('hex');
 let record;try{record=JSON.parse(store.kv.get(key));}catch{}
 if(!record){const issuedAt=Math.min(now,Date.now())-1000;record={accountId,provider:'kakao',origin:'https://www.kkumsu.com',namespace,binding:createHash('sha256').update('binding:'+accountId).digest('base64url'),issuedAt,expiresAt:issuedAt+SESSION_TTL*1000};store.kv.set(key,JSON.stringify(record));store.publicExpiry ||= new Map();store.publicExpiry.set(key,record.expiresAt);}
 return {key,...record};
}
function fixtureTx(store,op,keys,p) {
 if(p.session)return {keys,p};
 const namespace=(p.prefix || keys[0]).split(':record:')[0].split(':owner:')[0],proof=fixtureSession(store,p.accountId,namespace,p.now);
 return {keys:[...keys,proof.key],p:{...p,session:proof,scopeNamespace:namespace,authOrigin:proof.origin}};
}
class MemoryStore extends BaseMemoryStore {
 ownerTransaction(op,keys,p){const args=fixtureTx(this,op,keys,p);return super.ownerTransaction(op,args.keys,args.p);}
}
const ENV={VERCEL:'1',VERCEL_ENV:'production',SESSION_SECRET:'synthetic-owner-tests',YB_AUTH_ORIGIN:'https://www.kkumsu.com'};
const ID='a'.repeat(22),ID2='b'.repeat(22),PASS='synthetic-password',ACCOUNT='opaque-owner-A';
const DATA={name:'합성 테스트 가게',address:'서울 마포구 12',headline:'가게 소개',intro:'테스트 설명',sections:[],faqs:[]};
const SITUATIONS=[{question:'혼자 쉬고 싶다면?',answer:'좌석을 안내합니다.'}];
const PASSWORD=await hashPassword(PASS);
function req(body,opts={}){const r=Readable.from([]);r.body=body;r.method=opts.method || 'POST';r.url=opts.url || '/api/owner-stores';r.headers={host:'www.kkumsu.com',origin:'https://www.kkumsu.com','content-type':'application/json','x-vercel-forwarded-for':'203.0.113.1',...opts.headers};r.socket={remoteAddress:'127.0.0.1'};if(opts.query)r.query=opts.query;return r;}
function res(){return {statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(v){this.body=v;},json(){return JSON.parse(this.body);}};}
async function call(h,body,opts){if(body?.action==='update'&&!opts?.legacy&&!Object.hasOwn(body,'expectedRevision')) {const current=await call(h,undefined,{...opts,method:'GET',url:'/api/owner-stores?op=read&id='+body.id});body={...body,expectedRevision:current.statusCode===200?current.json().revision:'0'.repeat(32)};}const r=res();await h(req(body,opts),r);return r;}
const scope=requestScope(req(),ENV),get=(op,id=ID)=>({method:'GET',url:'/api/owner-stores?op='+op+(op==='read'?'&id='+id:'')});
const claim=(id=ID,password=PASS)=>({action:'claim',id,password});
const update=(data=DATA,id=ID)=>({action:'update',id,consent:true,data});
const auth=accountId=>async()=>({accountId,provider:'test'});
const handler=(store,accountId=ACCOUNT,extra={})=>createHandler({store,env:ENV,...extra,authenticate:async args=>{const session=await (extra.authenticate || auth(accountId))(args);if(session?.accountId){session.provider='kakao';Object.defineProperty(session,SESSION_BINDING,{value:fixtureSession(store.fixtureBackend || store,session.accountId,args.scope.namespace,args.now)});}return session;}});
async function seed(st,{id=ID,ownerAccountId,hidden=false,deleted=false,s=scope,now=Date.now(),expiresAt=s.ttl?now+s.ttl*1000:null,data=DATA}={}) {
 const record={id,data,password:PASSWORD,revision:'0'.repeat(32),createdAt:now,updatedAt:now,hidden,expiresAt,...(ownerAccountId?{ownerAccountId}:{}),...(deleted?{deleted:true}:{})};
 await st.publicTransaction('create',storeKeys(s,id),{now,record,ttl:s.ttl,counters:[]});return record;
}
const clean=r=>assert.ok(!/"(?:password|salt|hash|ownerAccountId|expiresAt)"\s*:/.test(r.body),r.body);

test('claim preserves exact public page, legacy password, ID and repeated claim identity',async()=>{
 const st=new MemoryStore(),before=await seed(st),h=handler(st),publicBefore=renderStore(scope,before);
 const c=await call(h,claim());assert.equal(c.statusCode,200,c.body);assert.deepEqual(c.json(),{id:ID,linked:true,url:'/stores/'+ID});clean(c);
 const linked=await st.getJson(storeKeys(scope,ID)[0]);assert.equal(linked.ownerAccountId,ACCOUNT);assert.deepEqual(linked.password,before.password);assert.deepEqual(linked.data,before.data);assert.equal(linked.updatedAt,before.updatedAt);assert.equal(renderStore(scope,linked),publicBefore);
 assert.equal((await call(h,claim())).statusCode,200);assert.equal((await st.getJson(storeKeys(scope,ID)[0])).revision,linked.revision);assert.equal(st.kv.get(ownerKeys(scope,ACCOUNT)[0]).size,1);
 const legacy=await call(legacyHandler({store:st,env:ENV}),{action:'auth',id:ID,password:PASS});assert.equal(legacy.statusCode,200);assert.deepEqual(Object.keys(legacy.json()),['id','data','url','hidden']);clean(legacy);
 const read=await call(h,undefined,get('read'));assert.deepEqual(Object.keys(read.json()),['id','data','hidden','updatedAt','revision']);clean(read);
 const list=await call(h,undefined,get('list'));assert.deepEqual(list.json().stores,[{id:ID,name:DATA.name,address:DATA.address,headline:DATA.headline,hidden:false,updatedAt:before.updatedAt}]);clean(list);
});

test('no automatic ownership on create; unauthenticated, logged-out and revoked sessions fail closed',async()=>{
 const st=new MemoryStore();let valid=true;const authenticate=async()=>{if(!valid)throw new HttpError(401,'SESSION','로그인 필요');return {accountId:ACCOUNT,provider:'test'};};
 const h=handler(st,ACCOUNT,{authenticate});await seed(st);assert.deepEqual((await call(h,undefined,get('list'))).json(),{stores:[]});
 assert.equal((await call(h,claim())).statusCode,200);valid=false;
 for(const [body,opts] of [[undefined,get('list')],[undefined,get('read')],[claim(),undefined],[update(),undefined],[{action:'unlink',id:ID},undefined]]) assert.equal((await call(h,body,opts)).statusCode,401);
 for(const result of [null,{}, {accountId:''},{accountId:'bad\nkey'}]) assert.equal((await call(handler(st,ACCOUNT,{authenticate:async()=>result}),claim())).statusCode,401);
 assert.equal((await st.getJson(storeKeys(scope,ID)[0])).ownerAccountId,ACCOUNT);
});

test('wrong passwords, nonexistent IDs and other account ownership reveal no private fields',async()=>{
 const st=new MemoryStore();await seed(st);const h=handler(st);
 assert.equal((await call(h,claim(ID,'incorrect-password'))).statusCode,403);
 assert.equal((await call(h,claim(ID2))).statusCode,403);assert.equal((await st.getJson(storeKeys(scope,ID)[0])).ownerAccountId,undefined);
 await call(h,claim());const other=handler(st,'other');
 for(const [body,opts,status] of [[claim(),undefined,403],[undefined,get('read'),404],[update(),undefined,404],[{action:'unlink',id:ID},undefined,404]]){const r=await call(other,body,opts);assert.equal(r.statusCode,status,r.body);clean(r);}
 assert.deepEqual((await call(other,undefined,get('list'))).json(),{stores:[]});assert.equal((await st.getJson(storeKeys(scope,ID)[0])).ownerAccountId,ACCOUNT);
});

test('concurrent two-owner claim has exactly one winner and one index',async()=>{
 const st=new MemoryStore();await seed(st);
 const rows=await Promise.all([call(handler(st,'one'),claim()),call(handler(st,'two'),claim())]);assert.deepEqual(rows.map(r=>r.statusCode).sort(),[200,403]);
 const r=await st.getJson(storeKeys(scope,ID)[0]);const winner=r.ownerAccountId,loser=winner==='one'?'two':'one';assert.equal(st.kv.get(ownerKeys(scope,winner)[0]).size,1);assert.equal(st.kv.has(ownerKeys(scope,loser)[0]),false);
});

test('same IP and target-ID rate buckets are shared with legacy password API',async()=>{
 const st=new MemoryStore();await seed(st);const h=handler(st),legacy=legacyHandler({store:st,env:ENV});
 for(let i=0;i<8;i++){const r=i%2?await call(legacy,{action:'auth',id:ID,password:'bad-password'},{headers:{'x-vercel-forwarded-for':'ip'+i}}):await call(h,claim(ID,'bad-password'),{headers:{'x-vercel-forwarded-for':'ip'+i}});assert.equal(r.statusCode,403);}
 assert.equal((await call(h,claim(),{headers:{'x-vercel-forwarded-for':'fresh'}})).statusCode,429);
 const other=new MemoryStore(),oh=handler(other);
 for(let i=0;i<8;i++)assert.equal((await call(oh,claim(String(i).padStart(22,'0')))).statusCode,403);
 assert.equal((await call(oh,claim())).statusCode,429);
 // Spoofed forwarded-for is ignored on Vercel when the platform header is fixed.
 assert.equal((await call(oh,claim(),{headers:{'x-forwarded-for':'new-forged-ip'}})).statusCode,429);
});

test('update preserves legacy schema, situations, hidden state and credentials; explicit [] clears',async()=>{
 const st=new MemoryStore(),before=await seed(st,{hidden:true,data:{...DATA,situations:SITUATIONS}}),h=handler(st);await call(h,claim());
 const r=await call(h,update({...DATA,intro:'수정 소개'}));assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data.situations,SITUATIONS);assert.equal(r.json().hidden,true);clean(r);
 assert.deepEqual((await st.getJson(storeKeys(scope,ID)[0])).password,before.password);
 assert.deepEqual((await call(h,update({...DATA,situations:[]}))).json().data.situations,[]);
 const legacy=new MemoryStore();await seed(legacy);const lh=handler(legacy);await call(lh,claim());assert.equal(Object.hasOwn((await call(lh,update())).json().data,'situations'),false);
 const old=legacyHandler({store:st,env:ENV});assert.equal((await call(old,{action:'update',id:ID,password:PASS,consent:true,data:{...DATA,intro:'레거시 수정'}},{legacy:true})).statusCode,200);assert.equal((await st.getJson(storeKeys(scope,ID)[0])).ownerAccountId,ACCOUNT);
});

test('CAS conflict refuses stale edit and preserves concurrent situations/report hiding',async()=>{
 const st=new MemoryStore();await seed(st,{data:{...DATA,situations:SITUATIONS}});const h=handler(st);await call(h,claim());
 const base=st.ownerTransaction.bind(st);let count=0;const latest=[{question:'새 질문?',answer:'새 답변'}];
 st.ownerTransaction=async(op,keys,p)=>{if(op==='update' && count++===0){const old=await st.getJson(keys[0]);st.kv.set(keys[0],JSON.stringify({...old,data:{...old.data,situations:latest},hidden:true,revision:'concurrent-report'}));}return base(op,keys,p);};
 const r=await call(h,update({...DATA,intro:'오래된 편집기'}));assert.equal(r.statusCode,409,r.body);assert.equal(r.json().code,'CONFLICT');assert.equal(count,1);const saved=await st.getJson(storeKeys(scope,ID)[0]);assert.deepEqual(saved.data.situations,latest);assert.equal(saved.hidden,true);assert.equal(saved.data.intro,DATA.intro);
});

test('CAS conflicts return CONFLICT without overwriting data',async()=>{
 const st=new MemoryStore();await seed(st,{ownerAccountId:ACCOUNT});const base=st.ownerTransaction.bind(st);let calls=0;st.ownerTransaction=async(op,...args)=>{if(op==='update'){calls++;return {status:'conflict'};}return base(op,...args);};
 const r=await call(handler(st),update({...DATA,intro:'not saved'}));assert.equal(r.statusCode,409);assert.equal(r.json().code,'CONFLICT');assert.equal(calls,1);assert.equal((await st.getJson(storeKeys(scope,ID)[0])).data.intro,DATA.intro);
});

test('delete race blocks late update and claim, deleted and expired records cannot be claimed',async()=>{
 for(const action of ['update','claim']){
  const st=new MemoryStore();await seed(st,{ownerAccountId:action==='update'?ACCOUNT:undefined});const base=st.ownerTransaction.bind(st);let deleted=false;
  st.ownerTransaction=async(op,keys,p)=>{if(op===action&&!deleted){deleted=true;const old=await st.getJson(keys[0]);await st.publicTransaction('delete',storeKeys(scope,ID),{now:p.now,expected:old.revision,revision:'deleted',tombstoneTtl:0});}return base(op,keys,p);};
  const r=await call(handler(st),action==='claim'?claim():update());assert.equal(r.statusCode,action==='claim'?403:404,r.body);assert.equal((await st.getJson(storeKeys(scope,ID)[0])).deleted,true);assert.equal(st.kv.has(ownerKeys(scope,ACCOUNT)[0]),false);
 }
 for(const extra of [{deleted:true},{expiresAt:Date.now()-1}]){const st=new MemoryStore();await seed(st,extra);assert.equal((await call(handler(st),claim())).statusCode,403);}
});

test('ownership rechecked atomically on update/unlink race and claim checks revision',async()=>{
 const st=new MemoryStore();const old=await seed(st,{ownerAccountId:ACCOUNT}),keys=ownerKeys(scope,ACCOUNT,ID);
 const unlinked=await st.ownerTransaction('unlink',keys,{accountId:ACCOUNT,expected:old.revision,revision:'unlinked',now:Date.now()});assert.equal(unlinked.status,'ok');
 const late=await st.ownerTransaction('update',keys,{accountId:ACCOUNT,expected:old.revision,revision:'late',data:DATA,now:Date.now()});assert.equal(late.status,'denied');
 assert.equal((await st.ownerTransaction('claim',ownerKeys(scope,'new',ID),{accountId:'new',expected:old.revision,revision:'claim',now:Date.now()})).status,'conflict');
});

test('unlink is authorized, idempotence is not assumed, public page/password/ID stay stable',async()=>{
 const st=new MemoryStore(),original=await seed(st),h=handler(st);await call(h,claim());
 const r=await call(h,{action:'unlink',id:ID});assert.equal(r.statusCode,200);assert.deepEqual(r.json(),{id:ID,unlinked:true});
 const now=await st.getJson(storeKeys(scope,ID)[0]);assert.equal(now.ownerAccountId,undefined);assert.deepEqual(now.data,original.data);assert.deepEqual(now.password,original.password);assert.equal(renderStore(scope,now),renderStore(scope,original));assert.equal(st.kv.has(ownerKeys(scope,ACCOUNT)[0]),false,'empty sorted-set index is deleted just as Redis ZREM does');
 assert.equal((await call(h,undefined,get('read'))).statusCode,404);assert.equal((await call(handler(st,'new-account'),claim())).statusCode,200,'explicitly unlinked store can be linked with legacy password again');
});

test('stale owner indexes filter deleted, expired, wrong owner and invalid IDs; bounded reads',async()=>{
 const st=new MemoryStore();await seed(st,{ownerAccountId:ACCOUNT,hidden:true});await seed(st,{id:ID2,ownerAccountId:'other'});
 const index=new Map([[ID,1],[ID2,2],['c'.repeat(22),3],['../../private',4]]);st.kv.set(ownerKeys(scope,ACCOUNT)[0],index);
 const r=await call(handler(st),undefined,get('list'));assert.equal(r.statusCode,200);assert.deepEqual(r.json().stores.map(x=>x.id),[ID]);assert.equal(r.json().stores[0].hidden,true);assert.equal(index.size,1);clean(r);
 for(let i=0;i<600;i++)index.set(String(i).padStart(22,'0'),i+10);
 const p=await st.ownerTransaction('list',ownerKeys(scope,ACCOUNT),{accountId:ACCOUNT,prefix:scope.namespace+':record:',limit:9999,scan:9999,now:Date.now()});assert.ok(p.stores.length<=100);assert.equal(index.size,101,'only 500 stale IDs scanned');
});

test('account index capacity refuses new link atomically without modifying target',async()=>{
 const st=new MemoryStore();const index=new Map();
 for(let i=0;i<100;i++){const id=String(i).padStart(22,'0');await seed(st,{id,ownerAccountId:ACCOUNT});index.set(id,i);}
 st.kv.set(ownerKeys(scope,ACCOUNT)[0],index);await seed(st);
 const r=await call(handler(st),claim());assert.equal(r.statusCode,409);assert.equal(r.json().code,'OWNER_LIMIT');assert.equal((await st.getJson(storeKeys(scope,ID)[0])).ownerAccountId,undefined);assert.equal(index.size,100);
});

test('origin/forwarded-host/protocol spoof, traversal, overpost, XSS and consent rejected',async()=>{
 const st=new MemoryStore();await seed(st);const h=handler(st);
 for(const headers of [{origin:undefined},{origin:'null'},{origin:'https://evil.test'},{origin:'https://www.kkumsu.com/'},{'x-forwarded-host':'evil.test'},{'x-forwarded-proto':'http'}])assert.equal((await call(h,claim(),{headers})).statusCode,403);
 for(const body of [claim('../key'),{...claim(),ownerAccountId:ACCOUNT},{...update(),consent:false},update({...DATA,intro:'<script>alert(1)</script>'}),update({...DATA,intro:'javascript:alert(1)'}),{action:'unlink',id:ID,password:PASS},update({...DATA,situations:[{question:'//evil.test',answer:'x'}]})])assert.equal((await call(h,body)).statusCode,400);
 assert.equal((await call(h,{...update(),padding:'가'.repeat(23000)})).statusCode,413);
 assert.equal((await call(h,undefined,{method:'GET',url:'/api/owner-stores?op=read&id=../x'})).statusCode,400);
 assert.equal((await call(h,undefined,{method:'GET',url:'/api/owner-stores?op=list&op=read'})).statusCode,400);
 assert.throws(()=>validateOwnerRequest({action:'delete',id:ID}));
});

test('preview isolation and exact record expiry survive claim/update/unlink; production persistent',async()=>{
 const st=new MemoryStore(),now=Date.now(),opts={headers:{host:'qa.vercel.app',origin:'https://qa.vercel.app'}};
 const s=requestScope(req(undefined,opts),{...ENV,VERCEL_ENV:'preview'});await seed(st,{s,now});await seed(st);
 const key=storeKeys(s,ID)[0],expiry=st.publicExpiry.get(key),h=handler(st,ACCOUNT,{env:{...ENV,VERCEL_ENV:'preview'},now:now+2000});
 assert.equal((await call(h,claim(),opts)).statusCode,200);assert.equal(st.publicExpiry.get(key),expiry);assert.equal(st.publicExpiry.get(ownerKeys(s,ACCOUNT)[0]),expiry);
 assert.equal((await st.getJson(storeKeys(scope,ID)[0])).ownerAccountId,undefined);
 assert.equal((await call(h,update(),opts)).statusCode,200);assert.equal(st.publicExpiry.get(key),expiry);
 const late=await st.ownerTransaction('read',ownerKeys(s,ACCOUNT,ID),{accountId:ACCOUNT,now:expiry+1});assert.equal(late.status,'missing');
 assert.equal((await call(handler(st),claim())).statusCode,200);assert.equal(st.publicExpiry.has(storeKeys(scope,ID)[0]),false);assert.equal(st.publicExpiry.has(ownerKeys(scope,ACCOUNT)[0]),false);
});

// Offline Redis transport/cjson compatibility model, NOT a real Lua interpreter.
function cjson(v){return JSON.stringify(v,(_k,x)=>Array.isArray(x)&&x.length===0?{}:x);}
function redisFixture(){
 const backend=new MemoryStore(),calls=[];
 const redis=new RedisStore('https://redis.invalid','synthetic',async(url,opts)=>{
  const a=JSON.parse(opts.body);calls.push(a);let result;
  if(a[0]==='GET')result=backend.kv.get(a[1]) ?? null;
  else {assert.equal(a[0],'EVAL');const n=Number(a[2]),keys=a.slice(3,3+n),op=a[3+n],p=JSON.parse(a[4+n]);
   assert.ok([OWNER_STORES_LUA,STORES_LUA].includes(a[1]));const out=await backend[a[1]===OWNER_STORES_LUA?'ownerTransaction':'publicTransaction'](op,keys,p);
   if(keys[0]?.includes(':record:')&&backend.kv.has(keys[0]))backend.kv.set(keys[0],cjson(JSON.parse(backend.kv.get(keys[0]))));result=cjson(out);
  }
  return new Response(JSON.stringify({result}));
 });redis.fixtureBackend=backend;const base=redis.ownerTransaction.bind(redis);redis.ownerTransaction=(op,keys,p)=>{const args=fixtureTx(backend,op,keys,p);return base(op,args.keys,args.p);};return {redis,backend,calls};
}
for(const data of [DATA,{...DATA,situations:[]},{...DATA,situations:SITUATIONS}])test('Redis transport cjson mirrors memory legacy/new shape: '+JSON.stringify(data.situations),async()=>{
 const {redis,backend,calls}=redisFixture();await seed(backend,{data});const h=handler(redis);
 assert.deepEqual((await call(h,undefined,get('list'))).json(),{stores:[]});assert.equal((await call(h,claim())).statusCode,200);
 const read=await call(h,undefined,get('read'));assert.deepEqual(read.json().data,data);clean(read);
 assert.equal((await call(h,update({...DATA,intro:'수정'}))).statusCode,200);
 const after=(await call(h,undefined,get('read'))).json();assert.deepEqual(after.data,{...data,intro:'수정'});
 assert.equal((await call(h,undefined,get('list'))).json().stores.length,1);
 assert.equal((await call(h,{action:'unlink',id:ID})).statusCode,200);assert.deepEqual((await call(h,undefined,get('list'))).json(),{stores:[]});
 assert.ok(calls.some(a=>a[0]==='EVAL'&&a[1]===OWNER_STORES_LUA));assert.ok(OWNER_STORES_LUA.includes("'KEEPTTL'"));assert.ok(OWNER_STORES_LUA.includes('old.revision~=p.expected'));
});

test('lost claim response retries safely without duplicate index entries',async()=>{
 const st=new MemoryStore();await seed(st);const tx=st.ownerTransaction.bind(st);let lost=true;
 st.ownerTransaction=async(...args)=>{const r=await tx(...args);if(args[0]==='claim'&&lost){lost=false;throw Error('lost response');}return r;};
 const h=handler(st);assert.equal((await call(h,claim())).statusCode,503);assert.equal((await call(h,claim())).statusCode,200);assert.equal(st.kv.get(ownerKeys(scope,ACCOUNT)[0]).size,1);
});


test('two editors submit same read revision: first succeeds, stale second never overwrites',async()=>{
 const st=new MemoryStore();await seed(st);const h=handler(st);await call(h,claim());const initial=(await call(h,undefined,get('read'))).json();
 const a={...update({...DATA,intro:'first editor'}),expectedRevision:initial.revision};
 const b={...update({...DATA,intro:'second editor'}),expectedRevision:initial.revision};
 const results=await Promise.all([call(h,a),call(h,b)]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
 const winner=results.find(r=>r.statusCode===200).json();assert.notEqual(winner.revision,initial.revision);assert.deepEqual((await call(h,undefined,get('read'))).json().data,winner.data);
 assert.throws(()=>validateOwnerRequest(update()),{code:'FIELDS'});
 assert.throws(()=>validateOwnerRequest({...update(),expectedRevision:'not-a-revision'}),{code:'FIELDS'});
});

test('claim retries reverify password/revision after a concurrent legacy edit',async()=>{
 const st=new MemoryStore();await seed(st);const base=st.ownerTransaction.bind(st);let calls=0;
 st.ownerTransaction=async(op,keys,p)=>{if(op==='claim'&&calls++===0){const old=await st.getJson(keys[0]);st.kv.set(keys[0],JSON.stringify({...old,revision:'1'.repeat(32),data:{...DATA,intro:'concurrent legacy edit'}}));}return base(op,keys,p);};
 assert.equal((await call(handler(st),claim())).statusCode,200);assert.equal(calls,2);assert.equal((await st.getJson(storeKeys(scope,ID)[0])).data.intro,'concurrent legacy edit');
});


for(const transport of ['memory','redis-transport-model']) {
 const fixture=()=>{if(transport==='memory'){const backend=new MemoryStore();return {backend,store:backend};}const f=redisFixture();return {backend:f.backend,store:f.redis};};
 const link=async(store,backend,s,id,now)=>{const record=await backend.getJson(storeKeys(s,id)[0]);return store.ownerTransaction('claim',ownerKeys(s,ACCOUNT,id),{accountId:ACCOUNT,prefix:s.namespace+':record:',expected:record.revision,revision:'f'.repeat(32),now});};
 const list=(store,s,now)=>store.ownerTransaction('list',ownerKeys(s,ACCOUNT),{accountId:ACCOUNT,prefix:s.namespace+':record:',scan:500,limit:100,now});

 test(transport+': staggered previews retain latest absolute expiry and never lose a still-live record',async()=>{
  const {backend,store}=fixture(),t=Date.now()+1000;
  const s=requestScope(req(undefined,{headers:{host:'staggered-preview.vercel.app'}}),{...ENV,VERCEL_ENV:'preview'});
  const a=await seed(backend,{s,now:t}),b=await seed(backend,{s,id:ID2,now:t+3600000}),idx=ownerKeys(s,ACCOUNT)[0];
  assert.equal((await link(store,backend,s,ID,t+1000)).status,'ok');assert.equal(backend.publicExpiry.get(idx),a.expiresAt);
  assert.equal((await link(store,backend,s,ID2,t+3601000)).status,'ok');assert.equal(backend.publicExpiry.get(idx),b.expiresAt);
  assert.equal((await link(store,backend,s,ID,t+4000000)).status,'ok');assert.equal(backend.publicExpiry.get(idx),b.expiresAt,'older record cannot shorten index');
  const remaining=await list(store,s,a.expiresAt+1);assert.deepEqual(remaining.stores.map(r=>r.id),[ID2]);
  assert.equal((await store.ownerTransaction('read',ownerKeys(s,ACCOUNT,ID2),{accountId:ACCOUNT,now:a.expiresAt+1})).status,'ok');
  assert.equal(backend.publicExpiry.get(idx),b.expiresAt,'reads and stale pruning do not extend retention');
  assert.deepEqual((await list(store,s,b.expiresAt+1)).stores,[]);assert.equal(backend.kv.has(idx),false);
 });

 for(const order of ['persistent-first','finite-first']) test(transport+': injected mixed records fail safe, '+order,async()=>{
  const {backend,store}=fixture(),t=Date.now()+1000,finiteScope={...scope,ttl:60},idx=ownerKeys(scope,ACCOUNT)[0];
  await seed(backend,{now:t});const finite=await seed(backend,{s:finiteScope,id:ID2,now:t});
  // Public APIs cannot produce this mixed namespace; simulate migration/corruption.
  for(const id of order==='persistent-first'?[ID,ID2]:[ID2,ID]) assert.equal((await link(store,backend,scope,id,t+1000)).status,'ok');
  assert.equal(backend.publicExpiry.has(idx),false,'persistent membership must dominate finite membership');
  assert.equal((await link(store,backend,scope,ID2,t+2000)).status,'ok');assert.equal(backend.publicExpiry.has(idx),false,'idempotent finite claim cannot shorten persistent index');
  const rows=await list(store,scope,finite.expiresAt+1);assert.deepEqual(rows.stores.map(r=>r.id),[ID]);assert.equal(backend.publicExpiry.has(idx),false);
  const read=await store.ownerTransaction('read',ownerKeys(scope,ACCOUNT,ID),{accountId:ACCOUNT,now:finite.expiresAt+1});assert.equal(read.status,'ok');
 });

 test(transport+': removing last persistent member deletes index; later finite claim gets its proper TTL',async()=>{
  const {backend,store}=fixture(),t=Date.now()+1000,idx=ownerKeys(scope,ACCOUNT)[0];await seed(backend,{now:t});await link(store,backend,scope,ID,t+1000);
  const old=await backend.getJson(storeKeys(scope,ID)[0]);assert.equal((await store.ownerTransaction('unlink',ownerKeys(scope,ACCOUNT,ID),{accountId:ACCOUNT,expected:old.revision,revision:'e'.repeat(32),now:t+2000})).status,'ok');
  assert.equal(backend.kv.has(idx),false);assert.equal(backend.publicExpiry.has(idx),false);
  const finite=await seed(backend,{s:{...scope,ttl:60},id:ID2,now:t+3000});await link(store,backend,scope,ID2,t+4000);
  assert.equal(backend.publicExpiry.get(idx),finite.expiresAt,'a missing index is not a persistent existing index');
 });

 test(transport+': stale full index frees capacity without removing hidden or active owned records',async()=>{
  const {backend,store}=fixture(),t=Date.now()+1000,index=new Map(),live=[];
  for(let i=0;i<100;i++){
   const id=String(i).padStart(22,'0');const extra=i<95?{ownerAccountId:ACCOUNT,hidden:i===0}:i<97?{ownerAccountId:ACCOUNT,deleted:true}:i<99?{ownerAccountId:ACCOUNT,expiresAt:t-1}:{ownerAccountId:'another-owner'};
   await seed(backend,{id,now:t,...extra});index.set(id,i);if(i<95)live.push(id);
  }
  const idx=ownerKeys(scope,ACCOUNT)[0];backend.kv.set(idx,index);await seed(backend,{now:t});
  assert.equal((await link(store,backend,scope,ID,t+1000)).status,'ok');assert.equal(backend.kv.get(idx).size,96);
  const rows=(await list(store,scope,t+2000)).stores;assert.deepEqual(rows.map(r=>r.id).sort(),[...live,ID].sort());assert.equal(rows.find(r=>r.id===live[0]).hidden,true);
  assert.equal((await backend.getJson(storeKeys(scope,String(99).padStart(22,'0'))[0])).ownerAccountId,'another-owner','cleanup only touches this account index, not the foreign record');
 });
}

test('normal namespaces cannot mix durable production with expiring preview records',()=>{
 const scopes=['www.kkumsu.com','www.kkumsu.net','kkumsu-rho.vercel.app'].map(host=>requestScope(req(undefined,{headers:{host}}),ENV));
 assert.ok(scopes.every(s=>s.namespace===scope.namespace&&s.ttl===0));
 const previews=[requestScope(req(),{...ENV,VERCEL_ENV:'preview'}),requestScope(req(undefined,{headers:{host:'different-preview.vercel.app'}}),ENV)];
 for(const s of previews){assert.notEqual(s.namespace,scope.namespace);assert.equal(s.ttl,7200);assert.notEqual(ownerKeys(s,ACCOUNT)[0],ownerKeys(scope,ACCOUNT)[0]);}
 assert.notEqual(previews[0].namespace,previews[1].namespace);
 // Structural guard in addition to the explicitly labelled transport-model tests.
 assert.ok(OWNER_STORES_LUA.indexOf("local priorTtl=redis.call('PTTL'")<OWNER_STORES_LUA.indexOf("redis.call('ZADD'"));
 assert.ok(OWNER_STORES_LUA.includes('priorTtl==-2 or (priorTtl>=0 and priorTtl<remaining)'));
});

test('raw owner transactions reject absent/substituted session proof, value fields and missing/persistent TTL',async()=>{
 for(const tamper of ['missing-proof','wrong-key','binding','accountId','provider','origin','namespace','issuedAt','expiresAt','no-ttl','expired-ttl']) {
  const st=new BaseMemoryStore(),old=await seed(st,{ownerAccountId:ACCOUNT}),proof=fixtureSession(st,ACCOUNT,scope.namespace),keys=[...ownerKeys(scope,ACCOUNT,ID),proof.key];
  const p={accountId:ACCOUNT,scopeNamespace:scope.namespace,authOrigin:ENV.YB_AUTH_ORIGIN,session:proof,expected:old.revision,revision:'e'.repeat(32),data:{...DATA,intro:'blocked'},now:Date.now()};
  if(tamper==='missing-proof')delete p.session;
  else if(tamper==='wrong-key')keys[2]='yb:auth:v1:'+'f'.repeat(64)+':session:'+'e'.repeat(64);
  else if(tamper==='no-ttl')st.publicExpiry.delete(proof.key);
  else if(tamper==='expired-ttl')st.publicExpiry.set(proof.key,Date.now()-1);
  else {const r=JSON.parse(st.kv.get(proof.key));r[tamper]=typeof r[tamper]==='number'?r[tamper]+1:'substituted';st.kv.set(proof.key,JSON.stringify(r));}
  assert.equal((await st.ownerTransaction('update',keys,p)).status,'session',tamper);assert.deepEqual(await st.getJson(storeKeys(scope,ID)[0]),old);
 }
 assert.ok(OWNER_STORES_LUA.indexOf("local proof=p.session")<OWNER_STORES_LUA.indexOf("if op=='list'"));
 assert.ok(OWNER_STORES_LUA.includes("redis.call('PTTL',proof.key)<=0"));assert.ok(OWNER_STORES_LUA.includes('s.expiresAt<=p.now'));
});
