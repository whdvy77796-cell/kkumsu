import { test } from 'node:test';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { createHandler } from '../api/owner-auth.js';
import { MemoryStore, RedisStore, HttpError, lifecycleKeys, detachOwnerRaw, LIFECYCLE_RETENTION } from '../lib/guard.mjs';
import { requestScope } from '../lib/stores.mjs';
import { requireSession, providerSubject, SESSION_COOKIE, STATE_COOKIE, SESSION_TTL, STATE_TTL, AUTH_LUA, AUTH_RATE_LIMITS, beginAccountWithdrawal, cleanupAccountWithdrawal } from '../lib/owner-auth.mjs';
const ENV = { VERCEL: '1', VERCEL_ENV: 'production', YB_AUTH_ORIGIN: 'https://www.kkumsu.com', YB_AUTH_SECRET: 'synthetic-dedicated-auth-secret-at-least-32-bytes', YB_IDENTITY_KEY: 'synthetic-long-lived-identity-key-at-least-32-bytes', YB_KAKAO_CLIENT_ID: 'synthetic-kakao-client', YB_KAKAO_CLIENT_SECRET: 'synthetic-kakao-secret', YB_NAVER_CLIENT_ID: 'synthetic-naver-client', YB_NAVER_CLIENT_SECRET: 'synthetic-naver-secret' };
const TIME = 1800000000000;
const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...RSA.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
function idToken(nonce, claims = {}, header = {}, key = RSA.privateKey) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: JWK.kid, typ: 'JWT', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: 'https://nid.naver.com', sub: 'naver_subject_123', aud: ENV.YB_NAVER_CLIENT_ID, azp: ENV.YB_NAVER_CLIENT_ID, nonce, iat: TIME / 1000, exp: TIME / 1000 + 3600, ...claims })).toString('base64url');
  return h + '.' + p + '.' + sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url');
}
function request(url, headers = {}, method = 'GET') { return { url, method, headers: { host: 'www.kkumsu.com', 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.1', ...headers }, socket: { encrypted: true } }; }
async function invoke(h, url, headers, method) { const r = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(v) { this.body = v; }, json() { return JSON.parse(this.body); } }; await h(request(url, headers, method), r); return r; }
const jar = r => (r.headers['set-cookie'] || []).filter(s => !s.includes('Max-Age=0')).map(s => s.split(';')[0]).join('; ');
function setup(overrides = {}) {
  const store = overrides.store || new MemoryStore(), calls = [];
  let time = TIME, naverNonce;
  const fetcher = async (url, options) => { calls.push({ url, options }); return Response.json(url.endsWith('/jwks') ? { keys: [JWK] } : url.includes('/token') ? { access_token: 'synthetic-access-value', token_type: 'bearer', ...(url.includes('nid.naver.com') ? { id_token: idToken(naverNonce) } : {}) } : { id: 12345, properties: { nickname: 'discarded' } }); };
  const deps = { env: ENV, store, fetcher, now: () => time, ...overrides };
  return { h: createHandler(deps), store, calls, deps, setTime(v) { time = v; }, setNonce(v) { naverNonce = v; } };
}
async function start(x, provider = 'kakao', destination = 'dashboard', cookies = '') {
  const r = await invoke(x.h, '/api/owner-auth?op=start&provider=' + provider + '&return=' + destination, { cookie: cookies });
  assert.equal(r.statusCode, 303, r.body);
  const u = new URL(r.headers.location);
  if (provider === 'naver') x.setNonce(u.searchParams.get('nonce'));
  return { r, state: u.searchParams.get('state'), cookie: [cookies, jar(r)].filter(Boolean).join('; '), callback: u.searchParams.get('redirect_uri') };
}
const callbackUrl = (s, suffix = '&code=synthetic-code') => s.callback.replace(ENV.YB_AUTH_ORIGIN, '') + '&state=' + s.state + suffix;
async function login(x, provider = 'kakao', destination = 'dashboard', old = '') { const s = await start(x, provider, destination, old); const r = await invoke(x.h, callbackUrl(s), { cookie: s.cookie }); assert.equal(r.statusCode, 303, r.body); return { s, r, cookie: jar(r) }; }
async function session(x, cookies, options = {}) { const req = request('/api/owner-auth?op=status', { cookie: cookies, ...options.headers }); return requireSession({ req, store: x.store, scope: requestScope(req, options.env || ENV), env: options.env || ENV, now: options.now ?? TIME }); }

test('both providers: fixed authorization/code endpoints, exact callback, no client secret in redirect, private status and cookie flags', async () => {
  for (const provider of ['kakao', 'naver']) {
    const x = setup(), l = await login(x, provider);
    assert.equal(l.r.headers.location, ENV.YB_AUTH_ORIGIN + '/#/my-stores');
    assert.equal(l.s.callback, ENV.YB_AUTH_ORIGIN + '/api/owner-auth?op=callback&provider=' + provider);
    assert.ok(!l.s.r.headers.location.includes('secret'));
    for (const c of [...l.s.r.headers['set-cookie'], ...l.r.headers['set-cookie']]) { assert.match(c, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=/); assert.ok(!c.includes('Domain=')); }
    assert.ok(l.r.headers['set-cookie'].some(c => c.startsWith(SESSION_COOKIE + '=') && c.endsWith('Max-Age=' + SESSION_TTL)));
    const status = await invoke(x.h, '/api/owner-auth?op=status', { cookie: l.cookie });
    assert.deepEqual(status.json(), { authenticated: true, provider, providers: { kakao: true, naver: true } });
    assert.equal(status.headers['referrer-policy'], 'no-referrer'); assert.match(status.headers['content-security-policy'], /default-src 'none'/);
    const identity = await session(x, l.cookie); assert.match(identity.accountId, /^oa_/); assert.equal(identity.expiresAt - identity.issuedAt, SESSION_TTL * 1000);
    assert.equal(x.calls.length, 2); for (const c of x.calls) { assert.equal(c.options.redirect, 'error'); assert.ok(c.options.signal); assert.ok(!c.url.includes('synthetic-access')); }
    assert.equal(new URLSearchParams(x.calls[0].options.body).get('redirect_uri'), l.s.callback);
    const storage = JSON.stringify([...x.store.kv.values()]); for (const forbidden of ['synthetic-access', 'synthetic-code', 'discarded', '12345', 'naver_subject']) assert.ok(!storage.includes(forbidden));
  }
});
test('disabled configuration, no Redis default, no unsafe origin or fallback secret', async () => {
  for (const env of [{}, { ...ENV, YB_AUTH_SECRET: '' }, { ...ENV, YB_AUTH_SECRET: 'short' }, { ...ENV, YB_AUTH_ORIGIN: 'http://www.kkumsu.com' }, { ...ENV, YB_AUTH_ORIGIN: 'https://www.kkumsu.com/' }, { ...ENV, YB_AUTH_ORIGIN: 'https://user@www.kkumsu.com' }]) {
    const x = setup({ env }); assert.deepEqual((await invoke(x.h, '/api/owner-auth?op=status')).json(), { authenticated: false, provider: null, providers: { kakao: false, naver: false } }); assert.equal((await invoke(x.h, '/api/owner-auth?op=start&provider=kakao')).statusCode, 503); assert.equal(x.calls.length, 0);
  }
  const disabled = setup({ env: { ...ENV, YB_KAKAO_CLIENT_SECRET: '' } }); assert.equal((await invoke(disabled.h, '/api/owner-auth?op=status')).json().providers.kakao, false);
  const h = createHandler({ env: ENV, fetcher: () => { throw Error('network must not run'); } }); const unavailable = await invoke(h, '/api/owner-auth?op=status'); assert.equal(unavailable.statusCode, 503); assert.equal(unavailable.json().code, 'AUTH_STORE'); assert.equal((await invoke(h, '/api/owner-auth?op=start&provider=naver')).statusCode, 503);
});
test('bound signed state rejects missing, altered, foreign, duplicate cookie, expiry and provider mix-up', async () => {
  const x = setup(), a = await start(x), b = await start(x);
  const attempts = [ [callbackUrl(a), ''], [callbackUrl(a), b.cookie], [callbackUrl(a).replace(a.state, 'x'.repeat(43)), a.cookie], [callbackUrl(a), a.cookie + '; ' + a.cookie], [callbackUrl(a).replace('provider=kakao', 'provider=naver'), a.cookie], [callbackUrl(a), a.cookie.slice(0, -1) + (a.cookie.endsWith('A') ? 'B' : 'A')] ];
  for (const [url, cookies] of attempts) assert.ok((await invoke(x.h, url, { cookie: cookies })).statusCode >= 400);
  x.setTime(TIME + STATE_TTL * 1000); assert.equal((await invoke(x.h, callbackUrl(a), { cookie: a.cookie })).statusCode, 400); assert.equal(x.calls.length, 0);
});
test('concurrent callbacks exchange only once and replay is rejected', async () => {
  const x = setup(), s = await start(x);
  const results = await Promise.all(Array.from({ length: 8 }, () => invoke(x.h, callbackUrl(s), { cookie: s.cookie })));
  assert.equal(results.filter(r => r.statusCode === 303).length, 1); assert.equal(x.calls.length, 2); assert.equal((await invoke(x.h, callbackUrl(s), { cookie: s.cookie })).statusCode, 400);
});
test('cancellation and token/provider failure consume state and never leak provider messages', async () => {
  const x = setup(), s = await start(x); const r = await invoke(x.h, callbackUrl(s, '&error=access_denied&error_description=sensitive'), { cookie: s.cookie }); assert.equal(r.json().code, 'AUTH_CANCELLED'); assert.ok(!r.body.includes('sensitive')); assert.equal(x.calls.length, 0); assert.equal((await invoke(x.h, callbackUrl(s), { cookie: s.cookie })).statusCode, 400);
  for (const fetcher of [async () => Response.json({ error: 'sensitive' }, { status: 400 }), async () => { throw Error('sensitive'); }, async () => Response.json({ access_token: 'synthetic', token_type: 'unknown' }), async () => new Response('invalid-json'), async () => new Response('x'.repeat(66000))]) {
    const y = setup({ fetcher }), t = await start(y); const q = await invoke(y.h, callbackUrl(t), { cookie: t.cookie }); assert.equal(q.statusCode, 502); assert.ok(!q.body.includes('sensitive')); assert.equal((await invoke(y.h, callbackUrl(t), { cookie: t.cookie })).statusCode, 400);
  }
});
test('session fixation, rotation, cross-account/provider identity, expiry and revocation', async () => {
  const x = setup(), a = await login(x, 'kakao', 'dashboard', SESSION_COOKIE + '=' + 'a'.repeat(43)); assert.ok(!a.cookie.endsWith('a'.repeat(43)));
  const first = await session(x, a.cookie), b = await login(x, 'kakao', 'publish', a.cookie); assert.notEqual(a.cookie, b.cookie); assert.equal(first.accountId, (await session(x, b.cookie)).accountId); await assert.rejects(session(x, a.cookie), e => e instanceof HttpError && e.status === 401);
  const c = await login(x, 'naver', 'preview', b.cookie); assert.notEqual(first.accountId, (await session(x, c.cookie)).accountId); await assert.rejects(session(x, c.cookie, { now: TIME + SESSION_TTL * 1000 }), { status: 401 });
  const denied = await invoke(x.h, '/api/owner-auth?op=logout', { cookie: c.cookie, origin: 'https://evil.invalid' }, 'POST'); assert.equal(denied.statusCode, 403); await session(x, c.cookie);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=logout', { cookie: c.cookie, origin: ENV.YB_AUTH_ORIGIN }, 'POST')).statusCode, 200); await assert.rejects(session(x, c.cookie), { status: 401 });
});
test('logout racing token exchange prevents session establishment', async () => {
  let release, entered; const gate = new Promise(r => { release = r; }), enteredGate = new Promise(r => { entered = r; });
  const x = setup({ fetcher: async url => { if (url.includes('/token')) { entered(); await gate; return Response.json({ access_token: 'synthetic', token_type: 'bearer' }); } return Response.json({ id: 12345 }); } });
  const s = await start(x), pending = invoke(x.h, callbackUrl(s), { cookie: s.cookie }); await enteredGate;
  assert.equal((await invoke(x.h, '/api/owner-auth?op=logout', { cookie: s.cookie, origin: ENV.YB_AUTH_ORIGIN }, 'POST')).statusCode, 200); release(); const r = await pending; assert.equal(r.statusCode, 400); assert.ok(!JSON.stringify(r.headers['set-cookie']).includes(SESSION_COOKIE + '='));
});
test('return whitelist, query pollution, absolute URL, unknown operations and methods', async () => {
  const x = setup(); for (const destination of ['https://evil.invalid', '//evil.invalid', '../', '__proto__']) assert.equal((await invoke(x.h, '/api/owner-auth?op=start&provider=kakao&return=' + encodeURIComponent(destination))).statusCode, 400);
  for (const url of ['/api/owner-auth?op=test-login', '/api/owner-auth?op=status&op=start', '/api/owner-auth?op=start&provider=kakao&redirect_uri=https://evil.invalid', 'https://www.kkumsu.com/api/owner-auth?op=status', '/api/owner-auth/other?op=status']) assert.equal((await invoke(x.h, url)).statusCode, 400);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=logout')).statusCode, 405); assert.equal((await invoke(x.h, '/api/owner-auth?op=start&provider=kakao', {}, 'POST')).statusCode, 405);
  assert.equal(x.calls.length, 0);
});
test('unknown hosts, forwarded spoof, protocol downgrade, namespace changes, browser-session binding', async () => {
  const x = setup(), l = await login(x);
  for (const headers of [{ host: 'evil.invalid' }, { 'x-forwarded-host': 'evil.invalid' }, { 'x-forwarded-proto': 'http' }, { host: 'www.kkumsu.net' }]) { assert.ok((await invoke(x.h, '/api/owner-auth?op=status', headers)).statusCode >= 400); await assert.rejects(session(x, l.cookie, { headers }), e => e instanceof HttpError && [400,403].includes(e.status)); }
  await assert.rejects(session(x, l.cookie, { env: { ...ENV, VERCEL_ENV: 'preview' } }), { status: 401 });
  const s = await start(x, 'kakao', 'dashboard', l.cookie); assert.equal((await invoke(x.h, callbackUrl(s), { cookie: jar(s.r) })).statusCode, 400);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=start&provider=kakao', { origin: 'https://evil.invalid' })).statusCode, 403);
});
test('issuer identity parsing is strict and no email-based account merging', () => {
  assert.equal(providerSubject('kakao', { id: 123 }), '123'); assert.throws(() => providerSubject('naver', { resultcode: '00', response: { id: 'opaque_sub-1' } }), { status: 502 }, 'legacy Naver profile cannot bypass OIDC signature verification');
  for (const [p, v] of [['kakao',{ id: 0 }],['kakao',{ id: 9007199254740992 }],['kakao',{ id: '123' }],['kakao',{ sub: '123' }],['kakao',{ id: 123, code: -1 }],['naver',{ resultcode: '01', response: { id: 'a' } }],['naver',{ resultcode: '00', response: { email: 'a@b.invalid' } }],['naver',{ resultcode: '00', response: { id: {} } }],['other',{ id: 123 }]]) assert.throws(() => providerSubject(p, v), { status: 502 });
});
test('Redis atomic command wiring and fail-closed storage errors, without external calls', async () => {
  const commands = [];
  const st = new RedisStore('https://redis.invalid', 'synthetic', async (url, options) => { const cmd = JSON.parse(options.body); commands.push(cmd); return Response.json({ result: cmd[0] === 'EVAL' ? (cmd[1] === AUTH_LUA ? (cmd[3+Number(cmd[2])]==='prepare'?'ok':'no') : JSON.stringify({ status: 'ok' })) : 'OK' }); });
  const x = setup({ store: st }), s = await start(x); assert.equal((await invoke(x.h, callbackUrl(s), { cookie: s.cookie })).statusCode, 400);
  const evalCmd = commands.find(c => c[0] === 'EVAL' && c[1] === AUTH_LUA && c[3+Number(c[2])]==='claim'); assert.equal(evalCmd[1], AUTH_LUA); assert.equal(evalCmd[2], '1'); assert.equal(evalCmd[4], 'claim'); assert.match(AUTH_LUA, /r.stage~='ready'/); assert.match(AUTH_LUA, /redis.call\('DEL',KEYS\[1\]\)/);
  const bad = setup({ store: { cmd: async () => { throw Error('sensitive-store'); }, setJson: async () => { throw Error('sensitive-store'); }, getJson: async () => { throw Error('sensitive-store'); } } });
  assert.equal((await invoke(bad.h, '/api/owner-auth?op=start&provider=kakao')).statusCode, 503); await assert.rejects(session(bad, SESSION_COOKIE + '=' + 'a'.repeat(43)), { status: 503 });
  assert.equal((await invoke(bad.h, '/api/owner-auth?op=status', { cookie: SESSION_COOKIE + '=' + 'a'.repeat(43) })).statusCode, 503);
});

test('session-secret rotation preserves identity; separate identity key required', async () => {
  const x = setup(), a = await login(x), original = await session(x, a.cookie);
  const env = { ...ENV, YB_AUTH_SECRET: 'synthetic-rotated-auth-secret-at-least-32-bytes' }, y = setup({ store: x.store, env });
  await assert.rejects(session(y, a.cookie, { env }), { status: 401 });
  const b = await login(y); assert.equal((await session(y, b.cookie, { env })).accountId, original.accountId);
  for (const key of ['', 'short', ENV.YB_AUTH_SECRET]) { const z = setup({ env: { ...ENV, YB_IDENTITY_KEY: key } }); assert.equal((await invoke(z.h, '/api/owner-auth?op=status')).json().providers.kakao, false); }
});
test('logout with pending cookie after callback commits also revokes committed session', async () => {
  const x = setup(), l = await login(x);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=logout', { cookie: l.s.cookie, origin: ENV.YB_AUTH_ORIGIN }, 'POST')).statusCode, 200);
  await assert.rejects(session(x, l.cookie), { status: 401 });
});

const rateEntries = x => [...x.store.kv.entries()].filter(([k]) => k.includes(':rate:'));
const stateEntries = x => [...x.store.kv.entries()].filter(([k]) => k.includes(':state:'));
const freshIp = n => '198.18.' + Math.floor(n / 250) + '.' + (n % 250 + 1);

test('start IP limit is atomic, provider-shared, ignores spoofed XFF and creates no extra state', async () => {
  const x = setup();
  const results = await Promise.all(Array.from({ length: AUTH_RATE_LIMITS.start.ip + 10 }, (_, i) => invoke(x.h, '/api/owner-auth?op=start&provider=' + (i % 2 ? 'kakao' : 'naver'), { 'x-forwarded-for': freshIp(i), 'x-real-ip': freshIp(i + 100) })));
  assert.equal(results.filter(r => r.statusCode === 303).length, 20); assert.equal(results.filter(r => r.statusCode === 429).length, 10);
  assert.equal(stateEntries(x).length, 20); assert.equal(rateEntries(x).length, 2);
  assert.ok(rateEntries(x).every(([, v]) => v === 20));
  const before = [...x.store.kv], last = results.find(r => r.statusCode === 303);
  const blocked = await invoke(x.h, '/api/owner-auth?op=start&provider=kakao', { cookie: jar(last), 'x-forwarded-for': '1.1.1.1' });
  assert.equal(blocked.statusCode, 429); assert.equal(blocked.json().code, 'AUTH_RATE_LIMIT'); assert.equal(blocked.headers['retry-after'], '900');
  assert.equal(blocked.headers.location, undefined); assert.equal(blocked.headers['set-cookie'], undefined); assert.deepEqual([...x.store.kv], before); assert.equal(x.calls.length, 0);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=start&provider=kakao', { 'x-vercel-forwarded-for': '203.0.113.2' })).statusCode, 303);
  for (const [key] of rateEntries(x)) { assert.equal(x.store.publicExpiry.get(key), TIME + 900000); assert.ok(!key.includes('203.0.113')); }
  x.setTime(TIME + 900000);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=start&provider=kakao')).statusCode, 303, 'fixed bucket resets without permanent lockout');
});

test('start global bucket bounds total state creation across many trusted IPs', async () => {
  const x = setup();
  const results = await Promise.all(Array.from({ length: AUTH_RATE_LIMITS.start.global + 5 }, (_, i) => invoke(x.h, '/api/owner-auth?op=start&provider=kakao', { 'x-vercel-forwarded-for': freshIp(i) })));
  assert.equal(results.filter(r => r.statusCode === 303).length, 300); assert.equal(results.filter(r => r.statusCode === 429).length, 5);
  assert.equal(stateEntries(x).length, 300); assert.equal(rateEntries(x).length, 301, 'limited new IPs allocate no counters');
  assert.equal(rateEntries(x).find(([k]) => k.endsWith(':global'))[1], 300); assert.equal(x.calls.length, 0);
});

test('callback IP quota applies before claim/exchange, preserves pending state and excludes status/logout', async () => {
  const x = setup(), s = await start(x);
  for (let i = 0; i < AUTH_RATE_LIMITS.callback.ip; i++) {
    const r = await invoke(x.h, callbackUrl(s), { cookie: s.cookie }); assert.equal(r.statusCode, i === 0 ? 303 : 400);
  }
  const pending = await start(x), before = [...x.store.kv], providerCalls = x.calls.length;
  const r = await invoke(x.h, callbackUrl(pending), { cookie: pending.cookie });
  assert.equal(r.statusCode, 429); assert.equal(r.headers['retry-after'], '900'); assert.equal(r.headers['set-cookie'], undefined);
  assert.deepEqual([...x.store.kv], before); assert.equal(x.calls.length, providerCalls);
  const counters = rateEntries(x);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=status')).statusCode, 200);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=logout', { cookie: pending.cookie, origin: ENV.YB_AUTH_ORIGIN }, 'POST')).statusCode, 200);
  assert.deepEqual(rateEntries(x), counters, 'status and logout neither consume nor depend on quota');
});

