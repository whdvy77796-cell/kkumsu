import { createHash } from 'node:crypto';
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
 for(const data of [null,{...DATA,extra:1},{...DATA,name:''},{...DATA,address:'abc'},{...DATA,headline:'x'.repeat(201)},{...DATA,intro:'<script>alert(1)</script>'},{...DATA,intro:'https://evil.test'},{...DATA,sections:[{heading:'one',body:''}]},{...DATA,faqs:Array(13).fill({question:'q',answer:'a'})}]) assert.throws(()=>validateRequest(create(ID,data)));
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
 const missingPage=await invoke(h,undefined,{method:'GET',url:'/api/stores?view=page&id='+ID});
 assert.equal(missingPage.statusCode,404);assert.match(missingPage.headers['content-type'],/text\/html/);assert.ok(missingPage.body.includes('/#/manage/'+ID));assert.equal(missingPage.headers['x-robots-tag'],'noindex, nofollow');
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
 for (const host of ['www.kkumsu.com','www.kkumsu.net','kkumsu-rho.vercel.app','lookhereai.com','www.lookhereai.com']) {
   const aliasScope=requestScope(request(undefined,{headers:{host}}),ENV);
   assert.equal(aliasScope.namespace,scope.namespace,'all promoted aliases share durable production pages');
   assert.equal(aliasScope.ttl,0,'a production-alias page must not expire as a preview');
 }
 const deployScope=requestScope(request(undefined,{headers:{host:'kkumsu-8u3oifqwm-kkkkkum.vercel.app'}}),ENV);
 assert.notEqual(deployScope.namespace,scope.namespace);assert.equal(deployScope.ttl,7200);
 assert.equal((await invoke(preview,undefined,{method:'GET',url:'/api/stores?view=page&id='+ID,...previewOptions})).headers['x-robots-tag'],'noindex, nofollow');
 assert.equal((await invoke(h,create())).statusCode,201,'prod does not collide with same preview id');
});

test('old and new domains share synthetic records while previews and cross-origin requests stay isolated',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});
 const aliases=['www.kkumsu.com','www.kkumsu.net','kkumsu-rho.vercel.app','lookhereai.com','www.lookhereai.com'];
 const opt=host=>({headers:{host,origin:'https://'+host}});
 assert.equal((await invoke(h,create(),opt(aliases[0]))).statusCode,201);
 for(const host of aliases){
   const read=await invoke(h,undefined,{...get(),...opt(host)});
   assert.equal(read.statusCode,200);assert.equal(read.json().data.name,DATA.name);
   const scoped=requestScope(request(undefined,opt(host)),ENV);
   assert.equal(scoped.namespace,scope.namespace);assert.equal(scoped.ttl,0);
 }
 assert.equal((await invoke(h,owner('auth'),opt('www.kkumsu.com'))).statusCode,200);
 assert.equal((await invoke(h,owner('auth'),opt('www.lookhereai.com'))).statusCode,200);
 assert.equal((await invoke(h,owner('auth',{password:'wrong-password'}),opt('www.lookhereai.com'))).statusCode,403);
 assert.equal((await invoke(h,create(ID,{...DATA,name:'attacker'}),opt('www.lookhereai.com'))).statusCode,409);
 assert.equal((await invoke(h,owner('update',{data:{...DATA,intro:'cross domain update'},consent:true}),opt('www.lookhereai.com'))).statusCode,200);
 assert.equal((await invoke(h,undefined,{...get(),...opt('www.kkumsu.com')})).json().data.intro,'cross domain update');
 assert.equal((await invoke(h,owner('update',{data:DATA,consent:true}),{headers:{host:'www.lookhereai.com',origin:'https://evil.example'}})).statusCode,403);
 assert.equal((await invoke(h,owner('auth'),{headers:{host:'www.lookhereai.com',origin:'https://www.lookhereai.com','x-forwarded-host':'evil.example'}})).statusCode,403);
 assert.equal((await invoke(h,owner('auth'),{headers:{host:'www.lookhereai.com',origin:'https://www.lookhereai.com','x-forwarded-proto':'http'}})).statusCode,403);
 assert.equal((await invoke(h,undefined,{...get(),...opt('evil.example')})).statusCode,404);
 const preview=createHandler({store:st,env:{...ENV,VERCEL_ENV:'preview'}});
 assert.equal((await invoke(preview,undefined,{...get(),...opt('www.lookhereai.com')})).statusCode,404);
 assert.equal((await invoke(h,owner('delete'),opt('www.lookhereai.com'))).statusCode,200);
 assert.equal((await invoke(h,undefined,{...get(),...opt('www.kkumsu.com')})).statusCode,404);
 assert.equal((await invoke(h,create(),opt('www.kkumsu.com'))).statusCode,409);
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
 const html=renderStore(scope,{id:ID,data:dangerous});assert.ok(!/<script|<img\s+src=x|<svg|<iframe|style=|onclick=/i.test(html));assert.ok(html.includes('&lt;img'));assert.ok(html.includes(DISCLOSURE));assert.ok(html.includes('<link rel="canonical" href="https://www.lookhereai.com/stores/'+ID+'">'));assert.ok(html.includes('<meta property="og:url" content="https://www.lookhereai.com/stores/'+ID+'">'));assert.ok(html.includes('/#/manage/'+ID));assert.ok(html.includes('/#/report-store/'+ID));assert.ok(html.includes('href="/styles.css"'));
 const preview=renderStore({...scope,production:false},{id:ID,data:DATA});assert.ok(preview.includes('noindex,nofollow'));assert.ok(!preview.includes('rel="canonical"'));
});

