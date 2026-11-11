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
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(body)); } catch { throw bad(); }
    if (bytes > maxBytes) throw new HttpError(413, 'TOO_LARGE', '보낸 내용이 너무 길어요.');
    return body;
  }
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
      pageDraft: UNLIMITED,
    },
    // 호출 전에 잡아두는 최대 예상 비용(마이크로달러). 끝나면 실제 비용으로 정산한다.
    estimateMicro: { search: 350000, report: 250000, research: 450000, pageDraft: 250000 },
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
      console.error('[maechul] redis error', r?.status); // never log provider echoes of request secrets
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
    try { return restorePublicArrays(JSON.parse(v)); } catch { return null; }
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
  async del(key) {
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
  async getJson(key) { if (this.publicExpiry?.has(key) && this.publicExpiry.get(key) <= Date.now()) { this.kv.delete(key); this.publicExpiry.delete(key); } const v = this.kv.get(key); return v ? JSON.parse(v) : null; }
  async setJson(key, value) { this.kv.set(key, JSON.stringify(value)); }
  async lock(key) { if (this.kv.has(key)) return false; this.kv.set(key, '1'); return true; }
  async unlock(key) { this.kv.delete(key); }
  async del(key) { this.kv.delete(key); }
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

// Atomic beta publishing operations. One EVAL owns each record/index transition;
// no lock expiry or request timeout can split a publish/delete from its index.
export const STORES_LUA = `-- stores:v1
local op = ARGV[1]
local p = cjson.decode(ARGV[2])
local function read(k) local v = redis.call('GET', k); if v then return cjson.decode(v) end end
local function write(k, v, ttl)
  if ttl > 0 then redis.call('SET', k, cjson.encode(v), 'EX', ttl)
  else redis.call('SET', k, cjson.encode(v)) end
end
local function allowed()
  for i,c in ipairs(p.counters or {}) do
    if tonumber(redis.call('GET', c.key) or '0') >= c.limit then return false end
  end
  return true
end
local function count()
  for i,c in ipairs(p.counters or {}) do
    redis.call('INCR', c.key); redis.call('EXPIRE', c.key, c.ttl)
  end
end
local function result(v) return cjson.encode(v) end
if op == 'rate' then
  if not allowed() then return result({status='limited'}) end
  count(); return result({status='ok'})
end
if op == 'list' then
  if p.ttl > 0 then redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', p.now - p.ttl * 1000) end
  local ids = redis.call('ZREVRANGE', KEYS[1], p.offset, p.offset + p.limit)
  local items = {}
  for i,id in ipairs(ids) do
    local r = read(p.prefix .. id)
    if r and not r.deleted and not r.hidden then table.insert(items, {id=r.id, data=r.data})
    else redis.call('ZREM', KEYS[1], id) end
  end
  return result({status='ok', items=items})
end
local old = read(KEYS[1])
if op == 'create' then
  if old then return result({status='exists', record=old}) end
  if not allowed() then return result({status='limited'}) end
  count(); write(KEYS[1], p.record, p.ttl)
  redis.call('ZADD', KEYS[2], p.record.createdAt, p.record.id)
  if p.ttl > 0 then redis.call('EXPIRE', KEYS[2], p.ttl) end
  return result({status='created', record=p.record})
end
if not old or old.deleted then return result({status='missing'}) end
if op == 'report' then
  if redis.call('HEXISTS', KEYS[3], p.reporter) == 1 then return result({status='reported'}) end
  if not allowed() then return result({status='limited'}) end
  count(); redis.call('HSET', KEYS[3], p.reporter, p.reason)
  if p.ttl > 0 then redis.call('EXPIRE', KEYS[3], p.ttl) end
  if redis.call('HLEN', KEYS[3]) >= 3 then
    old.hidden = true; old.revision = p.revision
    write(KEYS[1], old, p.ttl); redis.call('ZREM', KEYS[2], old.id)
  end
  return result({status='reported'})
end
if old.revision ~= p.expected then return result({status='conflict'}) end
if op == 'update' then
  write(KEYS[1], p.record, p.ttl)
  return result({status='ok', record=p.record})
end
if op == 'delete' then
  write(KEYS[1], {deleted=true, revision=p.revision}, p.tombstoneTtl)
  redis.call('ZREM', KEYS[2], old.id); redis.call('DEL', KEYS[3])
  return result({status='ok'})
end
return result({status='invalid'})`;

RedisStore.prototype.publicTransaction = async function(op, keys, payload) {
  const value = await this.cmd(['EVAL', STORES_LUA, String(keys.length), ...keys, op, JSON.stringify(payload)]);
  try { const r=JSON.parse(value); if(r.record) restorePublicArrays(r.record); if(Array.isArray(r.items)) r.items.forEach(restorePublicArrays); return r; } catch { throw new HttpError(503, 'STORE', '저장 상태를 확인하지 못했어요.'); }
};

MemoryStore.prototype.publicTransaction = async function(op, keys, p) {
  // Synchronous until return: concurrent async callers cannot interleave a transaction.
  this.publicExpiry ||= new Map();
  const now = p.now ?? Date.now();
  const get = key => {
    if (this.publicExpiry.has(key) && this.publicExpiry.get(key) <= now) {
      this.kv.delete(key); this.publicExpiry.delete(key);
    }
    return this.kv.get(key);
  };
  const put = (key, value, ttl) => {
    this.kv.set(key, value);
    if (ttl > 0) this.publicExpiry.set(key, now + ttl * 1000);
    else this.publicExpiry.delete(key);
  };
  const read = key => { const value = get(key); return value ? JSON.parse(value) : null; };
  const allowed = () => (p.counters || []).every(c => Number(get(c.key) || 0) < c.limit);
  const count = () => { for (const c of p.counters || []) put(c.key, Number(get(c.key) || 0) + 1, c.ttl); };
  if (op === 'rate') { if (!allowed()) return {status:'limited'}; count(); return {status:'ok'}; }
  const indexKey = op === 'list' ? keys[0] : keys[1];
  const index = get(indexKey) || new Map();
  const saveIndex = () => put(indexKey, index, p.indexTtl ?? p.ttl);
  if (op === 'list') {
    for (const [id, score] of index) if (p.ttl > 0 && score <= now - p.ttl * 1000) index.delete(id);
    const ids = [...index].sort((a,b) => b[1]-a[1] || b[0].localeCompare(a[0])).slice(p.offset, p.offset+p.limit+1);
    const items = [];
    for (const [id] of ids) { const r = read(p.prefix+id); if (r && !r.deleted && !r.hidden) items.push({id:r.id,data:r.data}); else index.delete(id); }
    return {status:'ok',items};
  }
  const old = read(keys[0]);
  if (op === 'create') {
    if (old) return {status:'exists',record:old};
    if (!allowed()) return {status:'limited'};
    count(); put(keys[0],JSON.stringify(p.record),p.ttl); index.set(p.record.id,p.record.createdAt); saveIndex();
    return {status:'created',record:structuredClone(p.record)};
  }
  if (!old || old.deleted) return {status:'missing'};
  if (op === 'report') {
    const reporters = get(keys[2]) || new Map();
    if (reporters.has(p.reporter)) return {status:'reported'};
    if (!allowed()) return {status:'limited'};
    count(); reporters.set(p.reporter,p.reason); put(keys[2],reporters,p.ttl);
    if (reporters.size >= 3) {old.hidden=true;old.revision=p.revision;put(keys[0],JSON.stringify(old),p.ttl);index.delete(old.id);}
    return {status:'reported'};
  }
  if (old.revision !== p.expected) return {status:'conflict'};
  if (op === 'update') {put(keys[0],JSON.stringify(p.record),p.ttl);return {status:'ok',record:structuredClone(p.record)};}
  if (op === 'delete') {put(keys[0],JSON.stringify({deleted:true,revision:p.revision}),p.tombstoneTtl);index.delete(old.id);this.kv.delete(keys[2]);this.publicExpiry.delete(keys[2]);return {status:'ok'};}
  return {status:'invalid'};
};

// Redis Lua cjson represents empty JSON arrays as empty objects on re-encode.
function restorePublicArrays(record) {
  if (record?.id && record?.data) for(const key of ['sections','faqs','situations']) { const v=record.data[key]; if(v && !Array.isArray(v) && typeof v==='object' && Object.keys(v).length===0) record.data[key]=[]; }
  return record;
}

// Account ownership transitions are isolated from the legacy password API.
// Every authorization check and record/index write happens in one transaction.

// Lossless ownership edits. Parsing validates; only selected source spans change.
export function rawObjectMembers(raw) {
 if(typeof raw!=='string'||Buffer.byteLength(raw)>131072)throw new Error('RAW_UNSAFE');
 const value=JSON.parse(raw);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('RAW_UNSAFE');
 const ws=i=>{while(/[\x20\t\r\n]/.test(raw[i]||'x'))i++;return i;};
 const endString=i=>{for(i++;i<raw.length;i++){if(raw[i]==='\\')i++;else if(raw[i]==='"')return i;}throw new Error('RAW_UNSAFE');};
 let i=ws(0)+1,previous=null;const members=new Map();
 while(true){i=ws(i);if(raw[i]==='}')return {value,members,close:i};const start=i,end=endString(i),key=JSON.parse(raw.slice(i,end+1));if(members.has(key))throw new Error('RAW_UNSAFE');i=ws(end+1)+1;i=ws(i);const first=i;let depth=0;
 for(;i<raw.length;i++){const c=raw[i];if(c==='"')i=endString(i);else if(c==='{'||c==='['){if(++depth>128)throw new Error('RAW_UNSAFE');}else if(c==='}'||c===']'){if(!depth)break;depth--;}else if(c===','&&!depth)break;}
 let last=i;while(last>first&&/[\x20\t\r\n]/.test(raw[last-1]))last--;
 members.set(key,{start,first,last,remove:raw[i]===','?[start,i+1]:[previous??start,i]});if(raw[i]==='}')return {value,members,close:i};previous=i;i++;
 }
}
export function patchRawObject(raw,changes) {
 const {members,close}=rawObjectMembers(raw),patches=[],added=[];let count=members.size;
 for(const [key,text]of Object.entries(changes)){const m=members.get(key);if(text===undefined){if(m){patches.push([...m.remove,'']);count--;}}else{JSON.parse(text);if(m)patches.push([m.first,m.last,text]);else{added.push(JSON.stringify(key)+':'+text);count++;}}}
 if(added.length)patches.push([close,close,(count>added.length?',':'')+added.join(',')]);
 patches.sort((a,b)=>b[0]-a[0]);let out=raw;for(const [a,b,text]of patches)out=out.slice(0,a)+text+out.slice(b);rawObjectMembers(out);return out;
}
export function ownerReplacement(raw,op,p) {
 const {value:old,members}=rawObjectMembers(raw);
 if(typeof old.id!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(old.id)||!old.data||Array.isArray(old.data)||typeof old.data!=='object'||!old.password||typeof old.password!=='object')throw new Error('RAW_UNSAFE');
 if(typeof p.revision!=='string'||!/^[a-f0-9]{32}$/.test(p.revision)||p.revision===old.revision)throw new Error('RAW_UNSAFE');
 const changes={revision:JSON.stringify(p.revision)};
 if(op==='claim')changes.ownerAccountId=JSON.stringify(p.accountId);
 else if(op==='unlink')changes.ownerAccountId=undefined;
 else if(op==='update'){
  const span=members.get('data'),dataRaw=raw.slice(span.first,span.last),parsed=rawObjectMembers(dataRaw),edits={};
  const allowed=['name','address','headline','intro','sections','faqs','situations'];
  if(!p.data||Array.isArray(p.data)||Object.keys(p.data).some(k=>!allowed.includes(k)))throw new Error('RAW_UNSAFE');
  for(const [key,value]of Object.entries(p.data)){
   if(['sections','faqs','situations'].includes(key)){
    if(!Array.isArray(value))throw new Error('RAW_UNSAFE');
    const fields=key==='sections'?['heading','body']:['question','answer'];
    const member=parsed.members.get(key);if(member){const segment=dataRaw.slice(member.first,member.last);let quoted=false,escaped=false,stack=[];for(let i=0;i<segment.length;i++){const c=segment[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;continue;}if(c==='{')stack.push(i);else if(c==='}')rawObjectMembers(segment.slice(stack.pop(),i+1));}}
    const prior=parsed.value[key];if(prior!==undefined&&!(prior&&typeof prior==='object'&&!Array.isArray(prior)&&Object.keys(prior).length===0)&&(!Array.isArray(prior)||prior.some(r=>!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!fields.includes(k)))))throw new Error('RAW_UNSAFE');
   }
   edits[key]=JSON.stringify(value);
  }
  changes.data=patchRawObject(dataRaw,edits);if(!Number.isSafeInteger(p.updatedAt)||p.updatedAt<0)throw new Error('RAW_UNSAFE');changes.updatedAt=JSON.stringify(p.updatedAt);
 }else throw new Error('RAW_UNSAFE');
 return patchRawObject(raw,changes);
}

