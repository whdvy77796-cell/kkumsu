import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, RedisStore, ownerReplacement, rawObjectMembers, STORES_LUA, OWNER_STORES_LUA } from '../lib/guard.mjs';
import { normalizeData, renderStore, requestScope, storeKeys, hashPassword } from '../lib/stores.mjs';
import { sourceHash, getCurrentTranslations } from '../lib/store-translations.mjs';
import { ownerKeys } from '../lib/owner-stores.mjs';
import { SESSION_BINDING } from '../lib/owner-auth.mjs';
import { createHandler as publicHandler } from '../api/stores.js';
import { createHandler as ownerHandler } from '../api/owner-stores.js';

// Synthetic data only. No Redis, network, OAuth provider or live service calls.
const id='t'.repeat(22), accountId='synthetic-translation-owner', password='synthetic-password';
const env={SESSION_SECRET:'synthetic-test-secret',YB_AUTH_ORIGIN:'http://localhost:3199'};
const headers={host:'localhost:3199',origin:env.YB_AUTH_ORIGIN,'content-type':'application/json'};
const scope=requestScope({headers},env), keys=storeKeys(scope,id);
const base={name:'합성 가게',address:'서울 합성로 12',headline:'가게 소개',intro:'좌석 20개입니다.',sections:[],faqs:[]};
const passwordHash=await hashPassword(password), revision='a'.repeat(32), nextRevision='b'.repeat(32);
function translated(source=base,label='fresh') {
 const value={...structuredClone(source),intro:'There are 20 seats '+label+'.'};
 return normalizeData({...source,translations:{sourceHash:sourceHash(source),en:structuredClone(value),ja:structuredClone(value),zh:structuredClone(value)}});
}
function member(raw,key) {const m=rawObjectMembers(raw).members.get(key);return m?raw.slice(m.first,m.last):undefined;}
function fixture({translations=false,unknown=false,legacy=false,persistent=false}={}) {
 const st=new MemoryStore(),now=Date.now(),expiresAt=now+3600000;
 const data=translations?translated(base,'old'):structuredClone(base);
 let raw=JSON.stringify({id,data,password:passwordHash,revision,createdAt:now-1000,updatedAt:now-1000,hidden:false,expiresAt,ownerAccountId:accountId});
 if(unknown) raw=raw.replace('"data":{','"futureRecord":{"large":900719925474099312345,"x":1,"x":2},"data":{"futureData":{"large":900719925474099312345,"x":1,"x":2},');
 if(legacy) raw=raw.replace('"sections":[]','"sections":{ }').replace('"faqs":[]','"faqs":{}');
 raw=raw.replace('"password":','"password" : ');
 st.kv.set(keys[0],raw);st.kv.set(keys[1],new Map([[id,now-1000]]));st.kv.set(keys[2],new Map([['reporter','reason']]));
 st.publicExpiry=new Map(persistent?[]:[[keys[0],expiresAt],[keys[1],expiresAt]]);
 const proof={key:'yb:auth:v1:'+'1'.repeat(64)+':session:'+'2'.repeat(64),accountId,provider:'google',origin:env.YB_AUTH_ORIGIN,namespace:scope.namespace,binding:'s'.repeat(43),issuedAt:now-1000,expiresAt:now-1000+604800000};
 st.kv.set(proof.key,JSON.stringify(proof));st.publicExpiry.set(proof.key,proof.expiresAt);
 const ownerIndex=ownerKeys(scope,accountId,id)[1];st.kv.set(ownerIndex,new Map([[id,now-1000]]));
 return {st,raw,now,expiresAt,proof,ownerIndex};
}
function payload(f,data=translated()) {return {now:f.now,updatedAt:f.now,expectedRaw:f.raw,expected:revision,revision:nextRevision,data,accountId,session:f.proof,scopeNamespace:scope.namespace,authOrigin:env.YB_AUTH_ORIGIN};}
function tx(f,kind,p=payload(f)) {return kind==='public'?f.st.publicTransaction('update',keys,p):f.st.ownerTransaction('update',[keys[0],f.ownerIndex,f.proof.key],p);}
function state(st) {return structuredClone({kv:st.kv,expiry:st.publicExpiry});}
async function call(f,kind,data,{pass=password,expectedRevision=revision}={}) {
 const session={accountId,provider:'google',[SESSION_BINDING]:f.proof};
 const handler=kind==='public'?publicHandler({store:f.st,env}):ownerHandler({store:f.st,env,authenticate:async()=>session});
 const body={action:'update',id,consent:true,data,...(kind==='public'?{password:pass}:{expectedRevision})};
 const req={method:'POST',url:kind==='public'?'/api/stores':'/api/owner-stores',headers,body,socket:{remoteAddress:'127.0.0.1'}};
 const res={statusCode:200,setHeader(){},end(body){this.body=JSON.parse(body);}};
 await handler(req,res);return res;
}

