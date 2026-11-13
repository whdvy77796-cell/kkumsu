import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStoreTools, buildShareText, cleanStoreData, buildQrModules, drawQr, publicUrl, validStoreShape, REPORT_REASONS } from '../public/store-tools.js';

const ID = 'abcdefghijklmnopqrstuv';
const good = () => ({ name: '테스트', address: '서울', headline: '한 줄', intro: '소개', sections: [{ heading: 'a', body: 'b' }], faqs: [{ question: 'q', answer: 'a' }], situations: [{ question: '비 오는 날 갈 곳?', answer: '실내 좌석이 있어요' }] });
const legacy = () => { const g = good(); delete g.situations; return g; };
const KEYS = ['name', 'address', 'headline', 'intro', 'sections', 'faqs', 'situations'];

// 최소 가짜 DOM 요소
function makeEnv(post) {
  const st = { shown: [], nav: [] };
  const h = (tag, attrs, ...kids) => {
    const el = { tag, attrs: attrs || {}, children: kids.flat(Infinity).filter((x) => x != null && x !== false), value: attrs?.value ?? '', checked: false, handlers: {}, textContent: undefined };
    el.addEventListener = (n, f) => { el.handlers[n] = f; };
    return el;
  };
  const btn = (label, onclick) => h('button', { onclick }, label);
  const env = { h, btn, post, show: (...k) => { st.shown = k.flat(Infinity); }, setNavbar: (...k) => { st.nav = k.flat(Infinity); } };
  return { st, env };
}
const walk = (n, f) => { if (n && typeof n === 'object') { f(n); (n.children || []).forEach((c) => walk(c, f)); } };
const find = (st, p) => { let r = null; st.shown.forEach((n) => walk(n, (x) => { if (!r && p(x)) r = x; })); return r; };
const findAll = (st, p) => { const r = []; st.shown.forEach((n) => walk(n, (x) => { if (p(x)) r.push(x); })); return r; };
const labelOf = (b) => b.children.join('');
const click = (st, label) => find(st, (x) => x.tag === 'button' && labelOf(x) === label).attrs.onclick();
const tick = () => new Promise((r) => setTimeout(r, 0));

globalThis.location = { origin: 'https://example.test', hash: '' };

test('data cleaning enforces exact shape and bounds', () => {
  assert.equal(cleanStoreData(good()).error, null);
  assert.deepEqual(Object.keys(cleanStoreData({ ...good(), extra: 1 }).data), KEYS);
  assert.deepEqual(cleanStoreData(legacy()).data.situations, []);
  assert.ok(validStoreShape(legacy()) && validStoreShape(good()) && !validStoreShape({ ...good(), situations: [{ question: 1, answer: 'a' }] }) && !validStoreShape({ ...good(), situations: 'x' }));
  assert.match(cleanStoreData({ ...good(), situations: Array(9).fill({ question: 'q', answer: 'a' }) }).error, /8/);
  assert.match(cleanStoreData({ ...good(), situations: [{ question: 'q'.repeat(301), answer: 'a' }] }).error, /300/);
  assert.match(cleanStoreData({ ...good(), situations: [{ question: 'q', answer: 'a'.repeat(2001) }] }).error, /2000/);
  assert.ok(cleanStoreData({ ...good(), situations: [{ question: '', answer: 'a' }] }).error);
  assert.ok(cleanStoreData({ ...good(), situations: [{ question: 'q', answer: '  ' }] }).error);
  assert.match(cleanStoreData({ ...good(), name: 'x'.repeat(61) }).error, /60/);
  assert.match(cleanStoreData({ ...good(), intro: 'x'.repeat(2001) }).error, /2000/);
  assert.match(cleanStoreData({ ...good(), sections: Array(9).fill({ heading: 'a', body: 'b' }) }).error, /8/);
  assert.match(cleanStoreData({ ...good(), faqs: [{ question: 'q'.repeat(301), answer: 'a' }] }).error, /300/);
  assert.ok(cleanStoreData({ ...good(), sections: [{ heading: '', body: 'b' }] }).error);
  assert.match(cleanStoreData({ ...good(), situations: [{ question: '더 보려면?', answer: 'example.com' }] }).error, /웹 주소/);
  assert.ok(validStoreShape(good()) && !validStoreShape({ name: 1 }));
});

