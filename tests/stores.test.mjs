import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../api/stores.js';
import { MemoryStore, RedisStore, STORES_LUA, HttpError } from '../lib/guard.mjs';
import { normalizeData, validateRequest, requestScope, storeKeys, renderStore, DISCLOSURE } from '../lib/stores.mjs';
const ENV={VERCEL:'1',VERCEL_ENV:'production',SESSION_SECRET:'test-only-secret-not-a-credential'};
const ID='a'.repeat(22),PASS='synthetic-test-password';
const DATA={name:'테스트 & 가게',address:'서울 마포구 12',headline:'사장님이 직접 소개합니다',intro:'첫 문단\n\n두 번째 문단',sections:[],faqs:[]};
function request(body,options={}) { const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=options.method || 'POST';req.url=options.url || '/api/stores';req.headers={host:'www.kkumsu.com',origin:'https://www.kkumsu.com','content-type':'application/json','x-vercel-forwarded-for':'203.0.113.1',...options.headers};req.socket={remoteAddress:'127.0.0.1'};if(options.parsed)req.body=body;return req; }
function response() {return {statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(v){this.body=v;},json(){return JSON.parse(this.body);}};}
async function invoke(handler,body,options={}) {const r=response();await handler(request(body,options),r);return r;}
const create=(id=ID,data=DATA)=>({action:'create',id,password:PASS,consent:true,data});
const scope=requestScope(request(),ENV);
const owner=(action,extra={})=>({action,id:ID,password:PASS,...extra});
const get=(id=ID)=>({method:'GET',url:'/api/stores?id='+id});

test('strict exact data, consent, lengths, empty pairs, HTML/link rejection',()=>{
 assert.deepEqual(normalizeData({...DATA,sections:[{heading:' ',body:' '}]}).sections,[]);
 for(const data of [null,{...DATA,extra:1},{...DATA,name:''},{...DATA,address:'abc'},{...DATA,headline:'x'.repeat(201)},{...DATA,intro:'<script>alert(1)</script>'},{...DATA,intro:'https://evil.test'},{...DATA,sections:[{heading:'one',body:''}]},{...DATA,faqs:Array(9).fill({question:'q',answer:'a'})}]) assert.throws(()=>validateRequest(create(ID,data)));
 assert.throws(()=>validateRequest({...create(),consent:false}));
 assert.throws(()=>validateRequest({...create(),id:'../bad'}));
 assert.throws(()=>validateRequest({...create(),password:'short'}));
 assert.throws(()=>validateRequest({...create(),token:'not-accepted'}));
});

test('create, same-data retry, conflict, auth, update, delete; no secret leakage',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});
 let r=await invoke(h,create());assert.equal(r.statusCode,201,r.body);assert.equal(r.json().url,'/stores/'+ID);
 const stored=await st.getJson(storeKeys(scope,ID)[0]);assert.notEqual(stored.password.hash,PASS);assert.equal(stored.password.salt.length,32);assert.ok(!JSON.stringify(stored).includes(PASS));
 r=await invoke(h,create(ID,{...DATA,name:'  '+DATA.name+'  '}));assert.equal(r.statusCode,200);
 r=await invoke(h,create(ID,{...DATA,headline:'changed'}));assert.equal(r.statusCode,409);
 r=await invoke(h,owner('auth'));assert.equal(r.statusCode,200);
 r=await invoke(h,owner('auth',{password:'wrong-password'}));assert.equal(r.statusCode,403);
 r=await invoke(h,owner('update',{data:{...DATA,intro:'수정 소개'},consent:true}));assert.equal(r.statusCode,200);
 r=await invoke(h,undefined,get());assert.deepEqual(Object.keys(r.json()).sort(),['data','id']);assert.equal(r.json().data.intro,'수정 소개');assert.ok(!/password|salt|hash/.test(r.body));
 r=await invoke(h,owner('delete'));assert.equal(r.statusCode,200);
 assert.equal((await invoke(h,undefined,get())).statusCode,404);
 assert.equal((await invoke(h,undefined,{method:'GET',url:'/api/stores?view=directory'})).body.includes('/stores/'+ID),false);
 r=await invoke(h,create());assert.equal(r.statusCode,409,'deleted ID tombstone prevents late retry resurrection');
 const keys=storeKeys(scope,ID),tomb=await st.getJson(keys[0]);assert.deepEqual(Object.keys(tomb).sort(),['deleted','revision']);
 assert.equal(st.publicExpiry.has(keys[0]),false,'production tombstone has no expiry');
 const late=await st.publicTransaction('create',keys,{now:Date.now()+120*86400e3,record:{id:ID,data:DATA,createdAt:Date.now(),revision:'later'},ttl:0,counters:[]});
 assert.equal(late.status,'exists','a previously printed URL cannot be taken over after months');
});

