import { createHmac } from 'node:crypto';
import { HttpError } from './guard.mjs';
import { authConfig, trustedRequest, trustedRateIdentity } from './owner-auth.mjs';

// WIP: deliberately hard-disabled, not overridable through env/dependencies.
// A live Firebase lookup (validSince/auth_time) still races password reset between
// that lookup and an independent Redis owner-write. Tokens encrypted locally do
// not fix this. No owner sessions are issued or accepted for this provider.
export const LOCAL_AUTH_IMPLEMENTATION_READY = false;
export const LOCAL_AUTH_BLOCKERS = Object.freeze([
  'Atomic local login rotation/logout/replay fencing is not implemented.',
  'Reset completion/all-device revocation cannot be atomically checked with owner Redis writes.',
  'Live project-bound Admin lookup and validSince/auth_time revocation checks are not implemented.',
  'Runtime raw-body duplicate preservation and Firebase API-key header support are unverified.',
  'Managed email sender/domain/templates, privacy/retention/transfer notices and provider policy/security review are outstanding.',
  'No actual Redis or real-provider E2E validation has occurred.'
]);
const fail = (status, code) => new HttpError(status, code, '이메일 로그인을 완료할 수 없어요. 잠시 후 다시 시도해 주세요.');
const mac = (key, value) => createHmac('sha256', key).update(value).digest('base64url');
export function localAuthConfig(env = {}) {
  const auth = authConfig(env);
  if (!auth || env.YB_LOCAL_AUTH_ENABLED !== 'true' || env.YB_LOCAL_AUTH_PROVIDER !== 'firebase') return null;
  if (typeof env.YB_FIREBASE_PROJECT_ID !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.YB_FIREBASE_PROJECT_ID)) return null;
  if (typeof env.YB_FIREBASE_API_KEY !== 'string' || !/^AIza[A-Za-z0-9_-]{35}$/.test(env.YB_FIREBASE_API_KEY)) return null;
  return { auth, project: env.YB_FIREBASE_PROJECT_ID, apiKey: env.YB_FIREBASE_API_KEY };
}
export const localAuthAvailable = env => LOCAL_AUTH_IMPLEMENTATION_READY && !!localAuthConfig(env);
export const LOCAL_RATE_LIMITS = Object.freeze({ windowSeconds: 900, global: 200, ip: 15, account: 5 });
const GENERIC = Object.freeze({ accepted: true, message: '요청이 가능한 계정이면 안내 메일을 보내드립니다. 메일함을 확인해 주세요.' });
// Flat string-only JSON rejects duplicate decoded keys, nested/unknown fields.
// Already-parsed objects fail closed: body parsers erase duplicate-key evidence.
export function parseLocalInput(raw, op) {
  if (!['signup','login','reset'].includes(op)) throw fail(400, 'LOCAL_OP');
  if (Buffer.isBuffer(raw)) { const decoded = raw.toString('utf8'); if (!Buffer.from(decoded).equals(raw)) throw fail(400, 'LOCAL_INPUT'); raw = decoded; }
  if (typeof raw !== 'string') throw fail(400, 'LOCAL_RAW_BODY_REQUIRED');
  if (Buffer.byteLength(raw) > 4096) throw fail(413, 'LOCAL_INPUT');
  const pair = /\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*:\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*/y;
  const text = raw.trim(); if (!text.startsWith('{') || !text.endsWith('}')) throw fail(400, 'LOCAL_INPUT');
  const out = Object.create(null); let pos = 1;
  while (pos < text.length - 1) {
    pair.lastIndex = pos; const match = pair.exec(text); if (!match) throw fail(400, 'LOCAL_INPUT');
    const key = JSON.parse(match[1]); if (Object.hasOwn(out, key)) throw fail(400, 'LOCAL_INPUT');
    out[key] = JSON.parse(match[2]); pos = pair.lastIndex;
    if (pos === text.length - 1) break;
    if (text[pos++] !== ',' || pos >= text.length - 1) throw fail(400, 'LOCAL_INPUT');
  }
  const keys = Object.keys(out), expected = op === 'reset' ? ['email'] : ['email','password'];
  if (keys.length !== expected.length || keys.some(k => !expected.includes(k))) throw fail(400, 'LOCAL_INPUT');
  if (out.email.length > 254 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,188}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(out.email) || out.email.includes('..') || out.email.startsWith('.') || out.email.includes('.@') || out.email.split('@')[1].split('.').some(v => v.startsWith('-') || v.endsWith('-') || v.length > 63)) throw fail(400, 'LOCAL_INPUT');
  out.email = out.email.toLowerCase();
  if (op !== 'reset' && (out.password.length < (op === 'signup' ? 12 : 1) || Buffer.byteLength(out.password) > 1024 || /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(out.password))) throw fail(400, 'LOCAL_INPUT');
  return out;
}
export function localRequestContext(req, env) {
  if (req.headers.origin !== env.YB_AUTH_ORIGIN || !['same-origin', undefined].includes(req.headers['sec-fetch-site'])) throw fail(403, 'ORIGIN');
  if (req.method !== 'POST') throw fail(405, 'METHOD');
  if (typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) throw fail(415, 'CONTENT_TYPE');
}
export async function limitLocalAuth({ req, scope, env, store, email, now }) {
  const config = trustedRequest(req, scope, env);
  if (!Number.isSafeInteger(now) || now < 0) throw fail(503, 'LOCAL_CLOCK');
  const identity = trustedRateIdentity(req, env), ms = LOCAL_RATE_LIMITS.windowSeconds * 1000, bucket = Math.floor(now / ms), ttl = Math.ceil(((bucket + 1) * ms - now) / 1000);
  const prefix = 'yb:local-rate:v1:' + mac(config.secret, JSON.stringify([config.origin, scope.namespace])) + ':' + bucket;
  const counters = [{ key: prefix + ':global', limit: LOCAL_RATE_LIMITS.global, ttl }, { key: prefix + ':ip:' + mac(config.secret, 'local-ip:' + identity), limit: LOCAL_RATE_LIMITS.ip, ttl }, { key: prefix + ':account:' + mac(config.secret, 'local-email:' + email.toLowerCase()), limit: LOCAL_RATE_LIMITS.account, ttl }];
  let r; try { if (typeof store?.publicTransaction !== 'function') throw Error(); r = await store.publicTransaction('rate', [], { now, counters }); } catch { throw fail(503, 'LOCAL_RATE_STORE'); }
  if (r?.status === 'limited') throw new HttpError(429, 'LOCAL_RATE_LIMIT', '요청이 많아요. 잠시 후 다시 시도해 주세요.', { retryAfter: ttl });
  if (r?.status !== 'ok') throw fail(503, 'LOCAL_RATE_STORE');
}
export function localAccountId(config, scope, project, sub) {
  if (typeof project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || typeof sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sub)) throw fail(502, 'LOCAL_IDENTITY');
  return 'oa_' + mac(config.identityKey, JSON.stringify(['account', config.origin, scope.namespace, 'firebase-password', project, sub]));
}
const ENDPOINT = 'https://identitytoolkit.googleapis.com/v1/accounts:';
async function providerCall(fetcher, apiKey, operation, body) {
  if (!['signUp','signInWithPassword','lookup','sendOobCode'].includes(operation)) throw fail(502, 'LOCAL_PROVIDER');
  try {
    const url = ENDPOINT + operation;
    const response = await fetcher(url, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Goog-Api-Key': apiKey }, body: JSON.stringify(body) });
    if (response.redirected || (response.url && response.url !== url) || Number(response.headers?.get('content-length')) > 32768 || !response.body?.getReader) throw Error();
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > 32768) { await reader.cancel(); throw Error(); } chunks.push(Buffer.from(r.value)); } } finally { reader.releaseLock(); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    if (!response.ok) {
      if (response.status === 400 && ['EMAIL_EXISTS','EMAIL_NOT_FOUND','INVALID_PASSWORD','INVALID_LOGIN_CREDENTIALS','USER_DISABLED'].includes(data.error?.message)) return { rejected: true };
      throw Error();
    }
    if (data.error) throw Error();
    return { data };
  } catch { throw fail(502, 'LOCAL_PROVIDER'); }
}
// Synthetic mock protocol only: no ambient network/env, cookies, sessions or DB.
export function createLocalAuthSimulator({ fetcher, project = 'synthetic-project', apiKey = 'synthetic-api-key', config, scope }) {
  if (typeof fetcher !== 'function' || !project.startsWith('synthetic-') || apiKey !== 'synthetic-api-key') throw fail(503, 'LOCAL_SIMULATION_ONLY');
  const call = (op, body) => providerCall(fetcher, apiKey, op, body);
  return async (op, raw) => {
    const input = parseLocalInput(raw, op);
    if (!input.email.endsWith('.invalid')) throw fail(400, 'LOCAL_SIMULATION_ONLY');
    if (op === 'reset') { await call('sendOobCode', { requestType: 'PASSWORD_RESET', email: input.email }); return { ...GENERIC }; }
    const tokenResponse = await call(op === 'signup' ? 'signUp' : 'signInWithPassword', { email: input.email, password: input.password, returnSecureToken: true });
    if (tokenResponse.rejected) { if (op === 'signup') return { ...GENERIC }; throw fail(401, 'LOCAL_CREDENTIALS'); }
    const tokens = tokenResponse.data;
    if (typeof tokens.idToken !== 'string' || !/^[A-Za-z0-9_.-]{1,16384}$/.test(tokens.idToken) || typeof tokens.localId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tokens.localId)) throw fail(502, 'LOCAL_PROVIDER');
    const found = await call('lookup', { idToken: tokens.idToken }), users = found.data?.users, user = users?.[0];
    if (!Array.isArray(users) || users.length !== 1 || !user || user.localId !== tokens.localId || typeof user.email !== 'string' || user.email.toLowerCase() !== input.email || user.disabled === true || typeof user.emailVerified !== 'boolean') throw fail(401, 'LOCAL_CREDENTIALS');
    if (op === 'signup') {
      if (user.emailVerified) throw fail(502, 'LOCAL_PROVIDER');
      const mail = await call('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: tokens.idToken });
      if (mail.rejected) throw fail(502, 'LOCAL_PROVIDER');
      return { ...GENERIC };
    }
    if (!user.emailVerified) throw fail(401, 'LOCAL_CREDENTIALS');
    localAccountId(config, scope, project, user.localId);
    // Even verified/replayed credentials NEVER mint an owner session.
    throw fail(503, 'LOCAL_SESSION_RELEASE_BLOCKED');
  };
}
