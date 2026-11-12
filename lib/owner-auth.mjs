import { createHash, createHmac, randomBytes, timingSafeEqual, createPublicKey, verify, constants } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError } from './guard.mjs';
import { requestScope } from './stores.mjs';

export const SESSION_COOKIE = '__Host-yb-session';
// Server-only metadata. Symbol/non-enumerability prevents accidental JSON output.
export const SESSION_BINDING = Symbol('owner-session-binding');
export const STATE_COOKIE = '__Host-yb-oauth';
export const STATE_TTL = 600;
export const SESSION_TTL = 7 * 24 * 3600;
// Fixed UTC 15-minute buckets, shared by all providers. Status and logout are
// deliberately exempt. A rejected transaction allocates/increments no counters.
export const AUTH_RATE_LIMITS = Object.freeze({
  windowSeconds: 900,
  start: Object.freeze({ ip: 20, global: 300 }),
  callback: Object.freeze({ ip: 40, global: 600 }),
});
export const RETURNS = Object.freeze({ dashboard: '/#/my-stores', publish: '/#/page-publish', preview: '/#/page-preview' });
const PROVIDERS = Object.freeze({
  kakao: { authorize: 'https://kauth.kakao.com/oauth/authorize', token: 'https://kauth.kakao.com/oauth/token', subject: 'https://kapi.kakao.com/v2/user/me' },
  naver: { authorize: 'https://nid.naver.com/oauth2/authorize', token: 'https://nid.naver.com/oauth2/token', jwks: 'https://nid.naver.com/oauth2/jwks', issuers: ['https://nid.naver.com'], scope: 'openid' },
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com', 'accounts.google.com'], scope: 'openid' },
});
// Google uses the existing endpoint without a registered query component. The
// handler reserves op-less callbacks for Google; provider is never inferred from
// untrusted claims. Kakao/Naver registered callbacks remain byte-for-byte stable.
const callbackFor = (config, provider) => config.origin + '/api/owner-auth' + (provider === 'google' ? '' : '?op=callback&provider=' + provider);
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
if op=='claim' then
  if not r or r.stage~='ready' or r.exp<=p.now or r.binding~=p.binding then return 'no' end
  r.stage='claimed'
  redis.call('SET',KEYS[1],cjson.encode(r),'PX',math.max(1,r.exp-p.now))
  return 'ok'
