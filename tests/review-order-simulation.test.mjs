import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDay, formatDay, addOneCalendarYear, createMockOrder, mockPayment, mockPublish, refundExample, isPreviewReady, TEST_PRICE_KRW } from '../public/review-order-simulation.js';

const day = parseDay;
const key = 'test_ck_abcdefghijklmnopqrst';
const https = { protocol: 'https:', hostname: 'preview.example' };
const response = (body, ok = true) => async () => ({ ok, json: async () => body });

test('calendar dates are strict and one-year expiry handles leap day', () => {
  assert.equal(formatDay(day('2026-11-14')), '2026-11-14');
  assert.equal(formatDay(addOneCalendarYear(day('2026-11-14'))), '2027-11-14');
  assert.equal(formatDay(addOneCalendarYear(day('2024-02-29'))), '2025-02-28');
  assert.equal(formatDay(addOneCalendarYear(day('2023-03-01'))), '2024-03-01');
  for (const x of ['2024-02-30', '2025-02-29', '2026-13-01', '2026-00-01', '2026-1-1', '', '2100-01-01']) assert.throws(() => day(x), x);
});

test('fake order transitions only in order and never mutate the original', () => {
  const d = day('2026-11-14');
  const order = createMockOrder(d, 'SIM-example');
  assert.equal(order.label, '가상 실습');
  assert.equal(order.amount, 3900);
  assert.equal(order.phase, 'created');
  assert.throws(() => mockPublish(order, d));
  assert.throws(() => createMockOrder(d, 'real-order'));
  const paid = mockPayment(order, d);
  assert.equal(order.phase, 'created');
  assert.equal(paid.phase, 'mock-paid');
  assert.throws(() => mockPayment(paid, d));
  const posted = mockPublish(paid, d);
  assert.equal(posted.phase, 'mock-published');
  assert.equal(formatDay(posted.expiresExclusiveDay), '2027-11-14');
  assert.throws(() => mockPublish(posted, d));
  assert.throws(() => mockPayment(order, d - 1));
  assert.throws(() => mockPublish(paid, d - 1));
});

test('later of payment and publication through 7 calendar days is full refund', () => {
  const order = mockPublish(mockPayment(createMockOrder(day('2026-01-01'), 'SIM-A'), day('2026-01-01')), day('2026-01-03'));
  for (const x of ['2026-01-03', '2026-01-09', '2026-01-10']) {
    const result = refundExample(order, day(x));
    assert.equal(result.full, true, x);
    assert.equal(result.refund, TEST_PRICE_KRW, x);
  }
  assert.throws(() => refundExample(order, day('2026-01-02')));
});

test('after 7 days refund uses remaining days from next day and rounds up', () => {
  const start = day('2026-01-03');
  const order = mockPublish(mockPayment(createMockOrder(day('2026-01-01'), 'SIM-B'), day('2026-01-01')), start);
  const request = day('2026-01-11');
  const result = refundExample(order, request);
  assert.equal(result.full, false);
  assert.equal(result.totalDays, 365);
  assert.equal(result.remainingDays, order.expiresExclusiveDay - (request + 1));
  assert.equal(result.refund, Math.ceil(3900 * result.remainingDays / 365));
  assert.equal(refundExample(order, order.expiresExclusiveDay + 3).refund, 0);
});

test('test feature fails closed unless preview config returns test client key', async () => {
  let args;
  const good = async (...a) => { args = a; return { ok: true, json: async () => ({ configured: true, clientKey: key }) }; };
  assert.equal(await isPreviewReady(good, https), true);
  assert.equal(args[0], '/api/review-checkout-config');
  assert.equal(args[1].method, 'GET');
  assert.equal('body' in args[1], false);
  for (const val of [{ configured: false, clientKey: key }, { configured: true, clientKey: 'live_ck_abcdefghijklmnop' }, { configured: true, clientKey: 'test_sk_abcdefghijklmnop' }, {}, null]) assert.equal(await isPreviewReady(response(val), https), false);
  assert.equal(await isPreviewReady(response({ configured: true, clientKey: key }, false), https), false);
  assert.equal(await isPreviewReady(async () => { throw Error('network'); }, https), false);
  assert.equal(await isPreviewReady(good, { protocol: 'http:', hostname: 'example.com' }), false);
});

test('simulation never calls order or payment APIs, persists data or asks for real data', async () => {
  const js = await readFile(new URL('../public/review-order-simulation.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/review-order-simulation.html', import.meta.url), 'utf8');
  assert.deepEqual(js.match(/\/api\/[A-Za-z0-9_/-]+/g), ['/api/review-checkout-config']);
  assert.doesNotMatch(js, /localStorage|sessionStorage|XMLHttpRequest|sendBeacon|payments\/confirm|document\.cookie|innerHTML|outerHTML|method:\s*'(POST|PUT|PATCH|DELETE)'/);
  assert.match(html, /name="robots" content="noindex/);
  assert.match(html, /토스 결제나 결제 승인과 연결되지 않습니다/);
  assert.match(html, /실제 주문·가게 공개·청구는 발생하지 않습니다/);
  assert.match(html, /새로고침하면 사라집니다/);
  assert.match(html, /공개 URL과 QR은 생성하지 않습니다/);
  assert.equal((html.match(/<button[^>]*\sdisabled/g) || []).length, 4);
});
