// AI 진단 보고서 점검: 서버 계산 · 입력 검사 · AI 응답 정리 · 캐시·잠금·한도 (실제 AI·Redis 대신 가짜 응답)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../api/report.js';
import { researchKey } from '../api/research.js';
import { normalizeResearch } from '../lib/research.mjs';
import { MemoryStore, kstDay } from '../lib/guard.mjs';
import { computeMetrics, MIN_WAGE } from '../lib/report-calc.mjs';
import { validateReportInput, buildReportInput, normalizeReport, REPORT_SCHEMA } from '../lib/report.mjs';

const ENV = { OPENROUTER_API_KEY: 'test-key', SESSION_SECRET: 'x'.repeat(32), VERCEL: '1', VERCEL_ENV: 'preview' };
const ok = (v) => ({ s: 'ok', v });

const ANSWERS = {
  a_basic: ok({ category: '국밥·탕·찌개', period: '3~5년' }),
  a_split: ok({ hall: { on: true, pct: '60' }, takeout: { on: true, pct: '10' }, delivery: { on: true, pct: '30' } }),
  a_staff: ok({ staff: '2', owner: '12', family: '4' }),
  a_problem: ok({ value: 'profit', detail: '바쁜데 남는 게 없어요' }),
  a_budget: ok({ money: '30만 원 이하', time: '1~3시간' }),
  b_know: ok('exact'),
  b_sales: ok([{ sales: '2400', days: '26' }, { sales: '2300', days: '25' }, { sales: '2200', days: '26' }]),
  b_channel_sales: ok({ hall: '1400', takeout: '250', delivery: '750', basis: '정산 입금액 (수수료 뺀 뒤)' }),
  b_costs: ok({ food: '1000', labor: '400', pack: '60', rent: '250', util: '80', fee: '150', mkt: '30', supply: '20', etc: '10' }),
  b_records: ok({ data: 'POS 매출 자료가 있어요', stock: '기록하지 않아요' }),
  c_menus: ok([{ name: '얼큰 소고기국밥', price: '11000', qty: '1200' }, { name: '수육', price: '25000', qty: '200' }, { name: '', price: '', qty: '' }]),
  c_cost: ok({ know: 'known', amount: '4800', includes: ['반찬'] }),
  m_unit: ok({ order: '23000', food: '9000', pack: '800', fee: '3000', rider: '3000', coupon: '1000' }),
  s_manners: ok({ mealWhen: '영업 중 틈틈이', mealWhere: '손님 좌석·홀', seen: '가끔 있어요', cleanDuring: ['손님 있을 땐 안 해요'] }),
};
const STORE = { name: '골목국밥', address: '서울 마포구 망원로 12', category: '국밥', menu: [{ name: '얼큰 소고기국밥', price: '11,000원' }], weaknesses: ['점심 대기가 길다'] };
const BODY = { name: '골목국밥', address: '서울 마포구 망원로 12', store: STORE, answers: ANSWERS };

const metric = (list, label) => list.find((m) => m.label === label);