test('directory is index-paginated at twenty entries and contains no private fields',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});
 for(let i=0;i<25;i++) { const id=String(i).padStart(22,'0');await st.publicTransaction('create',storeKeys(scope,id),{now:Date.now(),record:{id,data:{...DATA,name:'Store '+i},createdAt:i,revision:id,hidden:false,password:{hash:'private'}},ttl:0,counters:[]}); }
 const first=await invoke(h,undefined,{method:'GET',url:'/api/stores?view=directory'}),second=await invoke(h,undefined,{method:'GET',url:'/api/stores?view=directory&page=2'});
 assert.equal((first.body.match(/<li>/g)||[]).length,20);assert.equal((second.body.match(/<li>/g)||[]).length,5);assert.ok(first.body.includes('/stores?page=2'));assert.ok(!first.body.includes('private'));assert.equal((await invoke(h,undefined,{method:'GET',url:'/api/stores?view=directory&page=-1'})).statusCode,400);
});

test('atomic helpers: concurrent create consumes quota once; stale update cannot resurrect delete',async()=>{
 const st=new MemoryStore(),keys=storeKeys(scope,ID),record={id:ID,data:DATA,password:{salt:'test',hash:'test'},createdAt:Date.now(),revision:'v1',hidden:false};
 const p={now:Date.now(),record,ttl:0,counters:[{key:'create-count',limit:50,ttl:172800}]};
 const results=await Promise.all(Array.from({length:10},()=>st.publicTransaction('create',keys,p)));
 assert.equal(results.filter(r=>r.status==='created').length,1);assert.equal(st.kv.get('create-count'),1);assert.equal(st.kv.get(keys[1]).size,1);
 await st.publicTransaction('delete',keys,{now:Date.now(),expected:'v1',expectedRaw:st.kv.get(keys[0]),revision:'d'.repeat(32),tombstoneTtl:86400});
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


const SITUATIONS=[{question:'혼자 조용히 쉬고 싶을 때는?',answer:'창가 좌석과 따뜻한 차를 소개합니다.'}];
const withSituations=(situations=SITUATIONS)=>({...DATA,situations});
const pageOptions={method:'GET',url:'/api/stores?view=page&id='+ID};
const noPrivate=r=>assert.ok(!/"(?:password|salt|hash|revision|createdAt|updatedAt|expiresAt|reporter)"\s*:/.test(r.body),r.body);

test('legacy six-field records retain exact shapes and SSR apart from canonical metadata',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});
 assert.deepEqual(normalizeData(DATA),DATA);assert.equal(Object.hasOwn(normalizeData(DATA),'situations'),false);
 const created=await invoke(h,create());assert.equal(created.statusCode,201);
 assert.deepEqual(Object.keys(created.json()),['id','data','url','hidden']);assert.deepEqual(created.json().data,DATA);noPrivate(created);
 const auth=await invoke(h,owner('auth'));assert.deepEqual(auth.json(),created.json());noPrivate(auth);
 const publicJson=await invoke(h,undefined,get());assert.deepEqual(publicJson.json(),{id:ID,data:DATA});noPrivate(publicJson);
 const page=await invoke(h,undefined,pageOptions);assert.equal(page.statusCode,200);
 const meta='<link rel="canonical" href="https://www.lookhereai.com/stores/'+ID+'"><meta property="og:url" content="https://www.lookhereai.com/stores/'+ID+'">';
 const previousMeta='<link rel="canonical" href="https://www.kkumsu.com/stores/'+ID+'">';
 assert.ok(page.body.includes(meta),'new canonical and social URL are present');
 const normalized=page.body.replace(meta,previousMeta);
 assert.equal(createHash('sha256').update(normalized).digest('hex'),'5a07efab4f2ac938c4d2c3f9b6a841e14c37feac44b656cf33a5c3b07224e011','all other bytes remain identical');
 assert.ok(!page.body.includes('이럴 때 찾는 가게'));
 assert.equal(renderStore(scope,{id:ID,data:withSituations([])}),page.body,'explicit empty renders no new section');
});

