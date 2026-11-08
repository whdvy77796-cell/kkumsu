// 인터넷 조사 점검: 도구 설정(검색 + 허용된 사이트만 페이지 읽기) · 결과 정리 · 캐시 · 운영/미리보기 차이 (가짜 AI·저장소)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, validateResearchInput } from '../api/research.js';
import { MemoryStore, kstDay } from '../lib/guard.mjs';
import { researchTools, normalizeResearch, researchText, researchUser, FETCH_DOMAINS, RESEARCH_SCHEMA } from '../lib/research.mjs';

const ENV = { OPENROUTER_API_KEY: 'test-key', SESSION_SECRET: 'x'.repeat(32), VERCEL: '1', VERCEL_ENV: 'preview' };
const BODY = { name: '골목국밥', address: '서울 마포구 망원로 12', store: { name: '골목국밥', address: '서울 마포구 망원로 12', category: '국밥', menu: [{ name: '얼큰 소고기국밥', price: '11,000원' }], channels: [{ type: '네이버 플레이스', url: 'https://map.naver.com/p/1' }] } };

function req({ method = 'POST', body, headers = {} } = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  const r = Readable.from(data ? [Buffer.from(data)] : []);
  r.method = method;
  r.headers = {
    host: 'www.kkumsu.com', origin: 'https://www.kkumsu.com', 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(data)), 'x-forwarded-for': '203.0.113.11', ...headers,
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
function aiReply(content, { cost = 0.18, annotations = [] } = {}) {
  return new Response(JSON.stringify({
    model: 'anthropic/claude-sonnet-5.5',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, annotations } }],
    usage: { prompt_tokens: 40000, completion_tokens: 3000, cost, server_tool_use_details: { web_search_requests: 5, tool_calls_executed: 9 } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return typeof h === 'function' ? h() : h.clone();
  };
  f.calls = calls;
  return f;
}

const RAW = {
  period: '2025년 3월~2026년 10월',
  reviewsChecked: 7,
  platforms: [
    { platform: '카카오맵', status: '확인 못 함', rating: '', reviewCount: '', checked: '', note: '자동 수집이 막혀 있어 직접 열지 않음', url: '' },
    { platform: '네이버 블로그', status: '확인함', rating: '', reviewCount: '', checked: '블로그 5편', note: '', url: 'https://m.blog.naver.com/a/1' },
    { platform: '네이버 블로그', status: '확인함', rating: '', reviewCount: '', checked: '중복', note: '', url: '' },
    { platform: '이상한 곳', status: '모름', rating: '9/5', reviewCount: '', checked: '', note: '', url: 'javascript:alert(1)' },
  ],
  themes: [
    { theme: '대기', tone: 'bad', count: 4, repeated: true, summary: '점심 대기가 길다는 글이 반복돼요.', examples: ['(블로그, 2026년 9월) 점심 30분 대기', 'b', 'c', 'd'] },
    { theme: '대기', tone: 'good', count: 1, repeated: false, summary: '중복 주제', examples: [] },
    { theme: '분위기', tone: 'great', count: '3', repeated: 'yes', summary: '노포 분위기가 좋다는 글', examples: [] },
    { theme: '없는주제', tone: 'bad', count: 1, repeated: true, summary: '버려야 함', examples: [] },
    { theme: '맛', tone: 'good', count: 5, repeated: true, summary: '', examples: [] },
  ],
  menuPrices: [{ name: '국밥', price: '11,000원', source: '블로그', date: '2026년 9월' }, { name: '', price: '1원' }],
  infoIssues: ['영업시간이 출처마다 달라요', '영업시간이 출처마다 달라요'],
  competitors: [{ name: '옆집국밥', category: '국밥', priceRange: '9,000~10,000원', note: '도보 3분' }, { name: '' }],
  area: '직장인 점심 수요가 많아요.',
  sponsored: '블로그 5편 중 1편',
  limits: ['카카오맵 리뷰 본문은 직접 읽지 않았어요.'],
  sources: [{ title: '망원 국밥 후기', url: 'https://m.blog.naver.com/a/1', platform: '네이버 블로그', date: '2026-09-02' }, { title: '나쁜 링크', url: 'ftp://x' }],
};

test('도구: 웹 검색 + 페이지 읽기는 자동 수집이 허용된 블로그·리뷰 사이트만 (카카오맵·네이버 플레이스·구글 지도 제외)', () => {
  const [search, fetchTool] = researchTools({});
  assert.equal(search.type, 'openrouter:web_search');
  assert.equal(search.parameters.engine, 'auto');
  assert.equal(search.parameters.max_uses, 6);
  assert.equal(fetchTool.type, 'openrouter:web_fetch');
  assert.equal(fetchTool.parameters.max_uses, 5);
  assert.equal(fetchTool.parameters.engine, 'exa');
  assert.deepEqual(fetchTool.parameters.allowed_domains, FETCH_DOMAINS);
  for (const d of ['place.map.kakao.com', 'map.kakao.com', 'm.place.naver.com', 'pcmap.place.naver.com', 'google.com', 'www.google.com']) {
    assert.ok(!FETCH_DOMAINS.includes(d), `${d} 는 열지 않음`);
  }
  const exa = researchTools({ MAECHUL_RESEARCH_ENGINE: 'exa' })[0];
  assert.equal(exa.parameters.engine, 'exa');
  assert.equal(exa.parameters.max_characters, 1500);
  assert.match(researchUser(BODY, new Date('2026-11-09T00:00:00+09:00')), /올해: 2026년/);
  assert.match(researchUser(BODY), /상호명: 골목국밥[\s\S]*대표 메뉴\(앞서 찾은 공개 정보\): 얼큰 소고기국밥 11,000원[\s\S]*알려진 링크: 네이버 플레이스 https:\/\/map\.naver\.com\/p\/1/);
  assert.deepEqual(RESEARCH_SCHEMA.required.sort(), Object.keys(RESEARCH_SCHEMA.properties).sort());
});

test('결과 정리: 플랫폼·주제 목록 밖 값, 중복, 잘못된 링크를 거르고 인용 링크를 출처에 더한다', () => {
  const r = normalizeResearch(RAW, [{ type: 'url_citation', url_citation: { url: 'https://www.diningcode.com/profile.php?rid=1', title: '다이닝코드' } }]);
  assert.deepEqual(r.platforms.map((p) => `${p.platform}:${p.status}`), ['카카오맵:확인 못 함', '네이버 블로그:확인함', '기타:확인 못 함']);
  assert.equal(r.platforms[2].url, null, 'javascript: 링크는 버림');
  assert.deepEqual(r.themes.map((t) => `${t.theme}:${t.tone}:${t.count}:${t.repeated}`), ['대기:bad:4:true', '분위기:mixed:3:false']);
  assert.equal(r.themes[0].examples.length, 3);
  assert.equal(r.menuPrices.length, 1);
  assert.deepEqual(r.infoIssues, ['영업시간이 출처마다 달라요']);
  assert.equal(r.competitors.length, 1);
  assert.deepEqual(r.sources.map((s) => s.url), ['https://m.blog.naver.com/a/1', 'https://www.diningcode.com/profile.php?rid=1']);
  assert.equal(r.reviewsChecked, 7);
  const text = researchText({ ...r, searchedAt: '2026-11-09T01:00:00.000Z' });
  assert.match(text, /분석 기간: 2025년 3월~2026년 10월 · 실제로 읽은 후기·글: 7개 · 협찬 글: 블로그 5편 중 1편/);
  assert.match(text, /- 카카오맵: 확인 못 함 \(자동 수집이 막혀 있어 직접 열지 않음\)/);
  assert.match(text, /- 대기 · 아쉬움 · 4개 · 반복: 점심 대기가 길다는 글이 반복돼요\./);
  assert.match(text, /주변 경쟁점: 옆집국밥\(국밥\) 9,000~10,000원 - 도보 3분/);
  assert.equal(researchText(null), '- 인터넷 조사 결과 없음');
});

test('조사 API: 상호명·주소로 조사하고 실제 비용으로 정산, 같은 가게는 3일 동안 저장한 결과를 준다', async () => {
  const store = new MemoryStore();
  const fetcher = fakeFetch([aiReply('```json\n' + JSON.stringify(RAW) + '\n```')]);
  const handler = createHandler({ env: ENV, fetcher, store });
  const r1 = res();
  await handler(req({ body: BODY }), r1);
  assert.equal(r1.statusCode, 200, r1.body);
  const out = r1.json();
  assert.equal(out.cached, false);
  assert.equal(out.searches, 5);
  assert.equal(out.toolCalls, 9);
  assert.ok(out.searchedAt);
  const sent = fetcher.calls[0].body;
  assert.equal(sent.max_tool_calls, 12);
  assert.deepEqual(sent.tools.map((x) => x.type), ['openrouter:web_search', 'openrouter:web_fetch']);
  assert.equal(sent.provider.data_collection, 'deny');
  assert.equal(store.kv.get(`maechul:v1:budget:${kstDay()}`), 180000);
  const r2 = res();
  await handler(req({ body: BODY }), r2);
  assert.equal(r2.json().cached, true);
  assert.equal(fetcher.calls.length, 1);
});

test('조사 API: 검색 엔진 바꾸기는 미리보기에서만, 주소가 없으면 거절, 형식이 깨지면 고친다', async () => {
  assert.equal(validateResearchInput({ ...BODY, engine: 'exa' }, { VERCEL_ENV: 'preview' }).engine, 'exa');
  assert.equal(validateResearchInput({ ...BODY, engine: 'exa' }, { VERCEL_ENV: 'production' }).engine, null);
  assert.equal(validateResearchInput({ ...BODY, engine: 'evil' }, {}).engine, null);
  const bad = res();
  await createHandler({ env: ENV, fetcher: fakeFetch([aiReply('{}')]), store: new MemoryStore() })(req({ body: { name: '골목국밥', address: '' } }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'ADDRESS');
  const fetcher = fakeFetch([aiReply('조사해 보니 대기가 길다는 글이 많았어요...'), aiReply(JSON.stringify(RAW), { cost: 0.003 })]);
  const r = res();
  await createHandler({ env: ENV, fetcher, store: new MemoryStore() })(req({ body: BODY }), r);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(fetcher.calls[1].body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(fetcher.calls[1].body.response_format.json_schema.name, 'store_research');
  assert.equal(fetcher.calls[1].body.tools, undefined);
});

test('조사 API: 모의 모드는 같은 형식, 운영 배포에서는 모의 모드가 꺼진다', async () => {
  const r = res();
  await createHandler({ env: { MOCK_AI: '1' }, mockDelay: 0 })(req({ body: BODY }), r);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().mock, true);
  assert.ok(r.json().platforms.length >= 3);
  const prod = res();
  await createHandler({ env: { MOCK_AI: '1', VERCEL: '1', VERCEL_ENV: 'production' }, mockDelay: 0 })(req({ body: BODY }), prod);
  assert.equal(prod.statusCode, 503, '운영에서는 모의 응답 대신 설정 오류');
});