test('share text uses only provided fields and url', () => {
  const t = buildShareText(good(), publicUrl(ID));
  assert.ok(t.includes('테스트') && t.includes('한 줄') && t.includes(`https://example.test/stores/${ID}`));
  assert.ok(buildShareText({ ...good(), intro: '가'.repeat(500) }, 'u').length < 400);
});

test('QR modules have valid size and drawing adds 4-module quiet zone', () => {
  const m = buildQrModules(`https://example.test/stores/${ID}`);
  assert.ok(m.length >= 21 && m.every((r) => r.length === m.length));
  const calls = [];
  const canvas = { getContext: () => ({ fillRect: (...a) => calls.push(a), set fillStyle(v) {} }) };
  const size = drawQr(canvas, m, 10, 4);
  assert.equal(size, (m.length + 8) * 10);
  assert.ok(calls.slice(1).every(([x, y]) => x >= 40 && y >= 40 && x + 10 <= size - 40 && y + 10 <= size - 40));
});

test('manage: auth, update needs confirmation, password only in requests', async () => {
  const calls = [];
  const { st, env } = makeEnv(async (p, b) => { calls.push([p, b]); return b.action === 'auth' ? { data: good() } : { ok: true }; });
  makeStoreTools(env).renderManage(ID);
  const pw = find(st, (x) => x.tag === 'input' && x.attrs.type === 'password');
  assert.ok(pw);
  const legacyLink = find(st, x => x.tag === 'a' && x.attrs.href === 'https://www.kkumsu.com/#/my-stores');
  assert.ok(legacyLink && labelOf(legacyLink) === '기존 계정으로 관리하기 (기존 주소)');
  assert.match(text(st), /이전에 이 가게를 계정에 연결해 두셨다면/);
  pw.value = 'secret-pass';
  click(st, '관리 시작'); await tick(); await tick();
  assert.deepEqual(calls[0], ['/api/stores', { action: 'auth', id: ID, password: 'secret-pass' }]);
  assert.ok(!JSON.stringify(st.shown, (k, v) => (k === 'handlers' || k === 'onclick' ? undefined : v)).includes('secret-pass'));
  click(st, '저장하기'); await tick();
  assert.equal(calls.length, 1, 'no update without verification');
  find(st, (x) => x.attrs?.id === 'verified').checked = true;
  click(st, '저장하기'); await tick(); await tick();
  assert.equal(calls[1][1].action, 'update');
  assert.equal(calls[1][1].consent, true);
  assert.equal(calls[1][1].password, 'secret-pass');
  assert.deepEqual(Object.keys(calls[1][1].data), KEYS);
});

const SIT = '기존에 공개한 예상 질문';
async function openManage(data, post2) {
  const calls = [];
  const updated = [];
  const { st, env } = makeEnv(async (p, b) => { calls.push(b); return b.action === 'auth' ? { data } : (post2 ? post2(b) : { ok: true }); });
  makeStoreTools({ ...env, onUpdated: (...a) => updated.push(a) }).renderManage(ID);
  find(st, (x) => x.attrs.type === 'password').value = 'secret-pass';
  click(st, '관리 시작'); await tick(); await tick();
  return { st, calls, updated };
}
const setField = (st, id, v) => { const el = find(st, (x) => x.attrs?.id === id); el.value = v; el.handlers.input(); };
const save = async (st) => { find(st, (x) => x.attrs?.id === 'verified').checked = true; click(st, '저장하기'); await tick(); await tick(); };
const text = (st) => JSON.stringify(st.shown, (k, v) => (k === 'handlers' || k === 'onclick' ? undefined : v));

