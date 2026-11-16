// 번역·요약이 저장된 가게의 두 관리 화면(비밀번호/계정)이 "한국어를 바꾸면 기존 번역/요약이 공개 화면에서 자동으로 숨겨진다"를 알리는지 검사한다.
// 관리 화면에는 번역 생성·동의·검토 UI가 없고, 번역 API(/api/store-translate)를 호출하지 않는다. 합성 데이터만 쓰고 외부 호출은 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStoreTools } from '../public/store-tools.js';
import { makeAccountUI } from '../public/account-ui.js';

const ID = 'abcdefghijklmnopqrstuv';
const R1 = 'a'.repeat(32), R2 = 'b'.repeat(32);
const warn = (what) => `한국어 정보를 바꾸면 기존 ${what}은 공개 화면에서 자동으로 숨겨집니다.`;
const WARN = warn('번역');
const STALE_TEXT = /기존 번역은 공개 화면에서 자동으로 숨겨집니다|기존 요약은 공개 화면에서 자동으로 숨겨집니다|기존 번역과 요약은 공개 화면에서 자동으로 숨겨집니다/;
globalThis.location = { origin: 'https://example.test', hash: '' };
globalThis.window = { open() {} };

const base = () => ({ name: '테스트', address: '서울', headline: '한 줄', intro: '소개', sections: [{ heading: '메뉴', body: '커피' }], faqs: [{ question: 'q', answer: 'a' }] });
const withTr = () => ({ ...base(), translations: { sourceHash: 'x'.repeat(8), en: { ...base(), headline: 'one line' } } });
const withHl = () => ({ ...base(), highlights: { sourceHash: 'y'.repeat(8), lines: [{ ko: '한 줄', en: 'one line', zh: '一行', ja: '一行目' }] } });
const withBoth = () => ({ ...withTr(), ...withHl() });
// 새 계약: 관리 화면에 번역 생성 버튼/동의/검토 체크박스가 없어야 한다.
const noTranslateUi = (st) => {
  assert.equal(find(st, (x) => x.tag === 'button' && /번역/.test(x.children.join(''))), null);
  assert.equal(find(st, (x) => x.attrs?.['data-translation-consent'] || x.attrs?.['data-translation-reviewed'] || x.attrs?.['data-manage-translations']), null);
  assert.ok(!/번역에 동의|번역까지 검토|AI에 전송해 영어/.test(text(st)));
};

function makeEnv(extra) {
  const st = { shown: [] };
  const h = (tag, attrs, ...kids) => {
    const el = { tag, attrs: attrs || {}, children: kids.flat(Infinity).filter((x) => x != null && x !== false), value: attrs?.value ?? '', checked: false, handlers: {}, textContent: undefined };
    el.addEventListener = (n, f) => { el.handlers[n] = f; };
    el.append = (...n) => { el.children.push(...n); };
    el.replaceChildren = (...n) => { el.children = [...n]; };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    return el;
  };
  const btn = (label, onclick) => h('button', { onclick }, label);
  return { st, env: { h, btn, show: (...k) => { st.shown = k.flat(Infinity); }, setNavbar() {}, storeName: {}, ...extra } };
}
const walk = (n, f) => { if (n && typeof n === 'object') { f(n); (n.children || []).forEach((c) => walk(c, f)); } };
const find = (st, p) => { let r = null; st.shown.forEach((n) => walk(n, (x) => { if (!r && p(x)) r = x; })); return r; };
const text = (st) => { const t = []; st.shown.forEach((n) => walk(n, (x) => { x.children.forEach((c) => { if (typeof c === 'string') t.push(c); }); if (typeof x.textContent === 'string') t.push(x.textContent); })); return t.join('\n'); };
const click = (st, label) => find(st, (x) => x.tag === 'button' && x.children.join('') === label).attrs.onclick();
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

async function openManage(data) {
  const calls = [];
  const { st, env } = makeEnv({ post: async (p, b) => { calls.push(b); return b.action === 'auth' ? { data } : { ok: true }; } });
  makeStoreTools(env).renderManage(ID);
  find(st, (x) => x.attrs.type === 'password').value = 'secret-pass';
  click(st, '관리 시작'); await tick();
  return { st, calls };
}
async function openAccount(data) {
  const posts = [];
  const { st, env } = makeEnv({
    post: async (p, b) => { posts.push(b); return { ok: true, revision: R2 }; },
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ id: ID, data, revision: R1, hidden: false, updatedAt: '2026-11-08T03:04:05Z' }) }),
  });
  await makeAccountUI(env).renderAccountEdit(ID);
  return { st, posts };
}