test('callback global bucket cannot be bypassed by rotating trusted IPs', async () => {
  const x = setup(), s = await start(x);
  const results = await Promise.all(Array.from({ length: AUTH_RATE_LIMITS.callback.global + 3 }, (_, i) => invoke(x.h, callbackUrl(s), { cookie: s.cookie, 'x-vercel-forwarded-for': freshIp(i) })));
  assert.equal(results.filter(r => r.statusCode === 429).length, 3); assert.equal(results.filter(r => r.statusCode === 303).length, 1);
  assert.equal(x.calls.length, 2); assert.equal(rateEntries(x).filter(([k]) => k.includes(':callback:')).length, 601);
});

test('invalid origin/config/parameters and unbound callback never reach rate storage', async () => {
  const x = setup(), s = await start(x); let hits = 0;
  x.store.publicTransaction = async () => { hits++; throw Error('must not run'); };
  for (const [url, headers] of [
    ['/api/owner-auth?op=start&provider=kakao', { origin: 'https://evil.invalid' }],
    ['/api/owner-auth?op=start&provider=kakao&return=https://evil.invalid', {}],
    ['/api/owner-auth?op=start&provider=unknown', {}],
    ['/api/owner-auth?op=start&provider=kakao&provider=naver', {}],
    [callbackUrl(s), {}],
    [callbackUrl(s, '&code='), { cookie: s.cookie }],
    [callbackUrl(s, '&code=synthetic&error=access_denied'), { cookie: s.cookie }],
    [callbackUrl(s).replace(s.state, 'z'.repeat(43)), { cookie: s.cookie }],
  ]) assert.ok((await invoke(x.h, url, headers)).statusCode >= 400);
  const disabled = createHandler({ ...x.deps, env: { ...ENV, YB_KAKAO_CLIENT_SECRET: '' } });
  assert.equal((await invoke(disabled, '/api/owner-auth?op=start&provider=kakao')).statusCode, 503);
  assert.equal(hits, 0); assert.equal(x.calls.length, 0);
});

