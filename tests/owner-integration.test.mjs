import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { MemoryStore, OWNER_STORES_LUA } from '../lib/guard.mjs';
import { createHandler as authHandler } from '../api/owner-auth.js';
import { createHandler as ownerHandler } from '../api/owner-stores.js';
import { createHandler as legacyHandler } from '../api/stores.js';

// 전부 합성 데이터와 메모리 저장소·가짜 제공자 응답이다. 외부 요청 없음.
const env={VERCEL:'1',VERCEL_ENV:'production',SESSION_SECRET:'synthetic-existing-store-secret-0123456789',YB_AUTH_ORIGIN:'https://www.kkumsu.com',YB_AUTH_SECRET:'synthetic-session-signing-secret-0123456789',YB_IDENTITY_KEY:'synthetic-stable-identity-secret-0123456789',YB_KAKAO_CLIENT_ID:'synthetic-client',YB_KAKAO_CLIENT_SECRET:'synthetic-secret',YB_GOOGLE_CLIENT_ID:'synthetic-google-client',YB_GOOGLE_CLIENT_SECRET:'synthetic-google-secret'};
const id='abcdefghijklmnopqrstuv',password='synthetic-password';
const data={name:'검수용 가게',address:'서울 가상로 12',headline:'검수용 소개',intro:'실제 가게가 아닌 테스트 데이터입니다.',sections:[{heading:'영업시간',body:'월요일 휴무'}],faqs:[{question:'반려견이 함께 갈 수 있나요?',answer:'테라스에서만 가능합니다.'}]};
function req(url,method='GET',body,headers={}) { return {url,method,body,headers:{host:'www.kkumsu.com','x-forwarded-proto':'https','x-vercel-forwarded-for':'203.0.113.17',...(method==='POST'?{origin:env.YB_AUTH_ORIGIN,'content-type':'application/json'}:{}),...headers},socket:{encrypted:true,remoteAddress:'127.0.0.1'}}; }
function response(){return {statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(v){this.body=v||'';},json(){return JSON.parse(this.body)}};}
async function invoke(handler,url,method,body,headers){const res=response();await handler(req(url,method,body,headers),res);return res;}
function jar(res){return (res.headers['set-cookie']||[]).filter(s=>!s.includes('Max-Age=0')).map(s=>s.split(';')[0]).join('; ');}

for (const provider of ['kakao','google']) test(provider+' synthetic OAuth session links and edits only its own legacy store; URL, QR target and password stay valid',async()=>{
  const store=new MemoryStore();let subject=111,nonce;
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...rsa.publicKey.export({format:'jwk'}),kid:'integration-google',alg:'RS256',use:'sig'};
  const fakeProvider=async url=>{
    if(url==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[jwk]});
    if(!url.includes('/token'))return Response.json({id:subject});
    const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',sub:String(subject),aud:env.YB_GOOGLE_CLIENT_ID,nonce,iat:now,exp:now+3600,email:'discarded@example.invalid',email_verified:true})).toString('base64url');
    return Response.json({access_token:'synthetic-not-real',token_type:'bearer',...(provider==='google'?{id_token:h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),rsa.privateKey).toString('base64url')}:{})});
  };
  const auth=authHandler({env,store,fetcher:fakeProvider}),legacy=legacyHandler({env,store}),owner=ownerHandler({env,store});
  const login=async()=>{const start=await invoke(auth,'/api/owner-auth?op=start&provider='+provider+'&return=dashboard');assert.equal(start.statusCode,303,start.body);const a=new URL(start.headers.location),state=a.searchParams.get('state'),callback=new URL(a.searchParams.get('redirect_uri'));nonce=a.searchParams.get('nonce');callback.searchParams.set('state',state);callback.searchParams.set('code','synthetic-code');const finish=await invoke(auth,callback.pathname+callback.search,'GET',undefined,{cookie:jar(start)});assert.equal(finish.statusCode,303,finish.body);return {cookie:jar(finish),callback:callback.pathname+callback.search,stateCookie:jar(start)};};
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

test('Redis atomic session provider allowlist matches Google-enabled memory path without accepting arbitrary providers',()=>{
  assert.ok(OWNER_STORES_LUA.includes("(s.provider~='kakao' and s.provider~='naver' and s.provider~='google')"));
  assert.ok(OWNER_STORES_LUA.includes('s.provider~=proof.provider'));
});
