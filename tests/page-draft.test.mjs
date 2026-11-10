import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, validateDraftInput, normalizeDraft, draftLockKey, numberTokens, PAGE_DRAFT_SYSTEM, INPUT_LIMITS, contradictsOwner } from '../api/page-draft.js';
import { MemoryStore, limits, UNLIMITED } from '../lib/guard.mjs';

const ENV = { OPENROUTER_API_KEY: 'test-key', SESSION_SECRET: 'private-test-salt', VERCEL: '1', VERCEL_ENV: 'preview' };
const OK = { store: { name: '골목분식', address: '서울 마포구 망원로 12', verifiedFacts: ['주문 후 김밥을 만듭니다', '포장 가능합니다'] }, answers: { offer: '김밥과 떡볶이를 제공합니다', difference: '주문 후 만드는 김밥', audience: '간단히 식사하려는 이웃', visit: '포장 가능합니다', keywords: '24시간 무료주차 맛집' }, consent: true };
const clone = o => JSON.parse(JSON.stringify(o));
const good = () => ({ headline: { text: '주문 후 만드는 김밥', evidence: ['fact0'] }, intro: { text: '김밥과 떡볶이로 간단한 식사를 준비해 보세요.', evidence: ['offer', 'audience'] }, sections: [{ heading: '주문 후 준비하는 김밥', body: '주문을 받고 김밥을 만듭니다. 포장도 가능합니다.', evidence: ['fact0', 'fact1'] }], faqs: [{ question: '포장할 수 있나요?', answer: '네, 포장 가능합니다.', evidence: ['visit'] }], keywords: [{ text: '24시간 무료주차 맛집', evidence: ['keywords'] }] });
function req(body = OK, headers = {}, preParsed = false) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const r = Readable.from([Buffer.from(data)]);
  r.method = 'POST';
  r.headers = { host: 'www.kkumsu.com', origin: 'https://www.kkumsu.com', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), 'x-forwarded-for': '203.0.113.7', ...headers };
  if (preParsed) r.body = body;
  return r;
}
function res() { return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(s) { this.body = JSON.parse(s); } }; }
function reply(content = good(), usage = { cost: 0.02 }) { return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage }), { status: 200 }); }
function fake(...responses) { const f = async (url, opts) => { f.calls.push({ url, body: JSON.parse(opts.body) }); const r = responses.shift(); if (r instanceof Error) throw r; if (typeof r === 'function') return r(); if (!r) throw new Error('unexpected retry'); return r; }; f.calls = []; return f; }
async function call(body = OK, deps = {}, headers = {}, preParsed = false) { const r = res(); await createHandler({ env: ENV, store: new MemoryStore(), fetcher: fake(reply()), ...deps })(req(body, headers, preParsed), r); return r; }
const budget = store => Number([...store.kv].find(([k]) => k.includes(':budget:'))?.[1] || 0);
const spyStore = () => { const s = new MemoryStore(); s.touched = []; for (const name of ['reserve', 'lock', 'unlock', 'adjust', 'getJson', 'setJson']) { const fn = s[name].bind(s); s[name] = async (...args) => { s.touched.push([name, ...args]); return fn(...args); }; } return s; };

for (const consent of [undefined, false, null, 1, 'true']) test(`consent ${String(consent)}: no external call/storage`, async () => {
  const body = clone(OK); body.consent = consent; const store = spyStore(), f = fake();
  const r = await call(body, { store, fetcher: f }); assert.equal(r.statusCode, 400); assert.equal(r.body.code, 'CONSENT'); assert.equal(f.calls.length, 0); assert.equal(store.touched.length, 0);
});

