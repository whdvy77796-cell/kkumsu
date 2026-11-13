import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler, { reviewCheckoutConfig, isSafeTestClientKey, REVIEW_KEY_ENV } from '../api/review-checkout-config.js';

const VALID = 'test_ck_SyntheticKey0123456789';
function call(method, env) {
  const prev = { ...process.env };
  for (const k of Object.keys(process.env)) if (/TOSS/.test(k)) delete process.env[k];
  Object.assign(process.env, env || {});
  const headers = {}; let body = '';
  const res = { statusCode: 0, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, end: (b) => { body = b; } };
  try { handler({ method }, res); } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
  return { status: res.statusCode, headers, body };
}

test('valid synthetic test_ck_ is returned; response is minimal', () => {
  assert.deepEqual(reviewCheckoutConfig({ [REVIEW_KEY_ENV]: VALID }), { configured: true, clientKey: VALID });
  const r = call('GET', { [REVIEW_KEY_ENV]: VALID });
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(r.body), { configured: true, clientKey: VALID });
});

test('absent, live, secret, widget, docs-style and malformed keys are rejected', () => {
  const bad = [undefined, '', 'live_ck_abcdefghijklmnop', 'live_gck_abcdefghijklmnop', 'test_sk_abcdefghijklmnop', 'test_gsk_abcdefghijklmnop',
    'live_sk_abcdefghijklmnop', 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm', 'test_ck_short', 'test_ck_' + 'a'.repeat(101),
    ' ' + VALID, VALID + '\n', VALID + '!', 'xtest_ck_abcdefghijkl', 123, null, {}];
  for (const b of bad) {
    assert.deepEqual(reviewCheckoutConfig({ [REVIEW_KEY_ENV]: b }), { configured: false }, String(b));
    assert.equal(isSafeTestClientKey(b), false);
  }
  assert.deepEqual(reviewCheckoutConfig(undefined), { configured: false });
});

test('no fallback to other env vars; nothing else leaks', () => {
  const env = { TOSS_CLIENT_KEY: VALID, TOSS_SECRET_KEY: 'test_sk_secretsecretsecret', NEXT_PUBLIC_TOSS_CLIENT_KEY: VALID };
  assert.deepEqual(reviewCheckoutConfig(env), { configured: false });
  const r = call('GET', { ...env, [REVIEW_KEY_ENV]: 'live_ck_abcdefghijklmnop' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { configured: false });
  assert.ok(!/secret|live_|test_ck_/.test(r.body));
  const code = readFileSync(new URL('../api/review-checkout-config.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/TOSS_CLIENT_KEY|TOSS_SECRET/.test(code));
  assert.equal((code.match(/process\.env/g) || []).length, 1);
});

test('GET only: other methods get 405 with no-store and no key', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', undefined]) {
    const r = call(m, { [REVIEW_KEY_ENV]: VALID });
    assert.equal(r.status, 405, String(m));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers.allow, 'GET');
    assert.ok(!r.body.includes(VALID));
  }
});

test('production 배포는 안전한 테스트 키가 설정돼도 항상 비활성화', () => {
  assert.deepEqual(reviewCheckoutConfig({ VERCEL_ENV: 'production', YB_TOSS_REVIEW_CLIENT_KEY: 'test_ck_ABCDEFGHIJKLMNOPQRSTUV' }), { configured: false });
  assert.equal(reviewCheckoutConfig({ VERCEL_ENV: 'preview', YB_TOSS_REVIEW_CLIENT_KEY: 'test_ck_ABCDEFGHIJKLMNOPQRSTUV' }).configured, true);
});
