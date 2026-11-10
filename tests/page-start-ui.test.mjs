import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePageStart } from '../public/page-start.js';

function createStorage() {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), clear: () => values.clear() };
}
function createContext(post) {
  globalThis.sessionStorage = createStorage();
  globalThis.location = { hash: '#/' };
  sessionStorage.setItem('maechul.v3', '{"answers":{"old":"keep"}}');
  const state = { rendered: [], nav: [], storeName: { textContent: '' } };
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) });
  const show = (...children) => { state.rendered = children.flat(Infinity).filter(Boolean); };
  const setNavbar = (...children) => { state.nav = children.flat(Infinity).filter(Boolean); };
  const btn = (label, onclick) => h('button', { onclick }, label);
  const flow = makePageStart({ h, show, setNavbar, btn, post, storeName: state.storeName });
  return { flow, state, h, show, setNavbar, btn, post };
}
function text(node) {
  if (node == null || node === false) return '';
  if (typeof node !== 'object') return String(node);
  return node.textContent ?? (node.children || []).map(text).join(' ');
}
function allText(state) { return state.rendered.map(text).join(' '); }
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) { const found = find(child, predicate); if (found) return found; }
  return null;
}
function findRendered(state, predicate) { for (const n of state.rendered) { const found = find(n, predicate); if (found) return found; } return null; }
const candidate = { name: '테스트가게', address: '서울 마포구 망원로 12', category: '카페', features: ['창가 좌석'], strengths: [], menu: [] };
const response = (status = 'confirmed') => ({ candidates: [candidate], sources: [{ title: '예시 출처', url: 'https://example.com/place', origin: 'provider_annotation' }], webEvidence: { status }, searchedAt: '2026-11-10T10:00:00Z', cached: false });

test('one consented request, duplicate blocked, candidate confirmation preserves old work', async () => {
  let complete;
  const calls = [];
  const ctx = createContext((...args) => { calls.push(args); return new Promise((resolve) => { complete = resolve; }); });
  const pending = ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  await ctx.flow.begin('중복', '서울 마포구 다른로 12');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['/api/page-search', { name: '테스트가게', address: '서울 마포구 망원로 12', consent: true }]);
  assert.equal(location.hash, '#/page-search');
  assert.match(allText(ctx.state), /가게 정보를 찾고 있어요/);
  complete(response());
  await pending;
  assert.match(allText(ctx.state), /테스트가게/);
  assert.match(allText(ctx.state), /창가 좌석/);
  assert.match(allText(ctx.state), /제공자 인용/);
  const select = findRendered(ctx.state, (n) => n.tag === 'button' && text(n).includes('이 가게가 맞아요'));
  assert.ok(select);
  select.attrs.onclick();
  assert.equal(location.hash, '#/page-confirmed');
  ctx.flow.renderConfirmed();
  assert.match(allText(ctx.state), /질문 5개로 소개 초안/);
  assert.match(text(ctx.state.rendered[0]), /가게를 확인했어요/);
  assert.match(text(ctx.state.rendered[1]), /질문 5개로 소개 초안을 만들어요/);
  assert.match(text(ctx.state.rendered[2]), /테스트가게/);
  const answerQuestions = findRendered(ctx.state, n => n.tag === 'button' && text(n) === '질문 답하기');
  assert.ok(answerQuestions);
  answerQuestions.attrs.onclick();
  assert.equal(location.hash, '#/page-questions');
  assert.match(allText(ctx.state), /정확성은 아직 별도로 확인/);
  assert.equal(sessionStorage.getItem('maechul.v3'), '{"answers":{"old":"keep"}}');
});

test('unverified web search does not expose AI output as confirmed store info', async () => {
  const ctx = createContext(async () => response('unverified'));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  assert.match(allText(ctx.state), /검색 실행 여부를 확인하지 못해/);
  assert.doesNotMatch(allText(ctx.state), /창가 좌석/);
  assert.equal(findRendered(ctx.state, (n) => n.tag === 'button' && text(n).includes('이 가게가 맞아요')), null);
});

test('provider citation without execution count is labeled uncertain', async () => {
  const ctx = createContext(async () => response('citation_only'));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  assert.match(allText(ctx.state), /웹 검색 실행 횟수는 확인되지 않았어요/);
  assert.match(allText(ctx.state), /테스트가게/);
});

test('no candidates is not asserted to mean absence', async () => {
  const ctx = createContext(async () => ({ ...response(), candidates: [] }));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  assert.match(allText(ctx.state), /실제로 정보가 없다는 뜻은 아니에요/);
});

test('timeout does not retry and leaves status clear', async () => {
  let calls = 0;
  const ctx = createContext(async () => { calls++; const e = new Error('timeout'); e.code = 'TIMEOUT'; throw e; });
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  assert.equal(calls, 1);
  assert.match(allText(ctx.state), /이미 처리됐을 수 있으며 자동으로 다시 보내지 않았어요/);
});

test('reloading during a pending request never retries automatically', () => {
  const storage = createStorage();
  storage.setItem('yeogibwa.page.start.v1', JSON.stringify({ name: '테스트가게', address: '서울 마포구 망원로 12', status: 'pending' }));
  globalThis.sessionStorage = storage;
  globalThis.location = { hash: '#/page-search' };
  let calls = 0;
  let out = [];
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(Boolean) });
  const flow = makePageStart({ h, show: (...args) => { out = args; }, setNavbar: () => {}, btn: (label) => h('button', null, label), post: () => { calls++; }, storeName: { textContent: '' } });
  flow.renderSearch();
  assert.equal(calls, 0);
  assert.match(out.map(text).join(' '), /자동으로 다시 보내지 않았어요/);
});