test('limiter missing, error and malformed result fail closed without state or provider side effects', async () => {
  for (const limiter of [undefined, async () => { throw Error('private-rate-error'); }, async () => null, async () => ({ status: 'unknown' })]) {
    const x = setup(), l = await login(x), s = await start(x, 'kakao', 'dashboard', l.cookie);
    x.store.publicTransaction = limiter;
    const before = [...x.store.kv], calls = x.calls.length;
    for (const [url, headers] of [['/api/owner-auth?op=start&provider=kakao', {}], [callbackUrl(s), { cookie: s.cookie }]]) {
      const r = await invoke(x.h, url, headers); assert.equal(r.statusCode, 503); assert.equal(r.json().code, 'AUTH_RATE_STORE'); assert.equal(r.headers['set-cookie'], undefined); assert.ok(!r.body.includes('private-rate-error'));
    }
    assert.deepEqual([...x.store.kv], before); assert.equal(x.calls.length, calls);
    assert.equal((await invoke(x.h, '/api/owner-auth?op=status', { cookie: l.cookie })).json().authenticated, true);
    assert.equal((await invoke(x.h, '/api/owner-auth?op=logout', { cookie: s.cookie, origin: ENV.YB_AUTH_ORIGIN }, 'POST')).statusCode, 200);
  }
});