test('password manage: translated page shows warning up front and again after a successful save', async () => {
  const { st, calls } = await openManage(withTr());
  assert.ok(find(st, (x) => x.attrs?.['data-translation-warning']));
  assert.ok(text(st).includes(WARN));
  find(st, (x) => x.attrs?.id === 'verified').checked = true;
  click(st, '저장하기'); await tick(); await tick();
  assert.equal(calls[1].action, 'update');
    const t = text(st);
  assert.match(t, /저장했어요/);
  assert.equal(t.split(WARN).length - 1, 2, 'warning stays and success notice repeats it');
  noTranslateUi(st);
  assert.ok(!calls.some((c) => c.action === 'translate'), 'no translation request');
});

test('password manage: highlights-only and translations+highlights pages warn with the matching noun and have no translate UI', async () => {
  for (const [data, what] of [[withHl(), '요약'], [withBoth(), '번역과 요약']]) {
    const { st, calls } = await openManage(data);
    assert.ok(find(st, (x) => x.attrs?.['data-translation-warning']));
    assert.ok(text(st).includes(warn(what)), what);
    noTranslateUi(st);
    find(st, (x) => x.attrs?.id === 'verified').checked = true;
    click(st, '저장하기'); await tick(); await tick();
    assert.equal(calls[1].action, 'update');
    assert.equal(text(st).split(warn(what)).length - 1, 2, what);
    assert.equal(calls.length, 2, 'only auth and update');
  }
});

test('password manage: legacy page without translations shows no warning', async () => {
  for (const data of [base(), { ...base(), translations: {} }, { ...base(), translations: null }]) {
    const { st } = await openManage(data);
    assert.equal(find(st, (x) => x.attrs?.['data-translation-warning']), null);
    assert.ok(!STALE_TEXT.test(text(st)));
    noTranslateUi(st);
    find(st, (x) => x.attrs?.id === 'verified').checked = true;
    click(st, '저장하기'); await tick(); await tick();
    assert.ok(!STALE_TEXT.test(text(st)));
  }
});

test('account edit: translated page shows warning up front and after a successful save', async () => {
  const { st, posts } = await openAccount(withTr());
  assert.ok(find(st, (x) => x.attrs?.['data-translation-warning']));
  assert.ok(text(st).includes(WARN));
  const name = find(st, (x) => x.attrs?.id === 'acc-name'); name.value = '새 이름'; name.handlers.input();
  find(st, (x) => x.attrs?.id === 'acc-confirm').checked = true;
  click(st, '변경사항 반영하기'); await tick();
  assert.equal(posts.length, 1);
    const t = text(st);
  assert.match(t, /반영했어요/);
  assert.equal(t.split(WARN).length - 1, 2);
  noTranslateUi(st);
  assert.equal(posts[0].expectedRevision, R1, 'CAS revision still sent');
  assert.equal(posts[0].data.translations, undefined, 'edit never uploads generated translations');
});

test('account edit: highlights-only and translations+highlights pages warn with the matching noun and have no translate UI', async () => {
  for (const [data, what] of [[withHl(), '요약'], [withBoth(), '번역과 요약']]) {
    const { st, posts } = await openAccount(data);
    assert.ok(find(st, (x) => x.attrs?.['data-translation-warning']));
    assert.ok(text(st).includes(warn(what)), what);
    noTranslateUi(st);
    const name = find(st, (x) => x.attrs?.id === 'acc-name'); name.value = '새 이름'; name.handlers.input();
    find(st, (x) => x.attrs?.id === 'acc-confirm').checked = true;
    click(st, '변경사항 반영하기'); await tick();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].expectedRevision, R1);
    assert.equal(text(st).split(warn(what)).length - 1, 2, what);
  }
});

test('account edit: legacy page without translations shows no warning', async () => {
  const { st } = await openAccount(base());
  assert.equal(find(st, (x) => x.attrs?.['data-translation-warning']), null);
  find(st, (x) => x.attrs?.id === 'acc-confirm').checked = true;
  click(st, '변경사항 반영하기'); await tick();
  assert.ok(!STALE_TEXT.test(text(st)));
  noTranslateUi(st);
});