test('manage: regular pages use one customer question list and no separate scenario section', async () => {
  const { st, calls } = await openManage(legacy());
  assert.equal(find(st, (x) => x.tag === 'legend' && labelOf(x).startsWith(SIT)), null);
  assert.ok(find(st, (x) => x.tag === 'legend' && labelOf(x).includes('고객 질문과 답변 (1/12)')));
  assert.ok(!findAll(st, (x) => x.tag === 'button' && labelOf(x) === '이 예상 질문 삭제').length);
  await save(st);
  assert.deepEqual(calls[1].data.situations, []);
  assert.deepEqual(calls[1].data.faqs, legacy().faqs);
  assert.deepEqual(Object.keys(calls[1].data), KEYS);
});

test('manage: owner adds, changes, deletes situations; round trip; no secret leak', async () => {
  const { st, calls, updated } = await openManage(good());
  assert.equal(find(st, (x) => x.attrs?.id === 'f-question-t0').value, '비 오는 날 갈 곳?');
  click(st, '예상 질문 추가');
  setField(st, 'f-question-t1', '혼자 가도 되나요?');
  setField(st, 'f-answer-t1', '1인 좌석이 있어요');
  setField(st, 'f-answer-t0', '  실내 좌석과 우산꽂이가 있어요  ');
  await save(st);
  const sent = calls[1];
  assert.deepEqual(Object.keys(sent.data), KEYS);
  assert.deepEqual(sent.data.situations, [{ question: '비 오는 날 갈 곳?', answer: '실내 좌석과 우산꽂이가 있어요' }, { question: '혼자 가도 되나요?', answer: '1인 좌석이 있어요' }]);
  assert.deepEqual(sent.data.faqs, good().faqs);
  assert.deepEqual(sent.data.sections, good().sections);
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0], [ID, sent.data]);
  assert.ok(!JSON.stringify(updated).includes('secret-pass') && !text(st).includes('secret-pass'));
  // 삭제 후 왕복
  click(st, '이 예상 질문 삭제');
  assert.equal(findAll(st, (x) => x.tag === 'button' && labelOf(x) === '이 예상 질문 삭제').length, 1);
  await save(st);
  assert.deepEqual(calls[2].data.situations, [{ question: '혼자 가도 되나요?', answer: '1인 좌석이 있어요' }]);
  assert.equal(calls.filter((c) => c.action === 'update').length, 2);
  click(st, '이 예상 질문 삭제');
  await save(st);
  assert.deepEqual(calls[3].data.situations, []);
  assert.ok(calls.every((c) => c.action === 'auth' || c.action === 'update'));
});

test('manage: existing separate situation fields remain editable with an eight-item limit', async () => {
  const { st, calls } = await openManage(good());
  click(st, '예상 질문 추가');
  setField(st, 'f-question-t1', '질문만');
  await save(st);
  assert.equal(calls.length, 1, 'no update with empty answer');
  assert.ok(findAll(st, (x) => x.attrs?.role === 'status' && /예상 질문 2의 답변/.test(x.textContent || '')).length === 1);
  setField(st, 'f-answer-t1', '답');
  setField(st, 'f-question-t1', ' ');
  await save(st);
  assert.equal(calls.length, 1);
  for (let i = 0; i < 10; i++) { const b = find(st, (x) => x.tag === 'button' && labelOf(x) === '예상 질문 추가'); if (!b.disabled) click(st, '예상 질문 추가'); }
  assert.equal(findAll(st, (x) => x.tag === 'button' && labelOf(x) === '이 예상 질문 삭제').length, 8);
  assert.equal(find(st, (x) => x.tag === 'button' && labelOf(x) === '예상 질문 추가').disabled, true);
  assert.equal(find(st, (x) => x.tag === 'button' && labelOf(x) === '저장하기').disabled, undefined);
});

test('manage: unchecked verification blocks situation update', async () => {
  const { st, calls } = await openManage(good());
  click(st, '저장하기'); await tick();
  assert.equal(calls.length, 1);
});