test('distinct reporters: duplicates do not hide; three IPs hide public access but owner can delete',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});await invoke(h,create());
 for(const ip of ['1','1','2']) assert.equal((await invoke(h,{action:'report',id:ID,reason:'inaccurate'},{headers:{'x-vercel-forwarded-for':ip}})).statusCode,200);
 assert.equal((await invoke(h,undefined,get())).statusCode,200);
 await invoke(h,{action:'report',id:ID,reason:'other'},{headers:{'x-vercel-forwarded-for':'3'}});
 assert.equal((await invoke(h,undefined,get())).statusCode,404);
 const auth=await invoke(h,owner('auth'));assert.equal(auth.json().hidden,true);
 await invoke(h,owner('update',{data:{...DATA,intro:'edited'},consent:true}));assert.equal((await invoke(h,undefined,get())).statusCode,404,'edit must not unhide');
 assert.equal((await invoke(h,owner('delete'))).statusCode,200);
 assert.equal(st.kv.has(storeKeys(scope,ID)[2]),false);
});

test('strict origin, forwarded-host spoof protection and host namespace isolation',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});
 for(const headers of [{origin:'https://evil.test'},{origin:'https://www.kkumsu.com/'},{'x-forwarded-host':'evil.test'},{host:'preview.vercel.app','x-forwarded-host':'www.kkumsu.com'},{origin:undefined}]) assert.ok([400,403].includes((await invoke(h,create(),{headers})).statusCode));
 const preview=createHandler({store:st,env:{...ENV,VERCEL_ENV:'preview'}});
 const previewOptions={headers:{host:'qa.vercel.app',origin:'https://qa.vercel.app'}};
 assert.equal((await invoke(preview,create(),previewOptions)).statusCode,201);
 assert.equal((await invoke(h,undefined,get())).statusCode,404);
 assert.notEqual(requestScope(request(),{...ENV,VERCEL_ENV:'preview'}).namespace,scope.namespace);
 assert.equal((await invoke(preview,undefined,{method:'GET',url:'/api/stores?view=page&id='+ID,...previewOptions})).headers['x-robots-tag'],'noindex, nofollow');
 assert.equal((await invoke(h,create())).statusCode,201,'prod does not collide with same preview id');
});

test('body byte limit includes Vercel pre-parsed JSON and no storage fallback in deployment',async()=>{
 const h=createHandler({env:ENV,store:new MemoryStore()});
 const oversized={...create(),padding:'가'.repeat(23000)};
 for(const parsed of [true,false]) assert.equal((await invoke(h,oversized,{parsed})).statusCode,413);
 assert.equal((await invoke(createHandler({env:ENV}),create())).statusCode,503);
 assert.equal((await invoke(createHandler({env:ENV,store:{publicTransaction(){throw Error('secret detail');}}}),create())).statusCode,503);
});

test('SSR escapes every field, has canonical/disclosure/accessibility and no scripts',()=>{
 const dangerous={...DATA,name:'<img src=x onerror=bad()>',headline:'"quoted"',intro:'&lt;script&gt;',sections:[{heading:'<b>',body:'<svg/onload=bad>'}],faqs:[{question:'<iframe>',answer:'</title>'}]};
 const html=renderStore(scope,{id:ID,data:dangerous});assert.ok(!/<script|<img\s+src=x|<svg|<iframe|style=|onclick=/i.test(html));assert.ok(html.includes('&lt;img'));assert.ok(html.includes(DISCLOSURE));assert.ok(html.includes('https://www.kkumsu.com/stores/'+ID));assert.ok(html.includes('/#/manage/'+ID));assert.ok(html.includes('/#/report-store/'+ID));assert.ok(html.includes('href="/styles.css"'));
 const preview=renderStore({...scope,production:false},{id:ID,data:DATA});assert.ok(preview.includes('noindex,nofollow'));assert.ok(!preview.includes('rel="canonical"'));
});

test('directory is index-paginated at twenty entries and contains no private fields',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});
 for(let i=0;i<25;i++) { const id=String(i).padStart(22,'0');await st.publicTransaction('create',storeKeys(scope,id),{now:Date.now(),record:{id,data:{...DATA,name:'Store '+i},createdAt:i,revision:id,hidden:false,password:{hash:'private'}},ttl:0,counters:[]}); }
 const first=await invoke(h,undefined,{method:'GET',url:'/api/stores?view=directory'}),second=await invoke(h,undefined,{method:'GET',url:'/api/stores?view=directory&page=2'});
 assert.equal((first.body.match(/<li>/g)||[]).length,20);assert.equal((second.body.match(/<li>/g)||[]).length,5);assert.ok(first.body.includes('/stores?page=2'));assert.ok(!first.body.includes('private'));assert.equal((await invoke(h,undefined,{method:'GET',url:'/api/stores?view=directory&page=-1'})).statusCode,400);
});

