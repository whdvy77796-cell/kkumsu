import { createHash, createHmac, randomBytes, timingSafeEqual, createPublicKey, verify, constants } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError, lifecycleKeys } from './guard.mjs';
import { requestScope } from './stores.mjs';

export const SESSION_COOKIE = '__Host-yb-session';
// Server-only metadata. Symbol/non-enumerability prevents accidental JSON output.
export const SESSION_BINDING = Symbol('owner-session-binding');
export const STATE_COOKIE = '__Host-yb-oauth';
export const STATE_TTL = 600;
export const SESSION_TTL = 7 * 24 * 3600;
// Fixed UTC 15-minute buckets, shared by both providers. Status and logout are
// deliberately exempt. A rejected transaction allocates/increments no counters.
export const AUTH_RATE_LIMITS = Object.freeze({
  windowSeconds: 900,
  start: Object.freeze({ ip: 20, global: 300 }),
  callback: Object.freeze({ ip: 40, global: 600 }),
});
export const RETURNS = Object.freeze({ dashboard: '/#/my-stores', publish: '/#/page-publish', preview: '/#/page-preview' });
const PROVIDERS = Object.freeze({
  kakao: { authorize: 'https://kauth.kakao.com/oauth/authorize', token: 'https://kauth.kakao.com/oauth/token', subject: 'https://kapi.kakao.com/v2/user/me' },
  naver: { authorize: 'https://nid.naver.com/oauth2/authorize', token: 'https://nid.naver.com/oauth2/token', jwks: 'https://nid.naver.com/oauth2/jwks' },
});
const fail = (status, code) => new HttpError(status, code, status === 401 ? '로그인이 필요해요.' : '로그인을 완료하지 못했어요. 다시 시도해 주세요.');
const hash = value => createHash('sha256').update(value).digest('hex');
const mac = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const random = () => randomBytes(32).toString('base64url');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function authConfig(env = {}) {
  try {
    const origin = env.YB_AUTH_ORIGIN, secret = env.YB_AUTH_SECRET, identityKey = env.YB_IDENTITY_KEY;
    const u = new URL(origin);
    if (typeof origin !== 'string' || u.protocol !== 'https:' || u.origin !== origin || u.username || u.password || u.hostname.endsWith('.') || /^(localhost|127\.|\[)/i.test(u.hostname)) return null;
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) return null;
    // Back up this long-lived identity key separately. Changing it needs an
    // account/ownership migration; rotating the session secret does not.
    if (typeof identityKey !== 'string' || Buffer.byteLength(identityKey) < 32 || Buffer.byteLength(identityKey) > 4096 || identityKey === secret) return null;
    const providers = {};
    for (const provider of Object.keys(PROVIDERS)) {
      const prefix = 'YB_' + provider.toUpperCase() + '_';
      const clientId = env[prefix + 'CLIENT_ID'], clientSecret = env[prefix + 'CLIENT_SECRET'];
      const valid = v => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\s\x00-\x1f\x7f]/.test(v);
      providers[provider] = valid(clientId) && valid(clientSecret) ? { clientId, clientSecret } : null;
    }
    return { origin, host: u.host, secret, identityKey, providers };
  } catch { return null; }
}
export function trustedRequest(req, scope, env) {
  const config = authConfig(env), actual = requestScope(req, env);
  if (!config) throw fail(503, 'AUTH_CONFIG');
  if (!scope || scope.host !== actual.host || scope.namespace !== actual.namespace || actual.host !== config.host || (req.headers['x-forwarded-proto'] !== undefined && req.headers['x-forwarded-proto'] !== 'https')) throw fail(403, 'AUTH_HOST');
  return config;
}
export function cookie(req, name) {
  const raw = req.headers?.cookie;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > 12000) throw fail(401, 'AUTH_COOKIE');
  const values = raw.split(';').map(s => s.trim()).filter(s => s.split('=', 1)[0] === name).map(s => s.slice(name.length + 1));
  if (values.length > 1) throw fail(401, 'AUTH_COOKIE');
  return values[0] || null;
}
export const cookieHeader = (name, value, ttl) => name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + ttl;
const namespace = (config, scope) => 'yb:auth:v1:' + hash(config.origin + '|' + scope.namespace + '|' + mac(config.secret, 'namespace'));
// Vercel overwrites this single-IP header. Never trust X-Forwarded-For,
// X-Real-IP, arbitrary proxy chains or a client-supplied header off Vercel.
function trustedRateIdentity(req, env) {
  const raw = env.VERCEL === '1' ? req.headers?.['x-vercel-forwarded-for'] : undefined;
  if (typeof raw !== 'string' || raw.length > 45 || /[\s,%]/.test(raw)) throw fail(503, 'AUTH_RATE_IP');
  const version = isIP(raw);
  if (version === 4) return 'v4:' + raw;
  if (version !== 6) throw fail(503, 'AUTH_RATE_IP');
  const canonical = new URL('https://[' + raw + ']').hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const groups = (canonical.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a).map(v => parseInt(v, 16));
  if (groups.slice(0, 5).every(v => v === 0) && groups[5] === 65535) return 'v4:' + [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  // Group IPv6 privacy addresses by /64 so cheap address rotation cannot bypass
  // the per-network budget. Raw IPs never enter Redis keys, values or responses.
  return 'v6:' + groups.slice(0, 4).map(v => v.toString(16).padStart(4, '0')).join(':') + '/64';
}
async function limitOAuth({ req, store, scope, config, env, operation, now }) {
  if (!Number.isSafeInteger(now) || now < 0) throw fail(503, 'AUTH_CLOCK');
  const identity = trustedRateIdentity(req, env);
  if (typeof store?.publicTransaction !== 'function') throw fail(503, 'AUTH_RATE_STORE');
  const windowMs = AUTH_RATE_LIMITS.windowSeconds * 1000, bucket = Math.floor(now / windowMs);
  const ttl = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000));
  const prefix = namespace(config, scope) + ':rate:' + operation + ':' + bucket;
  const limits = AUTH_RATE_LIMITS[operation];
  const counters = [
    { key: prefix + ':global', limit: limits.global, ttl },
    { key: prefix + ':ip:' + mac(config.secret, 'oauth-rate-ip:' + identity), limit: limits.ip, ttl },
  ];
  let result;
  try { result = await store.publicTransaction('rate', [], { now, counters }); }
  catch { throw fail(503, 'AUTH_RATE_STORE'); }
  if (result?.status === 'limited') throw new HttpError(429, 'AUTH_RATE_LIMIT', '로그인 요청이 많아요. 잠시 후 다시 시도해 주세요.', { retryAfter: ttl });
  if (result?.status !== 'ok') throw fail(503, 'AUTH_RATE_STORE');
}
const sessionKey = (config, scope, token) => namespace(config, scope) + ':session:' + hash(token);
const stateKey = (config, scope, state) => namespace(config, scope) + ':state:' + hash(state);
const prior = req => { const value = cookie(req, SESSION_COOKIE); return opaque(value) ? hash(value) : '-'; };
const signed = (config, payload) => { const value = Buffer.from(JSON.stringify(payload)).toString('base64url'); return value + '.' + mac(config.secret, 'oauth-state:' + value); };
function verified(config, raw, now) {
  if (typeof raw !== 'string' || raw.length > 2400 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(raw)) throw fail(400, 'AUTH_STATE');
  const [value, signature] = raw.split('.');
  if (!equal(signature, mac(config.secret, 'oauth-state:' + value))) throw fail(400, 'AUTH_STATE');
  let payload; try { payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw fail(400, 'AUTH_STATE'); }
  if (!object(payload) || !Number.isSafeInteger(payload.iat) || payload.iat > now || payload.exp !== payload.iat + STATE_TTL * 1000 || payload.exp <= now || !opaque(payload.state)) throw fail(400, 'AUTH_STATE');
  return payload;
}