export const OWNER_STORES_LUA = `-- owner-stores:v1
local op = ARGV[1]
local p = cjson.decode(ARGV[2])
local serverTime=redis.call('TIME')
local serverNow=tonumber(serverTime[1])*1000+math.floor(tonumber(serverTime[2])/1000)
p.now=math.max(p.now,serverNow)
-- Session authorization and ownership mutation share this one EVAL. No request
-- timestamp, previously successful GET, or accountId alone can bypass logout.
local proof=p.session
local function sessionDenied() return cjson.encode({status='session'}) end
if type(proof)~='table' or type(proof.key)~='string' or #KEYS~=(op=='list' and 2 or 3) or KEYS[#KEYS]~=proof.key or #proof.key~=148 or not string.match(proof.key,'^yb:auth:v1:%x+:session:%x+$') then return sessionDenied() end
local function compatible(k,t) local actual=redis.call('TYPE',k).ok;return actual=='none' or actual==t end
local indexKey=KEYS[op=='list' and 1 or 2]
if not compatible(proof.key,'string') or not compatible(indexKey,'zset') or (op~='list' and not compatible(KEYS[1],'string')) then return cjson.encode({status='blocked'}) end
for i=1,#KEYS do for j=i+1,#KEYS do if KEYS[i]==KEYS[j] then return cjson.encode({status='blocked'})end end end
local sessionRaw=redis.call('GET',proof.key)
if not sessionRaw or redis.call('PTTL',proof.key)<=0 then return sessionDenied() end
local decoded,s=pcall(cjson.decode,sessionRaw)
if not decoded or type(s)~='table' or type(s.binding)~='string' or #s.binding~=43 or not string.match(s.binding,'^[%w_-]+$') or s.binding~=proof.binding or s.accountId~=p.accountId or s.accountId~=proof.accountId or (s.provider~='kakao' and s.provider~='naver' and s.provider~='google') or s.provider~=proof.provider or s.origin~=p.authOrigin or s.origin~=proof.origin or s.namespace~=p.scopeNamespace or s.namespace~=proof.namespace or type(s.issuedAt)~='number' or type(s.expiresAt)~='number' or s.issuedAt~=math.floor(s.issuedAt) or s.expiresAt~=math.floor(s.expiresAt) or s.issuedAt<0 or s.expiresAt>9007199254740991 or s.issuedAt~=proof.issuedAt or s.expiresAt~=proof.expiresAt or s.issuedAt>p.now or s.expiresAt<=p.now or s.expiresAt-s.issuedAt~=604800000 then return sessionDenied() end
local readError=false
local function read(k)
 if not compatible(k,'string') then readError=true;return nil end
 local v=redis.call('GET',k);if not v then return nil end
 local ok,r=pcall(cjson.decode,v)
 if not ok or type(r)~='table' or (not r.deleted and (type(r.id)~='string' or #r.id~=22 or type(r.data)~='table' or (r.updatedAt~=nil and (type(r.updatedAt)~='number' or r.updatedAt<0 or r.updatedAt>9007199254740991)) or (r.createdAt~=nil and (type(r.createdAt)~='number' or r.createdAt<0 or r.createdAt>9007199254740991)) or (r.expiresAt~=nil and r.expiresAt~=cjson.null and (type(r.expiresAt)~='number' or r.expiresAt<0 or r.expiresAt>9007199254740991)))) then readError=true;return nil end
 return r
end
local function result(v) return cjson.encode(v) end
local function active(r)
  return r and not r.deleted and not (type(r.expiresAt)=='number' and r.expiresAt<=p.now)
end
local function summary(r) return {id=r.id,name=r.data.name,address=r.data.address,headline=r.data.headline,hidden=r.hidden==true,updatedAt=r.updatedAt} end
local function index(r)
  -- Inspect BEFORE ZADD: -2 (missing) must not be confused with -1
  -- (an existing persistent index). Persistent membership always wins.
  local priorTtl=redis.call('PTTL',KEYS[2])
  redis.call('ZADD',KEYS[2],r.updatedAt or r.createdAt or p.now,r.id)
  if type(r.expiresAt)=='number' then
    local remaining=math.max(1,math.ceil(r.expiresAt-serverNow))
    if priorTtl==-2 or (priorTtl>=0 and priorTtl<remaining) then
      redis.call('PEXPIREAT',KEYS[2],math.ceil(r.expiresAt))
    end
  else redis.call('PERSIST',KEYS[2]) end
end
if op=='list' then
  local ids=redis.call('ZREVRANGE',KEYS[1],0,math.min(500,p.scan)-1)
  local items={}
  local stale={}
  for _,id in ipairs(ids) do
    local r=nil
    if #id==22 and string.match(id,'^[%w_-]+$') then r=read(p.prefix..id) end
    if active(r) and r.id==id and r.ownerAccountId==p.accountId then
      if #items<math.min(100,p.limit) then table.insert(items,summary(r)) end
    else table.insert(stale,id) end
  end
  if readError then return result({status='blocked'})end
  for _,id in ipairs(stale)do redis.call('ZREM',KEYS[1],id)end
  return result({status='ok',stores=items})
end
local old=read(KEYS[1])
if readError then return result({status='blocked'})end
if old and old.id and p.scopeNamespace..':record:'..old.id~=KEYS[1] then return result({status='blocked'})end
if not active(old) then return result({status='missing'}) end
if op=='read' then
  if old.ownerAccountId~=p.accountId then return result({status='denied'}) end
  return result({status='ok',recordRaw=redis.call('GET',KEYS[1])})
end
if op=='claim' then
  if old.ownerAccountId and old.ownerAccountId~=cjson.null and old.ownerAccountId~=p.accountId then return result({status='denied'}) end
elseif op=='update' or op=='unlink' then
  if old.ownerAccountId~=p.accountId then return result({status='denied'}) end
else return result({status='invalid'}) end
if old.revision~=p.expected then return result({status='conflict'}) end
if p.expectedRaw~=redis.call('GET',KEYS[1]) then return result({status='conflict'})end
if op=='claim' and old.ownerAccountId==p.accountId then index(old); return result({status='ok',recordRaw=p.expectedRaw}) end
if type(p.replacementRaw)~='string' then return result({status='blocked'})end
local replacementsOk,replacement=pcall(cjson.decode,p.replacementRaw);if not replacementsOk or replacement.id~=old.id or replacement.revision~=p.revision then return result({status='blocked'})end
if op=='claim' then
  local ids=redis.call('ZREVRANGE',KEYS[2],0,499)
  local stale={}
  for _,id in ipairs(ids) do
    local r=nil
    if #id==22 and string.match(id,'^[%w_-]+$') then r=read(p.prefix..id) end
    if not active(r) or r.id~=id or r.ownerAccountId~=p.accountId then table.insert(stale,id) end
  end
  if readError then return result({status='blocked'})end
  if redis.call('ZCARD',KEYS[2])-#stale>=100 then return result({status='capacity'}) end
  for _,id in ipairs(stale)do redis.call('ZREM',KEYS[2],id)end
  old.ownerAccountId=p.accountId
elseif op=='unlink' then old.ownerAccountId=nil
else old.data=p.data;old.updatedAt=p.updatedAt end
old.revision=p.revision
redis.call('SET',KEYS[1],p.replacementRaw,'KEEPTTL')
if op=='unlink' then redis.call('ZREM',KEYS[2],old.id) else index(old) end
return result({status='ok',recordRaw=p.replacementRaw})`;

