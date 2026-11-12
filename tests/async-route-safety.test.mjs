import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAccountUI, isDefinitiveRejection } from '../public/account-ui.js';
import { allowOwnerHashChange } from '../public/account-navigation.js';
import { PAY } from '../public/pay-config.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// Execute actual function bodies without booting the app or a payment SDK.
function extracted(name, env) {
  const code = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))?.[0];
  assert.ok(code, `missing function ${name}`);
  return new Function('env', `with (env) { return (${code}); }`)(env);
}
const ID = 'abcdefghijklmnopqrstuv';
const rid = 'r'.repeat(22), token = 't'.repeat(32);
const report = () => ({ rid, token, locked: true });
const pending = () => ({ rid, token, paymentKey: 'test-key', orderId: 'test-order', amount: 100 });
const paid = () => ({ rid, paid: true, locked: false });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const walk = (n, fn) => { if (n && typeof n === 'object') { fn(n); n.children?.forEach(x => walk(x, fn)); } };
function harness() {
  const d = deferred();
  const calls = { route: 0, show: 0, nav: 0, hash: 0, save: 0, toast: [], posts: [] };
  const screen = { nodes: [], nav: [] };
  let hash = '#/report';
  const location = { origin: 'https://example.test', get hash() { return hash; }, set hash(v) { hash = v; calls.hash++; } };
  globalThis.location = location;
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null && x !== false), value: attrs?.value || '', checked: false, handlers: {}, addEventListener(k, fn) { this.handlers[k] = fn; } });
  const env = {
    S: { report: { data: report() }, pendingPay: pending() }, navSeq: 1,
    location, document: { body: { dataset: { page: 'report' } } },
    h, btn: (text, onclick) => h('button', { onclick }, text),
    show: (...nodes) => { calls.show++; screen.nodes = nodes.flat(Infinity); },
    setNavbar: (...nodes) => { calls.nav++; screen.nav = nodes; },
    route: () => { calls.route++; env.navSeq++; screen.nodes = []; },
    save: () => { calls.save++; }, toast: (...args) => calls.toast.push(args),
    confirm: () => true, post: (...args) => { calls.posts.push(args); return d.promise; },
    console: { error() {} }, PAY: { mode: 'test' }, payConsent: true, payBusy: false,
    window: {}, setTimeout: fn => { fn(); },
  };
  for (const name of ['deleteServerCopy', 'reopenReport', 'confirmPayment', 'startPayment', 'paidReportRecoveryLinks', 'paidReportRecoveryCard', 'renderLinked']) env[name] = extracted(name, env);
  const ui = makeAccountUI({ ...env, storeName: {}, confirmFn: () => env.leaveConfirmed,
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ revision: 'a'.repeat(32), data: { name: 'B', address: '서울', headline: 'headline', intro: 'intro', sections: [], faqs: [] } }) }),
  });
  const find = predicate => { let found; screen.nodes.forEach(n => walk(n, x => { if (!found && predicate(x)) found = x; })); return found; };
  async function dirtyEditor() {
    location.hash = `#/my-stores/${ID}`; env.navSeq++; env.document.body.dataset.page = 'account';
    await ui.renderAccountEdit(ID);
    const input = find(x => x.tag === 'input' && x.attrs.type === 'text');
    assert.ok(input); input.value = 'B unsaved input'; input.handlers.input();
    assert.equal(ui.isEditingDirty(), true);
    return { input, nodes: screen.nodes, nav: screen.nav, hash: location.hash, counts: { ...calls, toast: calls.toast.length } };
  }
  function assertUntouched(before) {
    assert.equal(screen.nodes, before.nodes, 'must not replace editor DOM');
    assert.equal(screen.nav, before.nav, 'must not replace editor controls');
    assert.equal(before.input.value, 'B unsaved input');
    assert.equal(ui.isEditingDirty(), true, 'must retain actual account UI dirty state');
    assert.equal(location.hash, before.hash);
    assert.equal(env.document.body.dataset.page, 'account');
    for (const key of ['route', 'show', 'nav', 'hash']) assert.equal(calls[key], before.counts[key], key);
    assert.equal(calls.toast.length, before.counts.toast, 'no stale error/success toast');
  }
  return { d, calls, screen, env, ui, dirtyEditor, assertUntouched };
}