for(const kind of ['public','owner']) {
 test(kind+' HTTP update accepts validated translations instead of 503',async()=>{
  const f=fixture(),data=translated(),r=await call(f,kind,data);
  assert.equal(r.statusCode,200);assert.deepEqual(r.body.data.translations,data.translations);
  assert.deepEqual(getCurrentTranslations(r.body.data),data.translations);
  assert.equal((renderStore(scope,{id,data:r.body.data}).match(/public-store-translation/g)||[]).length,3);
  assert.equal(f.st.publicExpiry.get(keys[0]),f.expiresAt);
 });
 test(kind+' HTTP rejects malformed shape and stale hash before any write',async()=>{
  for(const mutate of [d=>delete d.translations.ja,d=>d.translations.sourceHash='0'.repeat(64),d=>d.translations.en.sections={}]) {
   const f=fixture(),data=translated();mutate(data);const before=state(f.st),r=await call(f,kind,data);
   assert.equal(r.statusCode,400);assert.equal(r.body.code,'FIELDS');assert.deepEqual(state(f.st),before);
  }
 });
 test(kind+' replaces full bundle atomically while preserving unknown and credential raw bytes',async()=>{
  const f=fixture({translations:true,unknown:true}),data=translated(base,'replacement');
  const beforeData=member(f.raw,'data'),beforeDirectory=structuredClone(f.st.kv.get(keys[1])),beforeReports=structuredClone(f.st.kv.get(keys[2]));
  assert.equal((await tx(f,kind,payload(f,data))).status,'ok');const out=f.st.kv.get(keys[0]);
  assert.equal(member(member(out,'data'),'translations'),JSON.stringify(data.translations));
  assert.equal(member(member(out,'data'),'futureData'),member(beforeData,'futureData'));
  for(const key of ['futureRecord','password','createdAt','hidden','expiresAt','ownerAccountId']) assert.equal(member(out,key),member(f.raw,key));
  assert.equal(f.st.publicExpiry.get(keys[0]),f.expiresAt);assert.deepEqual(f.st.kv.get(keys[1]),beforeDirectory);assert.deepEqual(f.st.kv.get(keys[2]),beforeReports);
 });
 test(kind+' omitted translations preserve exact legacy raw but stale bundle is not displayed',async()=>{
  const f=fixture({translations:true});
  const old=member(member(f.raw,'data'),'translations');
  f.raw=f.raw.replace(old,old.replace('"sourceHash":','"sourceHash" : ').replace('old','old\\u0020bundle'));f.st.kv.set(keys[0],f.raw);
  const original=member(member(f.raw,'data'),'translations'),data={...base,intro:'좌석 20개이며 소개를 수정했습니다.'};
  assert.equal((await tx(f,kind,payload(f,data))).status,'ok');const out=f.st.kv.get(keys[0]),record=JSON.parse(out);
  assert.equal(member(member(out,'data'),'translations'),original);assert.equal(getCurrentTranslations(record.data),null);
  assert.equal(renderStore(scope,record),renderStore(scope,{id,data}));
 });
 test(kind+' old records and omitted situations retain exact untouched bytes',async()=>{
  const f=fixture({unknown:true,legacy:true});
  f.raw=f.raw.replace('"data":{','"data":{"situations":[{"question":"q","answer":"a","future":900719925474099312345}],');f.st.kv.set(keys[0],f.raw);
  const p=payload(f,{intro:'수정한 소개'});assert.equal((await tx(f,kind,p)).status,'ok');
  const expected=f.raw.replace('"intro":'+JSON.stringify(base.intro),'"intro":"수정한 소개"').replace('"revision":"'+revision+'"','"revision":"'+nextRevision+'"').replace('"updatedAt":'+(f.now-1000),'"updatedAt":'+f.now);
  assert.equal(f.st.kv.get(keys[0]),expected);
 });
 test(kind+' wrong raw and revision CAS conflicts leave every key unchanged',async()=>{
  for(const mode of ['raw','revision']) {
   const f=fixture(),p=payload(f);
   if(mode==='raw') f.st.kv.set(keys[0],f.raw.replace('"hidden":false','"hidden":true'));else p.expected='c'.repeat(32);
   const before=state(f.st);assert.equal((await tx(f,kind,p)).status,'conflict');assert.deepEqual(state(f.st),before);
  }
 });
 test(kind+' concurrent identical revision updates have exactly one whole-bundle winner',async()=>{
  const f=fixture(),a=translated(base,'alpha'),b=translated(base,'beta');
  const result=await Promise.all([tx(f,kind,payload(f,a)),tx(f,kind,{...payload(f,b),revision:'c'.repeat(32)})]);
  assert.deepEqual(result.map(r=>r.status).sort(),['conflict','ok']);
  const saved=JSON.parse(f.st.kv.get(keys[0]));assert.deepEqual(saved.data.translations,a.translations);assert.equal(saved.revision,nextRevision);
 });
 test(kind+' persistent records remain persistent',async()=>{const f=fixture({persistent:true});assert.equal((await tx(f,kind)).status,'ok');assert.equal(f.st.publicExpiry.has(keys[0]),false);});
}

