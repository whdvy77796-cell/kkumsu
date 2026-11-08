// 요청 검사 · 이용량 제한(방문자별 횟수, 하루 전체 AI 예산) · 결과 캐시
// 저장소는 Vercel에 연결된 Upstash Redis(KV_REST_API_URL / KV_REST_API_TOKEN)를 쓴다.
import { createHash, createHmac } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  if (err instanceof HttpError) return send(res, err.status, { error: err.message, code: err.code, ...err.extra });
  console.error('[maechul] unexpected error', err?.stack || err);
  return send(res, 500, { error: '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', code: 'INTERNAL' });
}

export const isProduction = (env) => env.VERCEL_ENV === 'production';
export const onVercel = (env) => !!env.VERCEL;

export async function readJson(req, maxBytes = 16000) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > maxBytes) throw new HttpError(413, 'TOO_LARGE', '보낸 내용이 너무 길어요.');
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'CONTENT_TYPE', 'JSON 형식으로 보내주세요.');
  }
  const bad = () => new HttpError(400, 'BAD_JSON', '요청 형식이 올바르지 않아요.');
  // Vercel 런타임은 req.body를 미리 해석해 둔다. 로컬 개발 서버는 스트림을 직접 읽는다.
  let body;
  try { body = req.body; } catch { throw bad(); }
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    if (Buffer.byteLength(body) > maxBytes) throw new HttpError(413, 'TOO_LARGE', '보낸 내용이 너무 길어요.');
    try { return JSON.parse(body.toString()); } catch { throw bad(); }
  }
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'TOO_LARGE', '보낸 내용이 너무 길어요.');
    parts.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw bad(); }
}