end
if op=='finish' then
  if not r or r.stage~='claimed' or r.exp<=p.now or r.binding~=p.binding then return 'no' end
  redis.call('SET',KEYS[2],p.session,'EX',p.ttl)
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
  if (op === 'cancel') { if (r?.sessionKey) store.kv.delete(r.sessionKey); for (const key of keys) store.kv.delete(key); return 'ok'; }
  if (!r || r.exp <= p.now || r.binding !== p.binding || r.stage !== (op === 'claim' ? 'ready' : 'claimed')) return 'no';
  if (op === 'claim') { r.stage = 'claimed'; store.kv.set(keys[0], JSON.stringify(r)); }
  else { store.kv.set(keys[1], p.session); store.publicExpiry ||= new Map(); store.publicExpiry.set(keys[1], Date.now() + p.ttl * 1000); if (keys[2] !== keys[1]) store.kv.delete(keys[2]); r.stage = 'finished'; r.sessionKey = keys[1]; store.kv.set(keys[0], JSON.stringify(r)); }
  return 'ok';
}
export async function requireSession({ req, store, scope, env = process.env, now = Date.now() }) {
  try {
    if (!Number.isSafeInteger(now)) throw fail(401, 'AUTH');
    const config = trustedRequest(req, scope, env), token = cookie(req, SESSION_COOKIE);
    if (!opaque(token)) throw fail(401, 'AUTH');
    if (!store) throw fail(503, 'AUTH_STORE');
    const key = sessionKey(config, scope, token);
    const session = await store.getJson(key);
    if (!object(session) || !opaque(session.binding) || session.origin !== config.origin || session.namespace !== scope.namespace || !Object.hasOwn(PROVIDERS, session.provider) || !config.providers[session.provider] || !/^oa_[A-Za-z0-9_-]{43}$/.test(session.accountId) || !Number.isSafeInteger(session.issuedAt) || session.issuedAt > now || session.expiresAt !== session.issuedAt + SESSION_TTL * 1000 || session.expiresAt <= now) throw fail(401, 'AUTH');
    const result = { accountId: session.accountId, provider: session.provider, issuedAt: session.issuedAt, expiresAt: session.expiresAt };
    Object.defineProperty(result, SESSION_BINDING, { value: Object.freeze({ key, binding: session.binding, accountId: session.accountId, provider: session.provider, origin: session.origin, namespace: session.namespace, issuedAt: session.issuedAt, expiresAt: session.expiresAt }) });
    return result;
  } catch (err) { if (err instanceof HttpError) throw err; throw fail(503, 'AUTH_STORE'); }
}
export async function startLogin({ req, store, scope, env, provider, destination, now }) {
  const config = trustedRequest(req, scope, env);
  if (!Object.hasOwn(PROVIDERS, provider) || !config.providers[provider]) throw fail(503, 'AUTH_DISABLED');
  if (!Object.hasOwn(RETURNS, destination)) throw fail(400, 'AUTH_RETURN');
  if (req.headers.origin !== undefined && req.headers.origin !== config.origin) throw fail(403, 'ORIGIN');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'ORIGIN');
  const callback = callbackFor(config, provider);
  const payload = { state: random(), provider, callback, destination, origin: config.origin, namespace: scope.namespace, prior: prior(req), iat: now, exp: now + STATE_TTL * 1000, pkce: random(), ...(PROVIDERS[provider].jwks ? { nonce: random() } : {}) }; // verifier stays in signed HttpOnly cookie only
  const value = signed(config, payload), binding = hash(value);
  const previous = cookie(req, STATE_COOKIE);
  await limitOAuth({ req, store, scope, config, env, operation: 'start', now });
  if (previous) { try { const old = verified(config, previous, now); await transaction(store, 'cancel', [stateKey(config, scope, old.state)], {}); } catch (e) { if (!(e instanceof HttpError && e.code === 'AUTH_STATE')) throw e; } }
  await store.setJson(stateKey(config, scope, payload.state), { stage: 'ready', binding, exp: payload.exp }, STATE_TTL);
  const url = new URL(PROVIDERS[provider].authorize);
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.providers[provider].clientId, redirect_uri: callback, state: payload.state, code_challenge: createHash('sha256').update(payload.pkce).digest('base64url'), code_challenge_method: 'S256', ...(PROVIDERS[provider].jwks ? { scope: PROVIDERS[provider].scope, nonce: payload.nonce } : {}) }).toString();
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
// Provider-pinned OIDC issuers/endpoints; never use token-controlled discovery
// URLs, jku/x5u or embedded JWKs. Google scope is its documented minimum
// openid only; any email/email_verified/profile claims are discarded, never identities.
async function oidcSubject({ provider, token, clientId, payload, now, fetcher }) {
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
  const jwks = await providerJson(fetcher, PROVIDERS[provider].jwks, { method: 'GET', headers: { Accept: 'application/json' } });
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
    if (!object(claims) || !PROVIDERS[provider].issuers.includes(claims.iss) || typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) throw invalid();
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
  const callback = callbackFor(config, provider);
  if (!Object.hasOwn(PROVIDERS, provider) || !config.providers[provider] || payload.provider !== provider || payload.callback !== callback || payload.origin !== config.origin || payload.namespace !== scope.namespace || !Object.hasOwn(RETURNS, payload.destination) || !equal(payload.state, state) || !equal(payload.prior, prior(req))) throw fail(400, 'AUTH_STATE');
  if (!opaque(payload.pkce) || (PROVIDERS[provider].jwks && !opaque(payload.nonce))) throw fail(400, 'AUTH_STATE');
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
    const subject = endpoints.jwks
      ? await oidcSubject({ provider, token: tokens.id_token, clientId: credentials.clientId, payload, now: clock(), fetcher })
      : providerSubject('kakao', await providerJson(fetcher, endpoints.subject, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.access_token, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'property_keys=%5B%5D' }));
    const issuedAt = clock(), token = random();
    const session = { binding: random(), accountId: 'oa_' + mac(config.identityKey, JSON.stringify(['account', config.origin, scope.namespace, provider, credentials.clientId, subject])), provider, origin: config.origin, namespace: scope.namespace, issuedAt, expiresAt: issuedAt + SESSION_TTL * 1000 };
    const oldToken = cookie(req, SESSION_COOKIE);
    const oldKey = opaque(oldToken) ? sessionKey(config, scope, oldToken) : namespace(config, scope) + ':none';
    if (await transaction(store, 'finish', [key, sessionKey(config, scope, token), oldKey], { now: issuedAt, binding, session: JSON.stringify(session), ttl: SESSION_TTL }) !== 'ok') throw fail(400, 'AUTH_STATE');
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
