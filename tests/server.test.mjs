// 서버: 접근 보호·암호화 저장·파일 업로드·보고서 갱신·링크 재발급·삭제
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSalesCSV } from '../server/csv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, `.tmp-data-${process.pid}`);
let server;
let base;

before(async () => {
  process.env.DATA_DIR = DATA;
  const { start } = await import('../server/server.js');
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server && server.close();
  await fs.rm(DATA, { recursive: true, force: true });
});

const call = async (p, { method = 'GET', token, body, raw, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
};

test('화면 파일과 보안 헤더, 폴더 밖 파일 차단', async () => {
  const home = await call('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(home.body.toString('utf8').includes('<script type="module" src="/app.js"></script>'));
  for (const p of ['/app.js', '/ui.js', '/report.js', '/screens.js', '/fields.js', '/styles.css', '/logo.png', '/icon.png', '/shared/engine.js', '/shared/diagnose.js']) {
    assert.equal((await call(p)).status, 200, p);
  }
  assert.notEqual((await call('/shared/..%2Fserver%2Fserver.js')).status, 200, '폴더 밖 파일은 열리지 않아야 함');
  assert.notEqual((await call('/..%2Fdata%2F.server-secret')).status, 200);
});

test('데모 상태를 숨기지 않는다', async () => {
  const r = await call('/api/status');
  assert.equal(r.body.mode, 'demo');
  assert.equal(r.body.ai, false);
  assert.equal(r.body.search, false);
});

test('가입 없이 시작하고, 링크(토큰) 없이는 열 수 없으며, 저장 파일은 암호화된다', async () => {
  const c = await call('/api/cases', { method: 'POST', body: { profile: { name: '비밀분식집', biz: 'restaurant', concerns: ['profit_unknown'] } } });
  assert.equal(c.status, 201);
  const { id, token } = c.body;
  assert.equal((await call(`/api/cases/${id}`)).status, 401);
  assert.equal((await call(`/api/cases/${id}`, { token: 'x'.repeat(43) })).status, 401);
  const ok = await call(`/api/cases/${id}`, { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.profile.name, '비밀분식집');
  const raw = await fs.readFile(path.join(DATA, 'cases', id, 'case.enc'));
  assert.ok(!raw.toString('utf8').includes('비밀분식집') && !raw.includes(Buffer.from('비밀분식집')), '가게 이름이 평문으로 저장되면 안 됨');
  const meta = JSON.parse(await fs.readFile(path.join(DATA, 'cases', id, 'meta.json'), 'utf8'));
  assert.ok(!JSON.stringify(meta).includes(token), '토큰 원문을 저장하지 않음');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
});

test('답변을 고치면 보고서와 변경 내역이 갱신되고, 링크 재발급·삭제가 동작한다', async () => {
  const c = await call('/api/cases', { method: 'POST', body: { sample: 'restaurant' } });
  let { id, token } = c.body;
  let version = c.body.version;
  const a1 = await call(`/api/cases/${id}/analyze`, { method: 'POST', token, body: {} });
  assert.equal(a1.status, 200);
  const p1 = a1.body.report.calc.profit.high;
  const data = (await call(`/api/cases/${id}`, { token })).body.data;
  data.answers.c_labor = { v: 4000000, s: 'exact' };
  const put = await call(`/api/cases/${id}`, { method: 'PUT', token, body: { data, baseVersion: version } });
  assert.equal(put.status, 200);
  version = put.body.version;
  const stale = await call(`/api/cases/${id}`, { method: 'PUT', token, body: { data, baseVersion: version - 1 } });
  assert.equal(stale.status, 409, '오래된 버전으로 덮어쓰지 않음');
  const a2 = await call(`/api/cases/${id}/analyze`, { method: 'POST', token, body: {} });
  assert.ok(Math.abs(a2.body.report.calc.profit.high - p1 - 1600000) < 1);
  assert.ok(a2.body.changes.some((x) => x.startsWith('남는 금액')), '이전 보고서와 달라진 점을 알려줌');
  // 파일 업로드 (CSV 추출은 확인 전 대기 상태)
  const csv = Buffer.from('\uFEFF거래일시,결제금액,상태\n2026-10-01 12:10,15000,승인\n2026-10-01 12:30,9000,취소\n2026-10-02 18:00,22000,승인\n2026-11-01 11:00,8000,승인\n');
  const up = await call(`/api/cases/${id}/files`, { method: 'POST', token, raw: true, body: csv, headers: { 'Content-Type': 'text/csv', 'X-File-Name': encodeURIComponent('매출.csv'), 'X-File-Kind': 'sales_file' } });
  assert.equal(up.status, 201);
  const ex = up.body.attachment.extract;
  assert.equal(ex.ok, true);
  assert.equal(ex.excludedRows, 1);
  assert.deepEqual(ex.months.map((m) => [m.month, m.total, m.count]), [['2026-10', 37000, 2], ['2026-11', 8000, 1]]);
  assert.equal(up.body.attachment.confirmed, false, '사장님 확인 전에는 반영하지 않음');
  const bad = await call(`/api/cases/${id}/files`, { method: 'POST', token, raw: true, body: Buffer.from('MZ\x90\x00binary'), headers: { 'X-File-Name': 'a.exe', 'X-File-Kind': 'other' } });
  assert.equal(bad.status, 415);
  const fid = up.body.attachment.id;
  const dl = await call(`/api/cases/${id}/files/${fid}`, { token });
  assert.ok(dl.body.equals(csv));
  // 링크 재발급
  const rot = await call(`/api/cases/${id}/rotate`, { method: 'POST', token, body: {} });
  assert.equal(rot.status, 200);
  assert.equal((await call(`/api/cases/${id}`, { token })).status, 401, '예전 링크는 더 이상 열 수 없음');
  token = rot.body.token;
  assert.equal((await call(`/api/cases/${id}`, { token })).status, 200);
  assert.ok((await call(`/api/cases/${id}/files/${fid}`, { token })).body.equals(csv), '재발급 후에도 파일을 새 열쇠로 읽을 수 있음');
  // 이메일은 미연결임을 숨기지 않음
  assert.equal((await call(`/api/cases/${id}/email-link`, { method: 'POST', token, body: {} })).status, 501);
  // 삭제
  const del = await call(`/api/cases/${id}`, { method: 'DELETE', token });
  assert.equal(del.body.deleted, true);
  assert.equal((await call(`/api/cases/${id}`, { token })).status, 404);
  await assert.rejects(fs.access(path.join(DATA, 'cases', id)));
});

test('CSV: EUC-KR 파일과 열 자동 찾기', () => {
  // "일자,금액" (EUC-KR) + 데이터
  const head = Buffer.from([0xc0, 0xcf, 0xc0, 0xda, 0x2c, 0xb1, 0xdd, 0xbe, 0xd7, 0x0d, 0x0a]);
  const body = Buffer.from('2026-09-01,"12,000"\r\n2026-09-02,8000\r\n20260903,5000\r\n');
  const r = analyzeSalesCSV(Buffer.concat([head, body]));
  assert.equal(r.ok, true);
  assert.equal(r.columns[0].name, '일자');
  assert.deepEqual(r.months.map((m) => [m.month, m.total, m.count]), [['2026-09', 25000, 3]]);
  assert.ok(r.months[0].partial, '기록 일수가 적은 달은 부분 기록으로 표시');
});
