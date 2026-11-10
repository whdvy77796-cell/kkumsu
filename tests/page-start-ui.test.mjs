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
  return (node.children || []).map(text).join(' ');
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
  assert.match(allText(ctx.state), /다음 단계는 준비 중/);
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
    { platform: 'google_maps', text: '구글 단서', sourceTitle: '구글 페이지', sourceUrl: 'https://www.google.com/maps/place/x', sourceKind: 'map_page' },
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
  assert.match(t, /AI 제시 지도 링크/);
  assert.doesNotMatch(t, /알 수 없는 플랫폼/);
  const links = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (n.tag === 'a') links.push(n.attrs.href); (n.children || []).forEach(walk); };
  ctx.state.rendered.forEach(walk);
  assert.ok(links.includes('https://www.google.com/maps/place/x'));
  assert.ok(!links.some((l) => /javascript|127\.0\.0\.1/.test(l)));
  const googleSearch = links.find((l) => l.startsWith('https://www.google.com/maps/search/?api=1&query='));
  const kakaoSearch = links.find((l) => l.startsWith('https://map.kakao.com/link/search/'));
  assert.ok(googleSearch && kakaoSearch);
  assert.match(decodeURIComponent(googleSearch), /테스트가게 서울 마포구 망원로 12/);
  assert.match(decodeURIComponent(kakaoSearch), /테스트가게 서울 마포구 망원로 12/);
  assert.match(t, /직접 검색 링크를 누르면/);
  assert.doesNotMatch(t, /위험 단서/);
  const kakao = findRendered(ctx.state, (n) => n.attrs?.['data-platform'] === 'kakao_map');
  assert.match(text(kakao), /이번 결과에서 단서를 받지 못했어요\. 지도에 정보가 없다는 뜻은 아니에요\./);
  const choose = findRendered(ctx.state, (n) => n.tag === 'button' && text(n).includes('이 가게가 맞아요'));
  assert.ok(choose);
});

test('third-party label, empty array and legacy candidates without mapSignals', async () => {
  const third = { ...candidate, mapSignals: [{ platform: 'kakao_map', text: '카카오 단서', sourceTitle: '블로그', sourceUrl: 'https://blog.example.com/p', sourceKind: 'third_party' }] };
  let ctx = createContext(async () => ({ ...response(), candidates: [third, { ...candidate, mapSignals: [] }, { ...candidate, mapSignals: 'bad' }, candidate] }));
  await ctx.flow.begin('테스트가게', '서울 마포구 망원로 12');
  assert.match(allText(ctx.state), /AI 제시 외부 링크/);
  const empties = allText(ctx.state).match(/이번 결과에서 단서를 받지 못했어요/g) || [];
  assert.equal(empties.length, 3);
  const before = JSON.stringify(ctx.state.rendered.length);
  assert.ok(before);
  assert.equal('mapSignals' in candidate, false);
  const select = findRendered(ctx.state, (n) => n.tag === 'button' && text(n).includes('이 가게가 맞아요'));
  select.attrs.onclick();
  ctx.flow.renderConfirmed();
  assert.match(allText(ctx.state), /지도별 공개 검색 단서/);
  assert.equal(sessionStorage.getItem('maechul.v3'), '{"answers":{"old":"keep"}}');
});