test('only single valid Vercel IP is trusted; IPv6 /64 and mapped addresses normalize', async () => {
  for (const value of [undefined, '', '203.0.113.1, 203.0.113.2', ['203.0.113.1'], ' 203.0.113.1', 'bad-ip', 'fe80::1%eth0']) {
    const x = setup(); const r = await invoke(x.h, '/api/owner-auth?op=start&provider=kakao', { 'x-vercel-forwarded-for': value, 'x-forwarded-for': '203.0.113.1' });
    assert.equal(r.statusCode, 503); assert.equal(r.json().code, 'AUTH_RATE_IP'); assert.equal(x.store.kv.size, 0);
  }
  const off = setup({ env: { ...ENV, VERCEL: '' } }); assert.equal((await invoke(off.h, '/api/owner-auth?op=start&provider=kakao')).json().code, 'AUTH_RATE_IP');
  const x = setup(); for (let i = 1; i <= 20; i++) assert.equal((await invoke(x.h, '/api/owner-auth?op=start&provider=kakao', { 'x-vercel-forwarded-for': '2001:db8:abcd:0001::' + i.toString(16) })).statusCode, 303);
  assert.equal((await invoke(x.h, '/api/owner-auth?op=start&provider=kakao', { 'x-vercel-forwarded-for': '2001:0DB8:ABCD:1:0:0:ffff:ffff' })).statusCode, 429);
  const y = setup(); for (let i = 0; i < 20; i++) assert.equal((await invoke(y.h, '/api/owner-auth?op=start&provider=kakao', { 'x-vercel-forwarded-for': i % 2 ? '::ffff:203.0.113.1' : '203.0.113.1' })).statusCode, 303);
  assert.equal((await invoke(y.h, '/api/owner-auth?op=start&provider=kakao')).statusCode, 429);
});

