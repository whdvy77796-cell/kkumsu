// 서버 함수 점검: 실제 AI·Redis 대신 가짜 응답으로 확인한다. 실행: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler as searchHandler, searchTool } from '../api/store-search.js';
import { createHandler as surveyHandler } from '../api/survey.js';
import { MemoryStore, RedisStore, RESERVE_LUA, kstDay } from '../lib/guard.mjs';
import { extractJson, costMicro } from '../lib/ai.mjs';

const ENV = { OPENROUTER_API_KEY: 'test-key', SESSION_SECRET: 'x'.repeat(32), VERCEL: '1', VERCEL_ENV: 'preview' };

function req({ method = 'POST', body, headers = {} } = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  const r = Readable.from(data ? [Buffer.from(data)] : []);
  r.method = method;
  r.headers = {
    host: 'www.kkumsu.com',
    origin: 'https://www.kkumsu.com',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(data)),
    'x-forwarded-for': '203.0.113.7',
    ...headers,
  };
  return r;
}
function res() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b || ''; },
    json() { return JSON.parse(this.body); },
  };
}

const STORE_JSON = {
  candidates: [{
    name: '골목분식', address: '서울 마포구 망원로 12', category: '분식', phone: '02-123-4567', hours: '11:00~21:00',
    priceRange: null, rating: '네이버 4.5', reviewCount: 'null', menu: [{ name: '떡볶이', price: '5,000원' }, { name: '', price: null }],
    strengths: ['양념이 맛있다', '양념이 맛있다'], weaknesses: ['대기가 길다'], features: [],
    channels: [{ type: '네이버 플레이스', url: 'https://map.naver.com/p/1' }, { type: '이상한 링크', url: 'javascript:alert(1)' }],
    matchLevel: 'high', matchReason: '주소가 같아요',
  }],
  summary: '망원동 분식집', notFoundReason: null,
  sources: [
    { title: '중복 링크', url: 'https://blog.naver.com/a' },
    { title: '다이닝코드', url: 'https://www.diningcode.com/profile.php?rid=1' },
    { title: '잘못된 링크', url: 'ftp://example.com/x' },
  ],
};

function aiReply(content, { cost = 0.12, annotations = [], status = 200, searches = 2 } = {}) {
  return new Response(JSON.stringify({
    model: 'anthropic/claude-sonnet-5.5',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, annotations } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, cost, server_tool_use_details: { web_search_requests: searches } },
  }), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return typeof h === 'function' ? h(url, body) : h.clone(); // 응답 본문은 한 번만 읽힌다
  };
  f.calls = calls;
  return f;
}

const budgetKey = () => `maechul:v1:budget:${kstDay()}`;

