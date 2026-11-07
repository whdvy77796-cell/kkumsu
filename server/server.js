// 매출올려드림 AI - 로컬 서버 (외부 패키지 없음)
// - 회원가입 없이 시작, 이어하기 링크(접근 토큰)로만 열람
// - 저장 데이터는 토큰에서 만든 키로 암호화 (토큰 없이 파일만으로는 읽을 수 없음)
// - AI·인터넷 검색·이메일은 연결되지 않은 데모 모드
import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateReport } from '../shared/diagnose.js';
import { inputSignature } from '../shared/engine.js';
import { SAMPLES } from '../shared/samples.js';
import { analyzeSalesCSV } from './csv.js';
import { emptyData, sanitizeData, summarize, diffSummary, sniffFile, EXTRACT_NOTE } from '../shared/casekit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = +(process.env.PORT || 5180);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 30;
const MAX_JSON = 2 * 1024 * 1024;
const VERSION = '0.1.0';

// ───────── 비밀값·키
let SECRET;
async function loadSecret() {
  if (process.env.MAECHUL_SECRET) { SECRET = Buffer.from(process.env.MAECHUL_SECRET, 'base64'); return; }
  await fs.mkdir(DATA, { recursive: true });
  const p = path.join(DATA, '.server-secret');
  try { SECRET = Buffer.from(await fs.readFile(p, 'utf8'), 'base64'); }
  catch { SECRET = crypto.randomBytes(32); await fs.writeFile(p, SECRET.toString('base64'), { mode: 0o600 }); }
}
const caseKey = (id, token) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token), SECRET, `case:${id}`, 32));
const tokenHash = (id, token) => crypto.createHmac('sha256', SECRET).update(`auth:${id}:${token}`).digest('hex');
function encrypt(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function decrypt(key, buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

// ───────── 저장소
const caseDir = (id) => path.join(DATA, 'cases', id);
const validId = (id) => /^[a-f0-9]{32}$/.test(id);
const validFid = (id) => /^[a-f0-9]{24}$/.test(id);
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}
async function readMeta(id) {
  try { return JSON.parse(await fs.readFile(path.join(caseDir(id), 'meta.json'), 'utf8')); } catch { return null; }
}
async function readCase(id, key) {
  const buf = await fs.readFile(path.join(caseDir(id), 'case.enc'));
  return JSON.parse(decrypt(key, buf).toString('utf8'));
}
async function writeCase(id, key, obj) {
  const p = path.join(caseDir(id), 'case.enc');
  await fs.writeFile(p + '.tmp', encrypt(key, Buffer.from(JSON.stringify(obj))));
  await fs.rename(p + '.tmp', p);
}
async function createCase(data) {
  const id = crypto.randomBytes(16).toString('hex');
  const token = crypto.randomBytes(32).toString('base64url');
  await fs.mkdir(path.join(caseDir(id), 'files'), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(caseDir(id), 'meta.json'), JSON.stringify({ id, tokenHash: tokenHash(id, token), createdAt: now }));
  const obj = { data, version: 1, createdAt: now, updatedAt: now, report: null, reportInputVersion: null, history: [] };
  await writeCase(id, caseKey(id, token), obj);
  return { id, token, obj };
}

// ───────── 인증·요청 제한
const fails = new Map();
function limited(ip) {
  const f = fails.get(ip);
  return f && f.count >= 30 && Date.now() - f.since < 10 * 60 * 1000;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.since > 10 * 60 * 1000) fails.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}
