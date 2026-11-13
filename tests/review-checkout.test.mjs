import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  isTestClientKey, keyFromConfig, loadClientKey, CONFIG_ENDPOINT, NOT_READY_MESSAGE, buildPaymentRequest,
  parseResult, describeResult, makeOrderId, isAllowedOrigin, PRICE_KRW,
} from '../public/review-checkout.js';

const read = (f) => readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
const js = read('review-checkout.js');
const html = read('review-checkout.html');
const VALID = 'test_ck_SyntheticKey0123456789';

test('only test_ck_ keys pass; everything else fails closed', () => {
  assert.equal(isTestClientKey(VALID), true);
  for (const bad of ['live_ck_abcdefghijklmnop', 'live_gck_abcdefghijklmnop', 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm',
    'test_sk_abcdefghijklmnop', 'test_gsk_abcdefghijklmnop', 'live_sk_abcdefghijklmnop', '', 'test_ck_', 'xtest_ck_abcdefghijkl', null, undefined, 123]) {
    assert.equal(isTestClientKey(bad), false, String(bad));
    assert.equal(keyFromConfig({ configured: true, clientKey: bad }), null, 'config ' + bad);
  }
  assert.equal(keyFromConfig({ configured: false, clientKey: VALID }), null);
  assert.equal(keyFromConfig(null), null);
  assert.equal(keyFromConfig({ configured: true, clientKey: VALID }), VALID);
});

test('loadClientKey: one same-origin GET to the config endpoint; failures fail closed', async () => {
  const calls = [];
  const ok = async (u, o) => { calls.push([u, o]); return { ok: true, json: async () => ({ configured: true, clientKey: VALID }) }; };
  assert.equal(await loadClientKey(ok), VALID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/review-checkout-config');
  assert.equal(CONFIG_ENDPOINT, '/api/review-checkout-config');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal('body' in calls[0][1], false);
  assert.equal(await loadClientKey(async () => ({ ok: false, json: async () => ({ configured: true, clientKey: VALID }) })), null);
  assert.equal(await loadClientKey(async () => ({ ok: true, json: async () => ({ configured: true, clientKey: 'live_ck_abcdefghijklmnop' }) })), null);
  assert.equal(await loadClientKey(async () => { throw new Error('net'); }), null);
  assert.equal(await loadClientKey(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })), null);
  assert.equal(await loadClientKey(null), null);
  assert.equal(NOT_READY_MESSAGE, '토스 테스트 키를 연결하면 심사용 테스트창을 사용할 수 있어요. 실제 결제는 꺼져 있어요.');
});