test('map signals render grouped, safe links only, with caveats and empty states', async () => {
  const signals = [
    { platform: 'google_maps', text: '구글 단서', sourceTitle: '외부 공개 글', sourceUrl: 'https://blog.example.org/google', sourceKind: 'third_party' },
    { platform: 'google_maps', text: '지도 원문', sourceTitle: '구글 지도', sourceUrl: 'https://www.google.com/maps/place/x', sourceKind: 'map_page' },
    { platform: 'google_maps', text: '위험 단서', sourceTitle: '나쁨', sourceUrl: 'javascript:alert(1)', sourceKind: 'third_party' },
    { platform: 'google_maps', text: '<img src=x onerror=alert(1)>', sourceTitle: '', sourceUrl: 'http://127.0.0.1/a', sourceKind: 'third_party' },
    { platform: 'unknown', text: '알 수 없는 플랫폼', sourceUrl: 'https://example.com', sourceKind: 'third_party' },
    null, 'x', { platform: 'kakao_map', text: '   ' }, { platform: 'kakao_map' },
  ];
  const ctx = createContext(async () => ({ ...response(), candidates: [{ ...candidate, mapSignals: signals }] }));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  const t = allText(ctx.state);
  assert.match(t, /지도별 공개 검색 단서/);
  assert.match(t, /공식 API의 직접 응답이나 검증된 사실이 아니에요/);
  assert.match(t, /직접 확인해 주세요/);
  assert.match(t, /AI 제시 외부 링크/);
  assert.doesNotMatch(t, /지도 원문/);
  assert.doesNotMatch(t, /알 수 없는 플랫폼/);
  const links = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (n.tag === 'a') links.push(n.attrs.href); (n.children || []).forEach(walk); };
  ctx.state.rendered.forEach(walk);
  assert.ok(links.includes('https://blog.example.org/google'));
  assert.ok(!links.includes('https://www.google.com/maps/place/x'));
  assert.ok(!links.some((l) => /javascript|127\.0\.0\.1/.test(l)));
  const googleSearch = links.find((l) => l.startsWith('https://www.google.com/maps/search/?api=1&query='));
  const kakaoSearch = links.find((l) => l.startsWith('https://map.kakao.com/link/search/'));
  assert.ok(googleSearch && kakaoSearch);
  assert.match(decodeURIComponent(googleSearch), /테스트가게 서울 마포구 망원로 12/);
  assert.match(decodeURIComponent(kakaoSearch), /테스트가게 서울 마포구 망원로 12/);
  assert.match(t, /직접 검색 링크를 누르면/);
  assert.doesNotMatch(t, /위험 단서/);
  const kakao = findRendered(ctx.state, (n) => n.attrs?.['data-platform'] === 'kakao_map');
  assert.match(text(kakao), /카카오맵의 후기와 상세정보는 지도에서 직접 확인해 주세요/);
  const choose = findRendered(ctx.state, (n) => n.tag === 'button' && text(n).includes('이 가게가 맞아요'));
  assert.ok(choose);
});

test('third-party label, empty array and legacy candidates without mapSignals', async () => {
  const third = { ...candidate, mapSignals: [{ platform: 'google_maps', text: '구글 관련 외부 단서', sourceTitle: '블로그', sourceUrl: 'https://blog.example.com/p', sourceKind: 'third_party' }] };
  let ctx = createContext(async () => ({ ...response(), candidates: [third, { ...candidate, mapSignals: [] }, { ...candidate, mapSignals: 'bad' }, candidate] }));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  assert.match(allText(ctx.state), /AI 제시 외부 링크/);
  const empties = allText(ctx.state).match(/이번 결과에서 단서를 받지 못했어요/g) || [];
  assert.equal(empties.length, 1);
  const before = JSON.stringify(ctx.state.rendered.length);
  assert.ok(before);
  assert.equal('mapSignals' in candidate, false);
  const select = findRendered(ctx.state, (n) => n.tag === 'button' && text(n).includes('이 가게가 맞아요'));
  select.attrs.onclick();
  ctx.flow.renderConfirmed();
  assert.match(allText(ctx.state), /지도별 공개 검색 단서/);
  assert.equal(sessionStorage.getItem('maechul.v3'), '{"answers":{"old":"keep"}}');
});

function collectLinks(state) { const links = []; const walk = (n) => { if (!n || typeof n !== 'object') return; if (n.tag === 'a') links.push(n.attrs.href); (n.children || []).forEach(walk); }; state.rendered.forEach(walk); return links; }

test('webFeatures: per-source links, labels, unsafe/empty defense, no raw HTML, direct links without map section', async () => {
  const wf = [
    { text: '시그니처 라떼', sourceTitle: '블로그A', sourceUrl: 'https://a.example.com/p', origin: 'provider_annotation' },
    { text: '조용한 분위기', sourceTitle: '블로그A', sourceUrl: 'https://a.example.com/p', origin: 'provider_annotation' },
    { text: '주차 가능', sourceTitle: '기사B', sourceUrl: 'https://b.example.com/x', origin: 'model_generated' },
    { text: '위험요소', sourceTitle: 'x', sourceUrl: 'javascript:alert(1)', origin: 'model_generated' },
    { text: '내부요소', sourceTitle: 'x', sourceUrl: 'http://127.0.0.1/a', origin: 'model_generated' },
    { text: '   ', sourceTitle: 'x', sourceUrl: 'https://c.example.com', origin: 'model_generated' },
    { text: '<img src=x onerror=alert(1)>', sourceTitle: '<b>t</b>', sourceUrl: 'https://d.example.com', origin: 'model_generated' },
    null, 'x', { sourceUrl: 'https://e.example.com' },
  ];
  const ctx = createContext(async () => ({ ...response(), candidates: [{ ...candidate, features: ['무출처특징'], webFeatures: wf }] }));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  const t = allText(ctx.state);
  assert.match(t, /AI가 웹에서 찾은 가게 특징/);
  assert.match(t, /시그니처 라떼/); assert.match(t, /주차 가능/);
  assert.match(t, /제공자 인용/); assert.match(t, /AI 제시 링크/);
  assert.match(t, /참고자료/); assert.match(t, /사실 확인 필요/);
  assert.doesNotMatch(t, /위험요소|내부요소|무출처특징/);
  const links = collectLinks(ctx.state);
  assert.ok(links.includes('https://a.example.com/p') && links.includes('https://b.example.com/x'));
  assert.ok(!links.some((l) => /javascript|127\.0\.0\.1/.test(l)));
  const q = encodeURIComponent('테스트가게 서울 마포구 망원로 12');
  assert.ok(links.includes(`https://www.google.com/search?q=${q}`));
  assert.ok(links.includes(`https://map.kakao.com/link/search/${q}`));
  assert.ok(!links.some((l) => l.includes('google.com/maps')));
  assert.doesNotMatch(t, /지도별 공개 검색 단서/);
  assert.match(t, /구글 웹 검색/); assert.match(t, /전달/);
  assert.ok(findRendered(ctx.state, (n) => n.tag === 'button' && text(n).includes('이 가게가 맞아요')));
  assert.ok(findRendered(ctx.state, (n) => n.tag === 'li' && n.children[0] === '<img src=x onerror=alert(1)>'));
});

