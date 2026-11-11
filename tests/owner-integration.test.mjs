import { storeKeys } from '../lib/stores.mjs';
import { lifecycleKeys } from '../lib/guard.mjs';
import { beginAccountWithdrawal, cleanupAccountWithdrawal } from '../lib/owner-auth.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../lib/guard.mjs';
import { createHandler as authHandler } from '../api/owner-auth.js';
import { createHandler as ownerHandler } from '../api/owner-stores.js';
import { createHandler as legacyHandler } from '../api/stores.js';

// 전부 합성 데이터와 메모리 저장소·가짜 제공자 응답이다. 외부 요청 없음.
const env={VERCEL:'1',VERCEL_ENV:'production',SESSION_SECRET:'synthetic-existing-store-secret-0123456789',YB_AUTH_ORIGIN:'https://www.kkumsu.com',YB_AUTH_SECRET:'synthetic-session-signing-secret-0123456789',YB_IDENTITY_KEY:'synthetic-stable-identity-secret-0123456789',YB_KAKAO_CLIENT_ID:'synthetic-client',YB_KAKAO_CLIENT_SECRET:'synthetic-secret'};
const id='abcdefghijklmnopqrstuv',password='synthetic-password';
const data={name:'검수용 가게',address:'서울 가상로 12',headline:'검수용 소개',intro:'실제 가게가 아닌 테스트 데이터입니다.',sections:[{heading:'영업시간',body:'월요일 휴무'}],faqs:[{question:'반려견이 함께 갈 수 있나요?',answer:'테라스에서만 가능합니다.'}]};
function req(url,method='GET',body,headers={}) { return {url,method,body,headers:{host:'www.kkumsu.com','x-forwarded-proto':'https','x-vercel-forwarded-for':'203.0.113.17',...(method==='POST'?{origin:env.YB_AUTH_ORIGIN,'content-type':'application/json'}:{}),...headers},socket:{encrypted:true,remoteAddress:'127.0.0.1'}}; }
function response(){return {statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(v){this.body=v||'';},json(){return JSON.parse(this.body)}};}
async function invoke(handler,url,method,body,headers){const res=response();await handler(req(url,method,body,headers),res);return res;}
function jar(res){return (res.headers['set-cookie']||[]).filter(s=>!s.includes('Max-Age=0')).map(s=>s.split(';')[0]).join('; ');}