test('strict fields, types, required offer and all length limits precede storage', async () => {
  const changes = [b => b.extra = 1, b => b.store.extra = true, b => b.answers.extra = 'x', b => delete b.answers.visit, b => b.answers.offer = '한', b => b.answers.offer = '  ', b => b.store.address = '서울', b => b.store.name = 123, b => b.store.verifiedFacts = [''], b => b.store.verifiedFacts = Array(9).fill('특징'), b => b.store.verifiedFacts = ['x'.repeat(201)], b => b.store.name = 'a'.repeat(61), b => b.store.address = 'a'.repeat(121), ...['offer', 'difference', 'audience', 'visit'].map(k => b => b.answers[k] = 'a'.repeat(501)), b => b.answers.keywords = 'a'.repeat(301), b => b.answers.offer = '<script>alert(1)</script>'];
  for (const change of changes) { const b = clone(OK); change(b); const store = spyStore(), f = fake(); const r = await call(b, { store, fetcher: f }); assert.equal(r.statusCode, 400); assert.equal(f.calls.length, 0); assert.equal(store.touched.length, 0); }
  const b = clone(OK); b.store.name = '가'.repeat(60); b.store.address = '나'.repeat(120); b.store.verifiedFacts = Array(8).fill('다'.repeat(200)); for (const k of ['offer', 'difference', 'audience', 'visit']) b.answers[k] = '라'.repeat(500); b.answers.keywords = '마'.repeat(300); assert.doesNotThrow(() => validateDraftInput(b));
});

test('origin, protocol, malformed JSON, content type, oversized streamed and pre-parsed body preflight', async () => {
  for (const headers of [{ origin: 'https://evil.test' }, { origin: 'http://www.kkumsu.com' }, { origin: 'https://www.kkumsu.com/path' }, { origin: 'x'.repeat(3000) }, { origin: '' }, { host: 'www.kkumsu.com,evil.test' }]) { const store = spyStore(), f = fake(); const r = await call(OK, { store, fetcher: f }, headers); assert.equal(r.statusCode, 403); assert.equal(store.touched.length, 0); assert.equal(f.calls.length, 0); }
  assert.equal((await call('{bad')).body.code, 'BAD_JSON');
  assert.equal((await call(OK, {}, { 'content-type': 'text/plain' })).statusCode, 415);
  for (const pre of [false, true]) { const store = spyStore(), f = fake(); const r = await call({ ...OK, extra: 'a'.repeat(INPUT_LIMITS.bytes + 1) }, { store, fetcher: f }, { 'content-length': '0' }, pre); assert.equal(r.statusCode, 413); assert.equal(f.calls.length, 0); assert.equal(store.touched.length, 0); }
  const request = req(); request.method = 'GET'; const out = res(); await createHandler({ env: ENV, fetcher: fake() })(request, out); assert.equal(out.statusCode, 405); assert.equal(out.headers.allow, 'POST');
});

test('one call, no tools, no raw cache, known cost, separate counter, correct contract', async () => {
  const store = spyStore(), f = fake(reply()); const out = await call(OK, { store, fetcher: f });
  assert.equal(out.statusCode, 200); assert.equal(out.body.cached, false); assert.equal(out.body.mock, false); assert.ok(Date.parse(out.body.createdAt)); assert.deepEqual(Object.keys(out.body).sort(), ['cached', 'createdAt', 'draft', 'mock']);
  assert.equal(out.body.draft.omittedCount, 0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.max_tokens, 2400); assert.equal('tools' in f.calls[0].body, false); assert.equal('max_tool_calls' in f.calls[0].body, false);
  assert.equal(budget(store), 20000); assert.equal(store.touched.some(([m]) => m === 'getJson' || m === 'setJson'), false);
  assert.ok([...store.kv.keys()].some(k => k.includes(':ip:pageDraft:'))); assert.ok([...store.kv.keys()].every(k => !k.includes(':ip:report:') && !k.includes(':lock:')));
  assert.ok([...store.kv.values()].every(v => typeof v === 'number')); assert.ok(!JSON.stringify([...store.kv]).includes(OK.answers.offer));
  assert.equal(out.headers['cache-control'], 'no-store');
});

test('salted TTL lock prevents duplicate concurrent calls and unlocks in finally; no later cache reuse', async () => {
  const store = spyStore(); let release, entered; const started = new Promise(r => entered = r); const gate = new Promise(r => release = r);
  const f = fake(async () => { entered(); await gate; return reply(); }, reply());
  const first = call(OK, { store, fetcher: f }); await started;
  const second = await call(OK, { store, fetcher: f }); assert.equal(second.statusCode, 409); assert.equal(f.calls.length, 1);
  release(); assert.equal((await first).statusCode, 200); assert.equal((await call(OK, { store, fetcher: f })).statusCode, 200); assert.equal(f.calls.length, 2);
  const lock = store.touched.find(([m]) => m === 'lock'); assert.equal(lock[2], limits(ENV).lockTtl); assert.match(lock[1], /lock:[a-f0-9]{64}$/); assert.notEqual(draftLockKey(OK, 'salt1'), draftLockKey(OK, 'salt2'));
  assert.equal(store.touched.filter(([m]) => m === 'unlock').length, 2);
});

