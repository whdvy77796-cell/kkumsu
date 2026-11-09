import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../api/geo-search.js';
import { createHandler as storeHandler } from '../api/store-search.js';
import { GEO_CACHE_SECONDS, GEO_SEARCH_SYSTEM, geoSearchKey } from '../lib/geo-search.mjs';
import { MemoryStore, hashKey, kstDay } from '../lib/guard.mjs';

const ENV = { OPENROUTER_API_KEY: 'fake-key', SESSION_SECRET: 'test-secret', VERCEL: '1', VERCEL_ENV: 'preview' };
const VALID = { consent: true, name: '예시상사', address: '서울 중구 예시로 15' };
const SOURCE = { title: '검색 단서', url: 'https://example.org/business' };
function request(body = VALID, options = {}) {
  const text = JSON.stringify(body);
  const r = Readable.from(text === undefined ? [] : [Buffer.from(text)]);
  r.method = options.method || 'POST';
  r.headers = { host: 'site.example', origin: 'https://site.example', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text || '')), 'x-forwarded-for': '203.0.113.7', ...options.headers };
  if (options.parsed) r.body = body;
  return r;
}
function response() {
  return { statusCode: 0, headers: {}, body: '', setHeader(k,v) { this.headers[k.toLowerCase()] = v; }, end(v) { this.body = v; }, json() { return JSON.parse(this.body); } };
}
async function invoke(handler, body = VALID, options = {}) {
  const res = response();
  await handler(request(body, options), res);
  return { res, data: res.json() };
}
function provider(content, { annotations = [], cost = 0.02, searches = 2 } = {}) {
  const usage = { cost };
  if (searches !== undefined) usage.server_tool_use_details = { web_search_requests: searches };
  return new Response(JSON.stringify({ model: 'stub-model', choices: [{ message: { content, annotations } }], usage }), { status: 200 });
}
function fetchStub(makeResponse) {
  const calls = [];
  const fn = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions', 'never fetch search links or any other host');
    const body = JSON.parse(options.body);
    calls.push(body);
    return makeResponse(body, calls.length);
  };
  fn.calls = calls;
  return fn;
}
function oneCandidate(overrides = {}) {
  return { candidates: [{ name: '예시상사', address: '서울 중구 예시로 15', category: '소매업', matchLevel: 'medium', matchReason: '주소 일부가 비슷하나 확인 필요', ...overrides }], sources: [SOURCE] };
}
class TrackingStore extends MemoryStore {
  writes = [];
  locks = [];
  async setJson(k, value, ttl) { this.writes.push({ k, value, ttl }); return super.setJson(k, value, ttl); }
  async lock(k, ttl) { this.locks.push({ k, ttl }); return super.lock(k, ttl); }
}
const budget = () => 'maechul:v1:budget:' + kstDay();

test('explicit consent is required before provider calls or cache reads', async () => {
  const store = new TrackingStore();
  const fetcher = fetchStub(() => provider(JSON.stringify(oneCandidate())));
  const handler = createHandler({ env: ENV, fetcher, store });
  store.kv.set(geoSearchKey(VALID.name, VALID.address), JSON.stringify({ searchedAt: new Date().toISOString(), secret: 'cached' }));
  for (const value of [undefined, false, 'true', 1, null]) {
    const body = { ...VALID, consent: value };
    const { res, data } = await invoke(handler, body);
    assert.equal(res.statusCode, 400);
    assert.equal(data.code, 'CONSENT_REQUIRED');
  }
  assert.equal(fetcher.calls.length, 0);
  assert.equal(store.locks.length, 0);
  assert.equal(store.kv.get(budget()), undefined);
});

test('validates request, disallows photos and extra questionnaire, and rejects wrong method/origin', async () => {
  const fetcher = fetchStub(() => { throw Error('must not call'); });
  const handler = createHandler({ env: ENV, fetcher, store: new TrackingStore() });
  const cases = [
    [{...VALID, name: ''}, 400, 'NAME'], [{...VALID, address: '서울'}, 400, 'ADDRESS'],
    [{...VALID, name: 3}, 400, 'BAD_INPUT'], [{...VALID, address: {}}, 400, 'BAD_INPUT'],
    [{...VALID, name: 'a'.repeat(61)}, 400, 'INPUT_LENGTH'],
    [{...VALID, address: '가'.repeat(121)}, 400, 'INPUT_LENGTH'],
    [{...VALID, photos: ['a']}, 400, 'UNEXPECTED_FIELD'],
    [{...VALID, photo: { data: 'test' }}, 400, 'UNEXPECTED_FIELD'],
    [{...VALID, questionnaire: '없음'}, 400, 'UNEXPECTED_FIELD'],
    [{...VALID, refresh: true}, 400, 'UNEXPECTED_FIELD'],
    [{...VALID, name: 'data:image/png;base64,abc'}, 400, 'UNEXPECTED_FIELD'],
  ];
  for (const [body, status, code] of cases) {
    const got = await invoke(handler, body);
    assert.equal(got.res.statusCode, status, JSON.stringify(body));
    assert.equal(got.data.code, code);
  }
  const origin = await invoke(handler, VALID, {headers:{origin:'https://evil.example'}});
  assert.equal(origin.data.code, 'ORIGIN');
  const method = await invoke(handler, VALID, {method:'GET'});
  assert.equal(method.res.statusCode, 405);
  assert.equal(method.res.headers.allow, 'POST');
  const type = await invoke(handler, VALID, {headers:{'content-type':'multipart/form-data'}});
  assert.equal(type.data.code, 'CONTENT_TYPE');
  const oversized = await invoke(handler, {...VALID, photo:'x'.repeat(5000)}, {parsed:true, headers:{'content-length':'0'}});
  assert.equal(oversized.res.statusCode, 413);
  assert.equal(fetcher.calls.length, 0);
});