test('가게 찾기: Claude 웹 검색 결과를 정리하고 실제 비용으로 정산한 뒤 캐시한다', async () => {
  const store = new MemoryStore();
  const fetcher = fakeFetch([aiReply('```json\n' + JSON.stringify(STORE_JSON) + '\n```', {
    annotations: [
      { type: 'url_citation', url_citation: { url: 'https://blog.naver.com/a', title: '망원동 골목분식 후기' } },
      { type: 'url_citation', url_citation: { url: 'https://blog.naver.com/a', title: '중복' } },
    ],
  })]);
  const handler = searchHandler({ env: ENV, fetcher, store });
  const r1 = res();
  await handler(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12' } }), r1);
  assert.equal(r1.statusCode, 200, r1.body);
  const out = r1.json();
  assert.equal(out.candidates.length, 1);
  const c = out.candidates[0];
  assert.equal(c.reviewCount, null, '"null" 글자는 빈 값으로');
  assert.equal(c.priceRange, null);
  assert.deepEqual(c.menu, [{ name: '떡볶이', price: '5,000원' }]);
  assert.deepEqual(c.strengths, ['양념이 맛있다']);
  assert.equal(c.channels.length, 1, 'javascript: 링크는 버린다');
  assert.deepEqual(out.sources, [
    { title: '망원동 골목분식 후기', url: 'https://blog.naver.com/a' },
    { title: '다이닝코드', url: 'https://www.diningcode.com/profile.php?rid=1' },
  ], '인용 링크 먼저, 모델이 적은 출처는 중복·잘못된 주소를 빼고 뒤에');
  assert.equal(out.cached, false);
  assert.equal(out.searches, 2);

  const sent = fetcher.calls[0].body;
  assert.equal(sent.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(sent.tools[0].type, 'openrouter:web_search');
  assert.equal(sent.tools[0].parameters.max_uses, 3);
  assert.equal(sent.provider.data_collection, 'deny');
  assert.match(sent.messages[1].content, /골목분식/);

  assert.equal(store.kv.get(budgetKey()), 120000, '예약액이 실제 비용($0.12)으로 정산됨');

  const r2 = res();
  await handler(req({ body: { name: ' 골목분식 ', address: '서울 마포구 망원로 12' } }), r2);
  assert.equal(r2.json().cached, true);
  assert.equal(fetcher.calls.length, 1, '같은 가게는 다시 AI를 부르지 않는다');

  const r3 = res();
  await handler(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12', refresh: true } }), r3);
  assert.equal(r3.json().cached, false);
  assert.equal(fetcher.calls.length, 2, '다시 찾기를 요청하면 새로 검색한다');
});

test('가게 찾기: JSON이 깨지면 저렴한 모델로 형식만 다시 맞춘다', async () => {
  const store = new MemoryStore();
  const fetcher = fakeFetch([
    aiReply('찾아본 결과 골목분식은 망원동에 있는 분식집입니다. 떡볶이가 유명합니다.', { cost: 0.1 }),
    aiReply(JSON.stringify(STORE_JSON), { cost: 0.001, searches: 0 }),
  ]);
  const r = res();
  await searchHandler({ env: ENV, fetcher, store })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12' } }), r);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().candidates[0].name, '골목분식');
  assert.equal(fetcher.calls[1].body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(fetcher.calls[1].body.response_format.type, 'json_schema');
  assert.equal(fetcher.calls[1].body.tools, undefined, '형식 맞추기에는 검색을 쓰지 않는다');
  assert.equal(store.kv.get(budgetKey()), 101000);
});

test('가게 찾기: 못 찾은 경우 이유를 돌려준다', async () => {
  const fetcher = fakeFetch([aiReply(JSON.stringify({ candidates: [], summary: '', notFoundReason: '검색 결과가 없어요' }))]);
  const r = res();
  await searchHandler({ env: ENV, fetcher, store: new MemoryStore() })(req({ body: { name: '없는가게', address: '서울 어딘가 1' } }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().candidates, []);
  assert.equal(r.json().notFoundReason, '검색 결과가 없어요');
});

test('가게 찾기: 다른 사이트 요청·잘못된 입력·잘못된 방식은 거절한다', async () => {
  const fetcher = fakeFetch([aiReply('{}')]);
  const handler = searchHandler({ env: ENV, fetcher, store: new MemoryStore() });
  let r = res();
  await handler(req({ body: { name: '가', address: '서울 마포구' }, headers: { origin: 'https://evil.example' } }), r);
  assert.equal(r.statusCode, 403);
  r = res();
  await handler(req({ body: { name: '가', address: '서울 마포구' }, headers: { origin: undefined } }), r);
  assert.equal(r.statusCode, 403);
  r = res();
  await handler(req({ body: { name: '', address: '서울 마포구' } }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().code, 'NAME');
  r = res();
  await handler(req({ body: { name: '골목분식', address: '서울' } }), r);
  assert.equal(r.json().code, 'ADDRESS');
  r = res();
  await handler(req({ method: 'PUT', body: {} }), r);
  assert.equal(r.statusCode, 405);
  assert.equal(fetcher.calls.length, 0, '거절한 요청은 AI를 부르지 않는다');
});

test('가게 찾기: 방문자별 하루 횟수를 넘으면 429', async () => {
  const store = new MemoryStore();
  const fetcher = fakeFetch([aiReply(JSON.stringify(STORE_JSON), { cost: 0.01 })]);
  const handler = searchHandler({ env: { ...ENV, MAECHUL_IP_DAILY_SEARCHES: '2' }, fetcher, store });
  for (let i = 0; i < 2; i++) {
    const r = res();
    await handler(req({ body: { name: `가게${i}`, address: '서울 마포구 망원로 1' } }), r);
    assert.equal(r.statusCode, 200);
  }
  const r = res();
  await handler(req({ body: { name: '가게9', address: '서울 마포구 망원로 1' } }), r);
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().code, 'IP_QUOTA');
  const other = res();
  await handler(req({ body: { name: '가게9', address: '서울 마포구 망원로 1' }, headers: { 'x-forwarded-for': '198.51.100.1' } }), other);
  assert.equal(other.statusCode, 200, '다른 방문자는 계속 이용 가능');
});

test('가게 찾기: 하루 전체 예산을 넘으면 AI를 부르지 않는다', async () => {
  const store = new MemoryStore();
  store.kv.set(budgetKey(), 900000);
  const fetcher = fakeFetch([aiReply(JSON.stringify(STORE_JSON))]);
  const r = res();
  await searchHandler({ env: { ...ENV, MAECHUL_DAILY_BUDGET_USD: '1' }, fetcher, store })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12' } }), r);
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().code, 'DAILY_BUDGET');
  assert.equal(fetcher.calls.length, 0);
});

test('가게 찾기: 제공자 오류는 예약을 돌려주고, 시간 초과는 예약을 남긴다', async () => {
  const store = new MemoryStore();
  const credit = fakeFetch([new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 })]);
  let r = res();
  await searchHandler({ env: ENV, fetcher: credit, store })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12' } }), r);
  assert.equal(r.json().code, 'AI_CREDIT');
  assert.equal(store.kv.get(budgetKey()), 0, '청구되지 않은 실패는 예약을 돌려준다');

  const timeout = fakeFetch([async () => { throw new DOMException('timeout', 'TimeoutError'); }]);
  r = res();
  await searchHandler({ env: ENV, fetcher: timeout, store })(req({ body: { name: '골목분식2', address: '서울 마포구 망원로 12' } }), r);
  assert.equal(r.statusCode, 504);
  assert.equal(store.kv.get(budgetKey()), 350000, '청구 여부를 모르면 예약액을 그대로 둔다');
});

test('배포 환경에서 이용량 저장소나 키가 없으면 AI를 부르지 않는다', async () => {
  const fetcher = fakeFetch([aiReply(JSON.stringify(STORE_JSON))]);
  let r = res();
  await searchHandler({ env: { OPENROUTER_API_KEY: 'k', VERCEL: '1', VERCEL_ENV: 'production' }, fetcher })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12' } }), r);
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, 'STORE_CONFIG');
  r = res();
  await searchHandler({ env: { VERCEL: '1' }, fetcher, store: new MemoryStore() })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12' } }), r);
  assert.equal(r.json().code, 'AI_CONFIG');
  assert.equal(fetcher.calls.length, 0);
});

test('상태 확인(GET)은 비밀값 없이 준비 여부만 알려준다', async () => {
  const r = res();
  await searchHandler({ env: { ...ENV, KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 't' } })(req({ method: 'GET' }), r);
  const s = r.json();
  assert.equal(s.ai, true);
  assert.equal(s.store, true);
  assert.ok(!r.body.includes('test-key'));
});

test('맞춤 설문: 10문항을 만들고 중복·빈 문항을 정리한다', async () => {
  const qs = Array.from({ length: 11 }, (_, i) => ({ text: i === 3 ? '' : `점심시간에 손님이 몰린다 ${i}`, area: '손님', why: '리뷰에 대기 이야기가 있어요' }));
  qs.push({ text: '점심시간에 손님이 몰린다 0', area: '중복', why: '' });
  const store = new MemoryStore();
  const fetcher = fakeFetch([aiReply(JSON.stringify({ insights: [{ title: '대기', detail: '점심 대기 후기가 많아요' }], questions: qs }), { cost: 0.02, searches: 0 })]);
  const handler = surveyHandler({ env: ENV, fetcher, store });
  const r = res();
  await handler(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12', store: STORE_JSON.candidates[0] } }), r);
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.equal(out.questions.length, 10);
  assert.deepEqual(out.questions.map((q) => q.id), Array.from({ length: 10 }, (_, i) => `q${i + 1}`));
  assert.equal(new Set(out.questions.map((q) => q.text)).size, 10);
  const sent = fetcher.calls[0].body;
  assert.equal(sent.response_format.json_schema.name, 'store_survey');
  assert.equal(sent.tools, undefined, '설문 만들기에는 검색을 쓰지 않는다');
  assert.match(sent.messages[1].content, /골목분식/);
  assert.equal(store.kv.get(budgetKey()), 20000);

  const again = res();
  await handler(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12', store: STORE_JSON.candidates[0] } }), again);
  assert.equal(again.json().cached, true);
  assert.equal(fetcher.calls.length, 1);
});

test('맞춤 설문: 문항이 너무 적으면 실패로 알리고, 가게 정보 없이도 만들 수 있다', async () => {
  const few = fakeFetch([aiReply(JSON.stringify({ insights: [], questions: [{ text: '하나', area: 'a', why: '' }] }))]);
  let r = res();
  await surveyHandler({ env: ENV, fetcher: few, store: new MemoryStore() })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12', store: STORE_JSON.candidates[0] } }), r);
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().code, 'SURVEY_SHORT');

  const ten = Array.from({ length: 10 }, (_, i) => ({ text: `문장 ${i}`, area: 'a', why: 'b' }));
  const ok = fakeFetch([aiReply(JSON.stringify({ insights: [], questions: ten }))]);
  r = res();
  await surveyHandler({ env: ENV, fetcher: ok, store: new MemoryStore() })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12', store: null } }), r);
  assert.equal(r.statusCode, 200, r.body);
  assert.match(ok.calls[0].body.messages[1].content, /공개 정보를 찾지 못했습니다/);
});

test('모의 모드(MOCK_AI=1)는 로컬에서 키 없이 동작하고 운영 배포에서는 꺼진다', async () => {
  let r = res();
  await searchHandler({ env: { MOCK_AI: '1' }, mockDelay: 0 })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12' }, headers: { host: 'localhost:5180', origin: 'http://localhost:5180' } }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().mock, true);
  r = res();
  await surveyHandler({ env: { MOCK_AI: '1' }, mockDelay: 0 })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12', store: null } }), r);
  assert.equal(r.json().questions.length, 10);
  r = res();
  await searchHandler({ env: { MOCK_AI: '1', VERCEL: '1', VERCEL_ENV: 'production' }, mockDelay: 0 })(req({ body: { name: '골목분식', address: '서울 마포구 망원로 12' } }), r);
  assert.equal(r.statusCode, 503, '운영에서는 모의 응답을 쓰지 않는다');
});

test('Redis 저장소는 예약 스크립트와 정산 명령을 Upstash REST 형식으로 보낸다', async () => {
  const sent = [];
  const fetcher = async (url, opts) => {
    sent.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    const cmd = JSON.parse(opts.body)[0];
    const result = cmd === 'EVAL' ? ['ok', '350000', '1'] : cmd === 'GET' ? null : 'OK';
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  const st = new RedisStore('https://kv.example/', 'tok', fetcher);
  const r = await st.reserve({ budgetKey: 'b', ipKey: 'i', estimate: 350000, budget: 1000000, ipLimit: 4, ttl: 172800 });
  assert.deepEqual(r, { status: 'ok', spent: 350000, count: 1 });
  assert.equal(sent[0].url, 'https://kv.example');
  assert.equal(sent[0].auth, 'Bearer tok');
  assert.deepEqual(sent[0].body.slice(0, 5), ['EVAL', RESERVE_LUA, '2', 'b', 'i']);
  await st.adjust('b', -230000);
  assert.deepEqual(sent[1].body, ['INCRBY', 'b', '-230000']);
  assert.equal(await st.getJson('x'), null);
});

test('도우미: JSON 꺼내기, 비용 계산, 검색 도구 설정', () => {
  assert.deepEqual(extractJson('결과입니다:\n{"a":1}\n감사합니다'), { a: 1 });
  assert.equal(extractJson('없음'), null);
  assert.equal(costMicro('anthropic/claude-sonnet-5.5', { cost: 0.0123 }), 12300);
  assert.equal(costMicro('anthropic/claude-sonnet-5.5', { prompt_tokens: 10000, completion_tokens: 1000, server_tool_use_details: { web_search_requests: 2 } }), 50000);
  assert.equal(searchTool({}).parameters.engine, 'auto');
  assert.equal(searchTool({ MAECHUL_SEARCH_ENGINE: 'exa' }).parameters.max_characters, 2000);
});