test('payment request: 3900 KRW, CARD, success/fail URLs on same isolated page, no PII', () => {
  const id = makeOrderId({ randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' });
  assert.match(id, /^review-test-[A-Za-z0-9_=-]{6,}$/);
  assert.ok(id.length >= 6 && id.length <= 64);
  const r = buildPaymentRequest('https://example.com/', id);
  assert.equal(r.amount.value, 3900);
  assert.equal(PRICE_KRW, 3900);
  assert.equal(r.amount.currency, 'KRW');
  assert.equal(r.method, 'CARD');
  assert.equal(r.windowTarget, 'self');
  assert.equal(r.successUrl, 'https://example.com/review-checkout.html?r=success');
  assert.equal(r.failUrl, 'https://example.com/review-checkout.html?r=fail');
  assert.ok(r.orderName.includes('테스트'));
  assert.equal('customerName' in r || 'customerEmail' in r || 'customerMobilePhone' in r, false);
});

test('origin guard: https or localhost only', () => {
  assert.equal(isAllowedOrigin({ protocol: 'https:', hostname: 'a.com' }), true);
  assert.equal(isAllowedOrigin({ protocol: 'http:', hostname: 'localhost' }), true);
  assert.equal(isAllowedOrigin({ protocol: 'http:', hostname: 'a.com' }), false);
  assert.equal(isAllowedOrigin({ protocol: 'file:', hostname: '' }), false);
});

test('success params never claim approval and never expose paymentKey', () => {
  const ok = parseResult('?r=success&paymentKey=SECRETPK123&orderId=review-test-abc123&amount=3900');
  const d = describeResult(ok);
  const text = JSON.stringify(d);
  assert.equal(ok.valid, true);
  assert.ok(!text.includes('SECRETPK123'));
  assert.ok(!/paymentKey/.test(text));
  assert.ok(text.includes('인증이나 승인을 검증한 것은 아닙니다'));
  assert.ok(!text.includes('인증이 끝났습니다'));
  assert.ok(text.includes('청구와 주문은 없습니다'));
  assert.ok(!/결제가 완료|결제 완료|결제 성공|주문이 접수|공개되었습니다/.test(text));
  for (const q of ['?r=success&orderId=review-test-abc123&amount=1', '?r=success&orderId=other&amount=3900', '?r=success']) {
    const bad = parseResult(q);
    assert.equal(bad.valid, false, q);
    assert.deepEqual(describeResult(bad).rows, []);
  }
});

test('fail params are clipped, control chars removed; cancel and other errors both state no charge', () => {
  const f = parseResult('?r=fail&code=PAY_PROCESS_CANCELED&message=' + encodeURIComponent('x'.repeat(500) + '\n\u0000'));
  assert.ok(f.message.length <= 200);
  assert.ok(!/[\u0000-\u001f]/.test(f.message));
  assert.ok(describeResult(f).body.includes('청구된 금액은 없습니다'));
  assert.ok(describeResult(parseResult('?r=fail&code=REJECT_CARD_COMPANY')).body.includes('청구된 금액은 없습니다'));
  assert.equal(parseResult('').kind, 'start');
  assert.equal(parseResult('?r=weird').kind, 'start');
});

test('button starts disabled and is only enabled after a validated key', () => {
  assert.match(html, /<button[^>]*id="rc-pay"[^>]*\sdisabled/);
  const code = js.replace(/\/\/.*$/gm, '');
  assert.ok(code.indexOf('btn.disabled = true; ') < code.indexOf('await loadClientKey('));
  assert.ok(code.indexOf('await loadClientKey(') < code.indexOf('btn.disabled = false;'));
  assert.ok(code.includes('if (blocked) { status.textContent = blocked; return; }'));
  assert.ok(!html.includes('테스트 결제창이 열립니다'));
});

test('static safety: only the safe config GET, no order/confirm calls, no hard-coded keys, no innerHTML', () => {
  const code = js.replace(/\/\/.*$/gm, '');
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource|payments\/confirm|Authorization|btoa\(|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(code));
  assert.deepEqual(code.match(/\/api\/[A-Za-z0-9_\/-]*/g), ['/api/review-checkout-config']);
  assert.equal((code.match(/\bfetchFn\(/g) || []).length, 1);
  assert.ok(!/toss-test-client-key|querySelector\('meta/.test(code));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(code));
  for (const src of [code, html]) {
    assert.ok(!/live_(ck|gck|sk|gsk)_/.test(src));
    assert.ok(!/test_(sk|gsk)_/.test(src));
  }
  assert.ok(!/test_gck_/.test(code));
  assert.equal(code.match(/(test|live)_[a-z]*ck_[A-Za-z0-9_-]{6,}/g), null, 'no key literal');
});

test('page copy states test-only, no charge, no order/publication, free beta, live not active; isolated', () => {
  for (const s of ['테스트 전용', '테스트 키가 연결된 경우에만', '실제 결제(청구)는 일어나지 않습니다', '주문이 만들어지지 않고', '실제로 공개되지도 않습니다', '계속 무료', '실제 결제는 아직 활성화되지 않았습니다', '3,900원']) {
    assert.ok(html.includes(s), s);
  }
  assert.match(html, /name="robots" content="noindex/);
  assert.match(html, /src="https:\/\/js\.tosspayments\.com\/v2\/standard"/);
  assert.ok(!/<script>[^<]/.test(html), 'no inline script (CSP script-src self)');
  // no other public page links to it (direct URL only)
  const dir = new URL('../public/', import.meta.url);
  for (const f of readdirSync(dir)) {
    if (/^review-(checkout|order-simulation)\./.test(f) || !/\.(html|js)$/.test(f)) continue;
    assert.ok(!readFileSync(new URL(f, dir), 'utf8').includes('review-checkout'), f + ' must not reference the test page');
  }
});
