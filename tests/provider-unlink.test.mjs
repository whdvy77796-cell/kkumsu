import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderUnlinkAdapter } from '../lib/provider-unlink.mjs';
const NOW = 1800000000000;
const urls = { kakao: 'https://kapi.kakao.com/v1/user/unlink', naver: 'https://nid.naver.com/oauth2.0/revoke', google: 'https://oauth2.googleapis.com/revoke' };
function input(provider = 'kakao') {
  const expected = { provider, clientId: 'synthetic-client', subject: provider === 'kakao' ? '9223372036854775807' : 'synthetic-subject' };
  return { expected, reauthenticated: { ...expected, authenticatedAt: NOW, tokenBound: true, freshAuthentication: true }, accessToken: 'SYNTHETIC_NOT_A_REAL_TOKEN', clientSecret: 'SYNTHETIC_NOT_A_REAL_SECRET' };
}
function response(provider, body = '', status = 200, headers = {}) {
  const r = new Response(body, { status, headers });
  Object.defineProperty(r, 'url', { value: urls[provider] });
  return r;
}
function adapter(fetchImpl, extra = {}) {
  return createProviderUnlinkAdapter({ experimental: true, fetchImpl, now: () => NOW, timeoutMs: 50, ...extra });
}
test('requires explicit experimental transport and bounded timeout', () => {
  for (const options of [{}, { experimental: true }, { experimental: true, fetchImpl: () => {}, timeoutMs: 3001 }]) assert.throws(() => createProviderUnlinkAdapter(options), /configuration/);
});
for (const provider of Object.keys(urls)) test(provider + ': pinned POST without query/cookies/redirects; one request', async () => {
  let calls = 0;
  const invoke = adapter(async (url, init) => {
    calls++;
    assert.equal(url, urls[provider]); assert.equal(new URL(url).search, '');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer'); assert.ok(init.signal instanceof AbortSignal);
    const form = new URLSearchParams(init.body);
    if (provider === 'kakao') { assert.equal(init.headers.Authorization, 'Bearer ' + input().accessToken); assert.equal(init.body, ''); }
    else assert.equal(form.get('token'), input().accessToken);
    if (provider === 'naver') { assert.equal(form.get('client_id'), 'synthetic-client'); assert.equal(form.get('client_secret'), input().clientSecret); assert.equal(form.get('token_type_hint'), 'access_token'); }
    return response(provider, provider === 'kakao' ? '{"id":9223372036854775807}' : '');
  });
  const result = await invoke(input(provider));
  assert.equal(result.status, provider === 'naver' ? 'pending' : 'success');
  assert.equal(result.automaticRetry, false); assert.equal(calls, 1);
  assert.deepEqual(Object.keys(result).sort(), ['automaticRetry', 'reason', 'status']);
});
for (const field of ['provider', 'clientId', 'subject']) test('reject exact mismatch: ' + field, async () => {
  let calls = 0; const i = input(); i.reauthenticated[field] += '-wrong';
  assert.equal((await adapter(async () => { calls++; })(i)).status, 'blocked'); assert.equal(calls, 0);
});
for (const change of [i => i.reauthenticated.authenticatedAt = NOW - 300001, i => i.reauthenticated.authenticatedAt = NOW + 1, i => i.reauthenticated.tokenBound = false, i => i.reauthenticated.freshAuthentication = false, i => i.accessToken = 'bad\r\nheader', i => i.accessToken = 'x'.repeat(2049), i => i.expected.provider = 'toString', i => i.clientSecret = '']) test('invalid/replayed/unbound contract blocks before dispatch', async () => {
  let calls = 0; const i = input('naver'); change(i);
  assert.equal((await adapter(async () => { calls++; })(i)).status, 'blocked'); assert.equal(calls, 0);
});
for (const [provider, body, status] of [
  ['kakao', '{"id":1}', 200], ['kakao', '{"id":"9223372036854775807"}', 200],
  ['kakao', '{"id":9223372036854775807,"id":1}', 200], ['kakao', '{"code":-401}', 401],
  ['google', '{"error":"invalid_token"}', 400], ['google', '{"error":"invalid_token"}', 200],
  ['google', '<html>unexpected</html>', 200], ['naver', '', 200], ['naver', '{"result":"success"}', 200],
  ['google', '', 204], ['kakao', '', 503], ['google', '', 429], ['google', '', 302],
]) test(provider + ': unknown/error/already-revoked is pending ' + status + ' ' + body, async () => {
  let calls = 0;
  const result = await adapter(async () => { calls++; return response(provider, status === 204 ? null : body, status); })(input(provider));
  assert.equal(result.status, 'pending'); assert.equal(calls, 1); assert.equal(result.automaticRetry, false);
});
test('wrong origin and followed redirects never confirm', async () => {
  for (const field of ['url', 'redirected']) {
    const r = new Response(''); Object.defineProperty(r, field, { value: field === 'url' ? 'https://example.invalid/' : true });
    assert.equal((await adapter(async () => r)(input('google'))).status, 'pending');
  }
});
test('limits declared and streamed response bytes', async () => {
  for (const r of [response('google', '', 200, { 'content-length': '999999' }), response('google', 'x'.repeat(4097))]) assert.equal((await adapter(async () => r)(input('google'))).reason, 'response_limit');
});
test('timeout covers fetch and stalled body even if transport ignores abort', async () => {
  for (const bodyStall of [false, true]) {
    let calls = 0; let signal;
    const invoke = adapter(async (url, init) => {
      calls++; signal = init.signal;
      if (!bodyStall) return new Promise(() => {});
      const r = new Response(new ReadableStream({ start() {} })); Object.defineProperty(r, 'url', { value: urls.google }); return r;
    });
    assert.equal((await invoke(input('google'))).status, 'pending'); assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});
test('transport exceptions and provider echo never leak secrets', async () => {
  const i = input('google');
  for (const invoke of [adapter(async () => { throw new Error(i.accessToken + i.clientSecret); }), adapter(async () => response('google', i.accessToken + i.clientSecret))]) {
    const result = await invoke(i); assert.equal(result.status, 'pending');
    const serialized = JSON.stringify(result); assert.ok(!serialized.includes(i.accessToken)); assert.ok(!serialized.includes(i.clientSecret)); assert.ok(!serialized.includes(i.expected.subject));
  }
});
