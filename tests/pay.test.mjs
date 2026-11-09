// 무료 핵심 진단 / 유료 맞춤 실행 패키지 점검: 잠금 규칙 · 결제 모드 · 주문 · 토스페이먼츠 승인(가짜 응답) · 다시 열기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler as payHandler } from '../api/pay.js';
import { createHandler as reportHandler } from '../api/report.js';
import { MemoryStore } from '../lib/guard.mjs';
import { payConfig, publicPay, saveReport, RETENTION, orderKey, repKey, PRODUCT } from '../lib/pay.mjs';
import { redactReport, packageSize, FREE_SOLUTIONS } from '../public/paywall.js';
import { businessReady, REQUIRED_BUSINESS } from '../public/business.js';

const SECRET = 'x'.repeat(32);
const TEST_ENV = { SESSION_SECRET: SECRET, VERCEL: '1', VERCEL_ENV: 'preview', TOSS_CLIENT_KEY: 'test_ck_abc123', TOSS_SECRET_KEY: 'test_sk_def456', OPENROUTER_API_KEY: 'k' };
const ok = (v) => ({ s: 'ok', v });
const BIZ = { name: '연어로', owner: '홍길동', bizNo: '123-45-67890', address: '대구 중구 동성로3길 32-13', phone: '053-000-0000', email: 'help@example.com' };