for (const name of ['deleteServerCopy', 'reopenReport', 'confirmPayment']) {
  for (const ok of [true, false]) test(`${name}: late ${ok ? 'success' : 'failure'} leaves dirty owner editor B untouched`, async () => {
    const x = harness();
    const result = x.env[name](report()).then(() => null, e => e);
    const before = await x.dirtyEditor();
    if (ok) x.d.resolve(paid()); else x.d.reject(new Error('server rejected'));
    const error = await result;
    x.assertUntouched(before);
    if (ok) {
      assert.equal(error, null);
      if (name === 'deleteServerCopy') assert.equal(x.env.S.report.data.rid, undefined);
      else assert.equal(x.env.S.report.data.paid, true, 'underlying result still retained');
      if (name === 'confirmPayment') assert.equal(x.env.S.pendingPay, null);
    } else {
      assert.equal(x.env.S.report.data.locked, true);
      if (name === 'reopenReport') assert.match(error.message, /server rejected/); // Caller owns error UI.
      if (name === 'confirmPayment') assert.ok(x.env.S.pendingPay.paymentKey, 'retry data retained');
    }
  });
}

for (const name of ['deleteServerCopy', 'reopenReport', 'confirmPayment']) {
  test(`${name}: same-screen success retains original route behavior`, async () => {
    const x = harness(); const work = x.env[name](report()); x.d.resolve(paid()); await work;
    assert.equal(x.calls.route, 1); assert.equal(x.calls.hash, 0);
    assert.equal(x.calls.save > 0, true);
  });
  test(`${name}: same-screen failure retains original error behavior`, async () => {
    const x = harness(); const result = x.env[name](report()).then(() => null, e => e);
    x.d.reject(new Error('original failure')); const error = await result;
    assert.equal(x.calls.route, 0); assert.equal(x.calls.hash, 0);
    if (name === 'deleteServerCopy') assert.match(x.calls.toast[0][0], /original failure/);
    if (name === 'reopenReport') assert.match(error.message, /original failure/);
    if (name === 'confirmPayment') { assert.equal(x.calls.show, 2); assert.equal(x.screen.nav.length, 2); assert.ok(x.env.S.pendingPay); }
  });
}

test('late confirmation for another report preserves access without replacing local report or editor', async () => {
  const x = harness(); x.env.S.report.data.rid = 'other-report';
  const work = x.env.confirmPayment(); const before = await x.dirtyEditor();
  x.d.resolve({ ...paid(), token: 'returned-token' }); await work; x.assertUntouched(before);
  assert.equal(x.env.S.report.data.rid, 'other-report');
  assert.equal(x.env.S.pendingPay, null);
  const card = x.env.paidReportRecoveryCard();
  assert.equal(card.children[0].children[0].attrs.href, `#/r/${rid}.returned-token`);
  assert.match(source, /paidReportRecoveryCard\(\),/, 'home exposes recovery on the next user visit');
});

test('same-screen confirmation of another report navigates to paid report using token fallback', async () => {
  const x = harness(); x.env.S.report = null;
  const work = x.env.confirmPayment(); x.d.resolve(paid()); await work;
  assert.equal(x.env.location.hash, `#/r/${rid}.${token}`); assert.equal(x.calls.route, 0);
});

test('late confirmation does not clear a newer pending payment', async () => {
  const x = harness(); const work = x.env.confirmPayment(); const newer = { orderId: 'new-order' };
  x.env.S.pendingPay = newer; await x.dirtyEditor(); x.d.resolve(paid()); await work;
  assert.equal(x.env.S.pendingPay, newer);
});

