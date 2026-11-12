import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler, publicSummary } from '../api/ai-access.js';
import { HttpError, MemoryStore } from '../lib/guard.mjs';
import { requestScope, storeKeys } from '../lib/stores.mjs';
import { SESSION_BINDING, SESSION_TTL } from '../lib/owner-auth.mjs';

const NOW = Date.now(), ID = 'a'.repeat(22), OTHER_ID = 'b'.repeat(22), ACCOUNT = 'synthetic-account-A';
const ENV = { VERCEL: '1', VERCEL_ENV: 'production', YB_AUTH_ORIGIN: 'https://www.kkumsu.com', YB_AI_ACCESS_ENABLED: 'true', YB_AI_ACCESS_PROJECT_ID: 'prj_syntheticproject', YB_AI_ACCESS_DRAIN_SECRET: 'S'.repeat(40), YB_AI_ACCESS_STARTED_AT: new Date(NOW - 86400000).toISOString() };
const DATA = { state: 'active', since: ENV.YB_AI_ACCESS_STARTED_AT, updatedAt: new Date(NOW).toISOString(), lifetime: { verified: 4, unverified: 1 }, last7Days: { verified: 3, unverified: 1 }, breakdown: [{ provider: 'openai', purpose: 'search', verified: 4, unverified: 1 }] };
function req(url, extra = {}) { return { method: 'GET', url, headers: { host: 'www.kkumsu.com' }, ...extra }; }
function response() { return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(v) { this.body = v; }, json() { return JSON.parse(this.body); } }; }
async function invoke(h, url, extra) { const r = response(); await h(req(url, extra), r); return r; }
function authFixture(store, accountId = ACCOUNT) {
  const scope = requestScope(req('/'), ENV), issuedAt = NOW - 1000, expiresAt = issuedAt + SESSION_TTL * 1000;
  const key = `yb:auth:v1:${createHash('sha256').update(scope.namespace).digest('hex')}:session:${createHash('sha256').update(accountId).digest('hex')}`;
  const record = { accountId, provider: 'google', origin: ENV.YB_AUTH_ORIGIN, namespace: scope.namespace, binding: createHash('sha256').update('binding:'+accountId).digest('base64url'), issuedAt, expiresAt };
  store.kv.set(key, JSON.stringify(record)); store.publicExpiry ||= new Map(); store.publicExpiry.set(key, expiresAt);
  const session = { accountId, provider: 'google' }; Object.defineProperty(session, SESSION_BINDING, { value: { key, ...record } });
  return { session, scope, key };
}
function seed(store, scope, id, ownerAccountId) {
  const data = { name:'가상 가게',address:'서울 테스트구 1',headline:'가상',intro:'가상 소개',sections:[],faqs:[] };
  store.kv.set(storeKeys(scope,id)[0], JSON.stringify({id,data,ownerAccountId,revision:'a'.repeat(32),createdAt:NOW-1000,updatedAt:NOW-1000,hidden:false,expiresAt:null,password:{salt:'0'.repeat(32),hash:'0'.repeat(128)}}));
}
function setup(extra = {}) { const ownerStore = new MemoryStore(), statsStore = new MemoryStore(), fix = authFixture(ownerStore); seed(ownerStore,fix.scope,ID,ACCOUNT); seed(ownerStore,fix.scope,OTHER_ID,'synthetic-account-B'); const deps = { env: ENV, now: NOW, ownerStore, statsStore, authenticate: async () => fix.session, readSummary: async () => DATA, ...extra }; return { h:createHandler(deps), ownerStore, statsStore, fix, deps }; }

