import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, buildWebEvidence } from '../api/page-search.js';
import { MemoryStore } from '../lib/guard.mjs';

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
const pageKeys = (store) => [...store.kv.keys()].filter((k) => k.includes(':page-search-v1:') && !k.endsWith(':lock'));

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
  await store2.setJson('maechul:v2:search:old', { candidates: [{ name: 'old' }] });
  assert.equal((await call(OK, { store: store2, fetcher: fakeFetch(aiReply(JSON_OUT)) })).json().cached, false);
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