test('delete clears matching recovery link and cancellation sends no request', async () => {
  const x = harness(); x.env.S.paidReportLink = { rid, token };
  const work = x.env.deleteServerCopy(report()); x.d.resolve({ ok: true }); await work;
  assert.equal(x.env.S.paidReportLink, null);
  x.env.confirm = () => false; await x.env.deleteServerCopy(report()); assert.equal(x.calls.posts.length, 1);
});

for (const ok of [true, false]) test(`already-paid order captures navigation before reopen ${ok ? 'success' : 'failure'}`, async () => {
  const x = harness(); const order = deferred(), view = deferred();
  x.env.post = (_p, b) => b.action === 'order' ? order.promise : view.promise;
  const button = { textContent: 'Pay' }; const work = x.env.startPayment(report(), button);
  const before = await x.dirtyEditor(); order.resolve({ paid: true });
  await Promise.resolve();
  if (ok) view.resolve(paid()); else view.reject(new Error('view failed'));
  await work; x.assertUntouched(before); assert.equal(x.env.payBusy, false); assert.equal(button.disabled, false);
});

test('BUSY confirmation retry can finish state recovery after leaving without screen writes', async () => {
  const x = harness(); let attempts = 0;
  x.env.post = () => ++attempts === 1 ? Promise.reject(Object.assign(new Error('busy'), { code: 'BUSY' })) : x.d.promise;
  const work = x.env.confirmPayment(); const before = await x.dirtyEditor();
  x.d.resolve(paid()); await work; x.assertUntouched(before);
  assert.equal(attempts, 2); assert.equal(x.env.S.report.data.paid, true);
});

test('proper unsaved confirmation still permits deliberate user navigation', async () => {
  const x = harness(); await x.dirtyEditor();
  const event = { oldURL: `https://example.test/#/my-stores/${ID}`, newURL: 'https://example.test/#/' };
  const history = { state: null, replaceState: (_s, _t, url) => { x.env.location.hash = new URL(url).hash; } };
  x.env.leaveConfirmed = false; x.env.location.hash = '#/';
  assert.equal(allowOwnerHashChange(event, x.ui, history), false); assert.equal(x.ui.isEditingDirty(), true);
  x.env.leaveConfirmed = true; x.env.location.hash = '#/';
  if (allowOwnerHashChange(event, x.ui, history)) x.env.route();
  assert.equal(x.calls.route, 1); assert.equal(x.ui.isEditingDirty(), false); assert.equal(x.env.location.hash, '#/');
});

function postHarness(fetchImpl) {
  const calls = { timers: [], cleared: [], fetch: [] };
  const env = { AbortController, fetch: (...args) => { calls.fetch.push(args); return fetchImpl(...args); },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; calls.timers.push(timer); return timer; }, clearTimeout: timer => calls.cleared.push(timer),
  };
  return { post: extracted('post', env), calls };
}

test('exact post(): HTTP 401 AUTH retains body/code/status and is a definite account rejection', async () => {
  const x = postHarness(async () => ({ ok: false, status: 401, json: async () => ({ error: '로그인이 필요해요', code: 'AUTH' }) }));
  await assert.rejects(x.post('/api/owner-stores', { action: 'update' }, 20000), e => {
    assert.equal(e.message, '로그인이 필요해요'); assert.equal(e.code, 'AUTH'); assert.equal(e.status, 401);
    assert.equal(isDefinitiveRejection(e), true); return true;
  });
  const [url, options] = x.calls.fetch[0]; assert.equal(url, '/api/owner-stores');
  assert.equal(options.method, 'POST'); assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
  assert.equal(options.body, '{"action":"update"}'); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(x.calls.timers[0].ms, 20000); assert.deepEqual(x.calls.cleared, x.calls.timers);
});