test('numeric safety scoped to cited facts, not keywords or uncited inputs; preserve supported items', () => {
  const raw = good(); raw.sections.push({ heading: '이용 시간', body: '24시간 이용 가능합니다.', evidence: ['keywords', 'offer'] }, { heading: '가격', body: '김밥 3000원입니다.', evidence: ['offer'] });
  raw.faqs.push({ question: '주차 비용은?', answer: '무료주차입니다.', evidence: ['keywords'] });
  const d = normalizeDraft(raw, validateDraftInput(OK)); assert.equal(d.sections.length, 1); assert.equal(d.faqs.length, 1); assert.equal(d.omittedCount, 3); assert.equal(d.keywords.length, 1);
  const b = clone(OK); b.answers.offer = '김밥 10,000원, 오전 10시부터 20시까지'; const r = good(); r.sections = [{ heading: '가격과 시간', body: '김밥 10000원, 10시부터 20시까지입니다.', evidence: ['offer'] }]; assert.equal(normalizeDraft(r, validateDraftInput(b)).sections.length, 1);
  r.sections[0].body = '김밥 1000원입니다.'; assert.equal(normalizeDraft(r, validateDraftInput(b)).sections.length, 0); assert.deepEqual(numberTokens('10000원과 10,000원'), ['10000', '10000']);
});

test('empty/unknown/nonexistent evidence omitted, partial good results not discarded', () => {
  const raw = good(); raw.sections.push(...[[], ['fact7'], ['madeup'], ['audience', 'fact7'], ['keywords']].map(evidence => ({ heading: '미지원', body: '주차 가능합니다.', evidence })));
  const b = clone(OK); b.answers.visit = ''; raw.faqs.push({ question: '언제 가나요?', answer: '방문 가능합니다.', evidence: ['visit'] });
  const d = normalizeDraft(raw, validateDraftInput(b)); assert.equal(d.sections.length, 1); assert.equal(d.faqs.length, 0); assert.equal(d.omittedCount, 7); assert.equal(d.intro.text, raw.intro.text);
});

test('regular paraphrases, punctuation, Korean particles and multiline prose are retained', () => {
  const raw = good(); raw.sections[0].body = '주문을 받은 뒤 김밥을 준비합니다.\n바쁜 날에는 포장해서 드실 수 있어요.'; raw.faqs[0].answer = '네, 포장하실 수 있습니다. 간단히 식사할 때 이용해 보세요.';
  const d = normalizeDraft(raw, validateDraftInput(OK)); assert.equal(d.omittedCount, 0); assert.equal(d.sections[0].body, raw.sections[0].body);
});

test('HTML, oversized strings, excess output counts, unsupported name-only claims, guarantees omitted', () => {
  const raw = good(); raw.sections = [{ heading: 'HTML', body: '<b>김밥</b>', evidence: ['offer'] }, { heading: '긴 글', body: '가'.repeat(1001), evidence: ['offer'] }, { heading: '무료 주차', body: '주차 가능합니다.', evidence: ['name'] }, { heading: '보장', body: '매출 상승을 보장합니다.', evidence: ['offer'] }, { heading: '좋은 내용', body: '포장 가능합니다.', evidence: ['fact1'] }, { heading: '초과', body: '포장 가능합니다.', evidence: ['fact1'] }];
  const d = normalizeDraft(raw, validateDraftInput(OK)); assert.equal(d.sections.length, 1); assert.equal(d.omittedCount, 5);
});

test('negative and uncertain owner facts are not turned positive', () => {
  assert.match(PAGE_DRAFT_SYSTEM, /부정과 불확실성/);
  assert.equal(contradictsOwner('무료주차 가능합니다.', { fact0: '예약 불가', fact1: '무료주차 가능' }), false);
  assert.equal(contradictsOwner('반려견 동반 가능합니다.', { fact0: '반려견 동반 불가' }), true);
  for (const fact of ['주차 안 됩니다', '주차 불가', '주차 가능 여부 모름', '주차 미확인']) {
    assert.equal(contradictsOwner('주차 가능합니다.', { fact0: fact }), true);
    const b = clone(OK); b.store.verifiedFacts = [fact]; const raw = good(); raw.sections = [{ heading: '방문 안내', body: '무료주차 가능합니다.', evidence: ['fact0'] }]; assert.equal(normalizeDraft(raw, validateDraftInput(b)).sections.length, 0);
  }
  const b = clone(OK); b.answers.visit = '주차 불가'; const raw = good(); raw.faqs = [{ question: '주차할 수 있나요?', answer: '주차는 불가합니다.', evidence: ['visit'] }]; assert.equal(normalizeDraft(raw, validateDraftInput(b)).faqs.length, 1);
});