test('계산: 매출·비용·이익 세 가지를 나누고, 수수료 두 번 빼기와 재고 기록을 알려준다', () => {
  const { metrics, cautions, bench } = computeMetrics({ answers: ANSWERS }, STORE);
  assert.equal(metric(metrics, '지난달 매출').value, '2,400만 원');
  assert.equal(metric(metrics, '영업일당 매출').value, '92.3만 원');
  assert.equal(metric(metrics, '3달 전보다 지난달 매출').value, '+9.1%');
  assert.equal(metric(metrics, '지난달 비용 합계').value, '2,000만 원');
  const profit = metric(metrics, '추정 영업이익');
  assert.equal(profit.value, '400만 원');
  assert.equal(profit.kind, '추정');
  assert.match(profit.note, /재고 기록이 없어 식재료는 구매액 기준/);
  assert.equal(metric(metrics, '매출 대비 식재료비').value, '41.7%');
  assert.equal(metric(metrics, '사장님·가족 한 달 일한 시간').value, '416시간');
  assert.equal(metric(metrics, '사장님·가족 노동비 (최저임금 기준)').value, '429만 원');
  assert.equal(MIN_WAGE.won, 10320);
  assert.equal(metric(metrics, '사장님 노동비를 반영한 이익').value, '-29.3만 원');
  assert.equal(metric(metrics, '사장님·가족 1시간당 남는 돈').value, '9,615원');
  assert.equal(metric(metrics, '판매 방식 비중').value, '홀 60% · 포장 10% · 배달 30%');
  assert.equal(metric(metrics, '얼큰 소고기국밥 지난달 매출').value, '1,320만 원');
  assert.match(metric(metrics, '얼큰 소고기국밥 지난달 매출').note, /전체 매출의 55%/);
  assert.equal(metric(metrics, '얼큰 소고기국밥 재료비 비율').value, '43.6%');
  assert.equal(metric(metrics, '얼큰 소고기국밥 1개 팔면 남는 금액').value, '6,200원');
  assert.equal(metric(metrics, '배달 1건 남는 금액').value, '6,200원');
  assert.ok(cautions.some((x) => /두 번 빠진/.test(x)), '배달 수수료 두 번 빼기 경고');
  assert.ok(cautions.some((x) => /현금 흐름은 계산하지 않았어요/.test(x)));
  assert.equal(bench.name, '한식');
  assert.ok(metrics.every((m) => m.label && m.value && ['답변', '계산', '추정'].includes(m.kind)));
  // 걱정 메뉴가 대표 메뉴 3개 중 하나면 두 번 계산하지 않는다
  const worry = computeMetrics({ answers: { ...ANSWERS, c_worry: ok([{ name: '수육', price: '25000' }]), c_cost_more: ok({ m2: '9000', worry: '9000' }) } }, STORE).metrics;
  assert.equal(metric(worry, '수육 1개 팔면 남는 금액').value, '16,000원');
  assert.ok(!worry.some((m) => m.label.includes('(걱정 메뉴)')));
});

test('계산: 비용을 모르면 이익을 계산하지 않고, 이상한 값은 버린다', () => {
  const { metrics, cautions } = computeMetrics({ answers: { ...ANSWERS, b_know: ok('unknown') } }, null);
  assert.ok(!metric(metrics, '추정 영업이익') && !metric(metrics, '지난달 매출'));
  assert.ok(cautions.some((x) => /잘 모른다고/.test(x)));
  assert.ok(metric(metrics, '얼큰 소고기국밥 1개 팔면 남는 금액'), '메뉴 계산은 그대로');
  const odd = computeMetrics({ answers: { ...ANSWERS, a_staff: ok({ owner: '30' }), b_sales: { s: 'unknown', v: null } } }, null);
  assert.ok(!metric(odd.metrics, '사장님·가족 한 달 일한 시간'), '하루 24시간 넘는 값은 버림');
  assert.ok(!metric(odd.metrics, '추정 영업이익'), '매출을 모르면 이익 없음');
});

test('입력 검사: 모르는 질문은 버리고, 답이 부족하면 거절한다', () => {
  const v = validateReportInput({ ...BODY, answers: { ...ANSWERS, hack: ok('x'), c_menus: ok([{ name: '가'.repeat(900), price: '1' }]) } });
  assert.ok(!v.answers.hack);
  assert.equal(v.answers.c_menus.v[0].name.length, 400);
  assert.equal(v.store.name, '골목국밥');
  assert.throws(() => validateReportInput({ ...BODY, name: '' }), (e) => e.code === 'NAME');
  assert.throws(() => validateReportInput({ ...BODY, answers: { a_problem: ok('profit') } }), (e) => e.code === 'ANSWERS');
  const { a_problem, ...noProblem } = ANSWERS;
  assert.throws(() => validateReportInput({ ...BODY, answers: noProblem }), (e) => e.code === 'ANSWERS');
  // 고민을 바꾸기 전에 답한 마케팅 비용처럼, 지금 보이지 않는 질문의 답은 뺀다
  const hidden = validateReportInput({ ...BODY, answers: { ...ANSWERS, e_spend: ok({ insta: '50' }) } });
  assert.ok(!hidden.answers.e_spend, '이익 고민일 때 마케팅 비용 질문은 안 보임');
  assert.ok(!computeMetrics({ answers: hidden.answers }, null).metrics.some((m) => m.label === '한 달 마케팅 비용'));
  const shown = validateReportInput({ ...BODY, answers: { ...ANSWERS, a_problem: ok('acquisition'), e_spend: ok({ insta: '50' }) } });
  assert.ok(shown.answers.e_spend, '손님 부족 고민이면 남김');
});

