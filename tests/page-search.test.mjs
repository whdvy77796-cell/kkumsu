import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, buildWebEvidence, normalizeMapSignals, normalizeWebFeatures, currentBranchPrice, CACHE_NAMESPACE, RETRY_CACHE_NAMESPACE } from '../api/page-search.js';
import { MemoryStore, hashKey } from '../lib/guard.mjs';

const ENV = { OPENROUTER_API_KEY: 'test-key', SESSION_SECRET: 'x'.repeat(32), VERCEL: '1', VERCEL_ENV: 'preview' };

function req({ method = 'POST', body, headers = {} } = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  const r = Readable.from(data ? [Buffer.from(data)] : []);
  r.method = method;
  r.headers = {
    host: 'www.kkumsu.com', origin: 'https://www.kkumsu.com', 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(data)), 'x-forwarded-for': '203.0.113.7', ...headers,
  };
  return r;
}
function res() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b || ''; },
    json() { return JSON.parse(this.body); },
  };
}
const OK = { name: '골목분식', address: '서울 마포구 망원로 12', consent: true };
const JSON_OUT = JSON.stringify({
  candidates: [{ name: '골목분식', address: '서울 마포구 망원로 12', matchLevel: 'high', matchReason: '주소 일치' }],
  summary: '요약', sources: [{ title: '모델 링크', url: 'https://blog.naver.com/a' }],
});
const CITE = [{ type: 'url_citation', url_citation: { url: 'https://example.com/c', title: '인용' } }];

