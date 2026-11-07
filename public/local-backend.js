// 체험판(단일 HTML)용 브라우저 내 저장소: 서버와 같은 API를 이 브라우저 안에서 흉내 낸다.
// - 자료는 이 브라우저(IndexedDB)에만 저장되고, 이어하기 링크의 열쇠로 암호화된다 (WebCrypto AES-GCM).
// - 다른 기기·다른 브라우저에서는 열 수 없다.
import { generateReport } from '/shared/diagnose.js';
import { inputSignature } from '/shared/engine.js';
import { SAMPLES } from '/shared/samples.js';
import { emptyData, sanitizeData, summarize, diffSummary, sniffFile, EXTRACT_NOTE } from '/shared/casekit.js';
import { analyzeSalesCSV } from '/server/csv.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('maechul-local-v1', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('cases'); r.result.createObjectStore('files'); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}
const getRec = (store, key) => idb(store, 'readonly', (s) => s.get(key));
const putRec = (store, key, val) => idb(store, 'readwrite', (s) => s.put(val, key));
const delRec = (store, key) => idb(store, 'readwrite', (s) => s.delete(key));
const keysOf = (store) => idb(store, 'readonly', (s) => s.getAllKeys());

async function secret() {
  let s = localStorage.getItem('maechul.local.secret');
  if (!s) { s = b64url(rand(32)); localStorage.setItem('maechul.local.secret', s); }
  return enc.encode(s);
}
async function caseKey(id, token) {
  const base = await crypto.subtle.importKey('raw', enc.encode(token), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: await secret(), info: enc.encode(`case:${id}`) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function tokenHash(id, token) {
  const k = await crypto.subtle.importKey('raw', await secret(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(`auth:${id}:${token}`)));
}
async function seal(key, bytes) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return out.buffer;
}
async function open(key, buf) {
  const u = new Uint8Array(buf);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, key, u.subarray(12)));
}
const readCase = async (id, key) => JSON.parse(dec.decode(await open(key, (await getRec('cases', id)).enc)));
async function writeCase(id, key, obj, meta) {
  const rec = (await getRec('cases', id)) || {};
  await putRec('cases', id, { meta: meta || rec.meta, enc: await seal(key, enc.encode(JSON.stringify(obj))) });
}

const err = (status, message) => Object.assign(new Error(message), { status });
async function auth(id, headers) {
  const m = String(headers.Authorization || '').match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  if (!/^[a-f0-9]{32}$/.test(id || '') || !m) throw err(401, '접근 권한이 없어요. 이어하기 링크를 확인해 주세요.');
  const rec = await getRec('cases', id);
  if (!rec) throw err(404, '진단 기록을 찾을 수 없어요. 삭제되었거나 이 브라우저에 없는 기록이에요.');
  if (rec.meta.tokenHash !== (await tokenHash(id, m[1]))) throw err(401, '접근 권한이 없어요. 링크가 바뀌었거나 잘못되었어요.');
  return { token: m[1], key: await caseKey(id, m[1]) };
}

async function create(data) {
  const id = hex(rand(16));
  const token = b64url(rand(32));
  const now = new Date().toISOString();
  const obj = { data, version: 1, createdAt: now, updatedAt: now, report: null, reportInputVersion: null, history: [] };
  await writeCase(id, await caseKey(id, token), obj, { id, tokenHash: await tokenHash(id, token), createdAt: now });
  return { id, token, data, version: 1 };
}