test('Kakao uses unique PKCE S256 per attempt, verifier only in bound cookie and token POST', async () => {
  const x = setup(), a = await start(x), b = await start(x);
  const payload = s => JSON.parse(Buffer.from(s.cookie.split('=')[1].split('.')[0], 'base64url').toString('utf8'));
  const pa = payload(a), pb = payload(b), url = new URL(a.r.headers.location);
  assert.match(pa.pkce, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(pa.pkce, pb.pkce);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(pa.pkce).digest('base64url'));
  assert.ok(!a.r.headers.location.includes(pa.pkce)); assert.ok(!JSON.stringify(stateEntries(x)).includes(pa.pkce));
  assert.equal((await invoke(x.h, callbackUrl(a), { cookie: a.cookie })).statusCode, 303);
  assert.equal(x.calls[0].options.method, 'POST'); assert.equal(new URLSearchParams(x.calls[0].options.body).get('code_verifier'), pa.pkce);
  const n = await start(x, 'naver'), np = payload(n), nu = new URL(n.r.headers.location);
  assert.match(np.pkce, /^[A-Za-z0-9_-]{43}$/); assert.equal(nu.pathname, '/oauth2/authorize'); assert.equal(nu.searchParams.get('scope'), 'openid'); assert.equal(nu.searchParams.get('nonce'), np.nonce);
  assert.equal(nu.searchParams.get('code_challenge'), createHash('sha256').update(np.pkce).digest('base64url')); assert.ok(!nu.href.includes(np.pkce));
});