const malformed=[
 ['null',d=>d.translations=null],['undefined',d=>d.translations=undefined],['array',d=>d.translations=[]],['empty',d=>d.translations={}],
 ['missing language',d=>delete d.translations.zh],['extra language',d=>d.translations.ko=d.translations.en],
 ['wrong hash',d=>d.translations.sourceHash='0'.repeat(64)],['wrong source',d=>d.headline='원문 변경'],
 ['unknown data key',d=>d.extra='not allowed'],['extra translation field',d=>d.translations.en.extra='x'],
 ['cjson array input',d=>d.translations.en.sections={}],['wrong number',d=>d.translations.en.intro='There are 21 seats.'],
 ['markup',d=>d.translations.en.name='<script>bad</script>'],['link',d=>d.translations.en.name='https://evil.invalid'],
 ['wrong type',d=>d.translations.ja.name=1],['extra pairs',d=>d.translations.en.faqs=[{question:'q',answer:'a'}]]
];
for(const [label,mutate] of malformed) test('direct calls reject '+label+' without mutation or Redis EVAL',async()=>{
 for(const kind of ['public','owner']) {
  const f=fixture(),data=translated();mutate(data);const p=payload(f,data),before=state(f.st);
  assert.throws(()=>ownerReplacement(f.raw,'update',p));assert.equal((await tx(f,kind,p)).status,'blocked');assert.deepEqual(state(f.st),before);
  const calls=[],redis=new RedisStore('https://offline.invalid','synthetic',async(_url,options)=>{
   const command=JSON.parse(options.body);calls.push(command);assert.equal(command[0],'GET','malformed update must not reach EVAL');return new Response(JSON.stringify({result:f.raw}));
  });
  const result=kind==='public'?await redis.publicTransaction('update',keys,p):await redis.ownerTransaction('update',[keys[0],f.ownerIndex,f.proof.key],p);
  assert.equal(result.status,'blocked');assert.equal(calls.length,kind==='public'?0:1);
 }
});