test('post retains success, HTTP fallback, timeout, network and unexpected error handling', async () => {
  const value = { ok: true }; const good = postHarness(async () => ({ ok: true, status: 200, json: async () => value }));
  assert.equal(await good.post('/test', {}, 123), value); assert.deepEqual(good.calls.cleared, good.calls.timers);
  const cases = [
    [async () => ({ ok: false, status: 503, json: async () => { throw new Error('bad JSON'); } }), 'HTTP_503', 503],
    [async () => ({ ok: true, status: 200, json: async () => null }), 'HTTP_200', 200],
    [async () => { throw Object.assign(new Error('abort'), { name: 'AbortError' }); }, 'TIMEOUT', undefined],
    [async () => { throw new TypeError('offline'); }, 'NETWORK', undefined],
  ];
  for (const [fetcher, code, status] of cases) {
    const x = postHarness(fetcher); await assert.rejects(x.post('/test', {}, 123), e => e.code === code && e.status === status);
    assert.deepEqual(x.calls.cleared, x.calls.timers);
  }
  const error = new Error('unexpected'); const x = postHarness(async () => { throw error; });
  await assert.rejects(x.post('/test', {}, 123), e => e === error); assert.deepEqual(x.calls.cleared, x.calls.timers);
});

const recoveryAnchors = env => {
  const anchors = []; walk(env.paidReportRecoveryCard(), node => { if (node.tag === 'a') anchors.push(node); }); return anchors;
};

test('legacy singular recovery remains visible before migration without being overwritten', () => {
  const x = harness(), legacy = { rid: 'legacy-report', token: 'legacy-token' };
  x.env.S.paidReportLink = legacy;
  assert.equal(recoveryAnchors(x.env)[0].attrs.href, '#/r/legacy-report.legacy-token');
  assert.equal(x.env.S.paidReportLink, legacy);
  assert.equal(x.env.S.paidReportLinks, undefined, 'render is read-only');
});

test('two stale confirmations preserve the older singular and every token, survive reload, and all reopen', async () => {
  const x = harness(), first = deferred(), second = deferred();
  const legacy = { rid, token: 'o'.repeat(32) };
  const firstLink = { rid, token }, secondLink = { rid: 's'.repeat(22), token: 'u'.repeat(32) };
  x.env.S.paidReportLink = legacy;
  x.env.S.report.data.rid = 'another-local-report';
  const saved = [];
  x.env.save = () => { x.calls.save++; saved.push(JSON.stringify(x.env.S)); };
  x.env.post = (_path, body) => body.orderId === 'first-order' ? first.promise : second.promise;
  x.env.S.pendingPay = { ...pending(), orderId: 'first-order' };
  const work1 = x.env.confirmPayment();
  x.env.navSeq++;
  x.env.S.pendingPay = { ...pending(), ...secondLink, orderId: 'second-order' };
  const work2 = x.env.confirmPayment();
  const before = await x.dirtyEditor();
  // Reverse completion order: neither completion may replace the other link.
  second.resolve({ ...paid(), ...secondLink }); await work2; x.assertUntouched(before);
  first.resolve({ ...paid(), ...firstLink }); await work1; x.assertUntouched(before);
  assert.equal(x.env.S.paidReportLink, legacy, 'singular legacy entry was not overwritten');
  assert.deepEqual(x.env.S.paidReportLinks, [legacy, secondLink, firstLink]);
  assert.equal(x.env.S.report.data.rid, 'another-local-report');
  assert.equal(x.env.S.pendingPay, null);
  x.env.S = JSON.parse(saved.at(-1)); // Restore persisted local state.
  const anchors = recoveryAnchors(x.env);
  assert.deepEqual(anchors.map(a => a.attrs.href), [legacy, secondLink, firstLink].map(p => `#/r/${p.rid}.${p.token}`));
  assert.equal(new Set(anchors.map(a => a.children.join(''))).size, 3, 'all links have distinct labels');
  const views = [], opened = [];
  x.env.storeName = {};
  x.env.drawReport = data => opened.push({ rid: data.rid, token: data.token });
  x.env.post = async (path, body) => { views.push([path, body]); return { rid: body.rid, paid: true, store: { name: 'Paid report' } }; };
  x.env.leaveConfirmed = true;
  for (const anchor of anchors) {
    const oldURL = `https://example.test/${x.env.location.hash}`;
    x.env.location.hash = anchor.attrs.href;
    assert.equal(allowOwnerHashChange({ oldURL }, x.ui, { replaceState() { throw Error('must not cancel'); } }), true);
    x.env.navSeq++;
    const [, id, accessToken] = /^#\/r\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(anchor.attrs.href);
    await x.env.renderLinked(id, accessToken);
  }
  assert.deepEqual(opened, [legacy, secondLink, firstLink]);
  assert.deepEqual(views.map(([path, body]) => [path, body.action, body.rid, body.token]), [legacy, secondLink, firstLink].map(p => ['/api/pay', 'view', p.rid, p.token]));
  assert.deepEqual(x.env.S.paidReportLinks, [legacy, secondLink, firstLink], 'opening a link does not prune history');
});