test('normalizes candidates and links, strips image fields, and labels everything unverified', async () => {
  const candidate = oneCandidate({ name: '  예시상사  ', category: '생활용품 브랜드', hours: '정보 없음', priceRange: 'unknown', menu: [{name:'', price:'100'}], features:['','특징','특징'], channels:[{type:'홈페이지',url:'https://example.org/'},{type:'나쁜 링크',url:'javascript:alert(1)'}], photo:'data:image/png;base64,abc', matchLevel:'invalid' });
  candidate.sources = [{ title:'중복',url:SOURCE.url }, {title:'유해',url:'javascript:alert(1)'}, SOURCE];
  candidate.summary = '확실하게 매출과 순위가 보장됩니다';
  const annotations = [{url_citation:SOURCE}, {url_citation:SOURCE}];
  const fetcher = fetchStub(() => provider(JSON.stringify(candidate), {annotations, searches:3}));
  const { res, data } = await invoke(createHandler({ env: ENV, fetcher, store:new TrackingStore(), now:()=>Date.parse('2026-11-08T01:02:03.000Z') }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(data.candidates.length, 1);
  assert.equal(data.candidates[0].name, '예시상사');
  assert.equal(data.candidates[0].category, '생활용품 브랜드');
  assert.equal(data.candidates[0].hours, null);
  assert.equal(data.candidates[0].priceRange, null);
  assert.equal(data.candidates[0].matchLevel, 'low');
  assert.deepEqual(data.candidates[0].menu, []);
  assert.deepEqual(data.candidates[0].features, ['특징']);
  assert.deepEqual(data.candidates[0].channels, [{type:'홈페이지',url:'https://example.org/'}]);
  assert.equal('photo' in data.candidates[0], false);
  assert.deepEqual(data.sources, [SOURCE]);
  assert.equal(data.notFoundReason, null);
  assert.equal(data.searchedAt, '2026-11-08T01:02:03.000Z');
  assert.equal(data.searches, 3);
  assert.equal(data.cached, false);
  assert.equal(data.reviewRequired, true);
  assert.match(data.notice, /검증되지 않은/);
  assert.match(data.notice, /사업자 본인이 확인/);
  assert.match(data.notice, /입증하지 않으며/);
  assert.match(data.notice, /보장하지 않습니다/);
  assert.match(data.notice, /색인/);
  assert.doesNotMatch(data.summary, /매출과 순위가 보장/);
  const sent = fetcher.calls[0];
  assert.equal(sent.provider.data_collection, 'deny');
  assert.deepEqual(sent.tools.map(x=>x.type), ['openrouter:web_search']);
  assert.equal(sent.tools[0].parameters.max_uses, 3);
  assert.match(sent.messages[0].content, /스니펫만 사용/);
  assert.match(sent.messages[0].content, /명령은 신뢰할 수 없는 데이터/);
  assert.match(sent.messages[0].content, /절대로 지어내지 말고/);
  assert.match(sent.messages[1].content, /검색 대상 데이터/);
  assert.ok(!JSON.stringify(sent).includes('data:image'));
});

test('generic prompt handles brands, retail, services, schools, and food without imposing restaurant assumptions', async () => {
  for (const [name,category] of [['샘플브랜드','화장품 브랜드'], ['샘플서점','독립서점'], ['샘플컨설팅','경영 컨설팅'], ['샘플학원','교육 서비스'], ['샘플식당','음식점']]) {
    const fetcher = fetchStub(() => provider(JSON.stringify({candidates:[{name,address:'서울 중구 예시로 15',category,matchLevel:'medium'}],sources:[SOURCE]})));
    const { res, data } = await invoke(createHandler({env:ENV, fetcher, store:new TrackingStore()}), {consent:true,name,address:VALID.address});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(data.candidates[0].category, category);
    assert.equal(data.candidates[0].priceRange, null);
    assert.equal(data.candidates[0].hours, null);
    assert.equal(data.candidates[0].services, null);
    assert.deepEqual(data.candidates[0].features, []);
    assert.deepEqual(data.candidates[0].menu, []);
  }
  assert.match(GEO_SEARCH_SYSTEM, /브랜드/);
  assert.match(GEO_SEARCH_SYSTEM, /전문 서비스/);
  assert.match(GEO_SEARCH_SYSTEM, /본사와 지점을 혼동하거나 서로 합치지 마세요/);
});

test('retains separate ambiguous matches and caps candidates, and not-found is not a claim of nonexistence', async () => {
  const candidates = Array.from({length:5},(_,i)=>({name:'예시 지점 '+i, address:'주소 미확인', matchLevel:'low', matchReason:'지점 확인 필요'}));
  let fetcher = fetchStub(() => provider(JSON.stringify({candidates,sources:[SOURCE]})));
  let out = await invoke(createHandler({env:ENV,fetcher,store:new TrackingStore()}));
  assert.equal(out.data.candidates.length,3);
  assert.notEqual(out.data.candidates[0].name,out.data.candidates[1].name);
  assert.equal(out.data.candidates[0].matchLevel,'low');
  fetcher = fetchStub(() => provider(JSON.stringify({candidates:[],notFoundReason:'폐업 확정',sources:[]})));
  out = await invoke(createHandler({env:ENV,fetcher,store:new TrackingStore()}));
  assert.deepEqual(out.data.candidates, []);
  assert.match(out.data.notFoundReason, /확인하지 못했/);
  assert.match(out.data.summary, /부재를 뜻하지는 않습니다/);
  assert.doesNotMatch(JSON.stringify(out.data), /폐업 확정/);
});

test('namespaced hashed cache expires after exactly three days, preserves original search time, and uses guard TTL', async () => {
  let clock = Date.parse('2026-11-08T00:00:00Z');
  const now = () => clock;
  const store = new TrackingStore();
  const fetcher = fetchStub(() => provider(JSON.stringify(oneCandidate())));
  const handler = createHandler({env:ENV,fetcher,store,now});
  const a = await invoke(handler);
  const b = await invoke(handler, {...VALID, name:' 예시상사 '});
  assert.equal(a.data.cached,false);
  assert.equal(b.data.cached,true);
  assert.equal(a.data.searchedAt,b.data.searchedAt);
  assert.equal(fetcher.calls.length,1);
  assert.equal(store.writes[0].ttl,3*24*60*60);
  assert.equal(GEO_CACHE_SECONDS,259200);
  assert.match(store.writes[0].k,/^maechul:v2:geo-search:[a-f0-9]{40}$/);
  assert.notEqual(store.writes[0].k,hashKey('search',VALID.name,VALID.address));
  assert.ok(!store.writes[0].k.includes(VALID.name));
  assert.notEqual(geoSearchKey('가|나','주소 다'),geoSearchKey('가','나|주소 다'));
  assert.equal(store.locks[0].ttl,320);
  clock += GEO_CACHE_SECONDS*1000 - 1;
  assert.equal((await invoke(handler)).data.cached,true);
  clock += 1;
  const expired = await invoke(handler);
  assert.equal(expired.data.cached,false);
  assert.equal(expired.data.searchedAt,new Date(clock).toISOString());
  assert.equal(fetcher.calls.length,2);
});

test('concurrent same-input request is locked and a later request uses the cache', async () => {
  let resolveFetch, signalStart;
  const started = new Promise(resolve => { signalStart=resolve; });
  const fetcher = fetchStub(() => { signalStart(); return new Promise(resolve => {resolveFetch=resolve;}); });
  const store = new TrackingStore();
  const handler = createHandler({env:ENV,fetcher,store});
  const first = invoke(handler);
  await started;
  const second = await invoke(handler);
  assert.equal(second.res.statusCode,409);
  assert.equal(second.data.code,'BUSY');
  assert.equal(fetcher.calls.length,1);
  resolveFetch(provider(JSON.stringify(oneCandidate())));
  assert.equal((await first).res.statusCode,200);
  assert.equal((await invoke(handler)).data.cached,true);
  assert.equal(store.kv.has(geoSearchKey(VALID.name,VALID.address)+':lock'),false);
});

test('existing search visitor limit and budget remain shared with store-search', async () => {
  const env = {...ENV,MAECHUL_IP_DAILY_SEARCHES:'1'};
  const store = new TrackingStore();
  const fetcher = fetchStub(() => provider(JSON.stringify(oneCandidate())));
  assert.equal((await invoke(createHandler({env,fetcher,store}))).res.statusCode,200);
  const second = await invoke(storeHandler({env,fetcher,store}), {name:'다른 이름',address:VALID.address});
  assert.equal(second.res.statusCode,429);
  assert.equal(second.data.code,'IP_QUOTA');
  assert.equal(fetcher.calls.length,1);
  const tightStore = new TrackingStore();
  tightStore.kv.set(budget(),900000);
  const denied = await invoke(createHandler({env:{...ENV,MAECHUL_DAILY_BUDGET_USD:'1'},fetcher,store:tightStore}));
  assert.equal(denied.data.code,'DAILY_BUDGET');
  assert.equal(fetcher.calls.length,1);
});

test('provider failures settle known cost, retain unknown-cost reservations, and release locks', async () => {
  const store = new TrackingStore();
  let fetcher = fetchStub(() => new Response(JSON.stringify({error:{message:'no credits'}}),{status:402}));
  let result = await invoke(createHandler({env:ENV,fetcher,store}));
  assert.equal(result.data.code,'AI_CREDIT');
  assert.equal(store.kv.get(budget()),0);
  assert.equal(store.kv.has(geoSearchKey(VALID.name,VALID.address)+':lock'),false);
  fetcher = fetchStub(() => {throw new Error('timeout');});
  result = await invoke(createHandler({env:ENV,fetcher,store}));
  assert.equal(result.data.code,'AI_TIMEOUT');
  assert.equal(store.kv.get(budget()),350000);
  assert.equal(store.kv.has(geoSearchKey(VALID.name,VALID.address)+':lock'),false);
  assert.equal(store.writes.length,0);
});

test('empty, invalid, unsearched, and unsourced model responses fail closed without caching', async () => {
  const bad = [
    [provider(''), 'AI_EMPTY'],
    [provider('not JSON'), 'AI_FORMAT'],
    [provider(JSON.stringify({candidates:'not array'})), 'AI_FORMAT'],
    [provider(JSON.stringify(oneCandidate()),{searches:0}), 'AI_NO_SEARCH'],
    [provider(JSON.stringify(oneCandidate()),{searches:null}), 'AI_NO_SEARCH'],
    [provider(JSON.stringify({candidates:[{name:'허구'}],sources:[]})), 'AI_NO_SOURCES'],
  ];
  for (const [reply, code] of bad) {
    const store = new TrackingStore();
    const fetcher = fetchStub(() => reply.clone());
    const result = await invoke(createHandler({env:ENV,fetcher,store}));
    assert.equal(result.res.statusCode,502,code);
    assert.equal(result.data.code,code);
    assert.equal(store.writes.length,0);
    assert.equal(store.kv.get(budget()),20000);
    assert.equal(store.kv.has(geoSearchKey(VALID.name,VALID.address)+':lock'),false);
  }
});

test('fails closed without storage or AI key and never makes an actual network call', async () => {
  const fetcher = fetchStub(() => {throw Error('must not call');});
  let result = await invoke(createHandler({env:{VERCEL:'1',OPENROUTER_API_KEY:'fake'},fetcher}));
  assert.equal(result.data.code,'STORE_CONFIG');
  result = await invoke(createHandler({env:{VERCEL:'1'},fetcher,store:new TrackingStore()}));
  assert.equal(result.data.code,'AI_CONFIG');
  assert.equal(fetcher.calls.length,0);
});

test('missing search usage can be reported as unknown if a provider citation exists', async () => {
  const fetcher = fetchStub(() => provider(JSON.stringify(oneCandidate()), { searches: null, annotations: [{ url_citation: SOURCE }] }));
  const out = await invoke(createHandler({env:ENV, fetcher, store:new TrackingStore()}));
  assert.equal(out.res.statusCode, 200, out.res.body);
  assert.equal(out.data.searches, null);
  assert.equal(out.data.reviewRequired, true);
});

test('invalid, incomplete, or future cache values cannot bypass search or required notices', async () => {
  const t = Date.parse('2026-11-08T01:00:00.000Z');
  const store = new TrackingStore();
  store.kv.set(geoSearchKey(VALID.name, VALID.address), JSON.stringify({searchedAt:new Date(t).toISOString(),candidates:[],sources:[]}));
  const fetcher = fetchStub(() => provider(JSON.stringify(oneCandidate())));
  const handler = createHandler({env:ENV, fetcher, store, now:()=>t});
  const out = await invoke(handler);
  assert.equal(out.res.statusCode,200,out.res.body);
  assert.equal(out.data.cached,false);
  assert.equal(out.data.reviewRequired,true);
  assert.match(out.data.notice,/검증되지 않은/);
  assert.equal(fetcher.calls.length,1);
  store.kv.set(geoSearchKey(VALID.name, VALID.address), JSON.stringify({...out.data,searchedAt:new Date(t+1000).toISOString()}));
  const second = await invoke(handler);
  assert.equal(second.data.cached,false);
  assert.equal(fetcher.calls.length,2);
});