test('configured status reports absent or structurally unusable datastore as 503 AUTH_STORE, never logout', async () => {
  const getJson = async () => null, setJson = async () => {}, cmd = async () => null;
  for (const store of [undefined, null, {}, { getJson, cmd }, { setJson, cmd }, { getJson, setJson }, { getJson, setJson, kv: {} }]) {
    const h = createHandler({ env: ENV, store, fetcher: () => { throw Error('network must not run'); }, now: TIME });
    for (const cookie of ['', SESSION_COOKIE + '=' + 'a'.repeat(43)]) {
      const r = await invoke(h, '/api/owner-auth?op=status', { cookie });
      assert.equal(r.statusCode, 503); assert.equal(r.json().code, 'AUTH_STORE');
      assert.equal(Object.hasOwn(r.json(), 'authenticated'), false); assert.equal(Object.hasOwn(r.json(), 'providers'), false);
      assert.equal(r.headers['set-cookie'], undefined); assert.equal(r.headers['cache-control'], 'no-store');
    }
  }
});

test('unconfigured status stays 200 disabled even without datastore; configured healthy status remains normal', async () => {
  const disabled = { authenticated: false, provider: null, providers: { kakao: false, naver: false } };
  for (const env of [{ VERCEL: '1' }, { ...ENV, YB_AUTH_SECRET: '' }]) {
    for (const store of [undefined, null, {}]) {
      const h = createHandler({ env, store, fetcher: () => { throw Error('network must not run'); }, now: TIME });
      const r = await invoke(h, '/api/owner-auth?op=status'); assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), disabled);
    }
  }
  const x = setup(), r = await invoke(x.h, '/api/owner-auth?op=status');
  assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { authenticated: false, provider: null, providers: { kakao: true, naver: true } });
});

test('configured status preserves operational getJson failures as 503 without clearing session', async () => {
  for (const error of [new Error('private-storage-error'), new HttpError(503, 'STORE', 'private-storage-error')]) {
    let reads = 0;
    const store = { cmd: async () => null, setJson: async () => {}, getJson: async () => { reads++; throw error; } };
    const h = createHandler({ env: ENV, store, now: TIME });
    const r = await invoke(h, '/api/owner-auth?op=status', { cookie: SESSION_COOKIE + '=' + 'a'.repeat(43) });
    assert.equal(reads, 1); assert.equal(r.statusCode, 503); assert.ok(['AUTH_STORE', 'STORE'].includes(r.json().code));
    assert.equal(Object.hasOwn(r.json(), 'authenticated'), false); assert.equal(r.headers['set-cookie'], undefined); assert.ok(!r.body.includes('private-storage-error'));
  }
});

async function oidcAttempt({ claims = {}, header = {}, tokenTransform = v => v, jwks = { keys: [JWK] }, jwksResponse } = {}) {
  let nonce; const seen = [];
  const x = setup({ fetcher: async (url, options) => {
    seen.push({ url, options });
    if (url === 'https://nid.naver.com/oauth2/token') return Response.json({ access_token: 'synthetic-access', token_type: 'bearer', id_token: tokenTransform(idToken(nonce, claims, header)) });
    if (url === 'https://nid.naver.com/oauth2/jwks') return jwksResponse ? jwksResponse() : Response.json(jwks);
    throw Error('unexpected provider endpoint');
  } });
  const s = await start(x, 'naver'); nonce = new URL(s.r.headers.location).searchParams.get('nonce');
  const r = await invoke(x.h, callbackUrl(s), { cookie: s.cookie });
  return { x, s, r, seen, nonce };
}

test('Naver OIDC validates signed subject with fixed JWKS and PKCE; no profile request or persisted claims', async () => {
  for (const claims of [{}, { aud: [ENV.YB_NAVER_CLIENT_ID] }, { aud: [ENV.YB_NAVER_CLIENT_ID, 'other-audience'] }]) {
    const { x, s, r, seen, nonce } = await oidcAttempt({ claims: { ...claims, email: 'never-store@example.invalid' } });
    assert.equal(r.statusCode, 303, r.body); assert.equal((await session(x, jar(r))).provider, 'naver'); assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
    const payload = JSON.parse(Buffer.from(s.cookie.split('=')[1].split('.')[0], 'base64url').toString('utf8'));
    assert.deepEqual(seen.map(v => v.url), ['https://nid.naver.com/oauth2/token', 'https://nid.naver.com/oauth2/jwks']);
    assert.equal(new URLSearchParams(seen[0].options.body).get('code_verifier'), payload.pkce); assert.equal(seen[0].options.method, 'POST');
    assert.equal(seen[1].options.redirect, 'error'); assert.equal(seen[1].options.headers.Authorization, undefined);
    const stored = JSON.stringify([...x.store.kv]); for (const value of ['naver_subject_123','never-store@example.invalid','synthetic-access',payload.pkce,nonce]) assert.ok(!stored.includes(value));
  }
});