// Claim, cancellation and final session rotation are atomic, including logout
// racing an in-flight callback. No expiring mutex is released or reused.
export const AUTH_LUA = `-- yb:owner-auth:v1
local op=ARGV[1]
local p=cjson.decode(ARGV[2])
local raw=redis.call('GET',KEYS[1])
local r=nil
if raw then r=cjson.decode(raw) end
if op=='prepare' then
  redis.call('SET',KEYS[2],'0','NX')
  local generation=tonumber(redis.call('GET',KEYS[2]))
  if not generation or generation<0 or generation~=math.floor(generation) or generation>9007199254740990 then return 'no' end
  local state=cjson.decode(p.state);state.generation=generation
  return redis.call('SET',KEYS[1],cjson.encode(state),'NX','EX',p.ttl) and 'ok' or 'no'
end
if op=='claim' then
  if not r or r.stage~='ready' or r.exp<=p.now or r.binding~=p.binding then return 'no' end
  r.stage='claimed'
  redis.call('SET',KEYS[1],cjson.encode(r),'PX',math.max(1,r.exp-p.now))
  return 'ok'
end
if op=='finish' then
  if not r then return 'no' end
  local generation=tonumber(redis.call('GET',KEYS[4]))
  if not r or type(r.generation)~='number' or not generation or r.generation>generation then return 'blocked' end
  local barrierRaw=redis.call('GET',KEYS[5])
  if barrierRaw then local barrier=cjson.decode(barrierRaw);if barrier.phase~='done' or r.generation<barrier.cutoff then return 'blocked' end end
  if not r or r.stage~='claimed' or r.exp<=p.now or r.binding~=p.binding then return 'no' end
  local session=cjson.decode(p.session);session.generation=r.generation
  redis.call('SET',KEYS[2],cjson.encode(session),'EX',p.ttl)
  local clock=redis.call('TIME');local wall=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
  redis.call('ZREMRANGEBYSCORE',KEYS[6],'-inf',wall)
  redis.call('ZADD',KEYS[6],wall+p.ttl*1000,KEYS[2]);redis.call('EXPIRE',KEYS[6],p.ttl)
  if KEYS[3]~=KEYS[2] then redis.call('DEL',KEYS[3]) end
  r.stage='finished'; r.sessionKey=KEYS[2]
  redis.call('SET',KEYS[1],cjson.encode(r),'PX',math.max(1,r.exp-p.now))
  return 'ok'
end
if op=='cancel' then
  if r and r.sessionKey then redis.call('DEL',r.sessionKey) end
  redis.call('DEL',KEYS[1])
  if KEYS[2] then redis.call('DEL',KEYS[2]) end
  return 'ok'
end
return 'no'`;
async function transaction(store, op, keys, p) {
  if (typeof store?.cmd === 'function') return store.cmd(['EVAL', AUTH_LUA, String(keys.length), ...keys, op, JSON.stringify(p)]);
  // Dependency-injected MemoryStore only; the HTTP factory never defaults to it.
  if (!(store?.kv instanceof Map)) throw fail(503, 'AUTH_STORE');
  const raw = store.kv.get(keys[0]), r = raw ? JSON.parse(raw) : null;
  if (op === 'prepare') { if(!store.kv.has(keys[1]))store.kv.set(keys[1],'0'); const generation=JSON.parse(store.kv.get(keys[1])); if(!Number.isSafeInteger(generation)||generation<0||generation>=Number.MAX_SAFE_INTEGER||raw)return 'no'; const state=JSON.parse(p.state);state.generation=generation;store.kv.set(keys[0],JSON.stringify(state));store.publicExpiry ||= new Map();store.publicExpiry.set(keys[0],Date.now()+p.ttl*1000);return 'ok'; }
  if(op==='finish'){if(!r)return 'no';const generation=JSON.parse(store.kv.get(keys[3]) ?? 'null'),barrier=awaitLifecycleValue(store,keys[4]);if(!r||!Number.isSafeInteger(r.generation)||!Number.isSafeInteger(generation)||r.generation>generation||(barrier&&(barrier.phase!=='done'||!Number.isSafeInteger(barrier.cutoff)||r.generation<barrier.cutoff)))return 'blocked';const session=JSON.parse(p.session);session.generation=r.generation;p={...p,session:JSON.stringify(session)};}
  if (op === 'cancel') { if (r?.sessionKey) store.kv.delete(r.sessionKey); for (const key of keys) store.kv.delete(key); return 'ok'; }
  if (!r || r.exp <= p.now || r.binding !== p.binding || r.stage !== (op === 'claim' ? 'ready' : 'claimed')) return 'no';
  if (op === 'claim') { r.stage = 'claimed'; store.kv.set(keys[0], JSON.stringify(r)); }
  else { store.kv.set(keys[1], p.session); store.publicExpiry ||= new Map(); store.publicExpiry.set(keys[1], Date.now() + p.ttl * 1000); const index=store.kv.get(keys[5])||new Map();for(const [k,t]of index)if(t<=Date.now())index.delete(k);index.set(keys[1],Date.now()+p.ttl*1000);store.kv.set(keys[5],index);store.publicExpiry.set(keys[5],Date.now()+p.ttl*1000); if (keys[2] !== keys[1]) store.kv.delete(keys[2]); r.stage = 'finished'; r.sessionKey = keys[1]; store.kv.set(keys[0], JSON.stringify(r)); }
  return 'ok';
}
function awaitLifecycleValue(store,key){if(store.publicExpiry?.has(key)&&store.publicExpiry.get(key)<=Date.now()){store.kv.delete(key);store.publicExpiry.delete(key);}const value=store.kv.get(key);return value?JSON.parse(value):null;}
export async function requireSession({ req, store, scope, env = process.env, now = Date.now() }) {
  try {
    if (!Number.isSafeInteger(now)) throw fail(401, 'AUTH');
    const config = trustedRequest(req, scope, env), token = cookie(req, SESSION_COOKIE);
    if (!opaque(token)) throw fail(401, 'AUTH');
    if (!store) throw fail(503, 'AUTH_STORE');
    const key = sessionKey(config, scope, token);
    const session = await store.getJson(key);
    if (!object(session) || !Number.isSafeInteger(session.generation) || session.generation<0 || !opaque(session.binding) || session.origin !== config.origin || session.namespace !== scope.namespace || !Object.hasOwn(PROVIDERS, session.provider) || !config.providers[session.provider] || !/^oa_[A-Za-z0-9_-]{43}$/.test(session.accountId) || !Number.isSafeInteger(session.issuedAt) || session.issuedAt > now || session.expiresAt !== session.issuedAt + SESSION_TTL * 1000 || session.expiresAt <= now) throw fail(401, 'AUTH');
    const life=lifecycleKeys(scope,session.accountId),generation=await store.getJson(life.generation),barrier=await store.getJson(life.barrier);
    if(!Number.isSafeInteger(generation)||session.generation>generation||(barrier&&(barrier.phase!=='done'||!Number.isSafeInteger(barrier.cutoff)||session.generation<barrier.cutoff)))throw fail(401,'AUTH_LIFECYCLE');
    const result = { accountId: session.accountId, provider: session.provider, issuedAt: session.issuedAt, expiresAt: session.expiresAt };
    Object.defineProperty(result, SESSION_BINDING, { value: Object.freeze({ key, generation:session.generation, binding: session.binding, accountId: session.accountId, provider: session.provider, origin: session.origin, namespace: session.namespace, issuedAt: session.issuedAt, expiresAt: session.expiresAt }) });
    return result;
  } catch (err) { if (err instanceof HttpError) throw err; throw fail(503, 'AUTH_STORE'); }
}
export async function startLogin({ req, store, scope, env, provider, destination, now }) {
  const config = trustedRequest(req, scope, env);
  if (!Object.hasOwn(PROVIDERS, provider) || !config.providers[provider]) throw fail(503, 'AUTH_DISABLED');
  if (!Object.hasOwn(RETURNS, destination)) throw fail(400, 'AUTH_RETURN');
  if (req.headers.origin !== undefined && req.headers.origin !== config.origin) throw fail(403, 'ORIGIN');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'ORIGIN');
  const callback = config.origin + '/api/owner-auth?op=callback&provider=' + provider;
  const payload = { state: random(), provider, callback, destination, origin: config.origin, namespace: scope.namespace, prior: prior(req), iat: now, exp: now + STATE_TTL * 1000, pkce: random(), ...(provider === 'naver' ? { nonce: random() } : {}) }; // verifier stays in signed HttpOnly cookie only
  const value = signed(config, payload), binding = hash(value);
  const previous = cookie(req, STATE_COOKIE);
  await limitOAuth({ req, store, scope, config, env, operation: 'start', now });
  if (previous) { try { const old = verified(config, previous, now); await transaction(store, 'cancel', [stateKey(config, scope, old.state)], {}); } catch (e) { if (!(e instanceof HttpError && e.code === 'AUTH_STATE')) throw e; } }
  if(await transaction(store,'prepare',[stateKey(config,scope,payload.state),lifecycleKeys(scope).generation],{state:JSON.stringify({stage:'ready',binding,exp:payload.exp}),ttl:STATE_TTL})!=='ok')throw fail(503,'AUTH_STORE');
  const url = new URL(PROVIDERS[provider].authorize);
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.providers[provider].clientId, redirect_uri: callback, state: payload.state, code_challenge: createHash('sha256').update(payload.pkce).digest('base64url'), code_challenge_method: 'S256', ...(provider === 'naver' ? { scope: 'openid', nonce: payload.nonce } : {}) }).toString();
  return { location: url.href, cookies: [cookieHeader(STATE_COOKIE, value, STATE_TTL)] };
}
async function providerJson(fetcher, url, options) {
  try {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!response.ok || response.redirected || (response.url && response.url !== url)) throw Error();
    if (Number(response.headers?.get('content-length')) > 65536) throw Error();
    let text = '';
    if (response.body?.getReader) {
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 65536) { await reader.cancel(); throw Error(); } chunks.push(Buffer.from(item.value)); } } finally { reader.releaseLock(); }
      text = Buffer.concat(chunks).toString('utf8');
    } else { text = await response.text(); if (Buffer.byteLength(text) > 65536) throw Error(); }
    const value = JSON.parse(text); if (!object(value)) throw Error(); return value;
  } catch { throw fail(502, 'AUTH_PROVIDER'); }
}
// Naver OIDC section 3.5: fixed issuer/endpoints; never use token-controlled
// discovery URLs, jku/x5u or embedded JWKs. No profile/email API is called.
async function naverSubject({ token, clientId, payload, now, fetcher }) {
  const invalid = () => fail(502, 'AUTH_ID_TOKEN');
  const decode = (part, max) => {
    if (typeof part !== 'string' || part.length < 1 || part.length > max || !/^[A-Za-z0-9_-]+$/.test(part)) throw invalid();
    const bytes = Buffer.from(part, 'base64url');
    if (bytes.toString('base64url') !== part) throw invalid();
    return bytes;
  };
  let parts, header;
  try {
    if (typeof token !== 'string' || token.length > 16384) throw invalid();
    parts = token.split('.'); if (parts.length !== 3) throw invalid();
    header = JSON.parse(decode(parts[0], 2048).toString('utf8'));
    if (!object(header) || header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(header.kid) || (header.typ !== undefined && header.typ !== 'JWT') || ['jku','x5u','jwk','x5c','crit','b64'].some(k => Object.hasOwn(header, k))) throw invalid();
  } catch { throw invalid(); }
  const jwks = await providerJson(fetcher, PROVIDERS.naver.jwks, { method: 'GET', headers: { Accept: 'application/json' } });
  try {
    if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 8) throw invalid();
    const matches = jwks.keys.filter(k => object(k) && k.kid === header.kid);
    if (matches.length !== 1) throw invalid();
    const jwk = matches[0];
    if (jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') || (jwk.use !== undefined && jwk.use !== 'sig') || (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify')) || ['d','p','q','dp','dq','qi','oth'].some(k => Object.hasOwn(jwk, k))) throw invalid();
    const modulus = decode(jwk.n, 684); decode(jwk.e, 12);
    if (modulus.length < 256 || modulus.length > 512) throw invalid();
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 4096 || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), { key, padding: constants.RSA_PKCS1_PADDING }, decode(parts[2], 684))) throw invalid();
    const claims = JSON.parse(decode(parts[1], 8192).toString('utf8')), seconds = Math.floor(now / 1000);
    if (!object(claims) || claims.iss !== 'https://nid.naver.com' || typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) throw invalid();
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (!Array.isArray(audiences) || audiences.length < 1 || audiences.length > 4 || audiences.some(a => typeof a !== 'string') || new Set(audiences).size !== audiences.length || !audiences.includes(clientId) || (claims.azp !== undefined && claims.azp !== clientId) || (audiences.length > 1 && claims.azp !== clientId)) throw invalid();
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat < Math.floor(payload.iat / 1000) - 60 || claims.iat > seconds + 60 || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 86400 || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds + 60 || claims.nbf >= claims.exp)) || !equal(claims.nonce, payload.nonce)) throw invalid();
    return claims.sub;
  } catch { throw invalid(); }
}
export function providerSubject(provider, value) {
  if (provider === 'kakao' && object(value) && !value.error && !value.code && Number.isSafeInteger(value.id) && value.id > 0) return String(value.id);
  throw fail(502, 'AUTH_IDENTITY');
}
export async function finishLogin({ req, store, scope, env, provider, state, code, error, now, clock, fetcher }) {
  const config = trustedRequest(req, scope, env), raw = cookie(req, STATE_COOKIE), payload = verified(config, raw, now);
  const callback = config.origin + '/api/owner-auth?op=callback&provider=' + provider;
  if (!Object.hasOwn(PROVIDERS, provider) || !config.providers[provider] || payload.provider !== provider || payload.callback !== callback || payload.origin !== config.origin || payload.namespace !== scope.namespace || !Object.hasOwn(RETURNS, payload.destination) || !equal(payload.state, state) || !equal(payload.prior, prior(req))) throw fail(400, 'AUTH_STATE');
  if (!opaque(payload.pkce) || (provider === 'naver' && !opaque(payload.nonce))) throw fail(400, 'AUTH_STATE');
  const cancelled = error !== null && error !== undefined;
  if (cancelled ? (typeof error !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(error) || code !== null && code !== undefined) : (typeof code !== 'string' || code.length < 1 || code.length > 4096 || /[\x00-\x20\x7f]/.test(code))) throw fail(400, 'AUTH_CODE');
  await limitOAuth({ req, store, scope, config, env, operation: 'callback', now });
  const key = stateKey(config, scope, state), binding = hash(raw);
  if (await transaction(store, 'claim', [key], { now, binding }) !== 'ok') throw fail(400, 'AUTH_STATE');
  if (cancelled) { await transaction(store, 'cancel', [key], {}); throw fail(400, 'AUTH_CANCELLED'); }
  try {
    const credentials = config.providers[provider], endpoints = PROVIDERS[provider];
    const params = { grant_type: 'authorization_code', client_id: credentials.clientId, client_secret: credentials.clientSecret, code, redirect_uri: callback };
    params.code_verifier = payload.pkce;
    const tokens = await providerJson(fetcher, endpoints.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params).toString() });
    if (tokens.error || typeof tokens.access_token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(tokens.access_token) || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer') throw fail(502, 'AUTH_PROVIDER');
    const subject = provider === 'naver'
      ? await naverSubject({ token: tokens.id_token, clientId: credentials.clientId, payload, now: clock(), fetcher })
      : providerSubject('kakao', await providerJson(fetcher, endpoints.subject, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.access_token, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'property_keys=%5B%5D' }));
    const issuedAt = clock(), token = random();
    const session = { binding: random(), accountId: 'oa_' + mac(config.identityKey, JSON.stringify(['account', config.origin, scope.namespace, provider, credentials.clientId, subject])), provider, origin: config.origin, namespace: scope.namespace, issuedAt, expiresAt: issuedAt + SESSION_TTL * 1000 };
    const oldToken = cookie(req, SESSION_COOKIE);
    const oldKey = opaque(oldToken) ? sessionKey(config, scope, oldToken) : namespace(config, scope) + ':none';
    const life=lifecycleKeys(scope,session.accountId);
    const outcome=await transaction(store,'finish',[key,sessionKey(config,scope,token),oldKey,life.generation,life.barrier,life.sessions],{now:issuedAt,binding,session:JSON.stringify(session),ttl:SESSION_TTL});
    if(outcome==='blocked')throw fail(401,'AUTH_LIFECYCLE');
    if(outcome!=='ok')throw fail(400,'AUTH_STATE');
    return { location: config.origin + RETURNS[payload.destination], cookies: [cookieHeader(STATE_COOKIE, '', 0), cookieHeader(SESSION_COOKIE, token, SESSION_TTL)] };
  } catch (err) { await transaction(store, 'cancel', [key], {}).catch(() => {}); throw err; }
}
export async function logout({ req, store, scope, env, now }) {
  const config = trustedRequest(req, scope, env), token = cookie(req, SESSION_COOKIE), raw = cookie(req, STATE_COOKIE);
  const keys = [];
  if (raw) { try { keys.push(stateKey(config, scope, verified(config, raw, now).state)); } catch {} }
  if (opaque(token)) keys.push(sessionKey(config, scope, token));
  if (keys.length) await transaction(store, 'cancel', keys, {});
  return [cookieHeader(STATE_COOKIE, '', 0), cookieHeader(SESSION_COOKIE, '', 0)];
}