function aiReply(content, { annotations = [], searches = 2, cost = 0.1 } = {}) {
  const usage = { prompt_tokens: 100, completion_tokens: 50, cost };
  if (searches !== undefined) usage.server_tool_use_details = { web_search_requests: searches };
  return new Response(JSON.stringify({
    model: 'm', choices: [{ finish_reason: 'stop', message: { content, annotations } }], usage,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function fakeFetch(...replies) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const next = replies.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  f.calls = calls;
  return f;
}
async function call(body, deps, extra = {}) {
  const out = res();
  await createHandler({ env: ENV, ...deps })(req({ body, ...extra }), out);
  return out;
}
const pageKeys = (store) => [...store.kv.keys()].filter((k) => k.includes(`:${CACHE_NAMESPACE}:`) && !k.endsWith(':lock'));

test('consent missing/false/non-true: 400 and no cache or provider call', async () => {
  for (const consent of [undefined, false, 'true', 1, null]) {
    const store = new MemoryStore();
    store.getJson = async () => { throw new Error('cache touched'); };
    const f = fakeFetch();
    const body = { name: OK.name, address: OK.address };
    if (consent !== undefined) body.consent = consent;
    const o = await call(body, { store, fetcher: f });
    assert.equal(o.statusCode, 400);
    assert.equal(o.json().code, 'CONSENT');
    assert.equal(f.calls.length, 0);
  }
});

test('strict fields: extra keys (images, answers, refresh) rejected before any call', async () => {
  for (const extra of [{ images: ['x'] }, { answers: {} }, { refresh: true }, { interview: 'a' }]) {
    const f = fakeFetch();
    const o = await call({ ...OK, ...extra }, { store: new MemoryStore(), fetcher: f });
    assert.equal(o.statusCode, 400);
    assert.equal(o.json().code, 'FIELDS');
    assert.equal(f.calls.length, 0);
  }
  assert.equal((await call({ ...OK, name: '' }, { store: new MemoryStore(), fetcher: fakeFetch() })).json().code, 'NAME');
});

test('origin, method and payload limit enforced', async () => {
  const f = fakeFetch();
  const o1 = res();
  await createHandler({ env: ENV, store: new MemoryStore(), fetcher: f })(req({ body: OK, headers: { origin: 'https://evil.com' } }), o1);
  assert.equal(o1.statusCode, 403);
  const o2 = res();
  await createHandler({ env: ENV, store: new MemoryStore(), fetcher: f })(req({ method: 'GET' }), o2);
  assert.equal(o2.statusCode, 405);
  const o3 = await call({ ...OK, name: 'a'.repeat(3000) }, { store: new MemoryStore(), fetcher: f });
  assert.equal(o3.statusCode, 413);
  assert.equal(f.calls.length, 0);
});

test('success: confirmed evidence, separated sources, one call, cache hit keeps searchedAt, isolated namespace', async () => {
  const store = new MemoryStore();
  const f = fakeFetch(aiReply(JSON_OUT, { annotations: CITE, searches: 2 }));
  const o = await call(OK, { store, fetcher: f });
  assert.equal(o.statusCode, 200);
  const j = o.json();
  assert.equal(j.cached, false);
  assert.equal(j.mock, false);
  assert.equal(j.webEvidence.status, 'confirmed');
  assert.equal(j.candidates.length, 1);
  assert.deepEqual(j.sources.map((s) => s.origin), ['provider_annotation', 'model_generated']);
  assert.ok(j.searchedAt && j.model);
  assert.equal(f.calls.length, 1);
  assert.equal(pageKeys(store).length, 1);
  const j2 = (await call(OK, { store, fetcher: fakeFetch() })).json();
  assert.equal(j2.cached, true);
  assert.equal(j2.searchedAt, j.searchedAt);
  const store2 = new MemoryStore();
  const oldKey = hashKey('page-search-v3', OK.name, OK.address);
  await store2.setJson(oldKey, { candidates: [{ name: 'old' }] });
  assert.equal((await call(OK, { store: store2, fetcher: fakeFetch(aiReply(JSON_OUT)) })).json().cached, false);
  assert.equal((await store2.getJson(oldKey)).candidates[0].name, 'old');
});

test('lock: in-flight duplicate gets 409 and no second provider call', async () => {
  const store = new MemoryStore();
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = fakeFetch(() => gate.then(() => aiReply(JSON_OUT)));
  const first = call(OK, { store, fetcher: f });
  await new Promise((r) => setTimeout(r, 30));
  const second = await call(OK, { store, fetcher: fakeFetch() });
  assert.equal(second.statusCode, 409);
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal(f.calls.length, 1);
});

test('evidence states incl. explicit 0 conflict', () => {
  const u = (n) => (n === undefined ? {} : { server_tool_use_details: { web_search_requests: n } });
  assert.equal(buildWebEvidence(u(3), []).status, 'confirmed');
  assert.equal(buildWebEvidence(u(3), CITE).status, 'confirmed');
  assert.equal(buildWebEvidence(u(undefined), CITE).status, 'citation_only');
  assert.equal(buildWebEvidence(u(null), CITE).status, 'citation_only');
  assert.equal(buildWebEvidence(u(undefined), []).status, 'unverified');
  const z = buildWebEvidence(u(0), CITE);
  assert.equal(z.status, 'unverified');
  assert.equal(z.conflict, true);
  assert.equal(buildWebEvidence(u(1.5), []).status, 'unverified');
  assert.equal(buildWebEvidence(u(1.5), CITE).status, 'unverified');
  assert.equal(buildWebEvidence(u(undefined), [{ url: 'https://x.com' }]).status, 'unverified');
});

test('malformed JSON: exactly one model call, 502, no repair, nothing cached', async () => {
  const store = new MemoryStore();
  const f = fakeFetch(aiReply('not json at all'));
  const o = await call(OK, { store, fetcher: f });
  assert.equal(o.statusCode, 502);
  assert.equal(o.json().code, 'AI_FORMAT');
  assert.equal(f.calls.length, 1);
  assert.equal(pageKeys(store).length, 0);
});

test('timeout: no automatic retry, reservation kept (markUnknown), no candidates returned', async () => {
  const store = new MemoryStore();
  const f = fakeFetch(new Error('aborted'));
  const o = await call(OK, { store, fetcher: f });
  assert.equal(o.statusCode, 504);
  assert.equal(o.json().candidates, undefined);
  assert.equal(f.calls.length, 1);
  const budget = [...store.kv.entries()].find(([k]) => k.includes(':budget:'));
  assert.equal(Number(budget[1]), 350000);
});

test('unverified search: one provider call, clear error and no cached uncertain result', async () => {
  const store = new MemoryStore();
  const f = fakeFetch(aiReply(JSON.stringify({ candidates: [], summary: '' }), { searches: 0 }));
  const o = await call(OK, { store, fetcher: f });
  assert.equal(o.statusCode, 502);
  assert.equal(o.json().code, 'SEARCH_UNVERIFIED');
  assert.equal(f.calls.length, 1);
  assert.equal(pageKeys(store).length, 0);
});

test('no candidates after confirmed search is not asserted as absence', async () => {
  const f = fakeFetch(aiReply(JSON.stringify({ candidates: [], summary: '' }), { searches: 2 }));
  const j = (await call(OK, { store: new MemoryStore(), fetcher: f })).json();
  assert.deepEqual(j.candidates, []);
  assert.equal(j.absenceConfirmed, false);
  assert.equal(j.webEvidence.status, 'confirmed');
  assert.deepEqual(j.sources, []);
});

test('cost accounting settles against reservation', async () => {
  const store = new MemoryStore();
  await call(OK, { store, fetcher: fakeFetch(aiReply(JSON_OUT, { cost: 0.2 })) });
  const budget = [...store.kv.entries()].find(([k]) => k.includes(':budget:'));
  assert.equal(Number(budget[1]), 200000);
});

test('max 3 candidates', async () => {
  const c = (n) => ({ name: 'n' + n, address: 'a' });
  const f = fakeFetch(aiReply(JSON.stringify({ candidates: [1, 2, 3, 4, 5].map(c) })));
  assert.equal((await call(OK, { store: new MemoryStore(), fetcher: f })).json().candidates.length, 3);
});

test('mock: evidence status mock and mock=true; consent still required; no provider call', async () => {
  const f = fakeFetch();
  const env = { ...ENV, MOCK_AI: '1' };
  const bad = await call({ name: OK.name, address: OK.address }, { env, fetcher: f, mockDelay: 0 });
  assert.equal(bad.statusCode, 400);
  const o = await call(OK, { env, fetcher: f, mockDelay: 0 });
  const j = o.json();
  assert.equal(o.statusCode, 200);
  assert.equal(j.mock, true);
  assert.equal(j.webEvidence.status, 'mock');
  assert.equal(f.calls.length, 0);
});


test('map signals only keep bounded, attributed public links and classify actual hosts', () => {
  const g = (text, sourceUrl, extra = {}) => ({ platform: 'google_maps', text, sourceUrl, ...extra });
  const k = (text, sourceUrl, extra = {}) => ({ platform: 'kakao_map', text, sourceUrl, ...extra });
  const signals = normalizeMapSignals([
    g('가'.repeat(121), 'https://public.example.org/long'),
    g('지도 원문', 'https://www.google.com/maps/place/cafe'),
    g('내부', 'http://127.0.0.1/secret'),
    g('계정정보', 'https://u:p@example.org/path'),
    g('스크립트', 'javascript:alert(1)'),
    k('카카오 상세', 'https://place.map.kakao.com/123'),
    k('카카오 외부 주장', 'https://blog.example.org/story'),
    g('좌석', 'https://public.example.org/seat', { sourceTitle: '공개 글', sourceKind: 'map_page' }),
    g('좌석', 'https://public.example.org/duplicate'),
    g('주차', 'https://public.example.org/parking'),
    g('음식', 'https://public.example.org/menu'),
    g('초과', 'https://public.example.org/extra'),
    { platform: 'unknown', text: 'unknown', sourceUrl: 'https://example.org/' },
    { platform: 'google_maps', text: '', sourceUrl: 'https://example.org/' },
    { platform: 'google_maps', text: '출처 누락' }, null,
  ]);
  assert.equal(signals.length, 3);
  assert.deepEqual(signals.map((s) => [s.platform, s.sourceKind]), [
    ['google_maps', 'third_party'], ['google_maps', 'third_party'], ['google_maps', 'third_party'],
  ]);
  assert.ok(signals.every((s) => s.sourceUrl.startsWith('http') && s.text && s.sourceTitle));
  assert.deepEqual(normalizeMapSignals(null), []);
});

test('public-web feature instructions use the same provider call and search limits without claiming Google search', async () => {
  const f = fakeFetch(aiReply(JSON_OUT));
  const j = (await call(OK, { store: new MemoryStore(), fetcher: f })).json();
  assert.equal(j.candidates.length, 1);
  assert.deepEqual(j.candidates[0].webFeatures, []);
  assert.equal(f.calls.length, 1);
  const body = f.calls[0].body;
  assert.equal(body.tools[0].parameters.max_uses, 3);
  assert.equal(body.max_tool_calls, 4);
  assert.equal(body.max_tokens, 5000);
  assert.match(body.messages[0].content, /가게 자체의 특징/);
  assert.match(body.messages[0].content, /Google 검색을 했다고 주장하지 마세요/);
  assert.match(body.messages[0].content, /카카오맵 후기·평점·상세정보/);
  assert.match(body.messages[1].content, /webFeatures/);
});

test('map notes remain attached to the correct candidate after filtering invalid names', async () => {
  const make = (name, note) => ({ name, address: '서울 마포구', mapSignals: [{ platform: 'google_maps', text: note, sourceUrl: 'https://blog.example.org/place' }] });
  const content = JSON.stringify({ candidates: [make('', 'skip'), null, make('하나', 'one'), make('둘', 'two'), make('셋', 'three'), make('넷', 'four')] });
  const out = (await call(OK, { store: new MemoryStore(), fetcher: fakeFetch(aiReply(content)) })).json();
  assert.deepEqual(out.candidates.map((c) => [c.name, c.mapSignals[0].text]), [['하나', 'one'], ['둘', 'two'], ['셋', 'three']]);
});


test('Kakao map details are not returned as extracted data', async () => {
  const content = JSON.stringify({ candidates: [{
    name: '골목분식', address: '서울 마포구', hours: '카카오맵 기준 8시',
    rating: '카카오맵 4.6', reviewCount: 'Kakao Map 후기 100건',
    features: ['카카오맵 주차 가능', '별도 공개 홈페이지 안내'],
    strengths: ['카카오맵 후기의 친절', '별도 공개 글의 특징'],
    mapSignals: [{ platform: 'kakao_map', text: '매장 특징', sourceUrl: 'https://place.map.kakao.com/123' }],
  }] });
  const out = (await call(OK, { store: new MemoryStore(), fetcher: fakeFetch(aiReply(content)) })).json().candidates[0];
  assert.equal(out.hours, null);
  assert.equal(out.rating, null);
  assert.equal(out.reviewCount, null);
  assert.deepEqual(out.features, ['별도 공개 홈페이지 안내']);
  assert.deepEqual(out.strengths, ['별도 공개 글의 특징']);
  assert.deepEqual(out.mapSignals, []);
});


test('web features require safe matching sources, preserve origin, deduplicate, and never treat search/map pages as source evidence', () => {
  const sources = [
    { title: '제공자가 인용', url: 'https://official.example.org/about', origin: 'provider_annotation' },
    { title: 'AI가 제시', url: 'https://blog.example.org/a', origin: 'model_generated' },
    { title: 'Google 검색', url: 'https://www.google.com/search?q=store', origin: 'model_generated' },
    { title: '카카오 지도', url: 'https://place.map.kakao.com/123', origin: 'model_generated' },
    { title: '내부 주소', url: 'http://127.0.0.1/private', origin: 'provider_annotation' },
  ];
  const feature = (text, sourceUrl) => ({ text, sourceUrl, sourceTitle: '임의의 잘못된 제목', origin: 'provider_annotation' });
  const items = normalizeWebFeatures([
    feature('빵을 직접 구워요', 'https://official.example.org/about'),
    feature('주말에 문을 열어요', 'https://blog.example.org/a'),
    feature('빵을 직접 구워요', 'https://blog.example.org/a'),
    feature('없는 출처', 'https://else.example.org/a'),
    feature('검색 페이지', 'https://www.google.com/search?q=store'),
    feature('카카오 상세', 'https://place.map.kakao.com/123'),
    feature('카카오맵 후기 특징', 'https://blog.example.org/a'),
    feature('내부', 'http://127.0.0.1/private'),
    feature('실행', 'javascript:alert(1)'),
    feature('가'.repeat(121), 'https://blog.example.org/a'),
    null,
  ], sources);
  assert.deepEqual(items, [
    { text: '빵을 직접 구워요', sourceTitle: '제공자가 인용', sourceUrl: 'https://official.example.org/about', origin: 'provider_annotation' },
    { text: '주말에 문을 열어요', sourceTitle: 'AI가 제시', sourceUrl: 'https://blog.example.org/a', origin: 'model_generated' },
  ]);
  assert.deepEqual(normalizeWebFeatures(null, sources), []);
  assert.deepEqual(normalizeWebFeatures([feature('x', 'https://blog.example.org/a')], null), []);
  const many = Array.from({ length: 12 }, (_, i) => feature('특징 ' + i, 'https://blog.example.org/a'));
  assert.equal(normalizeWebFeatures(many, sources).length, 8);
});

test('web features stay with the right candidate and distinguish AI-generated links from provider citations', async () => {
  const make = (name, text, url) => ({ name, address: '서울 마포구', webFeatures: [{ text, sourceUrl: url }] });
  const content = JSON.stringify({ candidates: [make('', 'skip', 'https://blog.example.org/a'), null,
    make('하나', '특징 하나', 'https://example.com/c'), make('둘', '특징 둘', 'https://blog.example.org/a')],
    sources: [{ title: 'AI 링크', url: 'https://blog.example.org/a' }] });
  const out = (await call(OK, { store: new MemoryStore(), fetcher: fakeFetch(aiReply(content, { annotations: CITE })) })).json();
  assert.deepEqual(out.candidates.map((c) => [c.name, c.webFeatures[0].text, c.webFeatures[0].origin]), [
    ['하나', '특징 하나', 'provider_annotation'], ['둘', '특징 둘', 'model_generated'],
  ]);
});

test('prices explicitly for another branch are removed without discarding the menu', async () => {
  assert.equal(currentBranchPrice('1,700원 (대전역점 기준)', '성심당 본점'), null);
  assert.equal(currentBranchPrice('다른 지점 2,000원', '성심당 본점'), null);
  assert.equal(currentBranchPrice('1,700원 (대전역점 기준)', '성심당 대전역점'), '1,700원 (대전역점 기준)');
  assert.equal(currentBranchPrice('1,700원', '성심당 본점'), '1,700원');
  const content = JSON.stringify({ candidates: [{ name: '성심당 본점', address: '대전 중구', menu: [{ name: '튀김소보로', price: '1,700원 (대전역점 기준)' }] }] });
  const out = (await call(OK, { store: new MemoryStore(), fetcher: fakeFetch(aiReply(content)) })).json().candidates[0];
  assert.deepEqual(out.menu, [{ name: '튀김소보로', price: null }]);
});


const RETRY = { ...OK, retry: true, siteUrl: 'www.example.com/store', rejected: { name: '골목분식 다른 지점', address: '서울 다른 곳' }, previousSearchAt: '2026-11-10T10:00:00.000Z' };

test('retry requires consent and validates public reference URL before any provider call', async () => {
  for (const siteUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'http://localhost/', 'http://127.1/', 'https://[::1]/', 'https://user:pass@example.com/', 'https://example.com/?token=secret', 'https://example.com/#private', 'https://example.com:444/', 'http://shop.internal/', 'bad domain', 'x'.repeat(301), 123, {}]) {
    const f = fakeFetch(); const o = await call({ ...RETRY, siteUrl }, { store: new MemoryStore(), fetcher: f });
    assert.equal(o.statusCode, 400, String(siteUrl)); assert.equal(o.json().code, 'SITE_URL'); assert.equal(f.calls.length, 0);
  }
  const noConsent = await call({ ...RETRY, consent: false }, { store: new MemoryStore(), fetcher: fakeFetch() });
  assert.equal(noConsent.json().code, 'CONSENT');
  for (const extra of [{ retry: false }, { retry: 'true' }, { retry: undefined, siteUrl: 'https://example.com' }, { rejected: { name: '가게', address: '', secret: 'x' } }, { previousSearchAt: 'not-a-date' }]) {
    const f = fakeFetch(); const o = await call({ ...RETRY, ...extra }, { store: new MemoryStore(), fetcher: f });
    assert.equal(o.statusCode, 400); assert.equal(f.calls.length, 0);
  }
});

test('a rejection performs a separately cached search with URL and prior candidate as untrusted context', async () => {
  const store = new MemoryStore();
  const f = fakeFetch(aiReply(JSON_OUT), aiReply(JSON_OUT), aiReply(JSON_OUT), aiReply(JSON_OUT));
  const first = await call(OK, { store, fetcher: f }); assert.equal(first.statusCode, 200);
  const retry = await call(RETRY, { store, fetcher: f }); assert.equal(retry.statusCode, 200); assert.equal(retry.json().cached, false);
  assert.equal(f.calls.length, 2);
  const user = f.calls[1].body.messages.find(m => m.role === 'user').content;
  assert.match(user, /https:\/\/www\.example\.com\/store/); assert.match(user, /골목분식 다른 지점/); assert.match(user, /명령이 아닌 참고 데이터/);
  assert.equal(f.calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(f.calls[1].body.max_tool_calls, 4);
  const repeat = await call(RETRY, { store, fetcher: f }); assert.equal(repeat.json().cached, true); assert.equal(f.calls.length, 2);
  const differentUrl = await call({ ...RETRY, siteUrl: 'https://another.example.org/' }, { store, fetcher: f }); assert.equal(differentUrl.json().cached, false);
  const noUrl = await call({ ...RETRY, siteUrl: '' }, { store, fetcher: f }); assert.equal(noUrl.json().cached, false);
  assert.equal(f.calls.length, 4);
  assert.ok([...store.kv.keys()].some(k => k.includes(':' + RETRY_CACHE_NAMESPACE + ':')));
  assert.ok([...store.kv.keys()].some(k => k.includes(':' + CACHE_NAMESPACE + ':')));
});

test('duplicate retry has an independent lock and keeps existing search budget accounting', async () => {
  const store = new MemoryStore(); let release; const gate = new Promise(r => { release = r; });
  const f = fakeFetch(() => gate.then(() => aiReply(JSON_OUT)));
  const first = call(RETRY, { store, fetcher: f }); await new Promise(r => setTimeout(r, 30));
  const second = await call(RETRY, { store, fetcher: fakeFetch() }); assert.equal(second.statusCode, 409);
  release(); assert.equal((await first).statusCode, 200); assert.equal(f.calls.length, 1);
  assert.ok([...store.kv.keys()].some(k => k.includes(':ip:search:')));
  assert.equal([...store.kv.entries()].find(([k]) => k.includes(':budget:'))[1], 100000);
});