test('repeat confirmation dedupes only exact rid/token pairs and retains older tokens', async () => {
  const x = harness(), legacy = { rid, token: 'older-token' }, current = { rid, token };
  x.env.S.paidReportLink = legacy;
  x.env.S.paidReportLinks = [current, { ...legacy }, { ...current }];
  const work = x.env.confirmPayment(); x.d.resolve({ ...paid(), token }); await work;
  assert.deepEqual(x.env.S.paidReportLinks, [legacy, current]);
  assert.equal(x.env.S.paidReportLink, legacy);
  assert.equal(recoveryAnchors(x.env).length, 2);
  assert.equal(x.calls.route, 1, 'same-screen confirmation behavior retained');
});

test('confirmed deletion removes only the deleted report entries, including its older tokens', async () => {
  const x = harness(), legacy = { rid, token: 'older-token' };
  const other = { rid: 'other-report', token }, another = { rid: 'another-report', token: 'another-token' };
  x.env.S.paidReportLink = legacy;
  x.env.S.paidReportLinks = [legacy, { rid, token }, other, another];
  const work = x.env.deleteServerCopy(report()); const before = await x.dirtyEditor();
  x.d.resolve({ ok: true }); await work; x.assertUntouched(before);
  assert.equal(x.env.S.paidReportLink, null);
  assert.deepEqual(x.env.S.paidReportLinks, [other, another]);
  assert.deepEqual(recoveryAnchors(x.env).map(a => a.attrs.href), [other, another].map(p => `#/r/${p.rid}.${p.token}`));
});

test('failed or canceled deletion never removes history; unrelated legacy links survive deletion', async () => {
  for (const outcome of ['cancel', 'failure', 'success']) {
    const x = harness(), legacy = { rid: 'legacy-report', token: 'legacy-token' }, target = { rid, token };
    x.env.S.paidReportLink = legacy; x.env.S.paidReportLinks = [target, { ...legacy }];
    const original = JSON.stringify(x.env.S);
    if (outcome === 'cancel') x.env.confirm = () => false;
    const work = x.env.deleteServerCopy(report());
    if (outcome === 'failure') x.d.reject(new Error('delete failed'));
    if (outcome === 'success') x.d.resolve({ ok: true });
    await work;
    assert.equal(x.env.S.paidReportLink, legacy);
    if (outcome === 'success') assert.deepEqual(x.env.S.paidReportLinks, [legacy]);
    else assert.equal(JSON.stringify(x.env.S), original);
    if (outcome === 'cancel') assert.equal(x.calls.posts.length, 0);
  }
});

test('public payment configuration remains off', () => { assert.equal(PAY.mode, 'off'); });
