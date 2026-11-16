import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePageStart } from '../public/page-start.js';
import { syncTranslations, matchingTranslations, validTranslations, normalizeTranslationSource, translationSourceHash, translationFingerprint, validHighlightLines } from '../public/page-translations.js';
import { sourceHash as serverSourceHash, normalizeSourceData } from '../lib/store-translations.mjs';
import { webcrypto } from 'node:crypto';
// 새 계약: 한국어 초안 API(/api/page-draft) 한 번에 highlights가 함께 오고, 별도 번역 버튼·동의·검토·/api/store-translate 호출은 없다.
const source = () => ({ name: '테스트 가게', address: '서울 마포구 테스트로 12', headline: '차와 함께', intro: '따뜻한 차를 제공합니다.', sections: [{heading:'메뉴',body:'차 5,000원'}], faqs: [{question:'예약?',answer:'방문 전 문의'}] });
const lines = () => [
  { ko: '차와 함께', en: 'Together with tea', zh: '与茶同行', ja: 'お茶と一緒に' },
  { ko: '따뜻한 차를 제공합니다.', en: 'We serve warm tea.', zh: '我们提供热茶。', ja: '温かいお茶を提供します。' },
  { ko: '차 5,000원', en: 'Tea is 5,000 won', zh: '茶 5,000韩元', ja: 'お茶は5,000ウォン' },
];
const draftResponse = (rows = lines()) => { const s = source(); return { draft: { headline: { text: s.headline, evidence: ['offer'] }, intro: { text: s.intro, evidence: ['offer'] }, sections: s.sections.map(x => ({ ...x, evidence: ['offer'] })), faqs: s.faqs.map(x => ({ ...x, evidence: ['visit'] })), keywords: [] }, highlights: rows, createdAt: '2026-11-16T00:00:00Z', cached: false, mock: false }; };
const BAD_HASH = '0'.repeat(64);
function setup(post, mutate = () => {}, { withDraft = true } = {}) {
  const s = source();
  const pageDraft = { store: { name: s.name, address: s.address, verifiedFacts: [] }, answers: { offer: '차와 쿠키를 제공합니다' }, businessDetails: { phone: '', hours: '', menu: '' } };
  if (withDraft) pageDraft.draft = { headline: { text: s.headline }, intro: { text: s.intro }, sections: s.sections, faqs: s.faqs, keywords: [] };
  const initial = { status: 'confirmed', confirmedIndex: 0, result: { candidates: [s] }, pageDraft };
  mutate(initial);
  let stored = JSON.stringify(initial), rendered = [];
  globalThis.sessionStorage = { getItem: () => stored, setItem: (_, v) => { stored = v; } };
  globalThis.location = { hash: '#/page-preview' };
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null && x !== false), focus() {} });
  const args = { h, show: (...nodes) => { rendered = nodes; }, setNavbar: () => {}, btn: (label, onclick) => h('button', { onclick }, label), post, storeName: {} };
  let flow = makePageStart(args);
  const walk = (nodes, p) => { for (const n of nodes) { if (n && typeof n === 'object') { if (p(n)) return n; const found = walk(n.children || [], p); if (found) return found; } } };
  const find = p => walk(rendered, p);
  const node = id => { const n = find(n => n.attrs.id === id); assert.ok(n, id); return n; };
  const text = n => typeof n === 'object' ? (n.textContent ?? n.children.map(text).join(' ')) : String(n);
  return { get flow() { return flow; }, reload() { flow = makePageStart(args); }, node, find, text, all: () => rendered.map(text).join(' '), state: () => JSON.parse(stored),
    // 한국어 초안 생성: 질문 화면에서 초안 전송 동의 한 번 후 제출. 번역 전용 컨트롤은 없다.
    async generate({ consent = true } = {}) { globalThis.location.hash = '#/page-questions'; flow.renderQuestions(); if (consent) node('page-draft-consent').attrs.onchange({ target: { checked: true, removeAttribute() {} } }); return find(n => n.tag === 'form').attrs.onsubmit({ preventDefault() {} }); },
    input(id, value) { node(id).attrs.oninput({ target: { value } }); },
    publish() { return find(n => n.tag === 'form').attrs.onsubmit({ preventDefault() {} }); },
    credentials() { node('publish-password').value = 'password123'; node('publish-password-again').value = 'password123'; node('publish-consent').checked = true; } };
}
const TRANSLATION_UI_IDS = ['translation-generate', 'translation-consent', 'publish-translation-review'];
const noTranslationControls = c => { for (const id of TRANSLATION_UI_IDS) assert.equal(c.find(n => n.attrs.id === id), undefined, id); assert.equal(c.find(n => n.tag === 'button' && /번역/.test(c.text(n))), undefined); assert.equal(c.find(n => n.tag === 'input' && /번역/.test(String(n.attrs.id || ''))), undefined); };
const storeTranslateCalls = calls => calls.filter(x => x.url === '/api/store-translate');