test('webFeatures: at most 8 items shown', async () => {
  const wf = Array.from({ length: 12 }, (_, i) => ({ text: `특징${i}`, sourceTitle: `s${i}`, sourceUrl: `https://s${i}.example.com`, origin: 'model_generated' }));
  const ctx = createContext(async () => ({ ...response(), candidates: [{ ...candidate, webFeatures: wf }] }));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  const t = allText(ctx.state);
  assert.match(t, /특징7/); assert.doesNotMatch(t, /특징8/);
});

test('webFeatures empty keeps unsourced summary labeled; legacy keeps old behavior', async () => {
  let ctx = createContext(async () => ({ ...response(), candidates: [{ ...candidate, strengths: ['친절'], webFeatures: [] }] }));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  let t = allText(ctx.state);
  assert.match(t, /개별 출처가 연결되지 않은 AI 요약/);
  assert.match(t, /창가 좌석/); assert.match(t, /친절/);
  assert.doesNotMatch(t, /AI가 웹에서 찾은 가게 특징/);
  assert.ok(collectLinks(ctx.state).some((l) => l.startsWith('https://www.google.com/search?q=')));
  ctx = createContext(async () => ({ ...response(), candidates: [{ name: '빈가게', webFeatures: [] }] }));
  await ctx.flow.begin('빈가게', '서울');
  t = allText(ctx.state);
  assert.match(t, /충분히 확인하지 못했어요/);
  assert.doesNotMatch(t, /개별 출처가 연결되지 않은/);
  ctx = createContext(async () => ({ ...response(), candidates: [{ ...candidate, mapSignals: [] }] }));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  t = allText(ctx.state);
  assert.match(t, /AI가 정리한 가게 특징/);
  assert.match(t, /지도별 공개 검색 단서/);
  assert.doesNotMatch(t, /개별 출처가 연결되지 않은/);
  assert.ok(!collectLinks(ctx.state).some((l) => l.includes('google.com/search')));
});

const PAGE_KEY = 'yeogibwa.page.start.v1';
const draftResult = () => ({ draft: {
  headline: { text: '창가에서 즐기는 차', evidence: ['answers.offer'] },
  intro: { text: '차를 제공해요.', evidence: ['answers.offer'] },
  sections: [{ heading: '우리 메뉴', body: '따뜻한 차', evidence: ['answers.offer'] }],
  faqs: [{ question: '예약은 어떻게 하나요?', answer: '방문 전 예약해 주세요.', evidence: ['answers.visit'] }],
  keywords: [{ text: '차 한 잔', evidence: ['answers.offer'] }], omittedCount: 2,
}, createdAt: '2026-11-08T10:00:00Z', cached: false, mock: false });
function getNode(ctx, id) { const n = findRendered(ctx.state, x => x.attrs?.id === id); assert.ok(n, id); return n; }
function input(ctx, id, value) { getNode(ctx, id).attrs.oninput({ target: { value } }); }
function check(ctx, id, checked = true) { getNode(ctx, id).attrs.onchange({ target: { checked } }); }
function submit(ctx) { const f = findRendered(ctx.state, x => x.tag === 'form'); assert.ok(f); return f.attrs.onsubmit({ preventDefault() {} }); }
function reload(ctx) {
  ctx.flow = makePageStart({ h: ctx.h, show: ctx.show, setNavbar: ctx.setNavbar, btn: ctx.btn, post: ctx.post, storeName: ctx.state.storeName });
  return ctx;
}
async function ready(post = async () => draftResult(), c = candidate) {
  const calls = [];
  const ctx = createContext(async (url, data, timeout) => {
    if (url === '/api/page-search') return { ...response(), candidates: [c] };
    calls.push({ url, data, timeout }); return post(url, data, timeout);
  });
  await ctx.flow.begin('입력가게', '입력주소');
  findRendered(ctx.state, n => n.tag === 'button' && text(n) === '이 가게가 맞아요').attrs.onclick();
  ctx.flow.renderConfirmed();
  findRendered(ctx.state, n => n.tag === 'button' && text(n) === '질문 답하기').attrs.onclick();
  assert.equal(location.hash, '#/page-questions'); ctx.flow.renderQuestions();
  ctx.calls = calls; return ctx;
}
function fillAnswers(ctx) {
  input(ctx, 'page-answer-offer', '따뜻한 차');
  input(ctx, 'page-answer-difference', '직접 고른 찻잎');
  input(ctx, 'page-answer-audience', '친구와 이야기할 때');
  input(ctx, 'page-answer-visit', '방문 전 예약해 주세요.');
  input(ctx, 'page-answer-keywords', '지역 인기 카페');
}