const sol = (i, stars) => ({
  stars, area: `영역${i}`, title: `개선안 제목 ${i}`, problem: `발견한 문제 ${i}`,
  evidence: [`[답변] 근거A${i}`, i % 2 ? `[공개 정보] 근거B${i}` : `[계산] 근거B${i}`],
  actions: [`실행비밀${i}-1`, `실행비밀${i}-2`, `실행비밀${i}-3`, `실행비밀${i}-4`],
  effect: `효과비밀${i}`, owner: `담당비밀${i}`, cost: `비용비밀${i}`, supplies: i === 2 ? '' : `준비물비밀${i}`, metric: `지표비밀${i}`,
});
const FULL = {
  v: 2,
  report: {
    oneLine: '한 줄 진단', situation: '유입 부족', situationMessage: '안내', keyMetrics: [{ label: '지난달 매출', value: '2,800만 원', kind: '추정' }],
    topProblem: { title: '가장 중요한 문제', evidence: ['[답변] 근거'] }, firstAction: { title: '바로 할 일', how: '방법' },
    urgent: ['위생 경고'], publicView: { summary: '공개 요약', keep: ['강점'], gaps: ['다른 점'] },
    analysis: { profit: '분석비밀-수익', menu: '분석비밀-메뉴', customer: '분석비밀-고객', connection: '' },
    solutions: [sol(1, 3), sol(2, 3), sol(3, 2), sol(4, 1)],
    plan: { thisWeek: ['계획비밀-1', '계획비밀-2'], nextWeeks: ['계획비밀-3'], thisMonth: [], marketing: '계획비밀-마케팅', budget: '계획비밀-예산', check: '' },
    needCheck: ['확인할 것'],
  },
  metrics: [{ label: '지난달 매출', value: '2,800만 원', kind: '추정', note: '' }],
  cautions: [], bench: null, research: { period: '기간', sources: [] }, pasted: false,
  store: { name: '연어로', address: '대구' }, model: 'anthropic/claude-sonnet-5.5', truncated: false, createdAt: '2026-11-09T08:07:00.000Z',
};

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
// 보관 기간을 기록하는 저장소
class TtlStore extends MemoryStore {
  constructor() { super(); this.ttl = new Map(); }
  async setJson(key, value, ttl) { this.ttl.set(key, ttl); return super.setJson(key, value, ttl); }
}
// 가짜 토스페이먼츠
function fakeToss(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = handler(url, init, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls;
  return f;
}
const DONE = (orderId, amount = 9900) => ({
  status: 'DONE', orderId, totalAmount: amount, method: '카드', approvedAt: '2026-11-09T18:00:00+09:00', receipt: { url: 'https://dashboard.tosspayments.com/receipt/x' },
});
async function call(handler, opts) {
  const r = res();
  await handler(req(opts), r);
  return r;
}

test('잠금 규칙: 1순위 개선안만 전부, 나머지는 제목·문제·개수만 보내고 실행 내용은 아예 안 보낸다', () => {
  const red = redactReport(FULL);
  assert.equal(red.locked, true);
  assert.equal(FREE_SOLUTIONS, 1);
  assert.deepEqual(red.report.solutions[0], FULL.report.solutions[0], '1순위는 전체 공개');
  const s2 = red.report.solutions[1];
  assert.deepEqual(Object.keys(s2).sort(), ['area', 'locked', 'problem', 'stars', 'title', 'web']);
  assert.deepEqual(s2.locked, { evidence: 2, actions: 4, effect: true, meta: 3 });
  assert.equal(red.report.solutions[2].web, true, '공개 정보 근거가 있으면 인터넷 조사 반영 표시');
  assert.deepEqual(red.report.plan, { locked: { thisWeek: 2, nextWeeks: 1, thisMonth: 0, marketing: true, budget: true, check: false } });
  assert.deepEqual(red.report.analysis, { locked: ['profit', 'menu', 'customer'] });
  const text = JSON.stringify(red);
  for (const secret of ['실행비밀2', '실행비밀3', '실행비밀4', '효과비밀2', '담당비밀3', '지표비밀4', '근거A2', '분석비밀', '계획비밀']) {
    assert.ok(!text.includes(secret), `잠긴 내용이 새어 나감: ${secret}`);
  }
  for (const free of ['한 줄 진단', '가장 중요한 문제', '바로 할 일', '위생 경고', '공개 요약', '확인할 것', '실행비밀1-1', '개선안 제목 4', '발견한 문제 4']) {
    assert.ok(text.includes(free), `무료로 보여야 할 내용이 빠짐: ${free}`);
  }
  assert.equal(redactReport(red), red, '두 번 잠가도 같다');
  assert.deepEqual(packageSize(red), { solutions: 3, steps: 12, planItems: 3, analysis: 3 });
  assert.deepEqual(packageSize(FULL), packageSize(red), '전체 보고서로 세어도 같은 분량');
});

test('결제 모드: 키·환경·사업자 정보에 따라 off/test/live', () => {
  assert.equal(payConfig({}).mode, 'off');
  assert.equal(payConfig({}).reason, 'no_keys');
  assert.equal(payConfig(TEST_ENV).mode, 'test');
  assert.equal(payConfig({ ...TEST_ENV, VERCEL_ENV: 'production' }).mode, 'off', '운영 사이트에서 테스트 키는 막는다');
  assert.equal(payConfig({ ...TEST_ENV, VERCEL_ENV: 'production' }).reason, 'test_keys_in_production');
  const live = { ...TEST_ENV, VERCEL_ENV: 'production', TOSS_CLIENT_KEY: 'live_ck_1', TOSS_SECRET_KEY: 'live_sk_2' };
  assert.equal(payConfig(live, {}).mode, 'off', '사업자 정보 없이는 실제 결제를 안 켠다');
  assert.equal(payConfig(live, {}).reason, 'business_info');
  assert.equal(payConfig(live, BIZ).mode, 'live');
  assert.equal(payConfig({ ...live, TOSS_SECRET_KEY: 'test_sk_2' }, BIZ).reason, 'key_mismatch');
  // 결제위젯(결제창형) 키: gck/gsk 짝
  assert.equal(payConfig({ ...TEST_ENV, TOSS_CLIENT_KEY: 'test_gck_docs_a', TOSS_SECRET_KEY: 'test_gsk_docs_b' }).mode, 'test');
  assert.equal(payConfig({ ...live, TOSS_CLIENT_KEY: 'live_gck_a', TOSS_SECRET_KEY: 'live_gsk_b' }, BIZ).mode, 'live');
  assert.equal(payConfig({ ...TEST_ENV, TOSS_CLIENT_KEY: 'test_gck_a', TOSS_SECRET_KEY: 'test_sk_b' }).reason, 'key_mismatch', '위젯 키와 개별 연동 키를 섞으면 안 됨');
  assert.equal(payConfig({ ...TEST_ENV, TOSS_CLIENT_KEY: 'test_ck_a', TOSS_SECRET_KEY: 'test_gsk_b' }).reason, 'key_mismatch');
  assert.equal(payConfig({ ...TEST_ENV, MAECHUL_PAYWALL: 'off' }).mode, 'off');
  assert.deepEqual([payConfig({}).amount, payConfig({}).list], [9900, 19900]);
  assert.deepEqual([payConfig({ MAECHUL_PRICE: '12900', MAECHUL_LIST_PRICE: '9000' }).amount, payConfig({ MAECHUL_PRICE: '12900', MAECHUL_LIST_PRICE: '9000' }).list], [12900, 12900], '정가가 판매가보다 낮을 수 없다');
  assert.equal(publicPay(payConfig(TEST_ENV)).clientKey, 'test_ck_abc123');
  assert.ok(!JSON.stringify(publicPay(payConfig(TEST_ENV))).includes('test_sk'), '시크릿 키는 절대 공개하지 않는다');
  assert.equal(publicPay(payConfig({})).clientKey, undefined);
  assert.equal(PRODUCT.name, '매출올려드림 맞춤 실행 패키지');
  assert.equal(businessReady({}), false);
  assert.equal(businessReady(BIZ), true);
  assert.deepEqual(REQUIRED_BUSINESS, ['name', 'owner', 'bizNo', 'address', 'phone', 'email']);
});

test('보고서 만들기: 결제를 받으면 잠긴 보고서 + 보고서 번호, 안 받으면 전체 보고서', async () => {
  const BODY = {
    name: '연어로', address: '대구 중구 동성로3길 32-13', store: { name: '연어로', address: '대구 중구 동성로3길 32-13' },
    answers: {
      a_basic: ok({ category: '국밥·탕·찌개', period: '3~5년' }),
      a_split: ok({ hall: { on: true, pct: '60' }, takeout: { on: true, pct: '10' }, delivery: { on: true, pct: '30' } }),
      a_staff: ok({ staff: '2', owner: '12', family: '4' }),
      a_problem: ok({ value: 'profit', detail: '바쁜데 남는 게 없어요' }),
      a_budget: ok({ money: '30만 원 이하', time: '1~3시간' }),
      b_know: ok('exact'),
      b_sales: ok([{ sales: '2400', days: '26' }, { sales: '2300', days: '25' }, { sales: '2200', days: '26' }]),
      b_costs: ok({ food: '1000', labor: '400', pack: '60', rent: '250', util: '80', fee: '150', mkt: '30', supply: '20', etc: '10' }),
      b_records: ok({ data: 'POS 매출 자료가 있어요', stock: '기록하지 않아요' }),
      c_menus: ok([{ name: '얼큰 소고기국밥', price: '11000', qty: '1200' }, { name: '수육', price: '25000', qty: '200' }]),
      c_cost: ok({ know: 'known', amount: '4800', includes: ['반찬'] }),
      s_manners: ok({ mealWhen: '영업 중 틈틈이', mealWhere: '손님 좌석·홀', seen: '가끔 있어요', cleanDuring: ['손님 있을 땐 안 해요'] }),
    },
  };
  const store = new TtlStore();
  const env = { ...TEST_ENV, MOCK_AI: '1' };
  const r = await call(reportHandler({ env, store, mockDelay: 0 }), { body: BODY });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.match(d.rid, /^[A-Za-z0-9_-]{16}$/);
  assert.match(d.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(d.pay.mode, 'test');
  assert.equal(d.paid, false);
  const saved = await store.getJson(repKey(d.rid));
  assert.ok(saved.data.report.solutions.length >= 1, '서버에는 전체 보고서를 보관');
  assert.equal(store.ttl.get(repKey(d.rid)), RETENTION.unpaid);
  assert.ok(!JSON.stringify(saved).includes(d.token), '토큰은 해시로만 보관');
  if (saved.data.report.solutions.length > 1) {
    assert.equal(d.locked, true);
    assert.ok(!d.report.solutions[1].actions, '2순위부터 실행 방법은 안 보냄');
  }
  // 결제를 안 받는 모드: 지금처럼 전체 보고서
  const off = await call(reportHandler({ env: { ...env, TOSS_CLIENT_KEY: '', TOSS_SECRET_KEY: '' }, store, mockDelay: 0 }), { body: BODY });
  const od = off.json();
  assert.equal(od.locked, undefined);
  assert.equal(od.pay.mode, 'off');
  assert.ok(od.rid && od.token);
  assert.ok(Array.isArray(od.report.plan.thisWeek), '전체 보고서');
});

test('결제: 주문 → 금액 확인 → 토스 승인 → 열림, 새로고침해도 한 번만 승인', async () => {
  const store = new TtlStore();
  const { rid, token } = await saveReport(store, TEST_ENV, FULL);
  const toss = fakeToss((url, init, n) => (url.endsWith('/payments/confirm') ? [200, DONE(JSON.parse(init.body).orderId)] : [404, { code: 'NOT_FOUND' }]));
  const handler = payHandler({ env: TEST_ENV, store, fetcher: toss });

  const v0 = (await call(handler, { body: { action: 'view', rid, token } })).json();
  assert.equal(v0.locked, true);
  assert.equal(v0.paid, false);
  assert.equal((await call(handler, { body: { action: 'view', rid, token: 'y'.repeat(32) } })).statusCode, 403);
  assert.equal((await call(handler, { body: { action: 'view', rid: 'A'.repeat(16), token } })).statusCode, 404);
  assert.equal((await call(handler, { body: { action: 'view', rid, token }, headers: { origin: 'https://evil.example' } })).statusCode, 403);

  const o = (await call(handler, { body: { action: 'order', rid, token } })).json();
  assert.match(o.orderId, /^MO[A-Za-z0-9_-]{10,40}$/);
  assert.equal(o.amount, 9900);
  assert.equal(o.clientKey, 'test_ck_abc123');
  assert.equal(store.ttl.get(orderKey(o.orderId)), RETENTION.order);

  // 금액을 바꿔 보내면 토스를 부르지 않고 거절
  const bad = await call(handler, { body: { action: 'confirm', paymentKey: 'tgen_payment_key_1', orderId: o.orderId, amount: 100, rid, token } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'PAY_AMOUNT');
  assert.equal(toss.calls.length, 0);

  const c = await call(handler, { body: { action: 'confirm', paymentKey: 'tgen_payment_key_1', orderId: o.orderId, amount: 9900, rid, token } });
  assert.equal(c.statusCode, 200, c.body);
  const cd = c.json();
  assert.equal(cd.paid, true);
  assert.equal(cd.locked, undefined, '결제하면 전체 보고서');
  assert.deepEqual(cd.report.plan.thisWeek, ['계획비밀-1', '계획비밀-2']);
  assert.equal(cd.payment.amount, 9900);
  assert.equal(cd.payment.test, true);
  assert.equal(cd.payment.receiptUrl, 'https://dashboard.tosspayments.com/receipt/x');
  assert.equal(cd.token, undefined, '같은 브라우저면 새 토큰 없음');
  // 토스에 보낸 요청: 시크릿 키 Basic 인증(콜론 포함) · 서버가 정한 금액 · 중복 방지 키
  assert.equal(toss.calls.length, 1);
  assert.equal(toss.calls[0].init.headers.Authorization, `Basic ${Buffer.from('test_sk_def456:').toString('base64')}`);
  assert.deepEqual(toss.calls[0].body, { paymentKey: 'tgen_payment_key_1', orderId: o.orderId, amount: 9900 });
  assert.equal(toss.calls[0].init.headers['Idempotency-Key'], `confirm-${o.orderId}`);
  // 보관: 결제한 보고서 90일, 결제 기록 5년(보고서 내용 없이)
  assert.equal(store.ttl.get(repKey(rid)), RETENTION.paid);
  assert.equal(store.ttl.get(orderKey(o.orderId)), RETENTION.payment);
  const rec = await store.getJson(orderKey(o.orderId));
  assert.equal(rec.status, 'done');
  assert.ok(!JSON.stringify(rec).includes('계획비밀'), '결제 기록에는 보고서 내용을 넣지 않는다');

  // 새로고침: 다시 승인하지 않고 그대로 열림
  const again = await call(handler, { body: { action: 'confirm', paymentKey: 'tgen_payment_key_1', orderId: o.orderId, amount: 9900, rid, token } });
  assert.equal(again.statusCode, 200);
  assert.equal(toss.calls.length, 1);
  const other = await call(handler, { body: { action: 'confirm', paymentKey: 'tgen_other_key_99', orderId: o.orderId, amount: 9900, rid, token } });
  assert.equal(other.statusCode, 409);
  // 결제한 보고서는 다시 열면 전체, 또 주문하면 '이미 결제'
  const v1 = (await call(handler, { body: { action: 'view', rid, token } })).json();
  assert.equal(v1.paid, true);
  assert.deepEqual(v1.report.solutions[3].actions, FULL.report.solutions[3].actions);
  assert.deepEqual((await call(handler, { body: { action: 'order', rid, token } })).json(), { paid: true });
});

test('결제: 다른 브라우저로 돌아오면 새 열람 토큰, 이미 승인된 결제는 조회로 확인, 실패는 그대로 잠김', async () => {
  const store = new TtlStore();
  const { rid, token } = await saveReport(store, TEST_ENV, FULL);
  // 1) 토큰 없이 돌아온 경우 + 토스가 '이미 처리된 결제'라고 하면 조회로 확인
  const toss = fakeToss((url, init) => {
    if (url.endsWith('/payments/confirm')) return [400, { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제 입니다.' }];
    return [200, DONE(store.lastOrder)];
  });
  const handler = payHandler({ env: TEST_ENV, store, fetcher: toss });
  const o = (await call(handler, { body: { action: 'order', rid, token } })).json();
  store.lastOrder = o.orderId;
  const c = await call(handler, { body: { action: 'confirm', paymentKey: 'tgen_payment_key_2', orderId: o.orderId, amount: '9900' } });
  assert.equal(c.statusCode, 200, c.body);
  const cd = c.json();
  assert.equal(cd.paid, true);
  assert.match(cd.token, /^[A-Za-z0-9_-]{32}$/, '새 토큰 발급');
  assert.equal(toss.calls.length, 2);
  assert.equal(toss.calls[1].init.method, 'GET');
  assert.equal((await call(handler, { body: { action: 'view', rid: cd.rid, token: cd.token } })).json().paid, true);
  assert.equal((await call(handler, { body: { action: 'view', rid, token } })).json().paid, true, '원래 토큰도 그대로 됨');

  // 2) 카드 거절: 오류 메시지를 그대로 알려 주고 보고서는 잠긴 채로
  const store2 = new TtlStore();
  const s2 = await saveReport(store2, TEST_ENV, FULL);
  const reject = fakeToss(() => [400, { code: 'REJECT_CARD_PAYMENT', message: '한도초과 혹은 잔액부족으로 결제에 실패했습니다.' }]);
  const h2 = payHandler({ env: TEST_ENV, store: store2, fetcher: reject });
  const o2 = (await call(h2, { body: { action: 'order', ...s2 } })).json();
  const f = await call(h2, { body: { action: 'confirm', paymentKey: 'tgen_payment_key_3', orderId: o2.orderId, amount: 9900, ...s2 } });
  assert.equal(f.statusCode, 400);
  assert.equal(f.json().code, 'PAY_FAILED');
  assert.match(f.json().error, /잔액부족/);
  assert.equal((await call(h2, { body: { action: 'view', ...s2 } })).json().locked, true);

  // 3) 결제를 안 받는 모드에서는 주문을 만들지 않는다
  const off = payHandler({ env: { ...TEST_ENV, TOSS_CLIENT_KEY: '' }, store: store2, fetcher: reject });
  assert.equal((await call(off, { body: { action: 'order', ...s2 } })).statusCode, 409);
  assert.equal((await call(off, { body: { action: 'view', ...s2 } })).json().locked, undefined, '결제를 안 받으면 전체 공개');
  // GET: 공개 설정만
  const g = await call(payHandler({ env: TEST_ENV }), { method: 'GET' });
  assert.deepEqual(Object.keys(g.json()).sort(), ['amount', 'clientKey', 'list', 'mode', 'ok', 'orderName', 'reason']);
  assert.ok(!g.body.includes('test_sk'));
});