test('Naver ID tokens reject wrong signature, alg, kid, issuer, audience, azp, nonce and timing', async () => {
  const cases = [
    { header: { alg: 'none' } }, { header: { alg: 'HS256' } }, { header: { kid: 'unknown-key' } },
    { header: { jku: 'https://evil.invalid/keys' } }, { header: { x5u: 'https://evil.invalid/cert' } }, { header: { crit: ['unknown'] } },
    { claims: { iss: 'https://nid.naver.com/' } }, { claims: { iss: 'https://evil.invalid' } },
    { claims: { aud: 'wrong-client' } }, { claims: { aud: [] } }, { claims: { aud: [ENV.YB_NAVER_CLIENT_ID, 'other'], azp: undefined } }, { claims: { azp: 'wrong-client' } },
    { claims: { nonce: 'wrong-nonce' } }, { claims: { nonce: undefined } },
    { claims: { exp: TIME / 1000 } }, { claims: { exp: TIME / 1000 + 86401 } },
    { claims: { iat: TIME / 1000 + 61 } }, { claims: { iat: TIME / 1000 - 61 } }, { claims: { iat: 'invalid' } }, { claims: { nbf: TIME / 1000 + 61 } },
    { claims: { sub: '' } }, { claims: { sub: { email: 'not-a-subject' } } },
    { tokenTransform: () => undefined }, { tokenTransform: () => 'not-a-jwt' },
    { tokenTransform: token => { const parts = token.split('.'), sig = Buffer.from(parts[2], 'base64url'); sig[0] ^= 1; parts[2] = sig.toString('base64url'); return parts.join('.'); } },
  ];
  for (const input of cases) {
    const { x, s, r, seen } = await oidcAttempt(input); assert.equal(r.statusCode, 502); assert.equal(r.json().code, 'AUTH_ID_TOKEN');
    assert.equal([...x.store.kv.keys()].some(k => k.includes(':session:')), false); assert.ok(seen.every(c => c.url.startsWith('https://nid.naver.com/oauth2/')));
    const calls = seen.length; assert.equal((await invoke(x.h, callbackUrl(s), { cookie: s.cookie })).statusCode, 400); assert.equal(seen.length, calls);
  }
});

test('Naver fixed JWKS refuses redirects, oversized/invalid responses and ambiguous or unsafe keys', async () => {
  const cases = [
    { jwksResponse: () => new Response('', { status: 302, headers: { Location: 'https://evil.invalid/keys' } }) },
    { jwksResponse: () => { const r = Response.json({ keys: [JWK] }); Object.defineProperty(r, 'redirected', { value: true }); return r; } },
    { jwksResponse: () => { const r = Response.json({ keys: [JWK] }); Object.defineProperty(r, 'url', { value: 'https://evil.invalid/keys' }); return r; } },
    { jwksResponse: () => new Response('{}', { headers: { 'Content-Length': '65537' } }) },
    { jwksResponse: () => new Response('x'.repeat(65537)) }, { jwksResponse: () => new Response('invalid json') },
    { jwks: { keys: [] } }, { jwks: { keys: [JWK, JWK] } }, { jwks: { keys: Array(9).fill(JWK) } },
    { jwks: { keys: [{ ...JWK, alg: 'HS256' }] } }, { jwks: { keys: [{ ...JWK, kty: 'EC' }] } },
    { jwks: { keys: [{ ...JWK, use: 'enc' }] } }, { jwks: { keys: [{ ...JWK, key_ops: ['sign'] }] } },
    { jwks: { keys: [{ ...JWK, d: 'private-key-not-allowed' }] } }, { jwks: { keys: [{ ...JWK, n: 'AQAB' }] } },
  ];
  for (const input of cases) {
    const { x, r, seen } = await oidcAttempt(input); assert.equal(r.statusCode, 502); assert.equal([...x.store.kv.keys()].some(k => k.includes(':session:')), false);
    assert.equal(seen.length, 2); assert.equal(seen[1].url, 'https://nid.naver.com/oauth2/jwks'); assert.equal(seen[1].options.redirect, 'error');
  }
});

test('Naver signed state still requires per-attempt PKCE verifier and nonce before counters or exchange', async () => {
  for (const missing of ['pkce', 'nonce']) {
    const x = setup(), s = await start(x, 'naver'), raw = s.cookie.split('=')[1];
    const payload = JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString('utf8')); delete payload[missing];
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const cookie = STATE_COOKIE + '=' + encoded + '.' + createHmac('sha256', ENV.YB_AUTH_SECRET).update('oauth-state:' + encoded).digest('base64url');
    const before = [...x.store.kv], r = await invoke(x.h, callbackUrl(s), { cookie });
    assert.equal(r.statusCode, 400); assert.equal(r.json().code, 'AUTH_STATE'); assert.equal(x.calls.length, 0); assert.deepEqual([...x.store.kv], before);
  }
});


test('lifecycle: two devices, stalled callback, finite barrier, rotation and fresh re-registration',async()=>{
 const x=setup(),a=await login(x),b=await login(x),old=await start(x),who=await session(x,a.cookie),scope=requestScope(request('/'),ENV),operationId='A'.repeat(22),args={store:x.store,scope,accountId:who.accountId,operationId};
 const began=await beginAccountWithdrawal(args);assert.equal(began.status,'cleanup');assert.deepEqual(await beginAccountWithdrawal(args),began);
 await assert.rejects(session(x,a.cookie),{status:401});await assert.rejects(session(x,b.cookie),{status:401});
 const during=await start(x);assert.equal((await invoke(x.h,callbackUrl(during),{cookie:during.cookie})).statusCode,401);
 let done;do{done=await cleanupAccountWithdrawal({...args,cutoff:began.cutoff,limit:1});assert.ok(done.processed<=1);}while(done.status==='cleanup');assert.equal(done.status,'done');assert.equal(done.revoked,2);
 assert.equal((await invoke(x.h,callbackUrl(old),{cookie:old.cookie})).statusCode,401);
 const fresh=await login(x);assert.equal((await session(x,fresh.cookie)).accountId,who.accountId);
 const k=lifecycleKeys(scope,who.accountId);assert.ok(x.store.publicExpiry.get(k.barrier)-Date.now()>LIFECYCLE_RETENTION*1000-10000);
 assert.equal((await cleanupAccountWithdrawal({...args,cutoff:began.cutoff})).status,'done');assert.equal((await session(x,fresh.cookie)).accountId,who.accountId);
 const rotated={...ENV,YB_AUTH_SECRET:'synthetic-new-session-secret-at-least-32-bytes'},y=setup({store:x.store,env:rotated});assert.equal((await session(y,(await login(y)).cookie,{env:rotated})).accountId,who.accountId);
 const again=await beginAccountWithdrawal({...args,operationId:'B'.repeat(22),expectedCutoff:began.cutoff});assert.equal(again.cutoff,began.cutoff+1);assert.equal((await cleanupAccountWithdrawal({...args,cutoff:began.cutoff})).status,'conflict');
 assert.equal(x.store.publicExpiry.has(k.barrier),false);
});