async function handle(path, opts) {
  const url = new URL(path, 'http://local');
  const parts = url.pathname.split('/').filter(Boolean);
  const m = opts.method || 'GET';
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body || '{}') : opts.body;
  if (parts[1] === 'status') return { mode: 'demo', standalone: true, ai: false, search: false, email: false, payment: false };
  if (parts[1] === 'sample-report') {
    const s = SAMPLES[url.searchParams.get('kind')];
    if (!s) throw err(404, '예시를 찾을 수 없어요.');
    const data = s.make();
    return { data, report: generateReport(data) };
  }
  if (parts[1] !== 'cases') throw err(404, '없는 주소예요.');
  if (parts.length === 2 && m === 'POST') {
    if (body.sample) { const s = SAMPLES[body.sample]; if (!s) throw err(400, '예시 종류가 올바르지 않아요.'); return [201, await create(s.make())]; }
    if (!body.profile || !body.profile.name) throw err(400, '가게 이름을 입력해 주세요.');
    return [201, await create(emptyData(body.profile))];
  }
  const id = parts[2];
  const { key } = await auth(id, opts.headers || {});
  const sub = parts[3];
  if (!sub && m === 'GET') {
    const obj = await readCase(id, key);
    return { data: obj.data, version: obj.version, report: obj.report, reportInputVersion: obj.reportInputVersion, changes: obj.lastChanges || [], updatedAt: obj.updatedAt };
  }
  if (!sub && m === 'PUT') {
    const obj = await readCase(id, key);
    if (body.baseVersion !== obj.version) return [409, { error: 'conflict', message: '다른 창에서 먼저 저장된 내용이 있어요. 최신 내용으로 다시 불러왔어요.', data: obj.data, version: obj.version }];
    obj.data = sanitizeData(body.data, obj.data);
    obj.version += 1;
    obj.updatedAt = new Date().toISOString();
    await writeCase(id, key, obj);
    return { version: obj.version, data: obj.data };
  }
  if (!sub && m === 'DELETE') {
    const obj = await readCase(id, key);
    for (const f of obj.data.attachments || []) await delRec('files', `${id}/${f.id}`);
    for (const k of (await keysOf('files')).filter((k) => String(k).startsWith(`${id}/`))) await delRec('files', k);
    await delRec('cases', id);
    const gone = !(await getRec('cases', id));
    return [gone ? 200 : 500, { deleted: gone, message: gone ? '이 브라우저에 저장된 답변·자료·보고서를 모두 삭제했어요.' : '삭제를 완료하지 못했어요.' }];
  }
  if (sub === 'analyze' && m === 'POST') {
    const obj = await readCase(id, key);
    const report = generateReport(obj.data, { inputVersion: obj.version });
    report.inputSig = inputSignature(obj.data);
    const sum = summarize(report, obj.version);
    const prev = obj.history?.length ? obj.history[obj.history.length - 1] : null;
    const changes = prev && prev.sig !== sum.sig ? diffSummary(prev, sum) : (obj.lastChanges || []);
    Object.assign(obj, { report, reportInputVersion: obj.version, lastChanges: changes });
    if (!prev || prev.sig !== sum.sig) obj.history = [...(obj.history || []), sum].slice(-10);
      else obj.history[obj.history.length - 1] = sum;
    await writeCase(id, key, obj);
    return { report, reportInputVersion: obj.version, changes };
  }
  if (sub === 'rotate' && m === 'POST') {
    const obj = await readCase(id, key);
    const newToken = b64url(rand(32));
    const newKey = await caseKey(id, newToken);
    for (const f of obj.data.attachments || []) {
      const plain = await open(key, await getRec('files', `${id}/${f.id}`));
      await putRec('files', `${id}/${f.id}`, await seal(newKey, plain));
    }
    const rec = await getRec('cases', id);
    await writeCase(id, newKey, obj, { ...rec.meta, tokenHash: await tokenHash(id, newToken), rotatedAt: new Date().toISOString() });
    return { token: newToken, message: '새 링크를 만들었어요. 예전 링크로는 더 이상 열 수 없어요.' };
  }
  if (sub === 'email-link') return [501, { error: 'email_not_connected', message: '이메일 발송 기능은 아직 연결되지 않았어요.' }];
  if (sub === 'files') {
    const fid = parts[4];
    if (!fid && m === 'POST') {
      const name = decodeURIComponent(String(opts.headers['X-File-Name'] || 'file')).slice(0, 120);
      const kind = String(opts.headers['X-File-Kind'] || 'other').slice(0, 20);
      const bytes = new Uint8Array(await body.arrayBuffer());
      if (!bytes.length) throw err(400, '빈 파일이에요.');
      if (bytes.length > 10 * 1024 * 1024) throw err(413, '파일이 너무 커요.');
      const t = sniffFile(bytes, name);
      if (!t) throw err(415, '사진(JPG·PNG·WEBP·HEIC), PDF, CSV 파일만 올릴 수 있어요.');
      const obj = await readCase(id, key);
      if ((obj.data.attachments || []).length >= 30) throw err(400, '파일은 최대 30개까지 올릴 수 있어요.');
      const newId = hex(rand(12));
      await putRec('files', `${id}/${newId}`, await seal(key, bytes));
      const att = { id: newId, kind, name, mime: t.mime, type: t.type, size: bytes.length, at: new Date().toISOString(), note: '', confirmed: false };
      if (t.type === 'csv') att.extract = analyzeSalesCSV(bytes);
      else att.extractNote = t.type === 'xlsx' ? EXTRACT_NOTE.xlsx : EXTRACT_NOTE.other;
      obj.data.attachments = [...(obj.data.attachments || []), att];
      obj.version += 1;
      await writeCase(id, key, obj);
      return [201, { attachment: att, data: obj.data, version: obj.version }];
    }
    if (fid) {
      const obj = await readCase(id, key);
      const f = (obj.data.attachments || []).find((x) => x.id === fid);
      if (!f) throw err(404, '파일을 찾을 수 없어요.');
      if (m === 'GET') return new Blob([await open(key, await getRec('files', `${id}/${fid}`))], { type: f.mime });
      if (m === 'POST' && parts[5] === 'extract') {
        if (f.type !== 'csv') throw err(400, 'CSV 파일만 다시 읽을 수 있어요.');
        const plain = await open(key, await getRec('files', `${id}/${fid}`));
        const pick = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
        f.extract = analyzeSalesCSV(plain, { dateCol: pick(body.dateCol), amountCol: pick(body.amountCol), statusCol: pick(body.statusCol) });
        f.confirmed = false;
        obj.version += 1;
        await writeCase(id, key, obj);
        return { attachment: f, data: obj.data, version: obj.version };
      }
      if (m === 'DELETE') {
        obj.data.attachments = obj.data.attachments.filter((x) => x.id !== fid);
        await delRec('files', `${id}/${fid}`);
        obj.version += 1;
        await writeCase(id, key, obj);
        return { data: obj.data, version: obj.version };
      }
    }
  }
  throw err(404, '없는 주소예요.');
}

export function installLocalBackend() {
  window.__STANDALONE__ = true;
  window.__LOCAL_BACKEND__ = async (path, opts) => {
    try {
      const r = await handle(path, opts);
      if (Array.isArray(r)) return { status: r[0], body: r[1] };
      return { status: 200, body: r };
    } catch (e) {
      return { status: e.status || 500, body: { error: 'request_error', message: e.status ? e.message : `처리 중 문제가 생겼어요: ${e.message}` } };
    }
  };
}

installLocalBackend();