RedisStore.prototype.ownerTransaction = async function(op,keys,payload) {
  if(['claim','update','unlink'].includes(op)){const raw=await this.cmd(['GET',keys[0]]);if(raw){try{const old=rawObjectMembers(raw).value;payload={...payload,expectedRaw:raw,replacementRaw:op==='claim'&&old.ownerAccountId===payload.accountId?raw:ownerReplacement(raw,op,payload)};}catch{return {status:'blocked'};}}}
  const value=await this.cmd(['EVAL',OWNER_STORES_LUA,String(keys.length),...keys,op,JSON.stringify(payload)]);
  try {
    const r=JSON.parse(value);
    if(r.recordRaw!==undefined){r.record=JSON.parse(r.recordRaw);delete r.recordRaw;}
    if(r.record) restorePublicArrays(r.record);
    if(op==='list' && r.stores && !Array.isArray(r.stores) && Object.keys(r.stores).length===0) r.stores=[];
    return r;
  } catch { throw new HttpError(503,'STORE','저장 상태를 확인하지 못했어요.'); }
};

MemoryStore.prototype.ownerTransaction = async function(op,keys,p) {
  // No awaits: a transaction is indivisible even when requests run concurrently.
  this.publicExpiry ||= new Map();
  const now=Math.max(p.now ?? Date.now(),Date.now());
  // Synchronous validation and the remaining mutation below contain no awaits,
  // matching Redis EVAL ordering, server wall time, TTL and logout revocation.
  const proof=p.session,sessionKey=proof?.key;
  if(!proof || typeof sessionKey!=='string' || !/^yb:auth:v1:[a-f0-9]{64}:session:[a-f0-9]{64}$/.test(sessionKey) || keys.length!==(op==='list'?2:3) || keys.at(-1)!==sessionKey) return {status:'session'};
  const expiry=this.publicExpiry.get(sessionKey);
  if(!Number.isFinite(expiry) || expiry<=now){if(Number.isFinite(expiry)&&expiry<=now){this.kv.delete(sessionKey);this.publicExpiry.delete(sessionKey);}return {status:'session'};}
  let session;try{session=JSON.parse(this.kv.get(sessionKey));}catch{return {status:'session'};}
  if(!session || typeof session.binding!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(session.binding) || session.binding!==proof.binding || session.accountId!==p.accountId || session.accountId!==proof.accountId || !['kakao','naver','google'].includes(session.provider) || session.provider!==proof.provider || session.origin!==p.authOrigin || session.origin!==proof.origin || session.namespace!==p.scopeNamespace || session.namespace!==proof.namespace || !Number.isSafeInteger(session.issuedAt) || !Number.isSafeInteger(session.expiresAt) || session.issuedAt<0 || session.issuedAt!==proof.issuedAt || session.expiresAt!==proof.expiresAt || session.issuedAt>now || session.expiresAt<=now || session.expiresAt-session.issuedAt!==604800000) return {status:'session'};
  const get=key=>{if(this.publicExpiry.has(key) && this.publicExpiry.get(key)<=now){this.kv.delete(key);this.publicExpiry.delete(key);}return this.kv.get(key);};
  const read=key=>{const v=get(key);if(v===undefined)return null;if(typeof v!=='string')throw new Error('RAW_UNSAFE');const r=JSON.parse(v);if(!r||typeof r!=='object'||Array.isArray(r)||(!r.deleted&&(typeof r.id!=='string'||!r.data||typeof r.data!=='object'||['updatedAt','createdAt','expiresAt'].some(k=>r[k]!=null&&!Number.isFinite(r[k])))))throw new Error('RAW_UNSAFE');return restorePublicArrays(r);};
  const indexValue=get(keys[op==='list'?0:1]);if(indexValue!==undefined&&!(indexValue instanceof Map))return {status:'blocked'};
  if(new Set(keys).size!==keys.length)return {status:'blocked'};
  if(op==='list'||op==='claim'){for(const [id] of [...(indexValue||new Map())].sort((a,b)=>b[1]-a[1]).slice(0,500)){if(/^[A-Za-z0-9_-]{22}$/.test(id))read(p.scopeNamespace+':record:'+id);}}
  if(op!=='list'&&get(keys[0])!==undefined){try{rawObjectMembers(get(keys[0]));}catch{return {status:'blocked'};}}
  const active=r=>r && !r.deleted && !(typeof r.expiresAt==='number' && r.expiresAt<=now);
  const pruneEmpty=(key,items)=>{if(items.size===0){this.kv.delete(key);this.publicExpiry.delete(key);}};
  const index=r=>{
    const existing=get(keys[1]),priorExpiry=this.publicExpiry.get(keys[1]);
    const persistent=existing!==undefined && priorExpiry===undefined;
    const items=existing || new Map();items.set(r.id,r.updatedAt ?? r.createdAt ?? now);this.kv.set(keys[1],items);
    if(typeof r.expiresAt==='number' && !persistent) this.publicExpiry.set(keys[1],Math.max(priorExpiry || 0,r.expiresAt));
    else this.publicExpiry.delete(keys[1]);
  };
  if(op==='list') {
    const items=get(keys[0]) || new Map(),stores=[];
    const ids=[...items].sort((a,b)=>b[1]-a[1] || (a[0]<b[0]?1:a[0]>b[0]?-1:0)).slice(0,Math.min(500,p.scan));
    for(const [id] of ids) {
      const r=/^[A-Za-z0-9_-]{22}$/.test(id)?read(p.prefix+id):null;
      if(active(r) && r.id===id && r.ownerAccountId===p.accountId) {
        if(stores.length<Math.min(100,p.limit)) stores.push({id:r.id,name:r.data.name,address:r.data.address,headline:r.data.headline,hidden:r.hidden===true,updatedAt:r.updatedAt});
      } else items.delete(id);
    }
    pruneEmpty(keys[0],items);
    return {status:'ok',stores};
  }
  const old=read(keys[0]);
  if(old?.id&&p.scopeNamespace+':record:'+old.id!==keys[0])return {status:'blocked'};
  if(!active(old)) return {status:'missing'};
  if(op==='read') return old.ownerAccountId===p.accountId?{status:'ok',record:old}:{status:'denied'};
  if(op==='claim') {if(old.ownerAccountId!=null && old.ownerAccountId!==p.accountId) return {status:'denied'};}
  else if(op==='update' || op==='unlink') {if(old.ownerAccountId!==p.accountId) return {status:'denied'};}
  else return {status:'invalid'};
  if(old.revision!==p.expected) return {status:'conflict'};
  if(p.expectedRaw!==undefined&&p.expectedRaw!==get(keys[0]))return {status:'conflict'};
  if(op==='claim' && old.ownerAccountId===p.accountId){index(old);return {status:'ok',record:old};}
  let replacement;try{replacement=ownerReplacement(get(keys[0]),op,p);}catch{return {status:'blocked'};}
  if(op==='claim') {
    const items=get(keys[1]) || new Map();
    for(const [id] of [...items].sort((a,b)=>b[1]-a[1] || (a[0]<b[0]?1:a[0]>b[0]?-1:0)).slice(0,500)) {
      const r=/^[A-Za-z0-9_-]{22}$/.test(id)?read(p.prefix+id):null;
      if(!active(r) || r.id!==id || r.ownerAccountId!==p.accountId) items.delete(id);
    }
    pruneEmpty(keys[1],items);
    if(items.size>=100) return {status:'capacity'};
    old.ownerAccountId=p.accountId;
  } else if(op==='unlink') delete old.ownerAccountId;
  else {old.data=structuredClone(p.data);old.updatedAt=p.updatedAt;}
  old.revision=p.revision;
  // Retain the exact existing expiry; account linking must not extend a preview.
  this.kv.set(keys[0],replacement);
  if(op==='unlink') {const items=get(keys[1]);if(items){items.delete(old.id);pruneEmpty(keys[1],items);}} else index(old);
  return {status:'ok',record:JSON.parse(replacement)};
};