test('situations exact schema, pair limits, normalization, malformed and unsafe input rejection',()=>{
 assert.deepEqual(normalizeData(withSituations([])),withSituations([]));
 assert.deepEqual(normalizeData(withSituations([{question:' \t',answer:'\n '}])),withSituations([]));
 assert.deepEqual(normalizeData(withSituations([{question:'  질문  ',answer:'  답변  '}])).situations,[{question:'질문',answer:'답변'}]);
 assert.equal(normalizeData(withSituations(Array.from({length:8},()=>({question:'가'.repeat(300),answer:'나'.repeat(2000)})))).situations.length,8);
 for(const situations of [null,undefined,{},'text',[null],[[]],[{}],[{question:'q'}],[{answer:'a'}],[{question:'q',answer:''}],[{question:' ',answer:'a'}],[{question:3,answer:'a'}],[{question:'q',answer:false}],[{question:'q',answer:'a',extra:1}],[{question:'q'.repeat(301),answer:'a'}],[{question:'q',answer:'a'.repeat(2001)}],Array(9).fill(SITUATIONS[0])]) {
   assert.throws(()=>normalizeData({...DATA,situations}),{code:'FIELDS'});
 }
 for(const attack of ['<script>alert(1)</script>','<img src=x onerror=bad()>','</dd><iframe>','<svg/onload=bad>','https://evil.test','HTTP://evil.test','javascript:alert(1)','data:text/html,bad','www.evil.test','ftp://evil.test','//evil.test','evil.test/path','mailto:x@evil.test','[label](/target)','bad\u0000text']) for(const key of ['question','answer']) {
   assert.throws(()=>normalizeData(withSituations([{question:'질문',answer:'답변',[key]:attack}])),{code:'FIELDS'},key+': '+attack);
 }
 for(const data of [{...withSituations(),extra:1},Object.fromEntries(Object.entries(withSituations()).filter(([key])=>key!=='faqs'))]) assert.throws(()=>normalizeData(data),{code:'FIELDS'});
 // The new validation must not change acceptance of any original field.
 assert.equal(normalizeData({...DATA,intro:'ftp://legacy.example'}).intro,'ftp://legacy.example');
});