test('five questions, candidate prefill, independent consent and validation block every request', async () => {
  const ctx = await ready();
  const ids = ['offer', 'difference', 'audience', 'visit', 'keywords'];
  for (const id of ids) assert.ok(getNode(ctx, 'page-answer-' + id));
  assert.equal(getNode(ctx, 'page-store-name').attrs.value, candidate.name);
  assert.equal(getNode(ctx, 'page-store-address').attrs.value, candidate.address);
  assert.equal(getNode(ctx, 'page-store-name').attrs.maxlength, 60);
  assert.equal(getNode(ctx, 'page-store-address').attrs.maxlength, 120);
  assert.equal(getNode(ctx, 'page-answer-offer').attrs.required, true);
  assert.equal(getNode(ctx, 'page-answer-visit').attrs.required, false);
  assert.equal(getNode(ctx, 'page-answer-offer').attrs.maxlength, 500);
  assert.equal(getNode(ctx, 'page-answer-keywords').attrs.maxlength, 300);
  assert.ok(!getNode(ctx, 'page-draft-consent').attrs.checked);
  assert.match(allText(ctx.state), /OpenRouter 및 연결된 AI 제공자/);
  assert.match(allText(ctx.state), /가게명·주소·직접 선택한 특징·위 5개 답변/);
  assert.match(allText(ctx.state), /보관정책|개인정보|검색 동의와 별도/);
  await submit(ctx); assert.equal(ctx.calls.length, 0);
  assert.match(allText(ctx.state), /대표 메뉴·서비스를 2자 이상 입력/);
  input(ctx, 'page-answer-offer', '차 음료'); await submit(ctx);
  assert.equal(ctx.calls.length, 0); assert.match(allText(ctx.state), /별도로 동의/);
  check(ctx, 'page-draft-consent'); input(ctx, 'page-answer-offer', '가'.repeat(501)); await submit(ctx);
  assert.equal(ctx.calls.length, 0);
  input(ctx, 'page-answer-offer', '차 음료'); input(ctx, 'page-store-name', ''); await submit(ctx); assert.equal(ctx.calls.length, 0);
  input(ctx, 'page-store-name', '수정한 가게'); input(ctx, 'page-store-address', '수정한 주소');
  await submit(ctx); assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].data.store.name, '수정한 가게'); assert.equal(ctx.calls[0].data.store.address, '수정한 주소');
  assert.equal(sessionStorage.getItem('maechul.v3'), '{"answers":{"old":"keep"}}');
});

test('only explicitly checked facts are sent, maximum eight, no AI price or hours prefill', async () => {
  const c = { ...candidate, hours: '24시간', priceRange: '무료', webFeatures: Array.from({ length: 10 }, (_, i) => ({ text: '특징' + i, sourceUrl: 'https://example.com/a' })) };
  const ctx = await ready(undefined, c);
  for (let i = 0; i < 8; i++) assert.ok(!getNode(ctx, 'page-fact-' + i).attrs.checked);
  assert.equal(findRendered(ctx.state, n => n.attrs?.id === 'page-fact-8'), null);
  assert.equal(getNode(ctx, 'page-answer-visit').attrs.value, '');
  assert.equal(getNode(ctx, 'page-answer-offer').attrs.value, '');
  check(ctx, 'page-fact-1'); check(ctx, 'page-fact-2'); check(ctx, 'page-fact-2', false);
  fillAnswers(ctx); check(ctx, 'page-draft-consent'); await submit(ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url, '/api/page-draft');
  assert.deepEqual(ctx.calls[0].data, { store: { name: candidate.name, address: candidate.address, verifiedFacts: ['특징1'] }, answers: { offer: '따뜻한 차', difference: '직접 고른 찻잎', audience: '친구와 이야기할 때', visit: '방문 전 예약해 주세요.', keywords: '지역 인기 카페' }, consent: true });
  assert.equal(location.hash, '#/page-preview');
  assert.match(allText(ctx.state), /비공개 미리보기/); assert.match(allText(ctx.state), /2개를 제외/);
  assert.match(allText(ctx.state), /확인할 키워드 제안/); assert.match(allText(ctx.state), /사실 근거가 아니에요/);
  assert.match(allText(ctx.state), /부정 표현이나 조건/);
  assert.match(allText(ctx.state), /AI 학습·추천은 보장하지 않아요/);
  assert.equal(ctx.flow.info().resumeHash, '#/page-preview');
});

test('duplicate submit and pending reentry/reload never repeat automatically', async () => {
  let finish;
  const ctx = await ready(() => new Promise(resolve => { finish = resolve; }));
  fillAnswers(ctx); check(ctx, 'page-draft-consent');
  const originalForm = findRendered(ctx.state, n => n.tag === 'form');
  const pending = submit(ctx);
  await originalForm.attrs.onsubmit({ preventDefault() {} });
  ctx.flow.renderQuestions();
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.flow.busy(), true);
  assert.equal(findRendered(ctx.state, n => n.tag === 'button' && n.attrs.type === 'submit').attrs.disabled, true);
  assert.equal(JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft.status, 'pending');
  reload(ctx); ctx.flow.renderQuestions(); ctx.flow.renderPreview(); ctx.flow.renderEdit();
  assert.equal(ctx.calls.length, 1);
  assert.match(allText(ctx.state), /이미 처리됐을 수도/); assert.match(allText(ctx.state), /자동으로 다시 보내지 않았어요/);
  assert.equal(getNode(ctx, 'page-answer-offer').attrs.value, '따뜻한 차');
  assert.ok(!getNode(ctx, 'page-draft-consent').attrs.checked);
  finish(draftResult()); await pending;
});