test('manage: add section limit and delete requires confirmation', async () => {
  const calls = [];
  const { st, env } = makeEnv(async (p, b) => { calls.push(b); return { data: good() }; });
  makeStoreTools(env).renderManage(ID);
  find(st, (x) => x.attrs.type === 'password').value = 'pw';
  click(st, '관리 시작'); await tick(); await tick();
  for (let i = 0; i < 10; i++) if (findAll(st, (x) => x.tag === 'button' && labelOf(x) === '안내 항목 추가').length) click(st, '안내 항목 추가');
  assert.equal(findAll(st, (x) => x.tag === 'button' && labelOf(x) === '이 안내 항목 삭제').length, 8);
  click(st, '이 페이지 삭제…');
  click(st, '영구 삭제하기'); await tick();
  assert.ok(!calls.some((c) => c.action === 'delete'));
  find(st, (x) => x.attrs?.id === 'del-ok').checked = true;
  click(st, '영구 삭제하기'); await tick(); await tick();
  assert.deepEqual(calls.at(-1), { action: 'delete', id: ID, password: 'pw' });
});

test('manage: auth error is shown and invalid id rejected', async () => {
  const { st, env } = makeEnv(async () => { throw new Error('비밀번호가 달라요'); });
  makeStoreTools(env).renderManage(ID);
  find(st, (x) => x.attrs.type === 'password').value = 'x';
  click(st, '관리 시작'); await tick(); await tick();
  assert.ok(findAll(st, (x) => x.textContent === '비밀번호가 달라요').length === 1);
  makeStoreTools(env).renderManage('bad');
  assert.ok(find(st, (x) => x.attrs?.role === 'alert'));
});

test('report: fixed reasons, one post, no repeat', async () => {
  const calls = [];
  const { st, env } = makeEnv(async (p, b) => { calls.push(b); return { ok: true }; });
  makeStoreTools(env).renderReport(ID);
  assert.equal(findAll(st, (x) => x.attrs?.type === 'radio').length, REPORT_REASONS.length);
  click(st, '신고하기'); await tick();
  assert.equal(calls.length, 0);
  const radio = find(st, (x) => x.attrs?.id === 'r-inaccurate');
  radio.handlers.change();
  click(st, '신고하기'); await tick(); await tick();
  click(st, '신고하기'); await tick();
  assert.deepEqual(calls, [{ action: 'report', id: ID, reason: 'inaccurate' }]);
  assert.ok(!findAll(st, (x) => x.tag === 'input' && x.attrs.type === 'text').length);
});

test('published: renders link, share text, qr canvas without throwing', () => {
  const { st, env } = makeEnv(async () => ({}));
  globalThis.document = { createElement: () => ({ getContext: () => ({ fillRect() {} }) }) };
  makeStoreTools(env).renderPublished(ID, good());
  const a = find(st, (x) => x.tag === 'a' && x.attrs.href === `/stores/${ID}`);
  assert.ok(a);
  assert.ok(find(st, (x) => x.tag === 'a' && x.attrs.href === `/#/manage/${ID}`));
  assert.equal(find(st, (x) => x.tag === 'a' && x.attrs.href === '/#/my-stores'), null, 'new publication does not prompt account linking');
  const ta = find(st, (x) => x.tag === 'textarea');
  assert.ok(ta.value.includes(`https://example.test/stores/${ID}`));
  assert.ok(find(st, (x) => x.tag === 'canvas'));
});


test('manage: a dozen automatic customer questions are editable and save as FAQ', async () => {
  const data = { ...legacy(), faqs: Array.from({ length: 9 }, (_, i) => ({ question: `질문 ${i+1}`, answer: `답변 ${i+1}` })) };
  const { st, calls } = await openManage(data);
  assert.ok(find(st, (x) => x.tag === 'legend' && labelOf(x).includes('(9/12)')));
  setField(st, 'f-answer-q0', '수정된 답변');
  await save(st);
  assert.equal(calls[1].data.faqs.length, 9);
  assert.equal(calls[1].data.faqs[0].answer, '수정된 답변');
  for (let i = 0; i < 5; i++) { const b = find(st, x => x.tag === 'button' && labelOf(x) === '질문 추가'); if (!b.disabled) click(st, '질문 추가'); }
  assert.equal(findAll(st, x => x.tag === 'button' && labelOf(x) === '이 질문 삭제').length, 12);
  assert.equal(find(st, x => x.tag === 'button' && labelOf(x) === '질문 추가').disabled, true);
  assert.match(cleanStoreData({ ...data, faqs: Array(13).fill({ question:'q', answer:'a' }) }).error, /12/);
});