test('new situations create/read/auth/edit/delete keeps FAQs, sections and private fields separate',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});
 const data={...withSituations(),sections:[{heading:'안내',body:'안내 본문'}],faqs:[{question:'영업시간은?',answer:'매일 오전에 열어요.'}]};
 const created=await invoke(h,create(ID,data));assert.equal(created.statusCode,201);assert.deepEqual(created.json().data,data);noPrivate(created);
 const auth=await invoke(h,owner('auth'));assert.deepEqual(auth.json().data,data);noPrivate(auth);
 const pub=await invoke(h,undefined,get());assert.deepEqual(pub.json(),{id:ID,data});noPrivate(pub);
 const html=await invoke(h,undefined,pageOptions);assert.equal(html.statusCode,200);
 assert.ok(html.body.includes('<h2>이럴 때 찾는 가게</h2>'));assert.ok(html.body.includes('<dt><span>예상 질문</span> '+SITUATIONS[0].question+'</dt>'));
 assert.ok(html.body.includes('실제 검색 내역이나 검색 빈도를 뜻하지 않습니다.'));assert.ok(html.body.includes('<h2>고객 질문과 답변</h2>'));assert.ok(html.body.includes('안내 본문'));
 const edited={...data,situations:[{question:'가족과 함께 오고 싶다면?',answer:'테이블 좌석을 안내합니다.'}]};
 const update=await invoke(h,owner('update',{consent:true,data:edited}));assert.equal(update.statusCode,200);assert.deepEqual(update.json().data,edited);noPrivate(update);
 assert.deepEqual((await invoke(h,undefined,get())).json().data,edited);
 const deleted=await invoke(h,owner('delete'));assert.deepEqual(deleted.json(),{id:ID,deleted:true});
 assert.equal((await invoke(h,undefined,get())).statusCode,404);assert.equal((await invoke(h,undefined,pageOptions)).statusCode,404);
 assert.deepEqual(Object.keys(await st.getJson(storeKeys(scope,ID)[0])).sort(),['deleted','revision']);
});

test('omitted old-client update preserves situations; explicit [] clears and stays explicitly empty',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});await invoke(h,create(ID,withSituations()));
 const original=await st.getJson(storeKeys(scope,ID)[0]);
 let r=await invoke(h,owner('update',{consent:true,data:{...DATA,intro:'old editor change'}}));assert.equal(r.statusCode,200);assert.deepEqual(r.json().data.situations,SITUATIONS);
 assert.deepEqual(original.data,withSituations(),'previous record was not mutated');
 r=await invoke(h,owner('update',{consent:true,data:withSituations([])}));assert.equal(r.statusCode,200);assert.deepEqual(r.json().data.situations,[]);
 r=await invoke(h,owner('update',{consent:true,data:DATA}));assert.equal(r.statusCode,200);assert.equal(Object.hasOwn(r.json().data,'situations'),true);assert.deepEqual(r.json().data.situations,[]);
 assert.ok(!(await invoke(h,undefined,pageOptions)).body.includes('이럴 때 찾는 가게'));
 const legacy=new MemoryStore(),legacyHandler=createHandler({store:legacy,env:ENV});await invoke(legacyHandler,create());
 r=await invoke(legacyHandler,owner('update',{consent:true,data:{...DATA,intro:'legacy update'}}));assert.equal(r.statusCode,200);assert.equal(Object.hasOwn(r.json().data,'situations'),false);
});