test('atomic helpers: concurrent create consumes quota once; stale update cannot resurrect delete',async()=>{
 const st=new MemoryStore(),keys=storeKeys(scope,ID),record={id:ID,data:DATA,createdAt:Date.now(),revision:'v1',hidden:false};
 const p={now:Date.now(),record,ttl:0,counters:[{key:'create-count',limit:50,ttl:172800}]};
 const results=await Promise.all(Array.from({length:10},()=>st.publicTransaction('create',keys,p)));
 assert.equal(results.filter(r=>r.status==='created').length,1);assert.equal(st.kv.get('create-count'),1);assert.equal(st.kv.get(keys[1]).size,1);
 await st.publicTransaction('delete',keys,{now:Date.now(),expected:'v1',revision:'deleted',tombstoneTtl:86400});
 const late=await st.publicTransaction('update',keys,{now:Date.now(),expected:'v1',record:{...record,revision:'v2'},ttl:0});assert.equal(late.status,'missing');assert.equal(st.kv.get(keys[1]).size,0);
});

test('unknown create outcome retry returns existing without a duplicate',async()=>{
 const st=new MemoryStore(),base=st.publicTransaction.bind(st);let lost=true;
 st.publicTransaction=async(...args)=>{const out=await base(...args);if(args[0]==='create'&&lost){lost=false;throw new HttpError(503,'STORE','unknown');}return out;};
 const h=createHandler({store:st,env:ENV});assert.equal((await invoke(h,create())).statusCode,503);assert.equal((await invoke(h,create())).statusCode,200);assert.equal(st.kv.get(storeKeys(scope,ID)[1]).size,1);
});

test('auth rate limits by both IP and target id, create quotas fail without deleting existing records',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});await invoke(h,create());
 for(let i=0;i<7;i++) assert.equal((await invoke(h,owner('auth',{password:'wrong-password'}),{headers:{'x-vercel-forwarded-for':'attacker'+i}})).statusCode,403);
 assert.equal((await invoke(h,owner('auth'),{headers:{'x-vercel-forwarded-for':'new-ip'}})).statusCode,429);
 const st2=new MemoryStore(),h2=createHandler({store:st2,env:ENV});
 for(let i=0;i<3;i++) assert.equal((await invoke(h2,create(String(i).padStart(22,'0')))).statusCode,201);
 assert.equal((await invoke(h2,create('b'.repeat(22)))).statusCode,429);assert.equal((await invoke(h2,undefined,get('0'.repeat(22)))).statusCode,200);
 const before=st2.kv.get(storeKeys(scope,ID)[1]).size;st2.kv.set(scope.namespace+':limit:create:global:'+new Date(Date.now()+9*3600e3).toISOString().slice(0,10),50);
 assert.equal((await invoke(h2,create('c'.repeat(22)),{headers:{'x-vercel-forwarded-for':'fresh-ip'}})).statusCode,429);assert.equal(st2.kv.get(storeKeys(scope,ID)[1]).size,before);
});

test('preview records and index expire together without touching production',async()=>{
 const st=new MemoryStore(),s=requestScope(request(undefined,{headers:{host:'qa.vercel.app'}}),{...ENV,VERCEL_ENV:'preview'}),keys=storeKeys(s,ID),now=Date.now();
 await st.publicTransaction('create',keys,{now,record:{id:ID,data:DATA,createdAt:now,hidden:false,revision:'1'},ttl:7200,counters:[]});
 assert.ok(st.publicExpiry.has(keys[0]));assert.ok(st.publicExpiry.has(keys[1]));
 const after=await st.publicTransaction('list',[keys[1]],{now:now+7200001,prefix:s.namespace+':record:',ttl:7200,offset:0,limit:20});assert.equal(after.items.length,0);
});

test('Redis helper sends one EVAL and restores Lua empty arrays; no partial index writes',async()=>{
 const sent=[],st=new RedisStore('https://redis.invalid','synthetic-token',async(url,opts)=>{sent.push(JSON.parse(opts.body));return new Response(JSON.stringify({result:JSON.stringify({status:'created',record:{id:ID,data:{...DATA,sections:{},faqs:{}}}})}));});
 const r=await st.publicTransaction('create',storeKeys(scope,ID),{record:{id:ID,data:DATA},ttl:0});assert.equal(sent.length,1);assert.equal(sent[0][0],'EVAL');assert.equal(sent[0][1],STORES_LUA);assert.deepEqual(r.record.data.sections,[]);assert.ok(STORES_LUA.includes("redis.call('ZADD'"));assert.ok(STORES_LUA.includes("redis.call('ZREM'"));
});