test('lifecycle: epoch-less sessions and malformed completed barriers fail closed',async()=>{
 const x=setup(),a=await login(x),who=await session(x,a.cookie),key=[...x.store.kv.keys()].find(k=>k.includes(':session:')),r=JSON.parse(x.store.kv.get(key));delete r.generation;x.store.kv.set(key,JSON.stringify(r));await assert.rejects(session(x,a.cookie),{status:401});
 const b=await login(x),scope=requestScope(request('/'),ENV);x.store.kv.set(lifecycleKeys(scope,who.accountId).barrier,JSON.stringify({phase:'done'}));await assert.rejects(session(x,b.cookie),{status:401});
});

test('lifecycle raw detachment preserves escaped/nested unknown fields and blocks ambiguous JSON',()=>{
 const revision='f'.repeat(32);
 const strings=['"',String.fromCharCode(92),'ownerAccountId',String.fromCharCode(10),'한글',String.fromCodePoint(0x1f600),'[{},]'];
 for(let n=0;n<300;n++){const unknown={nested:[strings[n%strings.length],[],{},[strings[(n+1)%strings.length]]]},data={sections:[],faqs:[],unknown};const record={id:'a'.repeat(22),data,password:{salt:'synthetic',hash:'unchanged'},ownerAccountId:'account',extra:unknown};for(const r of [record,{ownerAccountId:'account',...record},{...record,z:1}]){const raw=JSON.stringify(r,null,n%3),out=detachOwnerRaw(raw,'account',revision);delete r.ownerAccountId;r.revision=revision;assert.deepEqual(JSON.parse(out),r);assert.ok(out.includes(JSON.stringify('ownerAccountId'))===false||out.includes('nested'));}}
 assert.equal(detachOwnerRaw('{"ownerAccountId":"else","data":[]}','account',revision),'{"ownerAccountId":"else","data":[]}');
 assert.throws(()=>detachOwnerRaw('{"ownerAccountId":"account","ownerAccountId":"account"}','account',revision));
 assert.throws(()=>detachOwnerRaw('{"ownerAccountId":"account",bad}','account',revision));
});


test('revision-safe detach preserves exact unrelated bytes, escaped keys and absent revision',()=>{
 const revision='e'.repeat(32),encoded=JSON.stringify(revision);
 const raw="{ \"unknown\" : [[],{\"revision\":\"nested\",\"s\":\"\\\\\\\" , }\"}], \"ownerAccountId\":\"account\", \"revi\\u0073ion\" : \"old\", \"tail\" : null }";
 const expected=raw.replace('"ownerAccountId":"account",','').replace('"old"',encoded);assert.equal(detachOwnerRaw(raw,'account',revision),expected);
 for(const raw of ['{"ownerAccountId":"account"}','{ "before" : [[],{}], "ownerAccountId":"account", "after" : false }'])assert.equal(detachOwnerRaw(raw,'account',revision),raw.replace('"ownerAccountId":"account"','"revision":'+encoded));
 for(const raw of ["{\"ownerAccountId\":\"account\",\"revision\":\"old\",\"revision\":\"other\"}","{\"ownerAccountId\":\"account\",\"revision\":\"old\",\"revi\\u0073ion\":\"other\"}"])assert.throws(()=>detachOwnerRaw(raw,'account',revision));
 assert.throws(()=>detachOwnerRaw('{"ownerAccountId":"account","revision":'+encoded+'}','account',revision));
});

// Executed expected-failure regressions: these are known blockers, not fixes.
test('BLOCKER: selective generation and barrier loss must not revive old credentials',{todo:'Needs scope/account incarnation and recovery authority; simple counter is insufficient'},async()=>{
 const x=setup(),a=await login(x),old=await start(x),who=await session(x,a.cookie),scope=requestScope(request('/'),ENV),k=lifecycleKeys(scope,who.accountId),args={store:x.store,scope,accountId:who.accountId,operationId:'L'.repeat(22)};
 await beginAccountWithdrawal(args);x.store.kv.delete(k.generation);x.store.kv.delete(k.barrier);x.store.publicExpiry.delete(k.barrier);await start(x);
 const oldSessionAccepted=await session(x,a.cookie).then(()=>true,()=>false),oldCallback=await invoke(x.h,callbackUrl(old),{cookie:old.cookie});assert.deepEqual({oldSessionAccepted,callbackStatus:oldCallback.statusCode},{oldSessionAccepted:false,callbackStatus:401});
});
test('BLOCKER: expired operation receipt must not let an ancient begin revoke fresh registration',{todo:'Needs expiring authenticated begin grant bound to account incarnation'},async()=>{
 const x=setup(),a=await login(x),who=await session(x,a.cookie),scope=requestScope(request('/'),ENV),args={store:x.store,scope,accountId:who.accountId,operationId:'T'.repeat(22)},b=await beginAccountWithdrawal(args);await cleanupAccountWithdrawal({...args,cutoff:b.cutoff});const k=lifecycleKeys(scope,who.accountId);x.store.publicExpiry.set(k.barrier,Date.now()-1);
 const fresh=await login(x),replayed=await beginAccountWithdrawal(args),freshStillValid=await session(x,fresh.cookie).then(()=>true,()=>false);assert.deepEqual({status:replayed.status,freshStillValid},{status:'conflict',freshStillValid:true});
});