test('omitted situations merge is immutable and re-read after a CAS conflict',async()=>{
 const st=new MemoryStore(),h=createHandler({store:st,env:ENV});await invoke(h,create(ID,withSituations()));
 const read=st.getJson.bind(st),snapshotRead=st.getLegacySnapshot.bind(st),transaction=st.publicTransaction.bind(st),observed=[];
 st.getLegacySnapshot=async key=>{const snap=await snapshotRead(key),record=snap.record;if(record?.data){Object.freeze(record.data.situations);Object.freeze(record.data);Object.freeze(record);observed.push(record);}return snap;};
 const latest=[{question:'새로 바뀐 질문?',answer:'다른 편집기에서 저장한 답변'}];let conflicts=0;
 st.publicTransaction=async(op,keys,p)=>{
   if(op==='update' && conflicts++===0){const concurrent=await read(keys[0]);st.kv.set(keys[0],JSON.stringify({...concurrent,data:{...concurrent.data,situations:latest},revision:'concurrent-revision'}));}
   return transaction(op,keys,p);
 };
 const r=await invoke(h,owner('update',{consent:true,data:{...DATA,intro:'오래 열린 편집기 수정'}}));assert.equal(r.statusCode,200,r.body);assert.equal(conflicts,2);assert.deepEqual(r.json().data.situations,latest);
 assert.deepEqual(observed[0].data.situations,SITUATIONS);assert.deepEqual(observed[1].data.situations,latest);
});

test('SSR escapes situations even for unvalidated stored data and never treats answers as markup',()=>{
 const dangerous=withSituations([{question:'</dt><script>alert("x")</script> & \'quoted\'',answer:'<img src=x onerror=bad()>\nline\n\n<a href="https://evil.test">bad</a>'}]);
 const html=renderStore(scope,{id:ID,data:dangerous});
 assert.ok(html.includes('&lt;/dt&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;'));
 assert.ok(html.includes('&lt;img src=x onerror=bad()&gt;<br>line</p><p>&lt;a href=&quot;https://evil.test&quot;&gt;bad&lt;/a&gt;'));
 assert.ok(!/<script|<img\s+src=x|<a href="https:\/\/evil/.test(html));
 const unsafeId=renderStore(scope,{id:'" onclick="bad',data:DATA});assert.ok(!unsafeId.includes('" onclick="bad'));
});

// Offline cjson model: empty arrays become {} on BOTH EVAL responses and
// persisted records. All RedisStore traffic stays inside this injected fetcher.
function cjsonStringify(value){return JSON.stringify(value,(_key,v)=>Array.isArray(v)&&v.length===0?{}:v);}
function redisFixture({loseCreate=false}={}){
 const backend=new MemoryStore(),state={missNextGet:false,lost:false},calls=[];
 const redis=new RedisStore('https://redis.invalid','synthetic-token',async(url,opts)=>{
   assert.equal(url,'https://redis.invalid');const args=JSON.parse(opts.body);calls.push(args);
   if(args[0]==='GET'){
     if(state.missNextGet){state.missNextGet=false;return new Response(JSON.stringify({result:null}));}
     return new Response(JSON.stringify({result:backend.kv.get(args[1])??null}));
   }
   assert.equal(args[0],'EVAL');assert.equal(args[1],STORES_LUA);const count=Number(args[2]),keys=args.slice(3,3+count),op=args[3+count],payload=JSON.parse(args[4+count]);
   const result=await backend.publicTransaction(op,keys,payload);
   if(op==='create' && backend.kv.has(keys[0])) backend.kv.set(keys[0],cjsonStringify(JSON.parse(backend.kv.get(keys[0]))));
   if(op==='create'&&loseCreate&&!state.lost){state.lost=true;throw new Error('simulated lost response after atomic commit');}
   return new Response(JSON.stringify({result:cjsonStringify(result)}));
 });
 return {redis,backend,state,calls};
}

for(const [label,data] of [['legacy omitted',DATA],['explicit empty',withSituations([])],['selected situations',withSituations()]]) test('RedisStore cjson CRUD, SSR, lost create and exists-race retries: '+label,async()=>{
 const fixture=redisFixture({loseCreate:true}),{redis,backend,state}=fixture,h=createHandler({store:redis,env:ENV}),keys=storeKeys(scope,ID);
 assert.equal((await invoke(h,create(ID,data))).statusCode,503);
 const raw=JSON.parse(backend.kv.get(keys[0]));assert.deepEqual(raw.data.sections,{});assert.deepEqual(raw.data.faqs,{});
 if(Object.hasOwn(data,'situations'))assert.deepEqual(raw.data.situations,data.situations.length?data.situations:{});else assert.equal(Object.hasOwn(raw.data,'situations'),false);
 let r=await invoke(h,create(ID,data));assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data,data);noPrivate(r);
 r=await invoke(h,owner('auth'));assert.equal(r.statusCode,200);assert.deepEqual(r.json().data,data);noPrivate(r);
 r=await invoke(h,undefined,get());assert.deepEqual(r.json(),{id:ID,data});noPrivate(r);
 assert.equal((await invoke(h,undefined,pageOptions)).body,renderStore(scope,{id:ID,data}));
 state.missNextGet=true;r=await invoke(h,create(ID,data));assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data,data);
 assert.equal(backend.kv.get(keys[1]).size,1);
 for(const [key,value] of backend.kv) if(key.includes(':limit:create:'))assert.equal(value,1,'create retry does not consume publish quota');
 const listing=await redis.publicTransaction('list',[keys[1]],{prefix:scope.namespace+':record:',offset:0,limit:20,ttl:0,now:Date.now()});assert.deepEqual(listing.items,[{id:ID,data}]);
 const directory=await invoke(h,undefined,{method:'GET',url:'/api/stores?view=directory'});assert.equal(directory.statusCode,200);assert.ok(directory.body.includes('/stores/'+ID));assert.ok(!directory.body.includes('synthetic-token'));
 const edited={...DATA,intro:'오래된 클라이언트 수정'};
 r=await invoke(h,owner('update',{consent:true,data:edited}));assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data,{...data,intro:edited.intro});
 r=await invoke(h,owner('update',{consent:true,data:withSituations([])}));assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data,withSituations([]));
 assert.deepEqual((await invoke(h,undefined,get())).json().data,withSituations([]));assert.equal((await invoke(h,undefined,pageOptions)).body,renderStore(scope,{id:ID,data:DATA}));
 assert.equal((await invoke(h,owner('delete'))).statusCode,200);assert.equal((await invoke(h,undefined,get())).statusCode,404);assert.equal((await invoke(h,create(ID,data))).statusCode,409);
 assert.deepEqual(Object.keys(JSON.parse(backend.kv.get(keys[0]))).sort(),['deleted','revision']);assert.equal(backend.kv.get(keys[1]).size,0);
});