test('API errors preserve all answers and selected facts; retry requires a user action and consent', async () => {
  let attempt = 0;
  const ctx = await ready(async () => { if (++attempt === 1) { const e = new Error('응답 지연'); e.code = 'TIMEOUT'; throw e; } return draftResult(); });
  fillAnswers(ctx); check(ctx, 'page-fact-0'); check(ctx, 'page-draft-consent'); await submit(ctx);
  assert.equal(ctx.calls.length, 1); assert.match(allText(ctx.state), /답변은 보존/);
  assert.equal(getNode(ctx, 'page-answer-visit').attrs.value, '방문 전 예약해 주세요.');
  reload(ctx); ctx.flow.renderQuestions();
  assert.equal(ctx.calls.length, 1); assert.equal(getNode(ctx, 'page-fact-0').attrs.checked, true);
  assert.equal(getNode(ctx, 'page-answer-keywords').attrs.value, '지역 인기 카페');
  await submit(ctx); assert.equal(ctx.calls.length, 1);
  check(ctx, 'page-draft-consent'); await submit(ctx); assert.equal(ctx.calls.length, 2);
  assert.equal(location.hash, '#/page-preview');
});

test('every draft field is editable and survives refresh; save is local only and preserves omittedCount', async () => {
  const ctx = await ready(); fillAnswers(ctx); check(ctx, 'page-draft-consent'); await submit(ctx);
  findRendered(ctx.state, n => n.tag === 'button' && text(n) === '내용 수정').attrs.onclick();
  assert.equal(location.hash, '#/page-edit'); ctx.flow.renderEdit();
  const changes = { 'page-edit-store-name': '수정한 상호', 'page-edit-store-address': '수정한 주소', 'page-edit-headline': '수정 제목', 'page-edit-intro': '수정 소개', 'page-edit-section-0-heading': '수정 섹션', 'page-edit-section-0-body': '수정 본문', 'page-edit-faq-0-question': '수정 질문?', 'page-edit-faq-0-answer': '수정 답변', 'page-edit-keyword-0': '수정 키워드' };
  for (const [id, value] of Object.entries(changes)) input(ctx, id, value);
  reload(ctx); ctx.flow.renderEdit(); assert.equal(ctx.flow.info().resumeHash, '#/page-edit');
  for (const [id, value] of Object.entries(changes)) assert.equal(getNode(ctx, id).attrs.value, value);
  await submit(ctx); assert.equal(ctx.calls.length, 1); assert.equal(location.hash, '#/page-preview');
  for (const value of Object.values(changes)) assert.ok(allText(ctx.state).includes(value));
  assert.match(allText(ctx.state), /2개를 제외/);
  reload(ctx); ctx.flow.renderPreview(); assert.match(allText(ctx.state), /수정 제목/);
  assert.equal(ctx.calls.length, 1); assert.equal(JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft.draft.omittedCount, 2);
  ctx.flow.renderQuestions(); assert.equal(getNode(ctx, 'page-answer-offer').attrs.value, '따뜻한 차');
  await submit(ctx); assert.equal(ctx.calls.length, 1);
  ctx.flow.renderSearch(); assert.match(allText(ctx.state), /이 가게가 맞나요/);
  ctx.flow.renderConfirmed(); assert.match(allText(ctx.state), /가게를 확인했어요/);
  assert.equal(sessionStorage.getItem('maechul.v3'), '{"answers":{"old":"keep"}}');
});

test('sparse results never invent FAQ, prices or opening hours', async () => {
  const ctx = await ready(async () => ({ draft: { headline: { text: '차를 파는 가게', evidence: ['answers.offer'] }, omittedCount: 3 }, cached: false, mock: false }));
  input(ctx, 'page-answer-offer', '차 음료'); check(ctx, 'page-draft-consent'); await submit(ctx);
  assert.match(allText(ctx.state), /차를 파는 가게/); assert.match(allText(ctx.state), /3개를 제외/);
  assert.doesNotMatch(allText(ctx.state), /자주 묻는 질문|24시간|무료|예약은 어떻게/);
  ctx.flow.renderEdit(); assert.equal(findRendered(ctx.state, n => n.attrs?.id === 'page-edit-faq-0-question'), null);
  await submit(ctx); assert.equal(ctx.calls.length, 1); assert.match(allText(ctx.state), /3개를 제외/);
});

test('all malicious draft content and edits stay text, never elements or HTML', async () => {
  const attack = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const payload = draftResult();
  for (const item of [payload.draft.headline, payload.draft.intro, ...payload.draft.keywords]) item.text = attack;
  payload.draft.sections[0].heading = attack; payload.draft.sections[0].body = attack;
  payload.draft.faqs[0].question = attack; payload.draft.faqs[0].answer = attack;
  const ctx = await ready(async () => payload); input(ctx, 'page-answer-offer', attack); check(ctx, 'page-draft-consent'); await submit(ctx);
  assert.ok(allText(ctx.state).includes(attack));
  assert.equal(findRendered(ctx.state, n => ['img', 'script', 'iframe'].includes(n.tag)), null);
  assert.equal(findRendered(ctx.state, n => 'innerHTML' in n.attrs || 'srcdoc' in n.attrs), null);
  ctx.flow.renderEdit(); input(ctx, 'page-edit-headline', attack + '<svg/onload=alert(3)>'); await submit(ctx);
  assert.ok(allText(ctx.state).includes('<svg/onload=alert(3)>'));
  assert.equal(findRendered(ctx.state, n => n.tag === 'svg'), null); assert.equal(ctx.calls.length, 1);
});