// 다른 사이트에서 이 API를 불러 쓰지 못하게, 같은 주소에서 온 요청만 받는다.
export function checkOrigin(req, env) {
  const origin = req.headers.origin;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  const deny = () => new HttpError(403, 'ORIGIN', '이 사이트 화면에서만 이용할 수 있어요.');
  if (!origin || origin === 'null' || !host) throw deny();
  let o;
  try { o = new URL(origin); } catch { throw deny(); }
  const extra = String(env.MAECHUL_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (o.host.toLowerCase() !== host && !extra.includes(o.host.toLowerCase())) throw deny();
}

export function clientId(req, secret) {
  const raw = String(
    req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown',
  ).split(',')[0].trim();
  return createHmac('sha256', secret).update('ip:' + raw).digest('hex').slice(0, 24);
}

export function kstDay(now = Date.now()) {
  return new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
}

export function hashKey(kind, ...parts) {
  const norm = parts.map((p) => String(p ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()).join('|');
  return `maechul:v2:${kind}:${createHash('sha256').update(norm).digest('hex').slice(0, 40)}`;
}

// 운영자 요청(2026-11-09)으로 기본은 이용량 제한 없음. 환경변수에 값을 넣으면 그때만 제한한다.
// (예산·횟수는 제한 없이도 기록해 두고, 캐시와 중복 요청 잠금은 비용을 아끼려고 그대로 쓴다.)
export const UNLIMITED = Number.MAX_SAFE_INTEGER;
export function limits(env) {
  const opt = (key, min, max) => {
    const raw = env[key];
    if (raw === undefined || raw === null || String(raw).trim() === '' || /^(0|off|none|unlimited)$/i.test(String(raw).trim())) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const count = (key) => {
    const n = opt(key, 1, 1000000);
    return n === null ? UNLIMITED : Math.floor(n);
  };
  const budget = opt('MAECHUL_DAILY_BUDGET_USD', 0.05, 100000);
  return {
    dailyBudgetMicro: budget === null ? UNLIMITED : Math.round(budget * 1e6),
    ipDaily: {
      search: count('MAECHUL_IP_DAILY_SEARCHES'),
      report: count('MAECHUL_IP_DAILY_REPORTS'),
      research: count('MAECHUL_IP_DAILY_RESEARCH'),
    },
    // 호출 전에 잡아두는 최대 예상 비용(마이크로달러). 끝나면 실제 비용으로 정산한다.
    estimateMicro: { search: 350000, report: 250000, research: 450000 },
    cacheTtl: 3 * 24 * 3600,
    // 보고서는 같은 답변으로 다시 열 때만 쓰도록 하루만 보관한다.
    cacheTtlByKind: { report: 24 * 3600 },
    lockTtl: 320,
  };
}

// 하루 예산과 방문자별 횟수를 한 번에 확인하고 잡아두는 스크립트
export const RESERVE_LUA = `-- maechul:reserve
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local count = tonumber(redis.call('GET', KEYS[2]) or '0')
if count >= tonumber(ARGV[3]) then return {'quota', tostring(spent), tostring(count)} end
if spent + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return {'budget', tostring(spent), tostring(count)} end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return {'ok', tostring(spent + tonumber(ARGV[1])), tostring(count + 1)}`;

export class RedisStore {
  constructor(url, token, fetcher = fetch) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.fetcher = fetcher;
  }
  async cmd(args) {
    let r, data;
    try {
      r = await this.fetcher(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(8000),
      });
      data = await r.json();
    } catch {
      data = null;
    }
    if (!r || !r.ok || !data || data.error) {
      console.error('[maechul] redis error', r?.status, data?.error);
      throw new HttpError(503, 'STORE', '이용량 확인 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
    return data.result;
  }
  async reserve({ budgetKey, ipKey, estimate, budget, ipLimit, ttl }) {
    const r = await this.cmd(['EVAL', RESERVE_LUA, '2', budgetKey, ipKey, String(estimate), String(budget), String(ipLimit), String(ttl)]);
    return { status: r?.[0], spent: Number(r?.[1]), count: Number(r?.[2]) };
  }
  async adjust(key, delta) {
    const d = Math.round(delta);
    if (d) await this.cmd(['INCRBY', key, String(d)]);
  }
  async getJson(key) {
    const v = await this.cmd(['GET', key]);
    if (!v) return null;
    try { return JSON.parse(v); } catch { return null; }
  }
  async setJson(key, value, ttl) {
    await this.cmd(['SET', key, JSON.stringify(value), 'EX', String(ttl)]);
  }
  async lock(key, ttl) {
    return (await this.cmd(['SET', key, '1', 'NX', 'EX', String(ttl)])) === 'OK';
  }
  async unlock(key) {
    await this.cmd(['DEL', key]);
  }
}

// 로컬 개발·테스트용 (서버 재시작 시 사라짐)
export class MemoryStore {
  constructor() { this.kv = new Map(); }
  async reserve({ budgetKey, ipKey, estimate, budget, ipLimit }) {
    const spent = Number(this.kv.get(budgetKey) || 0);
    const count = Number(this.kv.get(ipKey) || 0);
    if (count >= ipLimit) return { status: 'quota', spent, count };
    if (spent + estimate > budget) return { status: 'budget', spent, count };
    this.kv.set(budgetKey, spent + estimate);
    this.kv.set(ipKey, count + 1);
    return { status: 'ok', spent: spent + estimate, count: count + 1 };
  }
  async adjust(key, delta) { this.kv.set(key, Number(this.kv.get(key) || 0) + Math.round(delta)); }
  async getJson(key) { const v = this.kv.get(key); return v ? JSON.parse(v) : null; }
  async setJson(key, value) { this.kv.set(key, JSON.stringify(value)); }
  async lock(key) { if (this.kv.has(key)) return false; this.kv.set(key, '1'); return true; }
  async unlock(key) { this.kv.delete(key); }
}

let devStore = null;
export function createStore(env, fetcher = fetch) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisStore(url, token, fetcher);
  if (onVercel(env)) return null; // 배포 환경에서는 이용량 관리 없이 AI를 부르지 않는다
  devStore = devStore || new MemoryStore();
  return devStore;
}

// AI 호출을 이용량 한도 안에서 실행하고, 끝나면 실제 비용으로 정산한다.
export async function runMetered({ env, fetcher = fetch, store, req, kind, cacheKey, refresh, lock = false, run }) {
  const L = limits(env);
  const st = store || createStore(env, fetcher);
  if (!st) throw new HttpError(503, 'STORE_CONFIG', '이용량 관리 설정이 없어 AI 기능을 잠시 멈췄어요.');
  if (!env.OPENROUTER_API_KEY) throw new HttpError(503, 'AI_CONFIG', 'AI 연결 설정이 아직 안 됐어요.');
  if (cacheKey && !refresh) {
    const hit = await st.getJson(cacheKey);
    if (hit) return { ...hit, cached: true };
  }
  // 같은 요청이 이미 진행 중이면 AI를 두 번 부르지 않는다 (새로고침·두 번 누름).
  let lockKey = null;
  if (lock && cacheKey) {
    lockKey = `${cacheKey}:lock`;
    if (!(await st.lock(lockKey, L.lockTtl))) {
      throw new HttpError(409, 'BUSY', '같은 내용으로 이미 만드는 중이에요. 잠시 뒤 다시 확인해 주세요.');
    }
  }
  try {
    if (lockKey && !refresh) {
      const hit = await st.getJson(cacheKey);
      if (hit) return { ...hit, cached: true };
    }
    return await meteredCall({ env, st, L, req, kind, cacheKey, run });
  } finally {
    if (lockKey) await st.unlock(lockKey).catch(() => {});
  }
}

async function meteredCall({ env, st, L, req, kind, cacheKey, run }) {
  const day = kstDay();
  const secret = env.SESSION_SECRET || env.OPENROUTER_API_KEY;
  const budgetKey = `maechul:v1:budget:${day}`;
  const ipKey = `maechul:v1:ip:${kind}:${day}:${clientId(req, secret)}`;
  const estimate = L.estimateMicro[kind];
  const r = await st.reserve({ budgetKey, ipKey, estimate, budget: L.dailyBudgetMicro, ipLimit: L.ipDaily[kind], ttl: 172800 });
  if (r.status === 'quota') {
    throw new HttpError(429, 'IP_QUOTA', `오늘 이용할 수 있는 횟수(${L.ipDaily[kind]}회)를 모두 썼어요. 내일 다시 이용해 주세요.`);
  }
  if (r.status === 'budget') {
    throw new HttpError(429, 'DAILY_BUDGET', '오늘 준비한 AI 이용량이 모두 소진됐어요. 내일 다시 이용해 주세요.');
  }
  if (r.status !== 'ok') throw new HttpError(503, 'STORE', '이용량을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');

  const meter = {
    spent: 0,
    unknown: false,
    add(micro) { if (Number.isFinite(micro) && micro > 0) this.spent += micro; },
    markUnknown() { this.unknown = true; },
  };
  try {
    const out = await run(meter);
    await st.adjust(budgetKey, meter.spent - estimate).catch(() => {});
    if (cacheKey) await st.setJson(cacheKey, out, L.cacheTtlByKind[kind] || L.cacheTtl).catch(() => {});
    console.log(`[maechul] ${kind} ok cost=$${(meter.spent / 1e6).toFixed(4)}`);
    return { ...out, cached: false };
  } catch (err) {
    // 응답을 못 받아 실제 비용을 모르면 잡아둔 금액을 그대로 둔다(보수적으로 계산).
    const used = meter.unknown ? Math.max(meter.spent, estimate) : meter.spent;
    await st.adjust(budgetKey, used - estimate).catch(() => {});
    console.error(`[maechul] ${kind} failed cost=$${(used / 1e6).toFixed(4)}`, err?.code || err?.kind || err?.message);
    throw err;
  }
}