async function auth(req, id) {
  const ip = req.socket.remoteAddress || '';
  if (limited(ip)) throw httpErr(429, '잠시 후 다시 시도해 주세요.');
  const m = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  if (!validId(id) || !m) { noteFail(ip); throw httpErr(401, '접근 권한이 없어요. 이어하기 링크를 확인해 주세요.'); }
  const meta = await readMeta(id);
  const token = m[1];
  if (!meta) { noteFail(ip); throw httpErr(404, '진단 기록을 찾을 수 없어요. 삭제되었거나 링크가 잘못되었어요.'); }
  const a = Buffer.from(meta.tokenHash, 'hex');
  const b = Buffer.from(tokenHash(id, token), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { noteFail(ip); throw httpErr(401, '접근 권한이 없어요. 링크가 바뀌었거나 잘못되었어요.'); }
  return { meta, token, key: caseKey(id, token) };
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

// ───────── 응답 도우미
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpErr(413, '파일이나 내용이 너무 커요.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const b = await readBody(req, MAX_JSON);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw httpErr(400, '요청 형식이 올바르지 않아요.'); }
}

// ───────── 라우팅
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, ...
  const m = req.method;
  if (parts[1] === 'status' && m === 'GET') {
    return json(res, 200, { version: VERSION, mode: 'demo', ai: false, search: false, email: false, payment: false, message: 'AI·인터넷 검색·이메일·결제가 연결되지 않은 데모 모드' });
  }
  if (parts[1] === 'sample-report' && m === 'GET') {
    const kind = url.searchParams.get('kind');
    const s = SAMPLES[kind];
    if (!s) throw httpErr(404, '예시를 찾을 수 없어요.');
    const data = s.make();
    return json(res, 200, { data, report: generateReport(data) });
  }
  if (parts[1] !== 'cases') throw httpErr(404, '없는 주소예요.');
  if (parts.length === 2 && m === 'POST') {
    const body = await readJSON(req);
    let data;
    if (body.sample) {
      const s = SAMPLES[body.sample];
      if (!s) throw httpErr(400, '예시 종류가 올바르지 않아요.');
      data = s.make();
    } else {
      if (!body.profile || !body.profile.name) throw httpErr(400, '가게 이름을 입력해 주세요.');
      data = emptyData(body.profile);
    }
    const { id, token, obj } = await createCase(data);
    return json(res, 201, { id, token, data: obj.data, version: obj.version });
  }
  const id = parts[2];
  const { key, token } = await auth(req, id);
  const sub = parts[3];
  if (!sub) {
    if (m === 'GET') {
      const obj = await readCase(id, key);
      return json(res, 200, { data: obj.data, version: obj.version, report: obj.report, reportInputVersion: obj.reportInputVersion, changes: obj.lastChanges || [], updatedAt: obj.updatedAt });
    }
    if (m === 'PUT') {
      const body = await readJSON(req);
      return withLock(id, async () => {
        const obj = await readCase(id, key);
        if (body.baseVersion !== obj.version) return json(res, 409, { error: 'conflict', message: '다른 창에서 먼저 저장된 내용이 있어요. 최신 내용으로 다시 불러왔어요.', data: obj.data, version: obj.version });
        obj.data = sanitizeData(body.data, obj.data);
        obj.version += 1;
        obj.updatedAt = new Date().toISOString();
        await writeCase(id, key, obj);
        json(res, 200, { version: obj.version, data: obj.data });
      });
    }
    if (m === 'DELETE') {
      return withLock(id, async () => {
        await fs.rm(caseDir(id), { recursive: true, force: true });
        const gone = !fss.existsSync(caseDir(id));
        json(res, gone ? 200 : 500, { deleted: gone, message: gone ? '이 서버에 저장된 답변·자료·보고서를 모두 삭제했어요.' : '삭제를 완료하지 못했어요. 다시 시도해 주세요.' });
      });
    }
  }
  if (sub === 'analyze' && m === 'POST') {
    return withLock(id, async () => {
      const obj = await readCase(id, key);
      const report = generateReport(obj.data, { inputVersion: obj.version });
      report.inputSig = inputSignature(obj.data);
      const sum = summarize(report, obj.version);
      const prev = obj.history?.length ? obj.history[obj.history.length - 1] : null;
      const changes = prev && prev.sig !== sum.sig ? diffSummary(prev, sum) : (obj.lastChanges || []);
      obj.report = report;
      obj.reportInputVersion = obj.version;
      obj.lastChanges = changes;
      if (!prev || prev.sig !== sum.sig) obj.history = [...(obj.history || []), sum].slice(-10);
      else obj.history[obj.history.length - 1] = sum;
      await writeCase(id, key, obj);
      json(res, 200, { report, reportInputVersion: obj.version, changes });
    });
  }
  if (sub === 'rotate' && m === 'POST') {
    return withLock(id, async () => {
      const obj = await readCase(id, key);
      const newToken = crypto.randomBytes(32).toString('base64url');
      const newKey = caseKey(id, newToken);
      const dir = path.join(caseDir(id), 'files');
      for (const f of obj.data.attachments || []) {
        const p = path.join(dir, `${f.id}.enc`);
        const plain = decrypt(key, await fs.readFile(p));
        await fs.writeFile(p, encrypt(newKey, plain));
      }
      await writeCase(id, newKey, obj);
      const meta = await readMeta(id);
      meta.tokenHash = tokenHash(id, newToken);
      meta.rotatedAt = new Date().toISOString();
      await fs.writeFile(path.join(caseDir(id), 'meta.json'), JSON.stringify(meta));
      json(res, 200, { token: newToken, message: '새 링크를 만들었어요. 예전 링크로는 더 이상 열 수 없어요.' });
    });
  }
  if (sub === 'email-link' && m === 'POST') {
    return json(res, 501, { error: 'email_not_connected', message: '이메일 발송 기능은 아직 연결되지 않았어요. 이어하기 링크를 복사해 직접 보관해 주세요.' });
  }
  if (sub === 'files') {
    const fid = parts[4];
    if (!fid && m === 'POST') {
      const name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).slice(0, 120);
      const kind = String(req.headers['x-file-kind'] || 'other').slice(0, 20);
      const buf = await readBody(req, MAX_FILE);
      if (!buf.length) throw httpErr(400, '빈 파일이에요.');
      const t = sniffFile(buf, name);
      if (!t) throw httpErr(415, '사진(JPG·PNG·WEBP·HEIC), PDF, CSV 파일만 올릴 수 있어요.');
      return withLock(id, async () => {
        const obj = await readCase(id, key);
        if ((obj.data.attachments || []).length >= MAX_FILES) throw httpErr(400, `파일은 최대 ${MAX_FILES}개까지 올릴 수 있어요.`);
        const newId = crypto.randomBytes(12).toString('hex');
        await fs.mkdir(path.join(caseDir(id), 'files'), { recursive: true });
        await fs.writeFile(path.join(caseDir(id), 'files', `${newId}.enc`), encrypt(key, buf));
        const att = { id: newId, kind, name, mime: t.mime, type: t.type, size: buf.length, at: new Date().toISOString(), note: '', confirmed: false };
        if (t.type === 'csv') att.extract = analyzeSalesCSV(buf);
        else if (t.type === 'xlsx') att.extractNote = EXTRACT_NOTE.xlsx;
        else att.extractNote = EXTRACT_NOTE.other;
        obj.data.attachments = [...(obj.data.attachments || []), att];
        obj.version += 1;
        obj.updatedAt = att.at;
        await writeCase(id, key, obj);
        json(res, 201, { attachment: att, data: obj.data, version: obj.version });
      });
    }
    if (fid && validFid(fid)) {
      if (m === 'GET' && !parts[5]) {
        const obj = await readCase(id, key);
        const f = (obj.data.attachments || []).find((x) => x.id === fid);
        if (!f) throw httpErr(404, '파일을 찾을 수 없어요.');
        const plain = decrypt(key, await fs.readFile(path.join(caseDir(id), 'files', `${fid}.enc`)));
        return send(res, 200, plain, { 'Content-Type': f.mime, 'Cache-Control': 'no-store', 'Content-Disposition': `${f.type === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}` });
      }
      if (m === 'POST' && parts[5] === 'extract') {
        const body = await readJSON(req);
        return withLock(id, async () => {
          const obj = await readCase(id, key);
          const f = (obj.data.attachments || []).find((x) => x.id === fid);
          if (!f || f.type !== 'csv') throw httpErr(400, 'CSV 파일만 다시 읽을 수 있어요.');
          const plain = decrypt(key, await fs.readFile(path.join(caseDir(id), 'files', `${fid}.enc`)));
          const pick = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
          f.extract = analyzeSalesCSV(plain, { dateCol: pick(body.dateCol), amountCol: pick(body.amountCol), statusCol: pick(body.statusCol) });
          f.confirmed = false;
          obj.version += 1;
          await writeCase(id, key, obj);
          json(res, 200, { attachment: f, data: obj.data, version: obj.version });
        });
      }
      if (m === 'DELETE') {
        return withLock(id, async () => {
          const obj = await readCase(id, key);
          obj.data.attachments = (obj.data.attachments || []).filter((x) => x.id !== fid);
          await fs.rm(path.join(caseDir(id), 'files', `${fid}.enc`), { force: true });
          obj.version += 1;
          await writeCase(id, key, obj);
          json(res, 200, { data: obj.data, version: obj.version });
        });
      }
    }
  }
  throw httpErr(404, '없는 주소예요.');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  let base = PUBLIC;
  if (rel.startsWith('/shared/')) { base = SHARED; rel = rel.slice('/shared'.length); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const buf = await fs.readFile(p);
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

export async function start(port = PORT) {
  await loadSecret();
  await fs.mkdir(path.join(DATA, 'cases'), { recursive: true });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET') await serveStatic(req, res, url);
      else send(res, 405, 'Method not allowed');
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('[error]', e.message);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'server_error' : 'request_error', message: status === 500 ? '처리 중 문제가 생겼어요. 다시 시도해 주세요.' : e.message });
    }
  });
  await new Promise((r) => server.listen(port, HOST, r));
  console.log(`매출올려드림 AI (데모) 실행 중: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${server.address().port}`);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