test('all unsupported output yields owner-offer editable minimum with incomplete/review warning', () => {
  const raw = { headline: null, intro: null, sections: [{ heading: '시설', body: '무료주차', evidence: ['keywords'] }], faqs: [], keywords: [] };
  const d = normalizeDraft(raw, validateDraftInput(OK)); assert.ok(d.intro.text.includes(OK.answers.offer)); assert.match(d.intro.text, /미완성/); assert.match(d.intro.text, /의미의 정확성을 보증하지/); assert.equal(d.omittedCount, 3); assert.deepEqual(d.intro.evidence, ['offer']);
});

test('invalid JSON/output schema and empty response are explicit failures without retries; known cost settled and lock released', async () => {
  for (const content of ['not json', '{}', '']) { const store = spyStore(), f = fake(reply(content)); const out = await call(OK, { store, fetcher: f }); assert.equal(out.statusCode, 502); assert.match(out.body.code, /^AI_(FORMAT|EMPTY)$/); assert.equal(f.calls.length, 1); assert.equal(budget(store), 20000); assert.equal(store.touched.filter(([m]) => m === 'unlock').length, 1); }
});

test('provider errors do not leak raw input/output; known failure refunded, unknown cost reservation retained', async () => {
  const logs = []; const oldError = console.error; console.error = (...args) => logs.push(args.join(' '));
  try {
    for (const [response, amount] of [
      [new Response(JSON.stringify({ error: { message: OK.answers.offer } }), { status: 429 }), 0],
      [new Response(JSON.stringify({ error: { message: OK.answers.offer }, usage: { cost: 0.01 } }), { status: 500 }), 10000],
      [new Response(OK.answers.offer, { status: 500 }), 250000],
      [new Response('invalid envelope', { status: 200 }), 250000],
      [reply(good(), {}), 250000],
      [new Error(OK.answers.offer), 250000],
    ]) { const store = spyStore(), f = fake(response); const r = await call(OK, { store, fetcher: f }); assert.ok(r.statusCode >= 500); assert.equal(f.calls.length, 1); assert.equal(budget(store), amount); assert.equal(store.touched.filter(([m]) => m === 'unlock').length, 1); assert.ok(!JSON.stringify(r.body).includes(OK.answers.offer)); }
  } finally { console.error = oldError; }
  assert.ok(!logs.join('\n').includes(OK.answers.offer));
});

test('only new kind limits added; shared global budget but existing report quota unaffected', async () => {
  const l = limits({}); assert.equal(l.ipDaily.pageDraft, UNLIMITED); assert.equal(l.estimateMicro.pageDraft, 250000);
  const { pageDraft: unused, ...oldCounts } = l.ipDaily; const { pageDraft: unused2, ...oldEstimates } = l.estimateMicro;
  assert.deepEqual(oldCounts, { search: UNLIMITED, report: UNLIMITED, research: UNLIMITED }); assert.deepEqual(oldEstimates, { search: 350000, report: 250000, research: 450000 }); assert.equal(l.dailyBudgetMicro, UNLIMITED); assert.equal(l.cacheTtl, 259200); assert.deepEqual(l.cacheTtlByKind, { report: 86400 }); assert.equal(l.lockTtl, 320);
  const env = { ...ENV, MAECHUL_IP_DAILY_REPORTS: '1', MAECHUL_DAILY_BUDGET_USD: '0.3' }; assert.equal(limits(env).ipDaily.report, 1); assert.equal(limits(env).ipDaily.pageDraft, UNLIMITED);
  const store = spyStore(), f = fake(reply(good(), { cost: 0.1 })); assert.equal((await call(OK, { env, store, fetcher: f })).statusCode, 200); assert.equal((await call(OK, { env, store, fetcher: f })).body.code, 'DAILY_BUDGET'); assert.equal(f.calls.length, 1); assert.equal(budget(store), 100000);
});