test('missing and explicit-empty create identities remain distinct, with normalization idempotent',async()=>{
 for(const [original,other] of [[DATA,withSituations([])],[withSituations([]),DATA],[withSituations(),withSituations([{question:'different',answer:'answer'}])]]) {
   const st=new MemoryStore(),h=createHandler({store:st,env:ENV});assert.equal((await invoke(h,create(ID,original))).statusCode,201);
   assert.equal((await invoke(h,create(ID,{...original,name:'  '+original.name+'  '}))).statusCode,200);
   assert.equal((await invoke(h,create(ID,other))).statusCode,409);assert.deepEqual((await invoke(h,undefined,get())).json().data,original);
 }
});


test('up to twelve customer questions are accepted and server-rendered without claiming search frequency',()=>{
 const data={...DATA,faqs:Array.from({length:12},(_,i)=>({question:`질문 ${i+1}`,answer:`답변 ${i+1}`}))};
 const normalized=normalizeData(data); assert.equal(normalized.faqs.length,12);
 const html=renderStore(scope,{id:ID,data:normalized}); assert.match(html,/고객 질문과 답변/); assert.match(html,/실제 검색 기록이 아닌 예상 질문/);
 assert.ok(html.includes('질문 12')); assert.ok(html.includes('답변 12'));
 assert.throws(()=>normalizeData({...data,faqs:[...data.faqs,{question:'초과',answer:'초과'}]}));
});