test('synthetic OAuth session links and edits only its own legacy store; URL, QR target and password stay valid',async()=>{
  const store=new MemoryStore();let subject=111;
  const fakeProvider=async url=>Response.json(url.includes('/token')?{access_token:'synthetic-not-real',token_type:'bearer'}:{id:subject});
  const auth=authHandler({env,store,fetcher:fakeProvider}),legacy=legacyHandler({env,store}),owner=ownerHandler({env,store});
  const login=async()=>{const start=await invoke(auth,'/api/owner-auth?op=start&provider=kakao&return=dashboard');assert.equal(start.statusCode,303,start.body);const a=new URL(start.headers.location),state=a.searchParams.get('state'),callback=new URL(a.searchParams.get('redirect_uri'));callback.searchParams.set('state',state);callback.searchParams.set('code','synthetic-code');const finish=await invoke(auth,callback.pathname+callback.search,'GET',undefined,{cookie:jar(start)});assert.equal(finish.statusCode,303,finish.body);return {cookie:jar(finish),callback:callback.pathname+callback.search,stateCookie:jar(start)};};
  const created=await invoke(legacy,'/api/stores','POST',{action:'create',id,password,consent:true,data});assert.equal(created.statusCode,201,created.body);assert.equal(created.json().url,'/stores/'+id);
  const a=await login();const status=await invoke(auth,'/api/owner-auth?op=status','GET',undefined,{cookie:a.cookie});assert.equal(status.json().authenticated,true);
  const claim=await invoke(owner,'/api/owner-stores','POST',{action:'claim',id,password},{cookie:a.cookie});assert.equal(claim.statusCode,200,claim.body);assert.equal(claim.json().url,'/stores/'+id);
  const list=await invoke(owner,'/api/owner-stores?op=list','GET',undefined,{cookie:a.cookie});assert.deepEqual(list.json().stores.map(s=>s.id),[id]);
  const read=await invoke(owner,'/api/owner-stores?op=read&id='+id,'GET',undefined,{cookie:a.cookie});assert.equal(read.statusCode,200,read.body);assert.match(read.json().revision,/^[a-f0-9]{32}$/);
  const changed={...data,faqs:[{question:'반려견이 함께 갈 수 있나요?',answer:'테라스에서만 가능하며 매장 안은 불가합니다.'}]};
  const updated=await invoke(owner,'/api/owner-stores','POST',{action:'update',id,expectedRevision:read.json().revision,consent:true,data:changed},{cookie:a.cookie});assert.equal(updated.statusCode,200,updated.body);assert.equal(updated.json().id,id);assert.notEqual(updated.json().revision,read.json().revision);
  const publicPage=await invoke(legacy,'/api/stores?id='+id);assert.equal(publicPage.statusCode,200);assert.equal(publicPage.json().data.faqs[0].answer,changed.faqs[0].answer);
  const oldPassword=await invoke(legacy,'/api/stores','POST',{action:'auth',id,password});assert.equal(oldPassword.statusCode,200);assert.equal(oldPassword.json().url,'/stores/'+id);
  const stale=await invoke(owner,'/api/owner-stores','POST',{action:'update',id,expectedRevision:read.json().revision,consent:true,data},{cookie:a.cookie});assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'CONFLICT');
  subject=222;const b=await login();assert.equal((await invoke(owner,'/api/owner-stores?op=read&id='+id,'GET',undefined,{cookie:b.cookie})).statusCode,404);assert.equal((await invoke(owner,'/api/owner-stores','POST',{action:'claim',id,password},{cookie:b.cookie})).statusCode,403);
  assert.equal((await invoke(auth,a.callback,'GET',undefined,{cookie:a.stateCookie})).statusCode,400);
  const exit=await invoke(auth,'/api/owner-auth?op=logout','POST',{}, {cookie:a.cookie});assert.equal(exit.statusCode,200,exit.body);assert.equal((await invoke(owner,'/api/owner-stores?op=list','GET',undefined,{cookie:a.cookie})).statusCode,401);
  const after=await invoke(legacy,'/api/stores?id='+id);assert.equal(after.json().data.faqs[0].answer,changed.faqs[0].answer);
});