test('one Korean draft request carries highlights: no separate translation request, consent or button; ordered previews', async () => {
  const calls = [];
  const c = setup(async (url, payload) => { calls.push({ url, payload: structuredClone(payload) }); return draftResponse(); }, undefined, { withDraft: false });
  await c.generate({ consent: false }); assert.equal(calls.length, 0, 'draft consent is still required');
  await c.generate();
  assert.deepEqual(calls.map(x => x.url), ['/api/page-draft'], 'exactly one request, no /api/store-translate');
  assert.equal(calls[0].payload.consent, true);
  assert.equal(c.state().pageDraft.autoHighlights.status, 'ready');
  assert.match(c.state().pageDraft.autoHighlights.highlights.sourceHash, /^[a-f0-9]{64}$/);
  c.flow.renderPreview(); noTranslationControls(c);
  const all = c.all();
  assert.ok(all.indexOf('Together with tea') > 0 && all.indexOf('Together with tea') < all.indexOf('与茶同行') && all.indexOf('与茶同行') < all.indexOf('お茶と一緒に'));
  assert.match(all, /한국어 원문이 우선/);
  assert.equal(c.state().pageDraft.translation, undefined);
});
test('missing, empty or invalid highlights keep the Korean draft, explain it, and never retry or call translation', async () => {
  for (const rows of [undefined, [], lines().slice(0, 2), [...lines().slice(0, 2), { ko: '없는 문장', en: 'No such line', zh: '没有', ja: 'ない' }], [...lines().slice(0, 2), { ...lines()[2], en: 'Tea is 6,000 won' }]]) {
    const calls = [];
    const c = setup(async (url, p) => { calls.push(url); const r = draftResponse(); if (rows === undefined) delete r.highlights; else r.highlights = rows; return r; }, undefined, { withDraft: false });
    await c.generate();
    assert.deepEqual(calls, ['/api/page-draft']);
    const st = c.state().pageDraft; assert.equal(st.status, 'ready'); assert.equal(st.draft.headline.text, source().headline);
    assert.equal(st.autoHighlights.status, 'error'); assert.equal(st.autoHighlights.highlights, undefined);
    c.flow.renderPreview(); noTranslationControls(c); assert.match(c.all(), /한국어/); assert.doesNotMatch(c.all(), /Together with tea/);
    c.reload(); c.flow.renderPreview(); c.flow.renderPublish(); assert.deepEqual(calls, ['/api/page-draft'], 'reload does not retry');
    assert.match(c.all(), /한국어로만 공개/); noTranslationControls(c);
  }
});
test('failed draft request preserves answers, never starts a translation request and does not auto-retry on reload', async () => {
  const calls = []; const c = setup(async url => { calls.push(url); throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); }, undefined, { withDraft: false });
  await c.generate(); assert.equal(c.state().pageDraft.status, 'error'); assert.equal(c.state().pageDraft.answers.offer, '차와 쿠키를 제공합니다'); assert.equal(c.state().pageDraft.draft, undefined);
  assert.match(c.all(), /자동으로 다시 보내지 않았어요/);
  c.reload(); c.flow.renderQuestions(); assert.deepEqual(calls, ['/api/page-draft']);
});
test('loaded pending highlight state does not auto-resend and keeps Korean publishable', () => {
  const calls = []; const c = setup((...a) => calls.push(a), s => { s.pageDraft.autoHighlights = { status: 'pending', fingerprint: translationFingerprint(source()) }; });
  c.flow.renderPreview(); assert.equal(calls.length, 0); assert.match(c.all(), /한국어만 보존했어요/); assert.doesNotMatch(c.all(), /Together with tea/); noTranslationControls(c);
  c.flow.renderPublish(); assert.equal(calls.length, 0);
});
test('every Korean field and business information invalidates generated highlights without re-requesting', async () => {
  for (const [id, value] of [['page-edit-store-name', '새 상호'], ['page-edit-store-address', '서울 다른 주소 12'], ['page-edit-headline', '새 제목'], ['page-edit-intro', '새 소개'], ['page-edit-section-0-body', '가격 6,000원'], ['page-edit-faq-0-answer', '예약 불가'], ['page-business-phone', '02-1234-5678'], ['page-business-hours', '매일 10시'], ['page-business-menu', '차 6,000원']]) {
    const calls = []; const c = setup(async url => { calls.push(url); return draftResponse(); }, undefined, { withDraft: false });
    await c.generate(); assert.equal(c.state().pageDraft.autoHighlights.status, 'ready', id);
    if (id.startsWith('page-business')) c.flow.renderQuestions(); else c.flow.renderEdit();
    c.input(id, value);
    c.flow.renderPreview(); c.flow.renderPublish();
    assert.equal(c.state().pageDraft.autoHighlights.status, 'stale', id);
    assert.doesNotMatch(c.all(), /Together with tea/, id); noTranslationControls(c); assert.deepEqual(calls, ['/api/page-draft'], id);
  }
});
test('edits during the highlight hash verification discard the old highlights, even after revert', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let finish, started; const began = new Promise(r => { started = r; });
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: (...a) => new Promise(resolve => { finish = () => resolve(webcrypto.subtle.digest(...a)); started(); }) } } });
    const c = setup(async () => draftResponse(), undefined, { withDraft: false }); const pending = c.generate(); await began;
    c.input('page-business-menu', '검증 도중 메뉴'); c.input('page-business-menu', ''); finish(); await pending;
    const st = c.state().pageDraft; assert.equal(st.status, 'ready'); assert.equal(st.autoHighlights.status, 'stale'); assert.equal(st.autoHighlights.highlights, undefined);
    assert.equal(st.draft.headline.text, source().headline);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto; }
});
test('publication needs no translation review, sends one create request with highlights, and uncertain retry preserves the exact snapshot', async () => {
  const calls = []; let attempts = 0;
  const c = setup(async (url, p) => { calls.push({ url, p: structuredClone(p) }); if (url === '/api/page-draft') return draftResponse(); attempts++; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); }, undefined, { withDraft: false });
  await c.generate(); c.flow.renderPublish(); noTranslationControls(c); c.credentials();
  await c.publish(); // no translation review checkbox required
  assert.deepEqual(calls.map(x => x.url), ['/api/page-draft', '/api/stores']); assert.equal(storeTranslateCalls(calls).length, 0);
  const first = calls[1].p; assert.equal(first.action, 'create'); assert.equal(first.consent, true);
  assert.equal(first.data.highlights.lines.length, 3); assert.equal(first.data.highlights.sourceHash, await translationSourceHash(first.data)); assert.equal(first.data.translations, undefined);
  assert.equal(c.state().pageDraft.publishAttempt.status, 'uncertain');
  c.flow.renderEdit(); c.input('page-edit-intro', 'Changed after uncertain publish'); c.flow.renderPublish(); c.credentials(); await c.publish();
  assert.equal(attempts, 2); assert.deepEqual(calls[2].p.data, first.data); assert.equal(calls[2].p.id, first.id);
  assert.equal(storeTranslateCalls(calls).length, 0);
});
test('publication payload omits highlights after any Korean edit and never contains translations', async () => {
  const calls = []; const c = setup(async (url, p) => { calls.push({ url, p: structuredClone(p) }); return url === '/api/page-draft' ? draftResponse() : { id: p.id }; }, undefined, { withDraft: false });
  await c.generate(); c.flow.renderEdit(); c.input('page-edit-headline', '새 제목'); c.flow.renderPublish(); c.credentials(); await c.publish();
  const create = calls.find(x => x.url === '/api/stores'); assert.ok(create); assert.equal(create.p.data.headline, '새 제목'); assert.equal(create.p.data.highlights, undefined); assert.equal(create.p.data.translations, undefined);
});
test('tampered persisted highlight hash fails safely at publication: Korean-only, no translation call', async () => {
  const calls = []; const c = setup(async (url, p) => { calls.push({ url, p: structuredClone(p) }); return { id: p.id }; }, s => {
    s.pageDraft.autoHighlights = { status: 'ready', fingerprint: translationFingerprint(source()), highlights: { sourceHash: BAD_HASH, lines: lines() } };
  });
  c.flow.renderPublish(); c.credentials(); await c.publish();
  assert.deepEqual(calls.map(x => x.url), ['/api/stores']); assert.equal(calls[0].p.data.highlights, undefined); assert.equal(calls[0].p.data.headline, source().headline);
  assert.equal(c.state().pageDraft.autoHighlights.status, 'error');
});
test('unavailable or rejected Web Crypto never marks highlights ready and keeps the Korean draft', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    for (const provider of [undefined, { subtle: {} }, { subtle: { digest: async () => { throw new Error('unsupported'); } } }]) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: provider });
      const calls = []; const c = setup(async url => { calls.push(url); return draftResponse(); }, undefined, { withDraft: false }); await c.generate();
      assert.deepEqual(calls, ['/api/page-draft']); const st = c.state().pageDraft;
      assert.equal(st.status, 'ready'); assert.equal(st.autoHighlights.status, 'error'); assert.equal(st.autoHighlights.highlights, undefined); assert.equal(st.draft.headline.text, source().headline);
      c.flow.renderPreview(); assert.doesNotMatch(c.all(), /Together with tea/);
    }
  } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto; }
});
test('8-section limit includes business section; oversized drafts are refused at publication with no request', async () => {
  const calls = []; const c = setup((...a) => calls.push(a), s => { s.pageDraft.draft.sections = Array.from({ length: 8 }, (_, i) => ({ heading: '항목' + i, body: '내용' })); s.pageDraft.businessDetails.phone = '02-1234-5678'; });
  c.flow.renderEdit(); assert.equal(c.find(n => n.tag === 'button' && c.text(n) === '소개 섹션 추가').attrs.disabled, true);
  c.flow.renderPublish(); c.credentials(); await c.publish(); assert.equal(calls.length, 0); assert.match(c.all(), /최대 8개/);
});
test('highlight validation: exactly 3-4 distinct body-only Korean excerpts with matching numbers, scripts and no links', () => {
  const s = source(), ok = lines();
  assert.equal(validHighlightLines(ok, s), true); assert.equal(validHighlightLines([...ok, { ko: '메뉴', en: 'Menu', zh: '菜单', ja: 'メニュー' }], s), true);
  assert.equal(validHighlightLines(ok.slice(0, 2), s), false, 'fewer than three');
  assert.equal(validHighlightLines([...ok, ...ok.slice(0, 2)], s), false, 'more than four');
  assert.equal(validHighlightLines([ok[0], ok[1], { ...ok[1] }], s), false, 'duplicate');
  assert.equal(validHighlightLines([ok[0], ok[1], { ko: '방문 전 문의', en: 'Ask before visiting', zh: '到访前请咨询', ja: '来店前にお問い合わせ' }], s), false, 'FAQ text is not a highlight source');
  assert.equal(validHighlightLines([ok[0], ok[1], { ...ok[2], en: 'Tea is 6,000 won' }], s), false, 'number mismatch');
  assert.equal(validHighlightLines([ok[0], ok[1], { ...ok[2], en: 'Tea is 5,000 won, see example.com' }], s), false, 'link');
  assert.equal(validHighlightLines([ok[0], ok[1], { ...ok[2], zh: 'English only' }], s), false, 'wrong script');
  assert.equal(validHighlightLines([ok[0], ok[1], { ...ok[2], extra: 'x' }], s), false, 'extra key');
  assert.equal(validHighlightLines('x', s), false);
});
test('legacy full-translation helpers still reject partial or mismatched data (stored pages keep working)', () => {
  const s = source(); const good = { sourceHash: serverSourceHash(s), ...Object.fromEntries(['en', 'ja', 'zh'].map(l => [l, { ...structuredClone(s), headline: l + ' headline' }])) };
  assert.equal(validTranslations(good, s), true); assert.equal(validTranslations({ ...good, ja: null }, s), false);
  const d = { translation: { status: 'ready', fingerprint: JSON.stringify(s), requestFingerprint: 'wrong', translations: good } }; assert.equal(matchingTranslations(d, s), null);
  syncTranslations(d, { ...s, intro: 'changed' }); assert.equal(d.translation.status, 'stale');
});
test('Web Crypto hash matches server NFC, trim, field ordering and empty pair normalization', async () => {
  const data = { faqs: [{ answer: '  ', question: '' }, { answer: '  문의  ', question: ' 예약? ' }], sections: [{body:'  ',heading:''}, {body:'  차 5,000원 ',heading:' 메뉴 '}], intro: ' 따뜻한 차를 제공합니다. ', headline: ' 차와 함께 ', address: ' 서울 마포구 테스트로 12 ', name: ' 카페 Cafe\u0301 ' };
  for (const input of [data, {...data,situations:[]}, {...data,situations:[{answer:' ',question:' '}]}, {...data,situations:[{answer:'둘이 방문',question:'둘이?'}]}, {...data,translations:{ignored:true}}, {...data,highlights:{ignored:true}}]) {
    assert.deepEqual(normalizeTranslationSource(input), normalizeSourceData(input));
    assert.equal(await translationSourceHash(input, webcrypto), serverSourceHash(input));
  }
  assert.notEqual(await translationSourceHash(data,webcrypto), await translationSourceHash({...data,situations:[]},webcrypto));
  await assert.rejects(translationSourceHash({...data,faqs:[{question:'질문',answer:''}]},webcrypto));
  await assert.rejects(translationSourceHash({...data,situations:[{question:'example.com',answer:'주소'}]},webcrypto));
});