test('preview/edit direct entry without chosen store does not call API', () => {
  let calls = 0; const ctx = createContext(() => { calls++; });
  ctx.flow.renderQuestions(); ctx.flow.renderPreview(); ctx.flow.renderEdit();
  assert.equal(calls, 0); assert.equal(location.hash, '#/');
});

test('regeneration is explicitly requested, separately consented, and preserves answers', async () => {
  const ctx = await ready(); fillAnswers(ctx); check(ctx, 'page-draft-consent'); await submit(ctx);
  ctx.flow.renderQuestions();
  findRendered(ctx.state, n => n.tag === 'button' && text(n) === '답변으로 새 초안 만들기').attrs.onclick();
  assert.equal(ctx.calls.length, 1); assert.equal(getNode(ctx, 'page-answer-offer').attrs.value, '따뜻한 차');
  await submit(ctx); assert.equal(ctx.calls.length, 1);
  input(ctx, 'page-answer-offer', '차와 커피'); check(ctx, 'page-draft-consent'); location.hash = '#/page-questions'; await submit(ctx);
  assert.equal(ctx.calls.length, 2); assert.equal(ctx.calls[1].data.answers.offer, '차와 커피');
  assert.match(allText(ctx.state), /검색엔진이 수집할 공개 페이지가 아니에요/);
});


test('editing is automatically reflected when navigating to preview or back to questions', async () => {
  const ctx = await ready(); fillAnswers(ctx); check(ctx, 'page-draft-consent'); await submit(ctx);
  ctx.flow.renderEdit(); input(ctx, 'page-edit-headline', '자동 저장된 제목'); input(ctx, 'page-edit-store-name', '수정한 상호');
  ctx.flow.renderPreview(); assert.match(allText(ctx.state), /자동 저장된 제목/); assert.match(allText(ctx.state), /수정한 상호/);
  ctx.flow.renderEdit(); input(ctx, 'page-edit-intro', '질문으로 돌아가도 보존'); ctx.flow.renderQuestions();
  ctx.flow.renderPreview(); assert.match(allText(ctx.state), /질문으로 돌아가도 보존/); assert.equal(ctx.calls.length, 1);
});

test('owner can add and remove their own sections, FAQ and keywords locally', async () => {
  const ctx = await ready(async () => ({ draft: { headline: { text: '처음 제목', evidence: ['offer'] }, intro: { text: '기본 소개', evidence: ['offer'] }, sections: [], faqs: [], keywords: [], omittedCount: 1 }, cached: false }));
  fillAnswers(ctx); check(ctx, 'page-draft-consent'); await submit(ctx); ctx.flow.renderEdit();
  for (const label of ['소개 섹션 추가', 'FAQ 직접 추가', '키워드 추가']) {
    const button = findRendered(ctx.state, n => n.tag === 'button' && text(n) === label); assert.ok(button); button.attrs.onclick();
  }
  input(ctx, 'page-edit-section-0-heading', '사장님이 추가한 내용'); input(ctx, 'page-edit-section-0-body', '확인한 소개예요.');
  input(ctx, 'page-edit-faq-0-question', '포장할 수 있나요?'); input(ctx, 'page-edit-faq-0-answer', '네, 포장할 수 있어요.');
  input(ctx, 'page-edit-keyword-0', '직접 확인한 키워드'); await submit(ctx);
  for (const value of ['사장님이 추가한 내용', '확인한 소개예요.', '포장할 수 있나요?', '네, 포장할 수 있어요.', '직접 확인한 키워드']) assert.ok(allText(ctx.state).includes(value));
  assert.equal(ctx.calls.length, 1); ctx.flow.renderEdit();
  for (const label of ['소개 섹션 삭제', 'FAQ 삭제', '키워드 삭제']) {
    const button = findRendered(ctx.state, n => n.tag === 'button' && text(n) === label); assert.ok(button); button.attrs.onclick();
  }
  ctx.flow.renderPreview(); assert.doesNotMatch(allText(ctx.state), /사장님이 추가한 내용|포장할 수 있나요|직접 확인한 키워드/);
  assert.equal(ctx.calls.length, 1);
});

test('starting another store asks before destroying an in-progress draft', async () => {
  const ctx = await ready(); fillAnswers(ctx); check(ctx, 'page-draft-consent'); await submit(ctx);
  const prior = sessionStorage.getItem(PAGE_KEY); let warning = '';
  try {
    globalThis.confirm = msg => { warning = msg; return false; };
    await ctx.flow.begin('다른 가게', '서울 서초구 다른로 10');
    assert.match(warning, /작성하던 가게 소개와 수정 내용이 지워져요/);
    assert.equal(sessionStorage.getItem(PAGE_KEY), prior); assert.equal(ctx.calls.length, 1);
  } finally { delete globalThis.confirm; }
});

test('uncertain search outcome never retries without a deliberate warning', async () => {
  let requests = 0;
  const ctx = createContext(async () => { requests++; const e = new Error('연결 끊김'); e.code = 'TIMEOUT'; throw e; });
  await ctx.flow.begin('기존가게', '서울 마포구 망원로 12');
  assert.equal(ctx.flow.info().status, 'uncertain'); assert.equal(requests, 1);
  try {
    let warning = ''; globalThis.confirm = msg => { warning = msg; return false; };
    await ctx.flow.begin('기존가게', '서울 마포구 망원로 12');
    assert.match(warning, /비용이 중복될 수/); assert.equal(requests, 1);
  } finally { delete globalThis.confirm; }
});