async function raceFixture({ ttlMs }={}) {
  const store=new MemoryStore(),time=ttlMs===undefined?Date.now():Date.now()-7*24*3600*1000+ttlMs;
  const auth=authHandler({env,store,now:time,fetcher:async url=>Response.json(url.includes('/token')?{access_token:'synthetic-only',token_type:'bearer'}:{id:999})});
  const start=await invoke(auth,'/api/owner-auth?op=start&provider=kakao'),url=new URL(new URL(start.headers.location).searchParams.get('redirect_uri'));
  url.searchParams.set('state',new URL(start.headers.location).searchParams.get('state'));url.searchParams.set('code','synthetic-code');
  const finish=await invoke(auth,url.pathname+url.search,'GET',undefined,{cookie:jar(start)});assert.equal(finish.statusCode,303,finish.body);
  const cookie=jar(finish),owner=ownerHandler({env,store}),legacy=legacyHandler({env,store});
  assert.equal((await invoke(legacy,'/api/stores','POST',{action:'create',id,password,consent:true,data})).statusCode,201);
  const sessionKey=[...store.kv.keys()].find(k=>k.includes(':session:')),recordKey=[...store.kv.keys()].find(k=>k.endsWith(':record:'+id));
  return {store,auth,owner,cookie,sessionKey,recordKey};
}
function pauseMutation(store,action) {
  let arrive,release;const entered=new Promise(r=>arrive=r),gate=new Promise(r=>release=r),base=store.ownerTransaction.bind(store);
  store.ownerTransaction=async(op,keys,p)=>{if(op===action){arrive();await gate;}return base(op,keys,p);};
  return {entered,release};
}
async function mutationInput(f,action) {
  if(action==='claim')return {action,id,password};
  assert.equal((await invoke(f.owner,'/api/owner-stores','POST',{action:'claim',id,password},{cookie:f.cookie})).statusCode,200);
  if(action==='unlink')return {action,id};
  const read=await invoke(f.owner,'/api/owner-stores?op=read&id='+id,'GET',undefined,{cookie:f.cookie});
  return {action,id,consent:true,expectedRevision:read.json().revision,data:{...data,intro:'must-not-be-saved'}};
}
for(const action of ['claim','update','unlink'])test('atomic session: delayed '+action+' loses to completed logout without changing store',async()=>{
  const f=await raceFixture(),body=await mutationInput(f,action),before=f.store.kv.get(f.recordKey),gate=pauseMutation(f.store,action);
  const pending=invoke(f.owner,'/api/owner-stores','POST',body,{cookie:f.cookie});await gate.entered;
  const logout=await invoke(f.auth,'/api/owner-auth?op=logout','POST',{}, {cookie:f.cookie});assert.equal(logout.statusCode,200);
  gate.release();const result=await pending;assert.equal(result.statusCode,401,result.body);assert.equal(result.json().code,'SESSION');assert.equal(f.store.kv.get(f.recordKey),before);
  assert.ok(!result.body.includes(f.sessionKey));assert.ok(!result.body.includes(f.cookie));
});
for(const action of ['claim','update','unlink'])test('atomic session: '+action+' expires at commit using wall clock, despite stale request now and live Redis TTL',async()=>{
  const f=await raceFixture({ttlMs:700}),body=await mutationInput(f,action),before=f.store.kv.get(f.recordKey),session=JSON.parse(f.store.kv.get(f.sessionKey));
  // Model EX TTL outliving app-issued absolute expiry (e.g. clock skew). Both
  // independent guards must hold, not merely TTL or the initial request time.
  f.store.publicExpiry.set(f.sessionKey,session.expiresAt+60000);
  const gate=pauseMutation(f.store,action),pending=invoke(f.owner,'/api/owner-stores','POST',body,{cookie:f.cookie});await gate.entered;
  await new Promise(r=>setTimeout(r,Math.max(0,session.expiresAt-Date.now()+10)));gate.release();
  const result=await pending;assert.equal(result.statusCode,401,result.body);assert.equal(f.store.kv.get(f.recordKey),before);
});
test('atomic session: replacing session value with another account after authentication cannot authorize a pending write',async()=>{
  const f=await raceFixture(),body=await mutationInput(f,'update'),before=f.store.kv.get(f.recordKey),gate=pauseMutation(f.store,'update');
  const pending=invoke(f.owner,'/api/owner-stores','POST',body,{cookie:f.cookie});await gate.entered;
  const current=JSON.parse(f.store.kv.get(f.sessionKey));f.store.kv.set(f.sessionKey,JSON.stringify({...current,accountId:'oa_'+'B'.repeat(43)}));gate.release();
  const result=await pending;assert.equal(result.statusCode,401,result.body);assert.equal(f.store.kv.get(f.recordKey),before);assert.ok(!result.body.includes(f.sessionKey));
});

for(const action of ['claim','update','unlink'])test('withdrawal atomically wins pending '+action+' and preserves public record',async()=>{
 const f=await raceFixture(),body=await mutationInput(f,action),before=JSON.parse(f.store.kv.get(f.recordKey)),s=JSON.parse(f.store.kv.get(f.sessionKey)),scope={namespace:s.namespace},args={store:f.store,scope,accountId:s.accountId,operationId:'W'.repeat(22)},gate=pauseMutation(f.store,action);
 const pending=invoke(f.owner,'/api/owner-stores','POST',body,{cookie:f.cookie});await gate.entered;const begin=await beginAccountWithdrawal(args);gate.release();assert.equal((await pending).statusCode,401);
 const expiry=f.store.publicExpiry.get(f.recordKey);const done=await cleanupAccountWithdrawal({...args,cutoff:begin.cutoff});assert.equal(done.status,'done');const after=JSON.parse(f.store.kv.get(f.recordKey));const wasLinked=before.ownerAccountId!==undefined;delete before.ownerAccountId;assert.match(after.revision,/^[a-f0-9]{32}$/);if(wasLinked)assert.notEqual(after.revision,before.revision);else assert.equal(after.revision,before.revision);before.revision=after.revision;assert.deepEqual(after,before);assert.equal(f.store.publicExpiry.get(f.recordKey),expiry);
});