test('explicit dev mock: validates consent, no external/storage, production ignores MOCK_AI', async () => {
  const store = spyStore(), f = fake(); const env = { MOCK_AI: '1' };
  const out = await call(OK, { env, store, fetcher: f }); assert.equal(out.statusCode, 200); assert.equal(out.body.mock, true); assert.equal(out.body.cached, false); assert.ok(out.body.draft.intro.text.includes(OK.answers.offer)); assert.equal(store.touched.length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await call({ ...OK, consent: false }, { env, store, fetcher: f })).body.code, 'CONSENT');
  const prod = await call(OK, { env: { MOCK_AI: '1', VERCEL_ENV: 'production' }, store, fetcher: f }); assert.equal(prod.statusCode, 503); assert.equal(prod.body.code, 'AI_CONFIG');
});


test('unconfirmed practical claims are omitted even when attributed to unrelated owner answers', () => {
  const input = clone(OK); input.store.verifiedFacts = []; input.answers.visit = ''; input.answers.keywords = '무료주차 반려견 동반 24시간 영업';
  const raw = good(); raw.headline = { text: '김밥과 떡볶이', evidence: ['offer'] }; raw.sections = [
    { heading: '방문 안내', body: '무료주차 가능합니다.', evidence: ['offer'] },
    { heading: '방문 안내', body: '반려견 동반 가능합니다.', evidence: ['offer', 'keywords'] },
    { heading: '영업 안내', body: '24시간 영업합니다.', evidence: ['offer', 'keywords'] },
    { heading: '방문 안내', body: '예약해 주세요.', evidence: ['offer'] },
    { heading: '음식 안내', body: '김밥과 떡볶이를 제공합니다.', evidence: ['offer'] },
  ]; raw.faqs = [];
  const result = normalizeDraft(raw, validateDraftInput(input));
  assert.deepEqual(result.sections.map(x => x.body), ['김밥과 떡볶이를 제공합니다.']);
  assert.equal(result.omittedCount, 4);
});

test('owner negation blocks positive availability while preserving a correctly negative answer', () => {
  for (const no of ['예약 안 받아요', '예약은 받지 않습니다', '예약할 수 없습니다']) {
    assert.equal(contradictsOwner('예약해 주세요.', { visit: no }), true);
  }
  assert.equal(contradictsOwner('주차는 가능하지 않습니다.', { visit: '주차 불가' }), false);
  const input = clone(OK); input.answers.visit = '예약은 받지 않습니다';
  const raw = good(); raw.faqs = [{ question: '예약할 수 있나요?', answer: '예약해 주세요.', evidence: ['visit'] }];
  assert.equal(normalizeDraft(raw, validateDraftInput(input)).faqs.length, 0);
});


test('draft instructions request visitor-facing copy rather than survey commentary', () => {
  assert.match(PAGE_DRAFT_SYSTEM, /실제 손님이 가게 홈페이지에서 읽는 소개글/);
  assert.match(PAGE_DRAFT_SYSTEM, /설문이나 작성 과정을 설명하지 말고/);
});


test('numeric units must come from cited facts rather than reusing a number for another claim', () => {
  const input = clone(OK); input.answers.offer = '김밥 3개를 판매합니다'; input.answers.visit = '';
  const raw = good(); raw.headline = { text: '김밥 판매', evidence: ['offer'] }; raw.intro = { text: '김밥 3개를 판매합니다.', evidence: ['offer'] };
  raw.sections = [{ heading: '이용 안내', body: '김밥은 3시간 보관해요.', evidence: ['offer'] }, { heading: '상품', body: '김밥 3개를 판매합니다.', evidence: ['offer'] }]; raw.faqs = []; raw.keywords = [];
  const d = normalizeDraft(raw, validateDraftInput(input));
  assert.deepEqual(d.sections.map(x => x.body), ['김밥 3개를 판매합니다.']); assert.equal(d.omittedCount, 1);
});

test('contradictory positive claims are not hidden by a separate negative sentence', () => {
  assert.equal(contradictsOwner('주차할 수 없습니다. 주차 가능합니다.', { visit: '주차장은 이용하실 수 없습니다' }), true);
  assert.equal(contradictsOwner('영업합니다.', { visit: '현재 영업하지 않습니다' }), true);
  assert.equal(contradictsOwner('주차는 가능하지 않습니다.', { visit: '주차 불가' }), false);
});
