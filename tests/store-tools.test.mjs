import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStoreTools, buildShareText, cleanStoreData, buildQrModules, drawQr, publicUrl, validStoreShape, REPORT_REASONS } from '../public/store-tools.js';

const ID = 'abcdefghijklmnopqrstuv';
const good = () => ({ name: '테스트', address: '서울', headline: '한 줄', intro: '소개', sections: [{ heading: 'a', body: 'b' }], faqs: [{ question: 'q', answer: 'a' }] });

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
  assert.deepEqual(Object.keys(cleanStoreData({ ...good(), extra: 1 }).data), ['name', 'address', 'headline', 'intro', 'sections', 'faqs']);
  assert.match(cleanStoreData({ ...good(), name: 'x'.repeat(61) }).error, /60/);
  assert.match(cleanStoreData({ ...good(), intro: 'x'.repeat(2001) }).error, /2000/);
  assert.match(cleanStoreData({ ...good(), sections: Array(9).fill({ heading: 'a', body: 'b' }) }).error, /8/);
  assert.match(cleanStoreData({ ...good(), faqs: [{ question: 'q'.repeat(301), answer: 'a' }] }).error, /300/);
  assert.ok(cleanStoreData({ ...good(), sections: [{ heading: '', body: 'b' }] }).error);
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
  assert.deepEqual(Object.keys(calls[1][1].data), ['name', 'address', 'headline', 'intro', 'sections', 'faqs']);
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
  const ta = find(st, (x) => x.tag === 'textarea');
  assert.ok(ta.value.includes(`https://example.test/stores/${ID}`));
  assert.ok(find(st, (x) => x.tag === 'canvas'));
});