for(const legacyMissingRevision of [false,true])test('detach revision blocks stale legacy full-record resurrection, missing revision='+legacyMissingRevision,async()=>{
 const f=await raceFixture();await mutationInput(f,'update');const s=JSON.parse(f.store.kv.get(f.sessionKey)),scope={namespace:s.namespace},record=JSON.parse(f.store.kv.get(f.recordKey));record.unknown={nested:[[],{},'escaped " \\ content']};if(legacyMissingRevision)delete record.revision;f.store.kv.set(f.recordKey,JSON.stringify(record));const expiry=Date.now()+600000;f.store.publicExpiry.set(f.recordKey,expiry);
 const stale=await f.store.getJson(f.recordKey),args={store:f.store,scope,accountId:s.accountId,operationId:'R'.repeat(22)},began=await beginAccountWithdrawal(args),done=await cleanupAccountWithdrawal({...args,cutoff:began.cutoff});assert.equal(done.status,'done');
 const cleanRaw=f.store.kv.get(f.recordKey),clean=JSON.parse(cleanRaw);assert.equal(clean.ownerAccountId,undefined);assert.match(clean.revision,/^[a-f0-9]{32}$/);assert.notEqual(clean.revision,stale.revision);assert.deepEqual(clean.data,stale.data);assert.deepEqual(clean.password,stale.password);assert.deepEqual(clean.unknown,stale.unknown);assert.equal(clean.id,stale.id);assert.equal(f.store.publicExpiry.get(f.recordKey),expiry);
 const update=await f.store.publicTransaction('update',storeKeys(scope,id),{now:Date.now(),expected:stale.revision,record:{...stale,data:{...stale.data,intro:'stale attempted resurrection'}},ttl:0});assert.equal(update.status,'conflict');assert.equal(f.store.kv.get(f.recordKey),cleanRaw);assert.equal(f.store.publicExpiry.get(f.recordKey),expiry);
});

test('ambiguous revision blocks entire cleanup batch without changing record or TTL',async()=>{
 const f=await raceFixture();await mutationInput(f,'update');const s=JSON.parse(f.store.kv.get(f.sessionKey)),scope={namespace:s.namespace},raw=f.store.kv.get(f.recordKey),ambiguous=raw.slice(0,-1)+',"revision":"duplicate"}';f.store.kv.set(f.recordKey,ambiguous);const expiry=Date.now()+600000;f.store.publicExpiry.set(f.recordKey,expiry);const args={store:f.store,scope,accountId:s.accountId,operationId:'D'.repeat(22)},began=await beginAccountWithdrawal(args),done=await cleanupAccountWithdrawal({...args,cutoff:began.cutoff});assert.equal(done.status,'blocked');assert.equal(done.reason,'RAW_UNSAFE');assert.equal(f.store.kv.get(f.recordKey),ambiguous);assert.equal(f.store.publicExpiry.get(f.recordKey),expiry);assert.equal(JSON.parse(f.store.kv.get(lifecycleKeys(scope,s.accountId).barrier)).phase,'cleanup');assert.ok(f.store.kv.has(f.sessionKey),'prevalidation rejects batch before deleting any sessions');
});

