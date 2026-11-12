import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../lib/guard.mjs';
import { requestScope } from '../lib/stores.mjs';
import { authConfig, SESSION_TTL } from '../lib/owner-auth.mjs';
import { createHandler } from '../api/local-auth.js';
import { createHandler as ownerHandler } from '../api/owner-auth.js';
import { localAuthAvailable, localAuthConfig, parseLocalInput, createLocalAuthSimulator, limitLocalAuth, localAccountId } from '../lib/local-auth.mjs';
const env = { VERCEL: '1', VERCEL_ENV: 'production', YB_AUTH_ORIGIN: 'https://auth.example.invalid', YB_AUTH_SECRET: 'synthetic-auth-secret-longer-than-32-characters', YB_IDENTITY_KEY: 'synthetic-identity-distinct-longer-than-32-characters', YB_LOCAL_AUTH_ENABLED: 'true', YB_LOCAL_AUTH_PROVIDER: 'firebase', YB_FIREBASE_PROJECT_ID: 'synthetic-project', YB_FIREBASE_API_KEY: 'AIza' + 'x'.repeat(35) };
const now = 1800000000000, email = 'person@example.invalid', password = 'synthetic-password', raw = JSON.stringify({ email, password });
const request = (op = 'login', headers = {}) => ({ method: 'POST', url: '/api/local-auth?op=' + op, headers: { host: 'auth.example.invalid', origin: env.YB_AUTH_ORIGIN, 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.1', 'content-type': 'application/json', ...headers }, socket: { encrypted: true }, body: raw });
const scope = requestScope(request(), env), config = authConfig(env);
async function invoke(h, req) { const res = { headers: {}, setHeader(k,v) { this.headers[k.toLowerCase()] = v; }, end(body) { this.body = body; } }; await h(req,res); return res; }
function simulator(overrides = {}) {
  const calls = [], user = { localId: 'synthetic-sub', email, emailVerified: false, ...overrides.user };
  const run = createLocalAuthSimulator({ config, scope, fetcher: async (url, options) => {
    calls.push({ url, options });
    if (overrides.fetcher) return overrides.fetcher(url,options);
    return Response.json(url.endsWith(':lookup') ? { users: [user] } : url.endsWith(':sendOobCode') ? { email } : { localId: user.localId, idToken: 'synthetic.id.token', refreshToken: 'discard-me', email });
  } }); return { run, calls };
}
test('hard feature gate cannot be enabled with syntactically valid Firebase config', async () => {
  assert.ok(localAuthConfig(env)); assert.equal(localAuthAvailable(env), false);
  for (const changed of [{ YB_LOCAL_AUTH_ENABLED: '1' }, { YB_FIREBASE_API_KEY: 'bad' }, { YB_FIREBASE_PROJECT_ID: '../bad' }, { YB_IDENTITY_KEY: env.YB_AUTH_SECRET }]) assert.equal(localAuthConfig({ ...env, ...changed }), null);
  let external = 0; const h = createHandler({ env, fetcher: () => { external++; throw Error(); } });
  for (const op of ['signup','login','reset']) { const r = await invoke(h,request(op)); assert.equal(r.statusCode,503); assert.equal(JSON.parse(r.body).code,'LOCAL_AUTH_DISABLED'); assert.equal(r.headers['set-cookie'],undefined); for (const value of [email,password]) assert.ok(!r.body.includes(value)); }
  assert.equal(external,0);
  const status = await invoke(ownerHandler({ env, store: new MemoryStore(), now }), { ...request(), method:'GET', url:'/api/owner-auth?op=status' });
  assert.equal(JSON.parse(status.body).local,false); assert.equal(SESSION_TTL,604800);
});
test('input grammar rejects malformed duplicate decoded keys, extras, objects and unsafe values', () => {
  assert.equal(parseLocalInput(raw,'login').email,email);
  assert.equal(parseLocalInput(' { "email" : "PERSON@example.invalid" } ','reset').email,email);
  for (const value of ['{"email":"a@b.invalid","email":"b@b.invalid"}', '{"email":"a@b.invalid","\\u0065mail":"b@b.invalid"}', '{"email":"a@b.invalid",}', '{"email":null}', '{"email":"a@b.invalid","extra":"x"}', '{}', '[]', {email}, '{"email":"a..b@example.invalid"}', '{"email":"a@-bad.invalid"}', 'x'.repeat(4097)]) assert.throws(() => parseLocalInput(value,'reset'));
  assert.throws(() => parseLocalInput(JSON.stringify({email,password:'short'}),'signup'));
  assert.throws(() => parseLocalInput(JSON.stringify({email,password:'x\nsecret'}),'login'));
});
test('HTTP rejects cross-origin, same-site, method and polluted URLs without network/cookies', async () => {
  const h = createHandler({env});
  for (const headers of [{origin:'https://evil.invalid'}, {origin:undefined}, {'sec-fetch-site':'same-site'}, {'sec-fetch-site':'cross-site'}]) assert.equal((await invoke(h,request('login',headers))).statusCode,403);
  assert.equal((await invoke(h,{...request(),method:'GET'})).statusCode,405);
  for (const url of ['/api/local-auth?op=login&op=signup','/api/local-auth?op=login&email=private','https://evil.invalid/api/local-auth?op=login']) assert.equal((await invoke(h,{...request(),url})).statusCode,400);
  assert.equal((await invoke(h,{...request(),query:{op:['login']}})).statusCode,400);
});
test('signup uses managed verification, reset generic messaging and no credential output', async () => {
  const x = simulator(); const success = await x.run('signup',raw);
  assert.equal(success.accepted,true); assert.equal(x.calls.length,3);
  assert.equal(JSON.parse(x.calls[2].options.body).requestType,'VERIFY_EMAIL');
  for (const c of x.calls) { assert.match(c.url,/^https:\/\/identitytoolkit.googleapis.com\/v1\/accounts:/); assert.ok(!c.url.includes('?')); assert.equal(c.options.redirect,'error'); assert.equal(c.options.cache,'no-store'); assert.ok(c.options.signal); }
  assert.ok(!JSON.stringify(success).includes(email)); assert.ok(!JSON.stringify(success).includes('token'));
  const duplicate = simulator({fetcher: async () => Response.json({error:{message:'EMAIL_EXISTS'}},{status:400})}); assert.deepEqual(await duplicate.run('signup',raw),success);
  const reset = await x.run('reset',JSON.stringify({email}));
  const absent = simulator({fetcher: async () => Response.json({error:{message:'EMAIL_NOT_FOUND'}},{status:400})}); assert.deepEqual(await absent.run('reset',JSON.stringify({email})),reset);
  assert.equal(JSON.parse(x.calls.at(-1).options.body).requestType,'PASSWORD_RESET');
});
test('lookup is mandatory, unverified/mismatched/disabled identities cannot login; verified still blocked', async () => {
  for (const user of [{emailVerified:false},{emailVerified:'true'},{email:'other@example.invalid'},{disabled:true}]) await assert.rejects(simulator({user}).run('login',raw),{code:'LOCAL_CREDENTIALS'});
  const x = simulator({user:{emailVerified:true}});
  const results = await Promise.allSettled(Array.from({length:12},()=>x.run('login',raw)));
  assert.ok(results.every(r=>r.status==='rejected' && r.reason.code==='LOCAL_SESSION_RELEASE_BLOCKED'));
  assert.equal(x.calls.filter(c=>c.url.endsWith(':lookup')).length,12);
});
test('remote failures, redirects, oversized bodies and private provider errors fail closed', async () => {
  for (const fetcher of [async()=>{throw Error('private');},async()=>new Response('not-json'),async()=>new Response('x'.repeat(32769)),async()=>Response.json({error:{message:'private-password'}},{status:503}),async()=>({redirected:true}),async()=>Response.json({users:[]}),async()=>Response.json({idToken:'bad token',localId:'sub'})]) {
    await assert.rejects(simulator({fetcher}).run('login',raw), e => { assert.ok(!e.message.includes('private')); return e.status >= 400; });
  }
});
test('HMAC identities separate project/subject/scope, stable across session secret rotation', () => {
  const id=localAccountId(config,scope,'synthetic-project','sub'); assert.match(id,/^oa_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(id,localAccountId(config,scope,'synthetic-other','sub'));
  assert.notEqual(id,localAccountId(config,scope,'synthetic-project','other'));
  assert.notEqual(id,localAccountId(config,{...scope,namespace:'other'},'synthetic-project','sub'));
  assert.equal(id,localAccountId({...config,secret:'rotated'},scope,'synthetic-project','sub'));
});
test('account, IP and global rate budgets atomic bounded, no raw identifiers persisted', async () => {
  for (const mode of ['account','ip','global']) {
    const store=new MemoryStore(), n=mode==='account'?5:mode==='ip'?15:200;
    const results=await Promise.allSettled(Array.from({length:n+8},(_,i)=>limitLocalAuth({req:request('login',{'x-vercel-forwarded-for':mode==='global'?'198.18.0.'+(i+1):'203.0.113.1'}),scope,env,store,email:mode==='account'?email:'p'+i+'@example.invalid',now})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,n);
    assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.status===429));
    const stored=JSON.stringify([...store.kv]); assert.ok(!stored.includes('example.invalid')); assert.ok(!stored.includes('203.0.113'));
    assert.ok(store.kv.size<=1+2*n);
  }
  await assert.rejects(limitLocalAuth({req:request('login',{'x-vercel-forwarded-for':undefined,'x-forwarded-for':'1.1.1.1'}),scope,env,store:new MemoryStore(),email,now}),{code:'AUTH_RATE_IP'});
  await assert.rejects(limitLocalAuth({req:request(),scope,env,store:{publicTransaction:async()=>{throw Error();}},email,now}),{code:'LOCAL_RATE_STORE'});
});
test('reset racing verified lookup and repeated requests never issue or resurrect sessions', async () => {
  let release, entered; const gate=new Promise(r=>release=r), seen=new Promise(r=>entered=r);
  const x=simulator({fetcher:async url=>{ if(url.endsWith(':lookup')) { entered(); await gate; return Response.json({users:[{localId:'synthetic-sub',email,emailVerified:true,validSince:'9999999999'}]}); } return Response.json({localId:'synthetic-sub',idToken:'synthetic.token'}); }});
  const pending=x.run('login',raw); await seen; await x.run('reset',JSON.stringify({email})); release(); await assert.rejects(pending,{code:'LOCAL_SESSION_RELEASE_BLOCKED'});
  // This is fail-closed proof, not evidence of implemented distributed revocation.
});