test('AI에게 보낼 자료: 메뉴 이름이 들어간 질문, 계산값, 참고 통계, 사장님 기준 처방이 모두 들어간다', () => {
  const input = validateReportInput(BODY);
  const text = buildReportInput(input, computeMetrics({ answers: input.answers }, input.store));
  assert.match(text, /가장 큰 고민: 팔아도 남는 게 적어요/);
  assert.match(text, /얼큰 소고기국밥/);
  assert.match(text, /- 추정 영업이익: 400만 원 \(추정/);
  assert.match(text, /\[참고 통계\] 농림축산식품부 2025 외식업체 경영실태 조사/);
  assert.match(text, /\[우선 개선\] 손님이 보는 곳에서 식사하지 마세요\./);
  assert.ok(!/undefined|\[object Object\]/.test(text), text.match(/.*(undefined|\[object Object\]).*/)?.[0]);
});

const AI_REPORT = {
  oneLine: '바쁘게 팔지만 사장님 노동을 빼면 남는 게 거의 없어요.',
  situation: '팔아도 남지 않음',
  keyMetricLabels: ['추정 영업이익', '없는 라벨', '사장님 노동비를 반영한 이익'],
  topProblem: { title: '사장님·가족 노동에 기대 이익을 내고 있어요.', evidence: ['[계산] 사장님 노동비를 반영한 이익 -29.3만 원'] },
  firstAction: { title: '배달 수수료가 두 번 빠졌는지 확인하세요.', how: '정산서와 비용 장부를 나란히 놓고 봐요.' },
  urgent: [],
  analysis: { profit: '추정 영업이익은 400만 원이에요.', menu: '국밥 1그릇에 6,200원이 남아요.', customer: '대기가 길다는 공개 정보가 있어요.', connection: '바쁜 시간 운영이 이익과 이어져요.' },
  solutions: [
    { priority: '이번 주 실행', area: '운영', title: '바쁜 시간 역할을 나누세요.', problem: '대기가 길어요.', evidence: ['[공개 정보] 점심 대기'], actions: ['주문 담당을 정해요.', '전달 담당을 정해요.'], owner: '사장님', cost: '추가 비용 없음', supplies: '', metric: '점심 대기 시간' },
    { priority: '우선 개선', area: '손님 앞 기본', title: '손님이 보는 곳에서 식사하지 마세요.', problem: '손님과 마주쳐요.', evidence: ['[답변] 식사 장소: 손님 좌석·홀'], actions: ['식사 시간을 정해요.'], owner: '전 직원', cost: '없음', supplies: '가림막', metric: '마주침 횟수' },
    { priority: '아무거나', area: '', title: '', problem: '', evidence: [], actions: [], owner: '', cost: '', supplies: '', metric: '' },
  ],
  plan: { thisWeek: ['역할 나누기'], nextWeeks: ['수수료 확인'], thisMonth: ['원가 다시 보기'], marketing: '', budget: '추가 비용 없이 시작해요.', check: '매주 금요일에 대기 시간을 봐요.' },
  needCheck: ['재고 기록'],
};

test('결과 정리: 우선순위 순서, 없는 계산값 라벨 제거, 빈 솔루션 제거, 상황 문장', () => {
  const metrics = computeMetrics({ answers: ANSWERS }, STORE).metrics;
  const r = normalizeReport(AI_REPORT, metrics);
  assert.deepEqual(r.solutions.map((s) => s.stars), [3, 2]);
  assert.equal(r.solutions[0].supplies, '가림막');
  assert.deepEqual(r.keyMetrics.map((m) => m.label), ['추정 영업이익', '사장님 노동비를 반영한 이익']);
  assert.equal(r.situationMessage, '대표 메뉴 원가와 판매 방식별 비용 구조를 조정해야 해요.');
  const fallback = normalizeReport({ ...AI_REPORT, keyMetricLabels: [] }, metrics);
  assert.equal(fallback.keyMetrics[0].label, '추정 영업이익', '라벨이 없으면 기본 핵심 수치');
  assert.throws(() => normalizeReport({ ...AI_REPORT, solutions: [] }, metrics), (e) => e.code === 'AI_FORMAT');
  // 형식 고치기용 스키마는 모든 키가 필수이고 추가 키를 막는다
  assert.deepEqual(REPORT_SCHEMA.required.sort(), Object.keys(REPORT_SCHEMA.properties).sort());
  assert.equal(REPORT_SCHEMA.properties.solutions.items.additionalProperties, false);
});

// ───────── 서버 함수
function req({ method = 'POST', body, headers = {} } = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  const r = Readable.from(data ? [Buffer.from(data)] : []);
  r.method = method;
  r.headers = {
    host: 'www.kkumsu.com', origin: 'https://www.kkumsu.com', 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(data)), 'x-forwarded-for': '203.0.113.9', ...headers,
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
function aiReply(content, { cost = 0.09, finish = 'stop' } = {}) {
  return new Response(JSON.stringify({
    model: 'anthropic/claude-sonnet-5.5',
    choices: [{ finish_reason: finish, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 6000, completion_tokens: 5000, cost },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return typeof h === 'function' ? h(url, body) : h.clone();
  };
  f.calls = calls;
  return f;
}
const budgetKey = () => `maechul:v1:budget:${kstDay()}`;
// 인터넷 조사는 미리 저장돼 있다고 보고(=/api/research 를 먼저 부른 경우) 보고서 호출만 센다
const RESEARCH = {
  ...normalizeResearch({
    period: '2025년 3월~2026년 10월', reviewsChecked: 5,
    platforms: [{ platform: '카카오맵', status: '확인 못 함', note: '자동 수집 금지' }, { platform: '네이버 블로그', status: '확인함', checked: '블로그 5편' }],
    themes: [{ theme: '대기', tone: 'bad', count: 4, repeated: true, summary: '점심 대기가 길다는 글이 반복돼요.', examples: ['(블로그, 2026년 9월) 점심 30분 대기'] }],
    infoIssues: ['영업시간이 출처마다 달라요'], limits: ['카카오맵 리뷰 본문은 직접 읽지 않음'],
  }),
  input: { name: '골목국밥', address: '서울 마포구 망원로 12' }, model: 'anthropic/claude-sonnet-5.5', searchedAt: '2026-11-09T01:00:00.000Z',
};
const withResearch = async (store) => { await store.setJson(researchKey('골목국밥', '서울 마포구 망원로 12'), RESEARCH); return store; };

test('보고서 API: Claude가 만든 보고서를 정리하고, 실제 비용으로 정산하고, 같은 답은 캐시로 돌려준다', async () => {
  const store = await withResearch(new MemoryStore());
  const fetcher = fakeFetch([aiReply('```json\n' + JSON.stringify(AI_REPORT) + '\n```')]);
  const handler = createHandler({ env: ENV, fetcher, store });
  const r1 = res();
  await handler(req({ body: BODY }), r1);
  assert.equal(r1.statusCode, 200, r1.body);
  const out = r1.json();
  assert.equal(out.cached, false);
  assert.equal(out.report.solutions[0].title, '손님이 보는 곳에서 식사하지 마세요.');
  assert.equal(out.report.keyMetrics[0].value, '400만 원');
  assert.ok(out.metrics.length >= 10 && out.cautions.length >= 1 && out.bench.name === '한식');
  assert.equal(out.store.name, '골목국밥');
  assert.equal(out.research.period, '2025년 3월~2026년 10월', '저장된 인터넷 조사 결과를 함께 돌려줌');
  assert.equal(out.research.input, undefined);
  const sent = fetcher.calls[0].body;
  assert.equal(sent.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(sent.tools, undefined, '보고서는 웹 검색을 쓰지 않는다');
  assert.equal(sent.provider.data_collection, 'deny');
  assert.match(sent.messages[1].content, /얼큰 소고기국밥/);
  assert.match(sent.messages[1].content, /\[인터넷 조사 결과\][\s\S]*분석 기간: 2025년 3월~2026년 10월 · 실제로 읽은 후기·글: 5개/);
  assert.match(sent.messages[1].content, /- 대기 · 아쉬움 · 4개 · 반복: 점심 대기가 길다는 글이 반복돼요\./);
  assert.match(sent.messages[1].content, /- 카카오맵: 확인 못 함/);
  assert.equal(store.kv.get(budgetKey()), 90000, '예약 금액을 실제 비용 $0.09로 정산');

  const r2 = res();
  await handler(req({ body: BODY }), r2);
  assert.equal(r2.json().cached, true);
  assert.equal(fetcher.calls.length, 1, '캐시는 AI를 다시 부르지 않음');

  const r3 = res();
  await handler(req({ body: { ...BODY, refresh: true } }), r3);
  assert.equal(r3.json().cached, false);
  assert.equal(fetcher.calls.length, 2, '다시 만들기는 새로 부름');
});

test('보고서 API: 같은 보고서를 만드는 중이면 두 번째 요청은 AI를 부르지 않고 409', async () => {
  const store = await withResearch(new MemoryStore());
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetcher = fakeFetch([async () => { await gate; return aiReply(JSON.stringify(AI_REPORT)); }]);
  const handler = createHandler({ env: ENV, fetcher, store });
  const r1 = res();
  const first = handler(req({ body: BODY }), r1);
  await new Promise((r) => setTimeout(r, 20));
  const r2 = res();
  await handler(req({ body: BODY }), r2);
  assert.equal(r2.statusCode, 409);
  assert.equal(r2.json().code, 'BUSY');
  release();
  await first;
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(fetcher.calls.length, 1);
  const r3 = res();
  await handler(req({ body: BODY }), r3);
  assert.equal(r3.json().cached, true, '끝난 뒤에는 잠금이 풀리고 캐시로 받음');
});

test('보고서 API: JSON이 깨지면 저렴한 모델로 형식만 다시 맞춘다', async () => {
  const store = await withResearch(new MemoryStore());
  const fetcher = fakeFetch([aiReply('보고서 초안입니다: 핵심은 노동 의존이에요...', { cost: 0.08 }), aiReply(JSON.stringify(AI_REPORT), { cost: 0.004 })]);
  const r = res();
  await createHandler({ env: ENV, fetcher, store })(req({ body: BODY }), r);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(fetcher.calls[1].body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(fetcher.calls[1].body.response_format.json_schema.name, 'store_report');
  assert.equal(store.kv.get(budgetKey()), 84000);
});

test('보고서 API: 다른 사이트·부족한 답변은 거절하고, 하루 횟수를 넘으면 429', async () => {
  const store = await withResearch(new MemoryStore());
  const fetcher = fakeFetch([aiReply(JSON.stringify(AI_REPORT))]);
  const handler = createHandler({ env: { ...ENV, MAECHUL_IP_DAILY_REPORTS: '1' }, fetcher, store });
  const bad = res();
  await handler(req({ body: BODY, headers: { origin: 'https://evil.example' } }), bad);
  assert.equal(bad.statusCode, 403);
  const few = res();
  await handler(req({ body: { ...BODY, answers: { a_problem: ok('profit') } } }), few);
  assert.equal(few.statusCode, 400);
  assert.equal(few.json().code, 'ANSWERS');
  const r1 = res();
  await handler(req({ body: BODY }), r1);
  assert.equal(r1.statusCode, 200, r1.body);
  const r2 = res();
  await handler(req({ body: { ...BODY, answers: { ...ANSWERS, a_budget: ok({ money: '거의 없어요', time: '1시간 미만' }) } } }), r2);
  assert.equal(r2.statusCode, 429);
  assert.equal(r2.json().code, 'IP_QUOTA');
  assert.equal(fetcher.calls.length, 1);
});

test('보고서 API: 모의 모드는 키 없이 같은 형식을 돌려주고, 상태 확인은 비밀값을 보여주지 않는다', async () => {
  const r = res();
  await createHandler({ env: { MOCK_AI: '1' }, mockDelay: 0 })(req({ body: BODY }), r);
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.equal(out.mock, true);
  assert.ok(out.report.solutions.length >= 1 && out.report.oneLine.startsWith('(모의)'));
  const g = res();
  await createHandler({ env: ENV })(req({ method: 'GET' }), g);
  assert.ok(!g.body.includes('test-key'));
  assert.equal(g.json().ok, true);
});

test('보고서 API: 인터넷 조사가 없으면 먼저 조사(웹 검색·블로그 읽기)하고 그 결과를 합쳐 보고서를 만든다', async () => {
  const store = new MemoryStore();
  const researchJson = {
    period: '2026년 1월~10월', reviewsChecked: 4,
    platforms: [{ platform: '네이버 블로그', status: '확인함', rating: '', reviewCount: '', checked: '블로그 4편', note: '', url: 'https://m.blog.naver.com/a/1' }],
    themes: [{ theme: '맛', tone: 'good', count: 4, repeated: true, summary: '국물이 진하다는 글이 많아요.', examples: [] }],
    menuPrices: [], infoIssues: [], competitors: [], area: '', sponsored: '', limits: [], sources: [],
  };
  const fetcher = fakeFetch([aiReply(JSON.stringify(researchJson), { cost: 0.2 }), aiReply(JSON.stringify(AI_REPORT), { cost: 0.07 })]);
  const r = res();
  await createHandler({ env: ENV, fetcher, store })(req({ body: { ...BODY, pasted: '카카오맵 4.1점 (리뷰 87개)\n\n\n\n최근: 국물이 진해요' } }), r);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(fetcher.calls.length, 2, '조사 1번 + 보고서 1번');
  const types = fetcher.calls[0].body.tools.map((x) => x.type);
  assert.deepEqual(types, ['openrouter:web_search', 'openrouter:web_fetch']);
  const researchPrompt = fetcher.calls[0].body.messages[1].content;
  assert.ok(!researchPrompt.includes('바쁜데 남는 게 없어요') && !researchPrompt.includes('2400') && !researchPrompt.includes('카카오맵 4.1점'), '조사에는 인터뷰 답변·붙여 넣은 리뷰를 보내지 않음');
  assert.equal(fetcher.calls[1].body.tools, undefined, '보고서 단계는 검색 없이');
  const prompt = fetcher.calls[1].body.messages[1].content;
  assert.match(prompt, /- 맛 · 좋음 · 4개 · 반복: 국물이 진하다는 글이 많아요\./);
  assert.match(prompt, /\[사장님이 붙여 넣은 플랫폼 리뷰·평점\][^\n]*\n카카오맵 4\.1점 \(리뷰 87개\)\n\n최근: 국물이 진해요/);
  const out = r.json();
  assert.equal(out.research.reviewsChecked, 4);
  assert.equal(out.pasted, true);
  assert.equal(store.kv.get(budgetKey()), 270000, '조사 $0.20 + 보고서 $0.07 로 정산');
  // 같은 가게로 다시 만들 때는 저장된 조사 결과를 씀 (답이 바뀌어도 조사는 다시 안 함)
  const r2 = res();
  await createHandler({ env: ENV, fetcher: fakeFetch([aiReply(JSON.stringify(AI_REPORT))]), store })(req({ body: { ...BODY, answers: { ...ANSWERS, a_budget: ok({ money: '거의 없어요', time: '1시간 미만' }) } } }), r2);
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().research.searchedAt, out.research.searchedAt);
});
