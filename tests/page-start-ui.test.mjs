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
