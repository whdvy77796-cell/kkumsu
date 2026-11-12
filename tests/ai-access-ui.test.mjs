import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAiAccessPanel, parseAiAccess } from '../public/ai-access-ui.js';

const ID = 'abcdefghijklmnopqrstuv';
const SECRET_ID = 'SECRETsecretSECRET_-12';

function el(tag, attrs, kids) {
  const e = { tag, attrs: attrs || {}, children: [], handlers: {} };
  e.append = (...k) => { e.children.push(...k); };
  e.replaceChildren = (...k) => { e.children = [...k]; };
  e.setAttribute = (n, v) => { e.attrs[n] = String(v); };
  for (const [k, v] of Object.entries(e.attrs)) if (k.startsWith('on') && typeof v === 'function') e.handlers[k.slice(2)] = v;
  e.children.push(...kids);
  return e;
}
const h = (tag, attrs, ...kids) => el(tag, attrs, kids.flat(Infinity).filter((x) => x != null && x !== false));
const text = (n) => (typeof n === 'string' ? n : n.children.map(text).join(' '));
const find = (n, pred, out = []) => { if (typeof n === 'string') return out; if (pred(n)) out.push(n); n.children.forEach((c) => find(c, pred, out)); return out; };
const buttons = (n) => find(n, (x) => x.tag === 'button');
const tick = () => new Promise((r) => setTimeout(r, 0));
const mk = (payload, opts = {}) => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (opts.throws) throw new Error('boom ' + SECRET_ID);
    return { ok: opts.ok !== false, json: async () => payload };
  };
  return { calls, fetcher };
};
const active = (extra = {}) => ({ state: 'active', since: '2026-11-01T00:00:00Z', updatedAt: '2026-11-08T03:00:00Z', lifetime: { verified: 1234, unverified: 5 }, last7Days: { verified: 12, unverified: 0 }, breakdown: [{ provider: 'openai', purpose: 'search', verified: 10, unverified: 1 }], ...extra });

test('site: fetches immediately, same-origin GET, shows loading first', async () => {
  const m = mk(active());
  const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'site' });
  assert.match(text(p), /불러오는 중/);
  await tick();
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].url, '/api/ai-access?view=site');
  assert.equal(m.calls[0].init.method, 'GET');
  assert.equal(m.calls[0].init.credentials, 'same-origin');
  const t = text(p);
  assert.match(t, /여기봐 공개 페이지/);
  assert.match(t, /1,234회/);
  assert.match(t, /확인된 봇/);
  assert.match(t, /미확인 봇 주장/);
  assert.match(t, /인용하거나 추천/);
  assert.match(t, /성공적으로 응답한\(GET\)/);
  assert.match(t, /차단/);
  assert.match(t, /보장하지 않아요/);
  assert.match(t, /집계에는 접속자 IP를 따로 저장하거나 표시하지 않아요/);
  assert.match(t, /질문했는지는 알 수 없고/);
  assert.match(t, /마지막 갱신: 2026년 11월 8일/);
  assert.equal(find(p, (x) => x.tag === 'table').length, 1);
});

test('compact headline shows only verified count, freshness honestly, and expandable details', async () => {
  const m = mk(active({ collectionStartedAt: '2026-10-31T23:21:00Z' }));
  const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'site' });
  await tick();
  const hero = find(p, (x) => x.attrs.class === 'ai-access-hero')[0];
  assert.ok(hero);
  assert.match(text(hero), /1,234\s+회/);
  assert.doesNotMatch(text(hero), /1,239/); // 미확인 주장 5회는 확인된 봇에 합산하지 않는다.
  assert.match(text(hero), /미확인 봇 주장\s+5회/);
  assert.match(text(hero), /첫 집계 2026년 11월 1일부터 누적/);
  assert.match(text(hero), /마지막 집계: 2026년 11월 8일 12:00 \(한국시간\)/);
  assert.doesNotMatch(text(hero), /최근 1분|실시간|지금 1분/);
  const details = find(p, (x) => x.tag === 'details')[0];
  assert.ok(details);
  assert.equal(Object.hasOwn(details.attrs, 'open'), false);
  assert.equal(find(details, (x) => x.tag === 'summary').length, 1);
  assert.match(text(find(details, (x) => x.tag === 'summary')[0]), /추천·인용 횟수가 아니에요/);
  assert.match(text(details), /수집 설정 기준: 2026년 11월 1일 08:21/);
});