for(const partial of [false,true])test('BLOCKER: lost owner index cannot certify all links detached, partial='+partial,{todo:'Needs authoritative account incarnation and index count/membership reconciliation'},async()=>{
 const f=await raceFixture();await mutationInput(f,'update');const s=JSON.parse(f.store.kv.get(f.sessionKey)),scope={namespace:s.namespace},k=lifecycleKeys(scope,s.accountId);let record2;
 if(partial){const id2='b'.repeat(22),legacy=legacyHandler({env,store:f.store});assert.equal((await invoke(legacy,'/api/stores','POST',{action:'create',id:id2,password,consent:true,data})).statusCode,201);assert.equal((await invoke(f.owner,'/api/owner-stores','POST',{action:'claim',id:id2,password},{cookie:f.cookie})).statusCode,200);record2=storeKeys(scope,id2)[0];f.store.kv.get(k.owner).delete(id);}else{f.store.kv.delete(k.owner);f.store.publicExpiry.delete(k.owner);}
 const args={store:f.store,scope,accountId:s.accountId,operationId:'I'.repeat(22)},b=await beginAccountWithdrawal(args),done=await cleanupAccountWithdrawal({...args,cutoff:b.cutoff});const stillOwned=[f.recordKey,...(record2?[record2]:[])].some(key=>JSON.parse(f.store.kv.get(key)).ownerAccountId===s.accountId);assert.equal(done.status==='done'&&stillOwned,false,'must not certify completion while an owned record survives');
});


for(const loseBarrier of [false,true])for(const action of ['list','read','claim','update','unlink'])test('scope fence atomically rejects pending '+action+', barrierLost='+loseBarrier,async()=>{
 const f=await raceFixture();let body;if(action==='list'||action==='read')await mutationInput(f,'update');else body=await mutationInput(f,action);
 const s=JSON.parse(f.store.kv.get(f.sessionKey)),scope={namespace:s.namespace},k=lifecycleKeys(scope,s.accountId),before=f.store.kv.get(f.recordKey),gate=pauseMutation(f.store,action),url=action==='list'?'/api/owner-stores?op=list':action==='read'?'/api/owner-stores?op=read&id='+id:'/api/owner-stores';
 const pending=invoke(f.owner,url,body?'POST':'GET',body,{cookie:f.cookie});await gate.entered;
 if(loseBarrier)await beginAccountWithdrawal({store:f.store,scope,accountId:s.accountId,operationId:'P'.repeat(22)});f.store.kv.delete(k.generation);if(loseBarrier){f.store.kv.delete(k.barrier);f.store.publicExpiry.delete(k.barrier);}
 const start=await invoke(f.auth,'/api/owner-auth?op=start&provider=kakao');assert.equal(start.statusCode,303);assert.notEqual(JSON.parse(f.store.kv.get(k.generation)).incarnation,s.incarnation);assert.ok(f.store.kv.has(f.sessionKey));gate.release();const result=await pending;assert.equal(result.statusCode,401,result.body);assert.equal(f.store.kv.get(f.recordKey),before);
});

test('BLOCKER: a fresh login after scope+barrier loss must not inherit pre-loss owner links',{todo:'Scope fencing rejects old credentials but account/link incarnation and recovery authority are still absent'},async()=>{
 const f=await raceFixture();await mutationInput(f,'update');const s=JSON.parse(f.store.kv.get(f.sessionKey)),scope={namespace:s.namespace},k=lifecycleKeys(scope,s.accountId);await beginAccountWithdrawal({store:f.store,scope,accountId:s.accountId,operationId:'Q'.repeat(22)});f.store.kv.delete(k.generation);f.store.kv.delete(k.barrier);f.store.publicExpiry.delete(k.barrier);
 const start=await invoke(f.auth,'/api/owner-auth?op=start&provider=kakao'),authorization=new URL(start.headers.location),callback=new URL(authorization.searchParams.get('redirect_uri'));callback.searchParams.set('state',authorization.searchParams.get('state'));callback.searchParams.set('code','synthetic-code');const finish=await invoke(f.auth,callback.pathname+callback.search,'GET',undefined,{cookie:jar(start)});assert.equal(finish.statusCode,303);const read=await invoke(f.owner,'/api/owner-stores?op=read&id='+id,'GET',undefined,{cookie:jar(finish)});assert.equal(read.statusCode,404,'fresh incarnation must not automatically inherit old accountId-only links');
});