test('mixed public/owner concurrent updates cannot tear translations or bypass CAS',async()=>{
 const f=fixture(),a=translated(base,'password'),b=translated(base,'oauth');
 const result=await Promise.all([tx(f,'public',payload(f,a)),tx(f,'owner',{...payload(f,b),revision:'c'.repeat(32)})]);
 assert.deepEqual(result.map(r=>r.status),['ok','conflict']);assert.deepEqual(JSON.parse(f.st.kv.get(keys[0])).data.translations,a.translations);
});
test('owner session revocation and other-account ownership still deny translated updates',async()=>{
 for(const mode of ['logout','owner']) {
  const f=fixture();if(mode==='logout')f.st.kv.delete(f.proof.key);else {f.raw=f.raw.replace(accountId,'other-owner');f.st.kv.set(keys[0],f.raw);}
  const before=state(f.st);assert.equal((await tx(f,'owner')).status,mode==='logout'?'session':'denied');assert.deepEqual(state(f.st),before);
 }
});
test('password API still rejects wrong password with valid translations',async()=>{
 const f=fixture(),r=await call(f,'public',translated(),{pass:'wrong-password'});assert.equal(r.statusCode,403);assert.equal(f.st.kv.get(keys[0]),f.raw);
});
for(const kind of ['public','owner']) test(kind+' Redis mock receives exact CAS snapshot and replacement in a single EVAL',async()=>{
 const f=fixture({unknown:true}),p=payload(f),calls=[];
 const redis=new RedisStore('https://offline.invalid','synthetic',async(_url,options)=>{
  const command=JSON.parse(options.body);calls.push(command);
  if(command[0]==='GET')return new Response(JSON.stringify({result:f.raw}));
  assert.equal(command[0],'EVAL');assert.equal(command[1],kind==='public'?STORES_LUA:OWNER_STORES_LUA);
  const sent=JSON.parse(command.at(-1));assert.equal(sent.expectedRaw,f.raw);
  assert.deepEqual(JSON.parse(sent.replacementRaw).data.translations,p.data.translations);
  assert.equal(member(sent.replacementRaw,'futureRecord'),member(f.raw,'futureRecord'));
  assert.equal(member(sent.replacementRaw,'password'),member(f.raw,'password'));
  return new Response(JSON.stringify({result:JSON.stringify({status:'ok',recordRaw:sent.replacementRaw})}));
 });
 const r=kind==='public'?await redis.publicTransaction('update',keys,p):await redis.ownerTransaction('update',[keys[0],f.ownerIndex,f.proof.key],p);
 assert.equal(r.status,'ok');assert.deepEqual(calls.map(c=>c[0]),kind==='public'?['EVAL']:['GET','EVAL']);
 assert.match(kind==='public'?STORES_LUA:OWNER_STORES_LUA,/'KEEPTTL'/);
});

for(const kind of ['public','owner']) {
 test(kind+' omitted malformed stored translations are preserved byte-for-byte without blocking Korean edits',async()=>{
  const f=fixture({translations:true}),old=member(member(f.raw,'data'),'translations');
  const malformedRaw='{ "future":900719925474099312345,"duplicate":1,"duplicate":2 }';
  f.raw=f.raw.replace(old,malformedRaw);f.st.kv.set(keys[0],f.raw);
  assert.equal((await tx(f,kind,payload(f,{...base,intro:'한국어 수정'}))).status,'ok');
  const out=f.st.kv.get(keys[0]);assert.equal(member(member(out,'data'),'translations'),malformedRaw);
  assert.equal(getCurrentTranslations(JSON.parse(out).data),null);
 });
 test(kind+' explicit validated bundle replaces malformed stored translations completely',async()=>{
  const f=fixture({translations:true}),old=member(member(f.raw,'data'),'translations');
  f.raw=f.raw.replace(old,'{"unknown":900719925474099312345,"en":{"unsafe":"old"}}');f.st.kv.set(keys[0],f.raw);
  const data=translated();assert.equal((await tx(f,kind,payload(f,data))).status,'ok');
  assert.deepEqual(JSON.parse(f.st.kv.get(keys[0])).data.translations,data.translations);
 });
}