test('preview data is explicitly labeled, but production aliases are not', async () => {
  const original=globalThis.location;
  try {
    globalThis.location={hostname:'example-git-preview.vercel.app'};
    const a=makeAiAccessPanel({h,fetcher:mk(active()).fetcher,kind:'site'});assert.match(text(a),/시험 화면이에요/);
    globalThis.location={hostname:'kkumsu-rho.vercel.app'};
    const b=makeAiAccessPanel({h,fetcher:mk(active()).fetcher,kind:'site'});assert.doesNotMatch(text(b),/시험 화면이에요/);
    globalThis.location={hostname:'www.kkumsu.com'};
    const c=makeAiAccessPanel({h,fetcher:mk(active()).fetcher,kind:'site'});assert.doesNotMatch(text(c),/시험 화면이에요/);
    await tick();
  } finally {if(original===undefined) delete globalThis.location;else globalThis.location=original;}
});

test('store: lazy, no fetch until click, validated id, store wording', async () => {
  const m = mk(active());
  const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'store', storeId: ID });
  await tick();
  assert.equal(m.calls.length, 0);
  const [btn] = buttons(p);
  assert.equal(text(btn), '접근 현황 보기');
  btn.handlers.click();
  btn.handlers.click(); // 중복 클릭 무시
  await tick();
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].url, `/api/ai-access?view=store&id=${ID}`);
  assert.match(text(p), /이 가게 페이지/);
  assert.doesNotMatch(text(p), new RegExp(ID));
});

test('store: invalid id never fetches, shows unavailable', async () => {
  for (const bad of [undefined, 'short', ID + 'x', 'abc/../defghijklmnopqrs', 'abcdefghijklmnopqrs&=']) {
    const m = mk(active());
    const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'store', storeId: bad });
    assert.equal(buttons(p).some((b) => text(b) === '접근 현황 보기'), false);
    await tick();
    assert.equal(m.calls.length, 0);
    assert.match(text(p), /확인할 수 없어요/);
  }
});

test('not_started: no counts, no fake zero', async () => {
  const m = mk({ state: 'not_started', since: null, updatedAt: null, lifetime: { verified: 0, unverified: 0 }, last7Days: { verified: 0, unverified: 0 }, breakdown: [] });
  const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'site' });
  await tick();
  const t = text(p);
  assert.match(t, /아직 확인할 수 있는 AI·검색 봇 접근 기록이 없어요/);
  assert.doesNotMatch(t, /\d+회/.source ? /\d+\s*회(?!라는)/ : /x/);
  assert.equal(find(p, (x) => x.tag === 'table').length, 0);
});

test('configured collection time is distinct from first observed event, including before first event', async () => {
  const started='2026-10-31T23:21:00Z';
  const m=mk(active({collectionStartedAt:started}));const p=makeAiAccessPanel({h,fetcher:m.fetcher,kind:'site'});await tick();
  assert.match(text(p),/수집 설정 기준: 2026년 11월 1일 08:21 \(한국시간\)/);
  assert.match(text(p),/첫 집계 기록: 2026년 11월 1일/);
  const n=mk({state:'not_started',collectionStartedAt:started});const q=makeAiAccessPanel({h,fetcher:n.fetcher,kind:'site'});await tick();
  assert.match(text(q),/수집 설정 기준: 2026년 11월 1일 08:21/);assert.match(text(q),/실제 연결 상태에 따라 누락/);
  assert.equal(parseAiAccess(active({collectionStartedAt:'not a date'})),null);
});