test('reject button opens a separate consented retry with optional public website and preserves candidate details', async () => {
  const calls = []; let finish;
  const ctx = createContext((path, body) => { calls.push({ path, body }); if (calls.length === 1) return Promise.resolve(response()); return new Promise(r => { finish = r; }); });
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  const card = ctx.state.rendered.find(n => n.attrs?.class === 'card cand page-candidate');
  const labels = card.children.filter(n => n?.tag === 'button').map(text);
  assert.deepEqual(labels, ['이 가게가 맞아요', '아니에요']);
  findRendered(ctx.state, n => n.tag === 'button' && text(n) === '아니에요').attrs.onclick();
  assert.match(allText(ctx.state), /운영 중인 사이트 주소 \(선택\)/);
  let form = findRendered(ctx.state, n => n.tag === 'form' && n.attrs.class === 'page-retry-form');
  await form.attrs.onsubmit({ preventDefault() {} }); assert.equal(calls.length, 1);
  let url = findRendered(ctx.state, n => n.tag === 'input' && n.attrs.id === 'page-retry-url-1');
  url.attrs.oninput({ target: { value: 'https://example.com/?token=secret' } });
  await form.attrs.onsubmit({ preventDefault() {} }); assert.equal(calls.length, 1);
  url.attrs.oninput({ target: { value: 'www.example.com/store' } });
  const checkbox = findRendered(ctx.state, n => n.tag === 'input' && n.attrs.id === 'page-retry-consent-1');
  checkbox.attrs.onchange({ target: { checked: true } });
  const pending = form.attrs.onsubmit({ preventDefault() {} });
  await form.attrs.onsubmit({ preventDefault() {} }); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { path: '/api/page-search', body: { name: '테스트가게', address: '서울 마포구 망원로 12', consent: true, retry: true, siteUrl: 'https://www.example.com/store', rejected: { name: '테스트가게', address: '서울 마포구 망원로 12' }, previousSearchAt: '2026-11-10T10:00:00Z' } });
  finish(response()); await pending;
  assert.match(allText(ctx.state), /이 가게가 맞나요/);
  assert.equal(sessionStorage.getItem('maechul.v3'), '{"answers":{"old":"keep"}}');
});

test('retry works without a website, preserves input on failure and never automatically retries', async () => {
  const calls = [];
  const ctx = createContext(async (path, body) => { calls.push({ path, body }); if (calls.length === 1) return response(); const e = new Error('시간 초과'); e.code = 'AI_TIMEOUT'; throw e; });
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  findRendered(ctx.state, n => n.tag === 'button' && text(n) === '아니에요').attrs.onclick();
  const check = findRendered(ctx.state, n => n.attrs?.id === 'page-retry-consent-1'); check.attrs.onchange({ target: { checked: true } });
  await findRendered(ctx.state, n => n.tag === 'form' && n.attrs.class === 'page-retry-form').attrs.onsubmit({ preventDefault() {} });
  assert.equal(calls.length, 2); assert.equal(calls[1].body.siteUrl, '');
  assert.match(allText(ctx.state), /이미 처리됐을 수 있고 자동 재시도하지 않았어요/);
  assert.match(allText(ctx.state), /이 가게가 맞아요/);
  ctx.flow.renderSearch(); assert.equal(calls.length, 2);
});

test('reloading a pending retry does not call AI again and shows the earlier result', async () => {
  const ctx = createContext(async () => response()); await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  const data = JSON.parse(sessionStorage.getItem('yeogibwa.page.start.v1'));
  data.status = 'pending'; data.retry = { index: 0, siteUrl: 'https://example.com/', status: 'pending' };
  sessionStorage.setItem('yeogibwa.page.start.v1', JSON.stringify(data));
  let calls = 0, out = [];
  const flow = makePageStart({ h: ctx.h, show: (...x) => { out = x.flat(Infinity).filter(Boolean); }, setNavbar: ctx.setNavbar, btn: ctx.btn, post: () => { calls++; }, storeName: ctx.state.storeName });
  flow.renderSearch();
  assert.equal(calls, 0); assert.match(out.map(text).join(' '), /자동으로 다시 보내지 않았어요/);
  assert.match(out.map(text).join(' '), /이 가게가 맞아요/);
  assert.match(JSON.stringify(out), /https:\/\/example\.com\//);
});

test('no candidate result also offers a consented search again', async () => {
  const calls = []; const ctx = createContext(async (path, body) => { calls.push(body); return { ...response(), candidates: [] }; });
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  findRendered(ctx.state, n => n.tag === 'button' && text(n) === '다시 찾아보기').attrs.onclick();
  findRendered(ctx.state, n => n.attrs?.id === 'page-retry-consent-0').attrs.onchange({ target: { checked: true } });
  await findRendered(ctx.state, n => n.tag === 'form' && n.attrs.class === 'page-retry-form').attrs.onsubmit({ preventDefault() {} });
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].rejected, { name: '', address: '' });
});


test('malformed or unverified retry response preserves the original candidate and never publishes it', async () => {
  for (const invalid of [null, {}, { candidates: [] }, { candidates: [], webEvidence: { status: 'unverified' } }]) {
    let calls = 0; const ctx = createContext(async () => { calls++; return calls === 1 ? response() : invalid; });
    await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
    findRendered(ctx.state, n => n.tag === 'button' && text(n) === '아니에요').attrs.onclick();
    findRendered(ctx.state, n => n.attrs?.id === 'page-retry-consent-1').attrs.onchange({ target: { checked: true } });
    await findRendered(ctx.state, n => n.tag === 'form' && n.attrs.class === 'page-retry-form').attrs.onsubmit({ preventDefault() {} });
    assert.equal(calls, 2); assert.match(allText(ctx.state), /이전 결과는 보존했어요/); assert.match(allText(ctx.state), /이 가게가 맞아요/);
  }
});