// Trusted internal callers only. These are deliberately not HTTP operations.
async function lifecycleOperation(op,{store,scope,accountId,operationId,expectedCutoff=0,cutoff,limit=25}) {
 if(!store?.lifecycleTransaction||typeof accountId!=='string'||!accountId||accountId.length>512||/[\u0000-\u001f\u007f]/.test(accountId)||typeof operationId!=='string'||!/^[A-Za-z0-9_-]{22,64}$/.test(operationId)||!Number.isSafeInteger(expectedCutoff)||expectedCutoff<0||(op==='cleanup'&&(!Number.isSafeInteger(cutoff)||cutoff<1||!Number.isInteger(limit)||limit<1||limit>25)))throw fail(400,'AUTH_LIFECYCLE_INPUT');
 const k=lifecycleKeys(scope,accountId);
 try{const result=await store.lifecycleTransaction(op,[k.generation,k.barrier,k.sessions,k.owner],{accountId,operationId,expectedCutoff,cutoff,limit,namespace:scope.namespace,prefix:k.prefix,revisionSeed:op==='cleanup'?randomBytes(32).toString('hex'):undefined});if(!result||!['cleanup','done','conflict','blocked'].includes(result.status))throw new Error('invalid');return result;}catch{throw fail(503,'AUTH_STORE');}
}
export const beginAccountWithdrawal=options=>lifecycleOperation('begin',options);
export const cleanupAccountWithdrawal=options=>lifecycleOperation('cleanup',options);