test('unavailable state: no counts, retry offered', async () => {
  const m = mk({ state: 'unavailable', lifetime: { verified: 9, unverified: 9 } });
  const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'site' });
  await tick();
  assert.match(text(p), /확인할 수 없어요/);
  assert.doesNotMatch(text(p), /9회/);
  assert.equal(buttons(p).map(text).includes('다시 시도'), true);
});

test('malformed / unexpected responses become unavailable', async () => {
  const bad = [null, 'x', [], {}, { state: 'weird' }, { state: 'active' }, { state: 'active', lifetime: { verified: -1, unverified: 0 } },
    { state: 'active', lifetime: { verified: 1.5, unverified: 0 } }, { state: 'active', lifetime: { verified: '1', unverified: 0 } },
    active({ last7Days: { verified: 1 } }), active({ breakdown: [{ provider: 'evil', purpose: 'search', verified: 1, unverified: 0 }] }),
    active({ breakdown: [{ provider: 'openai', purpose: '<b>', verified: 1, unverified: 0 }] }), active({ since: 'not a date' }), active({ breakdown: 'x' })];
  for (const payload of bad) {
    assert.equal(parseAiAccess(payload), null, JSON.stringify(payload));
    const m = mk(payload);
    const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'site' });
    await tick();
    assert.match(text(p), /확인할 수 없어요/, JSON.stringify(payload));
  }
});

test('http error and thrown error: generic message, no leakage, retry works', async () => {
  for (const opts of [{ ok: false }, { throws: true }]) {
    const m = mk(active(), opts);
    const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'store', storeId: SECRET_ID });
    buttons(p)[0].handlers.click();
    await tick();
    assert.match(text(p), /확인할 수 없어요/);
    assert.doesNotMatch(text(p), /boom|SECRET/);
    const retry = buttons(p).find((b) => text(b) === '다시 시도');
    retry.handlers.click();
    await tick();
    assert.equal(m.calls.length, 2);
    assert.equal(m.calls[1].url, m.calls[0].url);
  }
});

test('limited: lower-bound wording on counts', async () => {
  const m = mk({ state: 'limited', since: null, updatedAt: '2026-11-08T03:00:00Z', lifetime: { verified: 7, unverified: 3 }, last7Days: null, breakdown: [] });
  const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'site' });
  await tick();
  const t = text(p);
  assert.match(t, /최소치/);
  assert.match(text(find(p, (x) => x.attrs.class === 'ai-access-hero')[0]), /최소\s+7\s+회/);
  assert.match(t, /최소 7회/);
  assert.match(t, /최소 3회/);
  assert.match(t, /7일 전체를 확인할 기록이 아직 충분하지 않아요\. 0회라는 뜻이 아니에요/);
});

test('active with real zero shows 0; hostile date string is rejected, not rendered', async () => {
  const m = mk(active({ last7Days: { verified: 0, unverified: 0 } }));
  const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'site' });
  await tick();
  assert.match(text(p), /0회/);
  const evil = mk(active({ updatedAt: '<img src=x onerror=alert(1)>' }));
  const q = makeAiAccessPanel({ h, fetcher: evil.fetcher, kind: 'site' });
  await tick();
  assert.doesNotMatch(text(q), /<img/);
  assert.match(text(q), /확인할 수 없어요/);
});

test('accessibility hooks: labelled region, live status, table headers', async () => {
  const m = mk(active());
  const p = makeAiAccessPanel({ h, fetcher: m.fetcher, kind: 'site' });
  await tick();
  assert.equal(p.tag, 'section');
  assert.ok(p.attrs['aria-labelledby']);
  assert.equal(find(p, (x) => x.attrs.id === p.attrs['aria-labelledby']).length, 1);
  assert.equal(find(p, (x) => x.attrs['aria-live'] === 'polite').length, 1);
  assert.equal(find(p, (x) => x.tag === 'th' && x.attrs.scope === 'col').length, 4);
});