function suggestion(ctx, key, index) { const b = findRendered(ctx.state, n => n.tag === 'button' && n.attrs['data-suggestion-for'] === key && n.attrs['data-suggestion-index'] === index); assert.ok(b, key + ':' + index); return b; }
test('each question has clickable, non-submitting answer examples without changing consent or making a request', async () => {
  const ctx = await ready();
  for (const key of ['offer', 'difference', 'audience', 'visit', 'keywords']) {
    assert.ok(findRendered(ctx.state, n => n.attrs?.['data-suggestions-for'] === key));
    assert.equal(suggestion(ctx, key, 0).attrs.type, 'button'); assert.equal(suggestion(ctx, key, 1).attrs.type, 'button');
  }
  check(ctx, 'page-draft-consent');
  suggestion(ctx, 'offer', 0).attrs.onclick();
  assert.equal(ctx.calls.length, 0);
  assert.match(JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft.answers.offer, /\[메뉴 이름\]/);
  await submit(ctx); assert.equal(ctx.calls.length, 0); assert.match(allText(ctx.state), /실제 가게 내용으로 바꾸거나 지워/);
  input(ctx, 'page-answer-offer', '따뜻한 차를 제공해요.'); await submit(ctx);
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.calls[0].data.consent, true);
});

test('an example cannot silently overwrite an answer and the user can deliberately replace it', async () => {
  const ctx = await ready(); input(ctx, 'page-answer-difference', '오래 작성한 내 답변');
  const old = globalThis.confirm; let prompts = [];
  try {
    globalThis.confirm = s => { prompts.push(s); return false; };
    suggestion(ctx, 'difference', 1).attrs.onclick();
    assert.equal(JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft.answers.difference, '오래 작성한 내 답변');
    globalThis.confirm = s => { prompts.push(s); return true; };
    suggestion(ctx, 'difference', 1).attrs.onclick();
    assert.match(JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft.answers.difference, /\[재료·공간·서비스의 특징\]/);
    assert.equal(prompts.length, 2); assert.match(prompts[0], /기존에 작성한 답변/);
    reload(ctx); ctx.flow.renderQuestions(); assert.match(getNode(ctx, 'page-answer-difference').attrs.value, /\[재료·공간·서비스의 특징\]/);
  } finally { if (old === undefined) delete globalThis.confirm; else globalThis.confirm = old; }
});

test('AI-found menus require explicit confirmation and never auto-select facts or include prices', async () => {
  const c = { ...candidate, menu: [{ name: '차와 빵', price: '99999원' }, { name: '홍차', price: '10000원' }] };
  const ctx = await ready(undefined, c); const old = globalThis.confirm; let prompted = '';
  try {
    globalThis.confirm = s => { prompted = s; return false; };
    const b = suggestion(ctx, 'offer', 0); assert.match(text(b), /AI가 찾은 메뉴 · 확인 필요/);
    b.attrs.onclick(); assert.equal(JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft.answers.offer, '');
    assert.match(prompted, /틀릴 수 있어요/); assert.doesNotMatch(prompted, /99999|10000/);
    globalThis.confirm = () => true; b.attrs.onclick();
    const saved = JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft;
    assert.equal(saved.answers.offer, '대표 메뉴: 차와 빵, 홍차.'); assert.deepEqual(saved.store.verifiedFacts, []);
    assert.equal(ctx.calls.length, 0);
  } finally { if (old === undefined) delete globalThis.confirm; else globalThis.confirm = old; }
});

test('example placeholders in any answer block transmission until the user fills or removes them', async () => {
  const ctx = await ready(); input(ctx, 'page-answer-offer', '따뜻한 차'); check(ctx, 'page-draft-consent');
  suggestion(ctx, 'visit', 1).attrs.onclick(); await submit(ctx);
  assert.equal(ctx.calls.length, 0); assert.match(allText(ctx.state), /\[ \] 부분을 실제 가게 내용으로 바꾸거나 지워/);
  input(ctx, 'page-answer-visit', '주차는 방문 전 확인해 주세요.'); await submit(ctx);
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.calls[0].data.answers.visit, '주차는 방문 전 확인해 주세요.');
});

test('keyword suggestions use currently entered store identity and remain nonfactual suggestions', async () => {
  const ctx = await ready(); input(ctx, 'page-store-name', '새 가게'); input(ctx, 'page-store-address', '대전 중구 대종로 1');
  suggestion(ctx, 'keywords', 0).attrs.onclick();
  assert.equal(JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft.answers.keywords, '새 가게, 대전 중구 새 가게');
  reload(ctx); ctx.flow.renderQuestions(); assert.equal(getNode(ctx, 'page-answer-keywords').attrs.value, '새 가게, 대전 중구 새 가게');
  assert.match(allText(ctx.state), /희망 검색어는 사실 근거로 사용하지 않아요/); assert.equal(ctx.calls.length, 0);
});


test('concrete answer examples require confirmation that they match the actual store', async () => {
  const ctx = await ready(); const old = globalThis.confirm; let prompt = '';
  try {
    globalThis.confirm = s => { prompt = s; return false; };
    for (const key of ['difference', 'audience', 'visit']) {
      const b = suggestion(ctx, key, 0); assert.match(text(b), /참고 예시 · 실제와 맞는지 확인/); b.attrs.onclick();
      assert.equal(JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft.answers[key], '');
      assert.match(prompt, /실제로 맞는 내용인지 확인/);
    }
    globalThis.confirm = () => true;
    suggestion(ctx, 'difference', 0).attrs.onclick(); suggestion(ctx, 'audience', 0).attrs.onclick(); suggestion(ctx, 'visit', 0).attrs.onclick();
    const saved = JSON.parse(sessionStorage.getItem(PAGE_KEY)).pageDraft;
    assert.match(saved.answers.difference, /직접 만들어/); assert.match(saved.answers.audience, /가족이나 친구/); assert.match(saved.answers.visit, /포장이 가능/);
    assert.deepEqual(saved.store.verifiedFacts, []); assert.equal(ctx.calls.length, 0);
  } finally { if (old === undefined) delete globalThis.confirm; else globalThis.confirm = old; }
});