test('site summary returns only whitelisted aggregates and may use short public cache', async () => {
  const x=setup({readSummary:async()=>({...DATA,rawIp:'203.0.113.1',request:'/private?credential=synthetic',breakdown:[{...DATA.breakdown[0],userAgent:'private'}]})});
  const r=await invoke(x.h,'/api/ai-access?view=site'); assert.equal(r.statusCode,200); assert.deepEqual(r.json(),{...DATA,collectionStartedAt:ENV.YB_AI_ACCESS_STARTED_AT});
  assert.match(r.headers['cache-control'],/s-maxage=60/); assert.doesNotMatch(r.body,/203\.0\.113|private|credential|userAgent/i);
});
test('owned store requires authenticated current session and real server-side ownership', async () => {
  const x=setup(); let observed;
  x.deps.readSummary=async args => { observed=args; return DATA; };
  const h=createHandler(x.deps);
  const ok=await invoke(h,`/api/ai-access?view=store&id=${ID}`); assert.equal(ok.statusCode,200); assert.deepEqual(ok.json(),{...DATA,collectionStartedAt:ENV.YB_AI_ACCESS_STARTED_AT});
  assert.equal(observed.storeId,ID); assert.match(ok.headers['cache-control'],/no-store/); assert.equal(ok.headers.vary,'Cookie');
  assert.equal((await invoke(h,`/api/ai-access?view=store&id=${OTHER_ID}`)).statusCode,404);
  x.ownerStore.kv.delete(x.fix.key); assert.equal((await invoke(h,`/api/ai-access?view=store&id=${ID}`)).statusCode,401);
});
test('logged out and malformed IDs do not access private metrics, even before setup', async () => {
  let read=0;
  const x=setup({env:{...ENV,YB_AI_ACCESS_ENABLED:'false'},authenticate:async()=>{throw new HttpError(401,'SESSION','로그인이 필요해요.');},readSummary:async()=>{read++;return DATA;}});
  assert.equal((await invoke(x.h,`/api/ai-access?view=store&id=${ID}`)).statusCode,401);
  assert.equal((await invoke(x.h,'/api/ai-access?view=store&id=bad')).statusCode,400); assert.equal(read,0);
  const site=await invoke(x.h,'/api/ai-access?view=site'); assert.equal(site.statusCode,200); assert.equal(site.json().state,'not_started'); assert.equal(site.json().lifetime,null);
});
test('rejects invalid methods, duplicate query fields, extra parameters, host spoofing', async () => {
  const x=setup();
  for (const url of ['/api/ai-access?view=site&view=store','/api/ai-access?view=site&id='+ID,'/api/ai-access?view=site&extra=1','/api/ai-access?view=store&id='+ID+'&id='+ID]) assert.equal((await invoke(x.h,url)).statusCode,400,url);
  assert.equal((await invoke(x.h,'/api/ai-access?view=site',{method:'POST'})).statusCode,405);
  assert.equal((await invoke(x.h,'/api/ai-access?view=site',{headers:{host:'www.kkumsu.com','x-forwarded-host':'evil.invalid'}})).statusCode,403);
});
test('no fallback to the operational store and failures are not reported as zero', async () => {
  const x=setup({statsStore:null,env:{...ENV,YB_AI_ACCESS_REDIS_URL:'https://same.invalid',YB_AI_ACCESS_REDIS_TOKEN:'synthetic',KV_REST_API_URL:'https://same.invalid/'},readSummary:async()=>{throw Error('not called');}});
  const r=await invoke(x.h,'/api/ai-access?view=site'); assert.equal(r.statusCode,200);assert.equal(r.json().state,'unavailable');assert.equal(r.json().lifetime,null);
  const alias=setup({statsStore:null,env:{...ENV,YB_AI_ACCESS_REDIS_URL:'https://same.invalid',YB_AI_ACCESS_REDIS_TOKEN:'synthetic',KV_REST_API_URL:'https://SAME.invalid:443/'}});
  assert.equal((await invoke(alias.h,'/api/ai-access?view=site')).json().state,'unavailable');
  const fail=setup({readSummary:async()=>{throw Error('synthetic internal secret');}}); const f=await invoke(fail.h,'/api/ai-access?view=site');assert.equal(f.json().state,'unavailable');assert.doesNotMatch(f.body,/secret/);
});
test('summary rejects malformed counts, unknown providers and unexpected state', () => {
  assert.deepEqual(publicSummary({...DATA,lifetime:{verified:-1,unverified:0}}).state,'unavailable');
  assert.deepEqual(publicSummary({...DATA,breakdown:[{provider:'evil',purpose:'search',verified:1,unverified:0}]}).state,'unavailable');
  assert.deepEqual(publicSummary({...DATA,updatedAt:'<img>'}).state,'unavailable');
  assert.deepEqual(publicSummary({...DATA,state:'not_started'}),{state:'not_started',since:null,updatedAt:null,lifetime:null,last7Days:null,breakdown:[]});
});
