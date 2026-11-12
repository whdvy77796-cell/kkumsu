import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAccountUI, extractStoreId, loginLinks, buildUpdateData, isValidRevision, formatUpdatedAt, isConflictError, isDefinitiveRejection } from '../public/account-ui.js';

const ID = 'abcdefghijklmnopqrstuv';
globalThis.location = { origin: 'https://example.test', hash: '' };
globalThis.window = { open() {} };
const R1 = 'a'.repeat(32), R2 = 'b'.repeat(32), R5 = '0123456789abcdef0123456789abcdef', R9 = 'f'.repeat(32);

function makeEnv({ post, fetcher }) {
  const st = { shown: [], nav: [] };
  const h = (tag, attrs, ...kids) => {
    const el = { tag, attrs: attrs || {}, children: kids.flat(Infinity).filter((x) => x != null && x !== false), value: attrs?.value ?? '', checked: false, handlers: {}, textContent: undefined };
    el.addEventListener = (n, f) => { el.handlers[n] = f; };
    return el;
  };
  const btn = (label, onclick) => h('button', { onclick }, label);
  const env = { h, btn, post, fetcher, storeName: {}, show: (...k) => { st.shown = k.flat(Infinity); }, setNavbar: (...k) => { st.nav = k.flat(Infinity); } };
  return { st, env };
}
const walk = (n, f) => { if (n && typeof n === 'object') { f(n); (n.children || []).forEach((c) => walk(c, f)); } };
const find = (st, p) => { let r = null; st.shown.forEach((n) => walk(n, (x) => { if (!r && p(x)) r = x; })); return r; };
const findAll = (st, p) => { const r = []; st.shown.forEach((n) => walk(n, (x) => { if (p(x)) r.push(x); })); return r; };
const textOf = (st) => { const t = []; st.shown.forEach((n) => walk(n, (x) => { x.children.forEach((c) => { if (typeof c === 'string') t.push(c); }); if (typeof x.textContent === 'string') t.push(x.textContent); })); return t.join('\n'); };
const click = (st, label) => find(st, (x) => x.tag === 'button' && x.children.join('') === label).attrs.onclick();
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const good = () => ({ name: '테스트', address: '서울', headline: '한 줄', intro: '소개', sections: [{ heading: '메뉴', body: '커피' }], faqs: [{ question: 'q', answer: 'a' }], situations: [{ question: '비 오는 날?', answer: '실내 좌석' }] });

test('extractStoreId accepts id or full urls only', () => {
  assert.equal(extractStoreId(ID), ID);
  assert.equal(extractStoreId(`  https://x.test/stores/${ID}?a=1 `), ID);
  assert.equal(extractStoreId(`https://x.test/#/manage/${ID}`), ID);
  assert.equal(extractStoreId('short'), '');
  assert.equal(extractStoreId(`https://x.test/stores/${ID}extra`), '');
  assert.equal(extractStoreId(null), '');
});

test('loginLinks only for providers reported true', () => {
  assert.deepEqual(loginLinks({ providers: { kakao: true, naver: false } }).map((l) => l.href), ['/api/owner-auth?op=start&provider=kakao&return=dashboard']);
  assert.equal(loginLinks({ providers: { kakao: 'yes' } }).length, 0);
  assert.equal(loginLinks({}).length, 0);
  assert.equal(loginLinks(null).length, 0);
});

test('dashboard logged out: provider anchors, no fake login when none', async () => {
  const urls = [];
  let { st, env } = makeEnv({ post: async () => ({}), fetcher: async (u) => { urls.push(u); return json({ authenticated: false, providers: { kakao: true, naver: true, google: true } }); } });
  await makeAccountUI(env).renderDashboard();
  assert.equal(urls[0], '/api/owner-auth?op=status');
  const anchors = findAll(st, (x) => x.tag === 'a');
  assert.deepEqual(anchors.map((a) => a.attrs.href), ['/api/owner-auth?op=start&provider=kakao&return=dashboard', '/api/owner-auth?op=start&provider=naver&return=dashboard', '/api/owner-auth?op=start&provider=google&return=dashboard']);
  assert.ok(find(st, (x) => x.tag === 'button' && x.children.join('') === '로그인 없이 시작하기'));

  ({ st, env } = makeEnv({ post: async () => ({}), fetcher: async () => json({ authenticated: false, providers: { kakao: false, naver: false } }) }));
  await makeAccountUI(env).renderDashboard();
  assert.equal(findAll(st, (x) => x.tag === 'a').length, 0);
  const t = textOf(st);
  assert.match(t, /준비 중/);
  assert.doesNotMatch(t, /로그인됨/);
});

test('status error is not shown as logged in', async () => {
  const { st, env } = makeEnv({ post: async () => ({}), fetcher: async () => { throw new Error('network down'); } });
  await makeAccountUI(env).renderDashboard();
  assert.match(textOf(st), /network down/);
  assert.doesNotMatch(textOf(st), /로그인됨|로그아웃/);
  const { st: s2, env: e2 } = makeEnv({ post: async () => ({}), fetcher: async () => json({ error: 'x' }, 500) });
  await makeAccountUI(e2).renderDashboard();
  assert.ok(find(s2, (x) => x.tag === 'button' && x.children.join('') === '다시 시도'));
});

test('dashboard logged in: list, XSS text stays text, bad ids skipped, claim flow', async () => {
  const posts = [];
  const evil = '<img src=x onerror=alert(1)>';
  let listCalls = 0;
  const { st, env } = makeEnv({
    post: async (p, b) => { posts.push([p, b]); return { ok: true }; },
    fetcher: async (u) => {
      if (u.includes('op=status')) return json({ authenticated: true, provider: 'kakao', providers: {} });
      listCalls++;
      return json({ stores: [{ id: ID, name: evil, address: 'a', headline: 'h', hidden: true, updatedAt: '2026-11-08' }, { id: '../x', name: 'bad' }] });
    },
  });
  const ui = makeAccountUI(env);
  await ui.renderDashboard();
  assert.equal(findAll(st, (x) => x.attrs?.['data-store-id']).length, 1);
  const h2 = find(st, (x) => x.tag === 'h2' && x.children[0] === evil);
  assert.ok(h2, 'raw string child only (h() inserts as text)');
  assert.equal(find(st, (x) => x.tag === 'a' && x.attrs.href === `/stores/${ID}`).attrs.rel, 'noopener');
  assert.match(textOf(st), /숨겨져/);
  assert.match(textOf(st), /기존 페이지와 주소, 관리 비밀번호는 그대로/);

  // missing inputs -> no post
  click(st, '이 계정에 연결'); await tick();
  assert.equal(posts.length, 0);
  find(st, (x) => x.attrs?.id === 'claim-id').value = `https://example.test/stores/${ID}`;
  click(st, '이 계정에 연결'); await tick();
  assert.equal(posts.length, 0, 'password required');
  find(st, (x) => x.attrs?.id === 'claim-pw').value = 'old-secret';
  // double click must not duplicate
  click(st, '이 계정에 연결'); click(st, '이 계정에 연결'); await tick();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], ['/api/owner-stores', { action: 'claim', id: ID, password: 'old-secret' }]);
  assert.equal(listCalls, 2, 'list reloaded after claim');
  assert.ok(!JSON.stringify(st.shown, (k, v) => (k === 'handlers' || k === 'onclick' ? undefined : v)).includes('old-secret'));
});

test('claim failure shows error, clears password, allows retry', async () => {
  let n = 0;
  const { st, env } = makeEnv({
    post: async () => { n++; throw new Error('비밀번호가 맞지 않아요.'); },
    fetcher: async (u) => (u.includes('op=status') ? json({ authenticated: true, providers: {} }) : json({ stores: [] })),
  });
  await makeAccountUI(env).renderDashboard();
  find(st, (x) => x.attrs?.id === 'claim-id').value = ID;
  const pw = find(st, (x) => x.attrs?.id === 'claim-pw'); pw.value = 'bad';
  click(st, '이 계정에 연결'); await tick();
  assert.equal(n, 1);
  assert.equal(pw.value, '');
  assert.match(textOf(st), /비밀번호가 맞지 않아요/);
  assert.equal(find(st, (x) => x.tag === 'button' && x.children.join('') === '이 계정에 연결').disabled, false);
});

test('logout posts and re-checks status; failure does not claim logout', async () => {
  let authed = true;
  const posts = [];
  const { st, env } = makeEnv({
    post: async (p, b) => { posts.push([p, b]); authed = false; return { ok: true }; },
    fetcher: async (u) => (u.includes('op=status') ? json({ authenticated: authed, providers: { kakao: true } }) : json({ stores: [] })),
  });
  await makeAccountUI(env).renderDashboard();
  click(st, '로그아웃'); await tick();
  assert.deepEqual(posts[0], ['/api/owner-auth?op=logout', {}]);
  assert.ok(findAll(st, (x) => x.tag === 'a').length === 1);

  const f = makeEnv({ post: async () => { throw new Error('fail'); }, fetcher: async (u) => (u.includes('op=status') ? json({ authenticated: true, providers: {} }) : json({ stores: [] })) });
  await makeAccountUI(f.env).renderDashboard();
  click(f.st, '로그아웃'); await tick();
  assert.match(textOf(f.st), /로그아웃되지 않았을 수 있어요/);
});

test('buildUpdateData omits situations entirely and validates', () => {
  const g = good();
  const u = buildUpdateData(g);
  assert.equal(u.error, null);
  assert.equal('situations' in u.data, false);
  assert.deepEqual(Object.keys(u.data), ['name', 'address', 'headline', 'intro', 'sections', 'faqs']);
  // legacy situations with url-like text must not block saving
  const odd = good(); odd.situations = [{ question: 'example.com?', answer: 'x' }];
  assert.equal(buildUpdateData(odd).error, null);
  assert.match(buildUpdateData({ ...g, name: '' }).error, /가게 이름/);
  assert.match(buildUpdateData({ ...g, faqs: Array(13).fill({ question: 'q', answer: 'a' }) }).error, /12/);
});

test('revision, date and conflict helpers', () => {
  assert.ok(isValidRevision(R1) && isValidRevision(R5) && isValidRevision('0'.repeat(32)));
  for (const bad of [undefined, null, '', 'abc', 0, 7, ' x', -1, 1.5, NaN, {}, [], true, 'x'.repeat(201), 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${R1}\n`, ` ${R1}`, `${R1} `, 'a'.repeat(16) + '-' + 'a'.repeat(15), 'a'.repeat(64)]) assert.equal(isValidRevision(bad), false, String(bad));
  const f = formatUpdatedAt('2026-11-08T03:04:05Z');
  assert.match(f, /2026/); assert.match(f, /12:04|12시|12:04/); assert.doesNotMatch(f, /T03|Z$/);
  assert.match(formatUpdatedAt(Date.UTC(2026, 10, 8, 3, 4)), /2026/);
  assert.match(formatUpdatedAt(Math.floor(Date.UTC(2026, 10, 8) / 1000)), /2026/);
  for (const bad of ['', 'garbage', null, undefined, {}, NaN]) assert.equal(formatUpdatedAt(bad), '');
  assert.ok(isConflictError({ status: 409 }) && isConflictError({ code: 'HTTP_409' }) && isConflictError({ code: 'REVISION_CONFLICT' }));
  assert.ok(!isConflictError({ code: 'HTTP_500' }) && !isConflictError(null) && !isConflictError({ code: 'HTTP_4090' }));
});

async function openEdit(data, postImpl, readImpl) {
  const posts = [];
  const { st, env } = makeEnv({
    post: async (p, b) => { posts.push([p, b]); return postImpl ? postImpl(b) : { ok: true, revision: R2, data: data ? { ...data, ...(b.data.situations ? { situations: b.data.situations } : {}) } : undefined }; },
    fetcher: readImpl || (async () => json({ id: ID, data, revision: R1, hidden: false, updatedAt: '2026-11-08T03:04:05Z' })),
  });
  await makeAccountUI(env).renderAccountEdit(ID);
  return { st, posts, env };
}

test('edit: requires confirmation, sends exact update, legacy preserved, no password', async () => {
  const { st, posts } = await openEdit(good());
  const t = textOf(st);
  assert.match(t, /사진 기능 준비 중/);
  assert.match(t, /다르면/);
  assert.ok(findAll(st, (x) => x.tag === 'input' && x.attrs.type === 'password').length === 0);
  find(st, (x) => x.attrs?.id === 'acc-name').value = '새 이름';
  find(st, (x) => x.attrs?.id === 'acc-name').handlers.input();
  click(st, '변경사항 반영하기'); await tick();
  assert.equal(posts.length, 0, 'needs confirmation');
  find(st, (x) => x.attrs?.id === 'acc-confirm').checked = true;
  click(st, '변경사항 반영하기'); click(st, '변경사항 반영하기'); await tick();
  assert.equal(posts.length, 1, 'no duplicate submit');
  assert.equal(posts[0][0], '/api/owner-stores');
  assert.equal(posts[0][1].action, 'update');
  assert.equal(posts[0][1].id, ID);
  assert.equal(posts[0][1].consent, true);
  assert.equal(posts[0][1].data.name, '새 이름');
  assert.equal('situations' in posts[0][1].data, false, 'situations omitted so server keeps latest');
  assert.equal(posts[0][1].expectedRevision, R1);
  assert.equal('password' in posts[0][1], false);
  assert.match(textOf(st), /반영했어요/);
});

const SAVE = '변경사항 반영하기';
const type = (st, id, v) => { const el = find(st, (x) => x.attrs?.id === id); el.value = v; el.handlers.input(); };
const check = (st, id) => { find(st, (x) => x.attrs?.id === id).checked = true; };

test('missing/malformed revision makes editing unavailable (no blind save)', async () => {
  for (const revision of [undefined, null, '', -3, {}, 1.2, 5, 'abc', 'r1', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${R1} `, [R1]]) {
    const r = await openEdit(null, null, async () => json({ id: ID, data: good(), revision }));
    assert.match(textOf(r.st), /수정할 수 없어요/);
    assert.equal(find(r.st, (x) => x.attrs?.id === 'acc-name'), null);
    assert.equal(find(r.st, (x) => x.tag === 'button' && x.children.join('') === SAVE), null);
  }
});

test('stale version (409): warns, keeps unsaved input, does not overwrite, needs latest + explicit overwrite consent', async () => {
  let reads = 0;
  const posts = [];
  const { st, env } = makeEnv({
    post: async (p, b) => {
      posts.push(b);
      if (posts.length === 1) { const e = new Error('conflict'); e.status = 409; e.code = 'HTTP_409'; throw e; }
      return { revision: R9, data: good() };
    },
    fetcher: async () => { reads++; const d = good(); if (reads > 1) d.name = '다른 기기에서 바꾼 이름'; return json({ id: ID, data: d, revision: reads > 1 ? R5 : R1 }); },
  });
  const ui = makeAccountUI(env);
  await ui.renderAccountEdit(ID);
  type(st, 'acc-name', '내가 고친 이름');
  type(st, 'acc-intro', '내 소개');
  check(st, 'acc-confirm');
  click(st, SAVE); await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].expectedRevision, R1);
  assert.match(textOf(st), /먼저 바뀌었어요/);
  assert.ok(find(st, (x) => x.attrs?.['data-conflict'] === 'conflict'));
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-name').value, '내가 고친 이름', 'unsaved input preserved');
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-intro').value, '내 소개');
  assert.equal(ui.isEditingDirty(), true);
  // save is blocked until latest is loaded
  assert.equal(find(st, (x) => x.tag === 'button' && x.children.join('') === SAVE).disabled, true);
  click(st, SAVE); await tick();
  assert.equal(posts.length, 1);
  click(st, '서버 최신 내용 불러와 비교하기'); await tick();
  assert.match(textOf(st), /다른 기기에서 바꾼 이름/);
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-name').value, '내가 고친 이름', 'still not overwritten by latest');
  assert.equal(ui.isEditingDirty(), true);
  // overwrite needs separate consent
  check(st, 'acc-confirm');
  click(st, SAVE); await tick();
  assert.equal(posts.length, 1, 'no overwrite without consent');
  check(st, 'acc-overwrite'); check(st, 'acc-confirm');
  click(st, SAVE); await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expectedRevision, R5, 'uses the latest revision the owner reviewed');
  assert.equal(posts[1].data.name, '내가 고친 이름');
  assert.equal(ui.isEditingDirty(), false, 'cleared only after verified success');
});

test('conflict code variants and non-conflict errors', async () => {
  const r = await openEdit(good(), () => { const e = new Error('x'); e.code = 'REVISION_CONFLICT'; throw e; });
  type(r.st, 'acc-name', 'n'); check(r.st, 'acc-confirm');
  click(r.st, SAVE); await tick();
  assert.ok(find(r.st, (x) => x.attrs?.['data-conflict']));
  const s = await openEdit(good(), () => { const e = new Error('서버 오류'); e.code = 'HTTP_400'; throw e; });
  type(s.st, 'acc-name', 'n'); check(s.st, 'acc-confirm');
  click(s.st, SAVE); await tick();
  assert.equal(find(s.st, (x) => x.attrs?.['data-conflict']), null);
  assert.match(textOf(s.st), /서버 오류/);
});

test('malformed revision in update response or latest read is rejected', async () => {
  for (const revision of [undefined, 5, 'abc', 'A'.repeat(32), 'a'.repeat(31)]) {
    const { st, env } = makeEnv({ post: async () => ({ revision }), fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
    const ui = makeAccountUI(env);
    await ui.renderAccountEdit(ID);
    type(st, 'acc-name', 'n'); check(st, 'acc-confirm');
    click(st, SAVE); await tick();
    assert.equal(ui.isEditingDirty(), true);
    assert.ok(find(st, (x) => x.attrs?.['data-conflict'] === 'unverified'));
  }
  // malformed revision on the 'latest' read after a conflict is not accepted either
  let reads = 0;
  const { st, env } = makeEnv({
    post: async () => { const e = new Error('c'); e.status = 409; throw e; },
    fetcher: async () => json({ id: ID, data: good(), revision: ++reads === 1 ? R1 : 'zzz' }),
  });
  await makeAccountUI(env).renderAccountEdit(ID);
  type(st, 'acc-name', 'n'); check(st, 'acc-confirm'); click(st, SAVE); await tick();
  click(st, '서버 최신 내용 불러와 비교하기'); await tick();
  assert.equal(find(st, (x) => x.attrs?.['data-latest']), null);
  assert.equal(find(st, (x) => x.tag === 'button' && x.children.join('') === SAVE).disabled, true);
});

test('timeout/network/5xx/unknown update errors: no blind resubmit; 4xx stays editable', async () => {
  const mkErr = (code, status) => () => { const e = new Error('err'); e.code = code; if (status) e.status = status; throw e; };
  for (const [code, status] of [['TIMEOUT'], ['NETWORK'], ['HTTP_500'], ['HTTP_503'], ['SOMETHING_ELSE'], [undefined]]) {
    const posts = [];
    const { st, env } = makeEnv({ post: async (p, b) => { posts.push(b); mkErr(code, status)(); }, fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
    const ui = makeAccountUI(env);
    await ui.renderAccountEdit(ID);
    type(st, 'acc-name', 'mine'); check(st, 'acc-confirm');
    click(st, SAVE); await tick();
    assert.ok(find(st, (x) => x.attrs?.['data-conflict'] === 'unverified'), String(code));
    assert.equal(find(st, (x) => x.tag === 'button' && x.children.join('') === SAVE).disabled, true);
    check(st, 'acc-confirm'); click(st, SAVE); await tick();
    assert.equal(posts.length, 1, 'no blind resubmit');
    assert.equal(find(st, (x) => x.attrs?.id === 'acc-name').value, 'mine');
    assert.equal(ui.isEditingDirty(), true);
  }
  // definitive validation errors remain editable and retryable
  for (const [code, status] of [['HTTP_400'], ['VALIDATION_ERROR'], [undefined, 422]]) {
    const posts = [];
    const { st, env } = makeEnv({ post: async (p, b) => { posts.push(b); if (posts.length === 1) mkErr(code, status)(); return { revision: R2, data: good() }; }, fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
    await makeAccountUI(env).renderAccountEdit(ID);
    type(st, 'acc-name', 'mine'); check(st, 'acc-confirm');
    click(st, SAVE); await tick();
    assert.equal(find(st, (x) => x.attrs?.['data-conflict']), null);
    check(st, 'acc-confirm'); click(st, SAVE); await tick();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].expectedRevision, R1, 'same revision: nothing was committed');
  }
  assert.ok(isDefinitiveRejection({ code: 'HTTP_400' }) && isDefinitiveRejection({ status: 422 }) && isDefinitiveRejection({ code: 'HTTP_403' }));
  assert.ok(!isDefinitiveRejection({ code: 'TIMEOUT' }) && !isDefinitiveRejection({ code: 'NETWORK' }) && !isDefinitiveRejection({ code: 'HTTP_502' }) && !isDefinitiveRejection({}) && !isDefinitiveRejection(null) && !isDefinitiveRejection({ status: 409 }));
});

test('after ambiguous failure, retry requires latest read + explicit overwrite consent; unchanged revision is reported', async () => {
  let n = 0;
  const posts = [];
  const { st, env } = makeEnv({
    post: async (p, b) => { posts.push(b); if (posts.length === 1) { const e = new Error('t'); e.code = 'TIMEOUT'; throw e; } return { revision: R9, data: good() }; },
    fetcher: async () => { n++; return json({ id: ID, data: good(), revision: R1 }); },
  });
  const ui = makeAccountUI(env);
  await ui.renderAccountEdit(ID);
  type(st, 'acc-name', 'mine'); check(st, 'acc-confirm'); click(st, SAVE); await tick();
  click(st, '서버 최신 내용 불러와 비교하기'); await tick();
  assert.match(textOf(st), /서버 버전이 그대로예요\. 이전 요청이 아직 처리 중일 수도 있어요/);
  check(st, 'acc-confirm'); click(st, SAVE); await tick();
  assert.equal(posts.length, 1, 'needs overwrite consent');
  check(st, 'acc-overwrite'); check(st, 'acc-confirm'); click(st, SAVE); await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expectedRevision, R1);
  assert.equal(ui.isEditingDirty(), false);
});

test('typing while a save is in flight is never lost or falsely marked saved', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const posts = [];
  const { st, env } = makeEnv({ post: async (p, b) => { posts.push(b); await gate; return { revision: R2, data: good() }; }, fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
  const ui = makeAccountUI(env);
  await ui.renderAccountEdit(ID);
  type(st, 'acc-name', '보낸 이름'); check(st, 'acc-confirm');
  click(st, SAVE);
  assert.equal(posts[0].data.name, '보낸 이름');
  // user keeps typing while the request is pending: confirmation is revoked, still dirty
  type(st, 'acc-name', '보낸 이름 + 나중에 친 글');
  type(st, 'acc-intro', '나중 소개');
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-confirm').checked, false);
  release(); await tick();
  assert.equal(posts.length, 1);
  assert.equal(ui.isEditingDirty(), true, 'later typing not marked saved');
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-name').value, '보낸 이름 + 나중에 친 글');
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-intro').value, '나중 소개');
  assert.match(textOf(st), /새로 고친 내용이 있어요/);
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-confirm').checked, false, 'must re-confirm');
  // second save uses the newly returned revision and the later edits
  click(st, SAVE); await tick();
  assert.equal(posts.length, 1, 'blocked without re-confirmation');
  check(st, 'acc-confirm'); click(st, SAVE); await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expectedRevision, R2);
  assert.equal(posts[1].data.intro, '나중 소개');
  assert.equal(ui.isEditingDirty(), false);
});

test('success without a valid new revision stays dirty and blocks blind re-save', async () => {
  const holder = {};
  const posts = [];
  const { st, env } = makeEnv({ post: async (p, b) => { posts.push(b); return { ok: true }; }, fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
  const ui = makeAccountUI(env); holder.ui = ui;
  await ui.renderAccountEdit(ID);
  type(st, 'acc-name', 'n'); check(st, 'acc-confirm');
  click(st, SAVE); await tick();
  assert.equal(ui.isEditingDirty(), true);
  assert.ok(find(st, (x) => x.attrs?.['data-conflict'] === 'unverified'));
  assert.equal(find(st, (x) => x.tag === 'button' && x.children.join('') === SAVE).disabled, true);
});

test('dirty guard: isEditingDirty/confirmLeave, nav buttons, add/remove, unload warning', async () => {
  const asked = [];
  let answer = false;
  const listeners = {};
  globalThis.addEventListener = (n, f) => { listeners[n] = f; };
  const { st, env } = makeEnv({ post: async () => ({ revision: R2, data: good() }), fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
  env.confirmFn = (m) => { asked.push(m); return answer; };
  const ui = makeAccountUI(env);
  delete globalThis.addEventListener;
  await ui.renderAccountEdit(ID);
  assert.equal(ui.isEditingDirty(), false);
  assert.equal(ui.confirmLeave(), true);
  assert.equal(asked.length, 0);
  const ev = { preventDefault() { this.prevented = true; }, returnValue: undefined };
  listeners.beforeunload(ev); assert.ok(!ev.prevented, 'no warning while clean');
  click(st, '질문 추가');
  assert.equal(ui.isEditingDirty(), true, 'add marks dirty');
  const ev2 = { preventDefault() { this.prevented = true; }, returnValue: undefined };
  listeners.beforeunload(ev2);
  assert.ok(ev2.prevented && ev2.returnValue === '', 'unload warned');
  location.hash = '#/my-stores/' + ID;
  const navBtn = st.nav.find((b) => b.children.join('') === '내 가게 목록');
  navBtn.attrs.onclick();
  assert.equal(asked.length, 1);
  assert.equal(location.hash, '#/my-stores/' + ID, 'declined: stays');
  assert.equal(ui.confirmLeave(), false);
  answer = true;
  navBtn.attrs.onclick();
  assert.equal(location.hash, '#/my-stores', 'accepted: navigates');
  assert.equal(ui.isEditingDirty(), false);
  location.hash = '';

  // remove and typing mark dirty; no confirm function => safe default is to stay
  const { st: s2, env: e2 } = makeEnv({ post: async () => ({ revision: R2, data: good() }), fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
  const ui2 = makeAccountUI(e2);
  await ui2.renderAccountEdit(ID);
  click(s2, '이 질문 삭제');
  assert.equal(ui2.isEditingDirty(), true);
  assert.equal(ui2.confirmLeave(), false);
  const { st: s3, env: e3 } = makeEnv({ post: async () => ({ revision: R2, data: good() }), fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
  const ui3 = makeAccountUI(e3);
  await ui3.renderAccountEdit(ID);
  type(s3, 'acc-headline', 'x');
  assert.equal(ui3.isEditingDirty(), true);
  check(s3, 'acc-confirm'); click(s3, SAVE); await tick();
  assert.equal(ui3.isEditingDirty(), false, 'cleared after verified save');
});

test('updatedAt shown as readable date on dashboard, unreadable omitted', async () => {
  const { st, env } = makeEnv({ post: async () => ({}), fetcher: async (u) => (u.includes('op=status') ? json({ authenticated: true, providers: {} }) : json({ stores: [{ id: ID, name: 'n', updatedAt: '2026-11-08T03:04:05Z' }, { id: 'bbbbbbbbbbbbbbbbbbbbbb', name: 'm', updatedAt: 'zzz' }] })) });
  await makeAccountUI(env).renderDashboard();
  const t = textOf(st);
  assert.match(t, /마지막 수정: .*2026/);
  assert.doesNotMatch(t, /T03:04|zzz/);
  assert.equal((t.match(/마지막 수정/g) || []).length, 1);
});

test('edit: add hours/menu sections, FAQ add/remove up to 12', async () => {
  const { st, posts } = await openEdit(good());
  click(st, '영업시간 항목 추가');
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-s1-h').value, '영업시간');
  click(st, '메뉴·가격 항목 추가');
  assert.equal(find(st, (x) => x.attrs?.id === 'acc-s2-h').value, '메뉴·가격');
  for (let i = 0; i < 20; i++) click(st, '질문 추가');
  assert.equal(findAll(st, (x) => x.tag === 'button' && x.children.join('') === '이 질문 삭제').length, 12);
  assert.equal(find(st, (x) => x.tag === 'button' && x.children.join('') === '질문 추가').disabled, undefined);
  // blank new entries must fail validation, not post
  find(st, (x) => x.attrs?.id === 'acc-confirm').checked = true;
  click(st, '변경사항 반영하기'); await tick();
  assert.equal(posts.length, 0);
  assert.match(textOf(st), /입력해 주세요/);
  for (let i = 0; i < 11; i++) click(st, '이 질문 삭제');
  assert.equal(findAll(st, (x) => x.tag === 'button' && x.children.join('') === '이 질문 삭제').length, 1);
});

test('edit: server error shown, unauthenticated read, invalid id, XSS as text', async () => {
  let r = await openEdit(good(), () => { const e = new Error('저장 실패'); e.code = 'HTTP_400'; throw e; });
  find(r.st, (x) => x.attrs?.id === 'acc-confirm').checked = true;
  click(r.st, '변경사항 반영하기'); await tick();
  assert.match(textOf(r.st), /저장 실패/);
  assert.equal(find(r.st, (x) => x.tag === 'button' && x.children.join('') === '변경사항 반영하기').disabled, undefined, 'new button, enabled');

  r = await openEdit(null, null, async () => json({ error: 'no' }, 401));
  assert.match(textOf(r.st), /로그인이 필요해요/);
  r = await openEdit(null, null, async () => json({ id: ID, data: { name: 1 } }));
  assert.match(textOf(r.st), /형식이 올바르지 않아요/);

  const { st, env } = makeEnv({ post: async () => ({}), fetcher: async () => { throw new Error('should not fetch'); } });
  await makeAccountUI(env).renderAccountEdit('../bad');
  assert.match(textOf(st), /올바르지 않아요/);

  const evil = good(); evil.name = '<script>alert(1)</script>';
  r = await openEdit(evil);
  const input = find(r.st, (x) => x.attrs?.id === 'acc-name');
  assert.equal(input.value, '<script>alert(1)</script>');
  assert.equal(input.children.length, 0, 'value property, not markup');
});

test('stale response does not overwrite newer screen', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  let call = 0;
  const { st, env } = makeEnv({
    post: async () => ({}),
    fetcher: async () => { call++; if (call === 1) { await gate; return json({ authenticated: true, providers: {} }); } return json({ authenticated: false, providers: { naver: true } }); },
  });
  const ui = makeAccountUI(env);
  const first = ui.renderDashboard();
  await ui.renderDashboard();
  release(); await first; await tick();
  assert.equal(findAll(st, (x) => x.tag === 'a').length, 1);
  assert.doesNotMatch(textOf(st), /로그아웃/);
});

test('late response after navigation does not overwrite the new route', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  location.hash = '#/my-stores';
  const { st, env } = makeEnv({ post: async () => ({}), fetcher: async () => { await gate; return json({ authenticated: true, providers: {} }); } });
  const p = makeAccountUI(env).renderDashboard();
  st.shown = ['OTHER-ROUTE'];
  location.hash = '#/somewhere-else';
  release(); await p; await tick();
  assert.deepEqual(st.shown, ['OTHER-ROUTE']);
  location.hash = '';
});

test('edit save response after navigation does not redraw over other route', async () => {
  location.hash = '#/account/edit/x';
  let release;
  const gate = new Promise((res) => { release = res; });
  const { st, posts } = await openEdit(good(), () => gate);
  find(st, (x) => x.attrs?.id === 'acc-confirm').checked = true;
  click(st, '변경사항 반영하기');
  st.shown = ['OTHER-ROUTE'];
  location.hash = '#/elsewhere';
  release({ ok: true }); await tick();
  assert.equal(posts.length, 1);
  assert.deepEqual(st.shown, ['OTHER-ROUTE']);
  location.hash = '';
});

test('unlink UI hidden by default; with support needs explicit confirmation and states what it does not do', async () => {
  const mk = (support) => {
    const posts = [];
    const r = makeEnv({
      post: async (p, b) => { posts.push([p, b]); return { ok: true }; },
      fetcher: async (u) => (u.includes('op=status') ? json({ authenticated: true, providers: {} }) : json({ stores: [{ id: ID, name: 'n' }] })),
    });
    r.env.supportsUnlink = support;
    return { ...r, posts };
  };
  let r = mk(false);
  await makeAccountUI(r.env).renderDashboard();
  assert.equal(find(r.st, (x) => x.tag === 'button' && /연결 해제/.test(x.children.join(''))), null);

  r = mk(true);
  await makeAccountUI(r.env).renderDashboard();
  const panel = find(r.st, (x) => x.attrs?.hidden === true);
  assert.ok(panel);
  click(r.st, '계정에서 연결 해제…');
  assert.equal(panel.attrs.hidden, true, 'panel starts hidden');
  assert.match(textOf(r.st), /삭제되지 않고[\s\S]*비밀번호도 바뀌거나 삭제되지 않아요/);
  click(r.st, '연결 해제하기'); await tick();
  assert.equal(r.posts.length, 0, 'needs checkbox');
  find(r.st, (x) => x.attrs?.id === `unlink-ok-${ID}`).checked = true;
  click(r.st, '연결 해제하기'); click(r.st, '연결 해제하기'); await tick();
  assert.deepEqual(r.posts, [['/api/owner-stores', { action: 'unlink', id: ID }]]);
});

test('draft resume link: shown on logged-out and logged-in dashboards only for the 3 allowed hashes', async () => {
  const LABEL = '이 탭에서 작성 중인 초안으로 돌아가기';
  const run = async (authed, resume) => {
    const { st, env } = makeEnv({ post: async () => ({}), fetcher: async (u) => (u.includes('op=status') ? json({ authenticated: authed, providers: { kakao: true } }) : json({ stores: [] })) });
    env.getDraftResume = resume;
    await makeAccountUI(env).renderDashboard();
    return st;
  };
  for (const authed of [false, true]) {
    for (const hash of ['#/page-preview', '#/page-edit', '#/page-publish']) {
      const st = await run(authed, () => hash);
      const a = find(st, (x) => x.tag === 'a' && x.children.join('') === LABEL);
      assert.ok(a, `${authed} ${hash}`);
      assert.equal(a.attrs.href, hash);
      assert.equal(a.attrs.target, undefined);
      assert.match(textOf(st), /이 탭에만 있어요[\s\S]*클라우드에 저장되지 않았/);
    }
    for (const bad of ['#/page-previewX', '#/page-preview?x=1', 'https://evil.test/', 'javascript:alert(1)', '//evil.test', '#/manage/abc', '#/page-edit ', '', null, undefined, 5, ['#/page-edit'], {}]) {
      const st = await run(authed, () => bad);
      assert.equal(find(st, (x) => x.attrs?.['data-draft-resume']), null, String(bad));
      assert.doesNotMatch(textOf(st), /작성 중인 초안/);
    }
    const thrown = await run(authed, () => { throw new Error('boom'); });
    assert.equal(find(thrown, (x) => x.attrs?.['data-draft-resume']), null);
    const none = await run(authed, undefined);
    assert.equal(find(none, (x) => x.attrs?.['data-draft-resume']), null);
  }
});

// ───────── situations (예상 질문) editing
const tx = (st, id) => find(st, (x) => x.attrs?.id === id);
const sitCount = (st) => findAll(st, (x) => x.tag === 'button' && x.children.join('') === '이 예상 질문 삭제').length;

test('situations: section only for records that already have the field; unchanged/reverted are omitted', async () => {
  const noField = good(); delete noField.situations;
  const a = await openEdit(noField);
  assert.equal(find(a.st, (x) => x.attrs?.['data-situations']), null);
  assert.equal(find(a.st, (x) => x.tag === 'button' && x.children.join('') === '예상 질문 추가'), null);

  const b = await openEdit(good());
  assert.ok(find(b.st, (x) => x.attrs?.['data-situations']));
  assert.equal(sitCount(b.st), 1);
  // edit and then revert exactly: still omitted
  type(b.st, 'acc-t0-q', '바뀐 질문'); type(b.st, 'acc-t0-q', good().situations[0].question);
  type(b.st, 'acc-name', '이름만 변경'); check(b.st, 'acc-confirm');
  click(b.st, SAVE); await tick();
  assert.equal(b.posts.length, 1);
  assert.equal('situations' in b.posts[0][1].data, false);
  assert.equal(b.posts[0][1].data.name, '이름만 변경');

  const empty = good(); empty.situations = [];
  const c = await openEdit(empty);
  assert.ok(find(c.st, (x) => x.attrs?.['data-situations']), 'field present as [] still shows section');
  type(c.st, 'acc-name', 'n'); check(c.st, 'acc-confirm'); click(c.st, SAVE); await tick();
  assert.equal('situations' in c.posts[0][1].data, false);
});

test('situations: edit/add/delete send exact validated pairs; delete-all sends explicit []', async () => {
  let r = await openEdit(good());
  type(r.st, 'acc-t0-q', '  새 질문  '); type(r.st, 'acc-t0-a', '새 답변');
  click(r.st, '예상 질문 추가');
  type(r.st, 'acc-t1-q', '둘째 질문'); type(r.st, 'acc-t1-a', '둘째 답변');
  check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.deepEqual(r.posts[0][1].data.situations, [{ question: '새 질문', answer: '새 답변' }, { question: '둘째 질문', answer: '둘째 답변' }]);
  assert.equal(r.posts[0][1].expectedRevision, R1);

  r = await openEdit(good());
  click(r.st, '이 예상 질문 삭제');
  assert.equal(sitCount(r.st), 0);
  check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.deepEqual(r.posts[0][1].data.situations, [], 'explicit [] for deletion');
  assert.ok('situations' in r.posts[0][1].data);
  // after a successful save the new baseline is []: next unrelated save omits it again
  type(r.st, 'acc-name', 'zz'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.equal(r.posts.length, 2);
  assert.equal('situations' in r.posts[1][1].data, false);
  assert.equal(r.posts[1][1].expectedRevision, R2);

  // max 8
  r = await openEdit(good());
  for (let i = 0; i < 20; i++) click(r.st, '예상 질문 추가');
  assert.equal(sitCount(r.st), 8);
});

test('situations: invalid pairs are rejected before any request', async () => {
  const cases = [
    [(st) => { type(st, 'acc-t0-a', '   '); }, /입력해 주세요/],
    [(st) => { type(st, 'acc-t0-q', ''); }, /입력해 주세요/],
    [(st) => { type(st, 'acc-t0-q', 'q'.repeat(301)); }, /300/],
    [(st) => { type(st, 'acc-t0-a', 'a'.repeat(2001)); }, /2000/],
    [(st) => { type(st, 'acc-t0-a', '자세한 내용은 example.com 에서'); }, /웹 주소/],
    [(st) => { click(st, '예상 질문 추가'); }, /입력해 주세요/],
  ];
  for (const [mutate, re] of cases) {
    const r = await openEdit(good());
    mutate(r.st); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
    assert.equal(r.posts.length, 0, String(re));
    assert.match(textOf(r.st), re);
  }
});

test('situations: legacy invalid text does not block saving other fields (omitted)', async () => {
  const odd = good(); odd.situations = [{ question: 'example.com?', answer: 'http://x.test' }];
  const r = await openEdit(odd);
  type(r.st, 'acc-name', 'ok'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.equal(r.posts.length, 1);
  assert.equal('situations' in r.posts[0][1].data, false);
});

test('situations: conflict latest preview shows situations and overwrite warning only when edited', async () => {
  const latestData = good(); latestData.situations = [{ question: '서버의 최신 예상 질문', answer: '서버의 최신 답' }];
  let reads = 0;
  const mk = async (edit) => {
    reads = 0;
    const { st, env } = makeEnv({
      post: async () => { const e = new Error('c'); e.status = 409; throw e; },
      fetcher: async () => { reads++; return json({ id: ID, data: reads === 1 ? good() : latestData, revision: reads === 1 ? R1 : R5 }); },
    });
    const ui = makeAccountUI(env);
    await ui.renderAccountEdit(ID);
    if (edit) type(st, 'acc-t0-q', '내가 고친 예상 질문'); else type(st, 'acc-name', 'n');
    check(st, 'acc-confirm'); click(st, SAVE); await tick();
    click(st, '서버 최신 내용 불러와 비교하기'); await tick();
    return st;
  };
  let st = await mk(true);
  assert.ok(find(st, (x) => x.attrs?.['data-latest-situations']));
  assert.match(textOf(st), /서버의 최신 예상 질문/);
  assert.match(textOf(st), /통째로 내 값으로 바뀝니다/);
  assert.equal(tx(st, 'acc-t0-q').value, '내가 고친 예상 질문', 'my edit preserved');
  st = await mk(false);
  assert.match(textOf(st), /서버의 최신 예상 질문/);
  assert.doesNotMatch(textOf(st), /통째로 내 값으로 바뀝니다/);
  assert.match(textOf(st), /보내지 않고 서버의 값이 그대로 유지/);
});

test('situations: conflict overwrite sends my edited pairs with the reviewed revision; unedited omits them', async () => {
  const posts = [];
  const { st, env } = makeEnv({
    post: async (p, b) => { posts.push(b); if (posts.length === 1) { const e = new Error('c'); e.status = 409; throw e; } return { revision: R9 }; },
    fetcher: async () => json({ id: ID, data: good(), revision: posts.length ? R5 : R1 }),
  });
  const ui = makeAccountUI(env);
  await ui.renderAccountEdit(ID);
  type(st, 'acc-t0-a', '내 답변'); check(st, 'acc-confirm'); click(st, SAVE); await tick();
  click(st, '서버 최신 내용 불러와 비교하기'); await tick();
  check(st, 'acc-overwrite'); check(st, 'acc-confirm'); click(st, SAVE); await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expectedRevision, R5);
  assert.deepEqual(posts[1].data.situations, [{ question: good().situations[0].question, answer: '내 답변' }]);
  assert.equal(ui.isEditingDirty(), false);
});

test('situations: typing during an in-flight save is kept; baseline follows what the server accepted', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const posts = [];
  const { st, env } = makeEnv({ post: async (p, b) => { posts.push(b); if (posts.length === 1) await gate; return { revision: posts.length === 1 ? R2 : R9 }; }, fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
  const ui = makeAccountUI(env);
  await ui.renderAccountEdit(ID);
  type(st, 'acc-t0-a', 'A안'); check(st, 'acc-confirm');
  click(st, SAVE);
  assert.deepEqual(posts[0].data.situations, [{ question: good().situations[0].question, answer: 'A안' }]);
  type(st, 'acc-t0-a', 'B안 (저장 중에 입력)');
  release(); await tick();
  assert.equal(ui.isEditingDirty(), true);
  assert.equal(tx(st, 'acc-t0-a').value, 'B안 (저장 중에 입력)');
  assert.equal(tx(st, 'acc-confirm').checked, false);
  check(st, 'acc-confirm'); click(st, SAVE); await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expectedRevision, R2);
  assert.equal(posts[1].data.situations[0].answer, 'B안 (저장 중에 입력)');
  assert.equal(ui.isEditingDirty(), false);

  // in-flight edit of another field only: accepted situations become baseline, so they are omitted next time
  let rel2; const gate2 = new Promise((res) => { rel2 = res; });
  const posts2 = [];
  const e2 = makeEnv({ post: async (p, b) => { posts2.push(b); if (posts2.length === 1) await gate2; return { revision: posts2.length === 1 ? R2 : R9 }; }, fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
  const ui2 = makeAccountUI(e2.env);
  await ui2.renderAccountEdit(ID);
  type(e2.st, 'acc-t0-a', 'A안'); check(e2.st, 'acc-confirm'); click(e2.st, SAVE);
  type(e2.st, 'acc-name', '저장 중 이름 변경');
  rel2(); await tick();
  check(e2.st, 'acc-confirm'); click(e2.st, SAVE); await tick();
  assert.equal(posts2.length, 2);
  assert.equal('situations' in posts2[1].data, false);
  assert.equal(posts2[1].data.name, '저장 중 이름 변경');
});

// ───────── reconcile with server situations after update; consistency note
const SIT_B = [{ question: '다른 편집자가 바꾼 질문', answer: '다른 편집자가 바꾼 답변' }];
const withSitB = () => ({ ...good(), situations: SIT_B.map((x) => ({ ...x })) });

test('editor shows the consistency review note (no auto-rewrite)', async () => {
  const r = await openEdit(good());
  const note = find(r.st, (x) => x.attrs?.['data-consistency-note']);
  assert.ok(note);
  const t = note.children.join('');
  assert.match(t, /자동으로 바뀌지 않아요/);
  assert.match(t, /반려견 테라스만/);
  assert.match(t, /직접 확인/);
  assert.match(t, /자동으로 고쳐 쓰지는 않아요/);
  const noField = good(); delete noField.situations;
  assert.ok(find((await openEdit(noField)).st, (x) => x.attrs?.['data-consistency-note']));
});

test('unrelated save omits situations and reconciles UI to the server value (A -> remote B)', async () => {
  const r = await openEdit(good(), () => ({ revision: R2, data: withSitB() }));
  type(r.st, 'acc-name', '이름만'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.equal('situations' in r.posts[0][1].data, false);
  assert.equal(tx(r.st, 'acc-t0-q').value, SIT_B[0].question, 'shows B, not stale A');
  assert.equal(tx(r.st, 'acc-t0-a').value, SIT_B[0].answer);
  assert.match(textOf(r.st), /다른 곳에서 바뀐 예상 질문을 최신 값으로 갱신/);
  // baseline is B: next unrelated save still omits situations, no hidden overwrite
  type(r.st, 'acc-name', '두번째'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.equal(r.posts.length, 2);
  assert.equal('situations' in r.posts[1][1].data, false);
});

test('conflict -> latest B -> overwrite of unrelated fields still omits situations and shows B afterwards', async () => {
  const posts = [];
  let reads = 0;
  const { st, env } = makeEnv({
    post: async (p, b) => { posts.push(b); if (posts.length === 1) { const e = new Error('c'); e.status = 409; throw e; } return { revision: R9, data: withSitB() }; },
    fetcher: async () => { reads++; return json({ id: ID, data: reads === 1 ? good() : withSitB(), revision: reads === 1 ? R1 : R5 }); },
  });
  const ui = makeAccountUI(env);
  await ui.renderAccountEdit(ID);
  type(st, 'acc-name', '내 이름'); check(st, 'acc-confirm'); click(st, SAVE); await tick();
  click(st, '서버 최신 내용 불러와 비교하기'); await tick();
  assert.match(textOf(st), /다른 편집자가 바꾼 질문/);
  check(st, 'acc-overwrite'); check(st, 'acc-confirm'); click(st, SAVE); await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expectedRevision, R5);
  assert.equal('situations' in posts[1].data, false, 'no hidden overwrite of B');
  assert.equal(tx(st, 'acc-t0-q').value, SIT_B[0].question);
  assert.equal(ui.isEditingDirty(), false);
});

test('situations typed during an unrelated save are preserved; baseline moves to server B; dirty stays', async () => {
  let release; const gate = new Promise((res) => { release = res; });
  const posts = [];
  const { st, env } = makeEnv({
    post: async (p, b) => { posts.push(b); if (posts.length === 1) { await gate; return { revision: R2, data: withSitB() }; } return { revision: R9, data: { ...good(), situations: b.data.situations } }; },
    fetcher: async () => json({ id: ID, data: good(), revision: R1 }),
  });
  const ui = makeAccountUI(env);
  await ui.renderAccountEdit(ID);
  type(st, 'acc-name', '이름'); check(st, 'acc-confirm'); click(st, SAVE);
  assert.equal('situations' in posts[0].data, false);
  type(st, 'acc-t0-a', '저장 중에 입력한 답변');
  release(); await tick();
  assert.equal(tx(st, 'acc-t0-a').value, '저장 중에 입력한 답변', 'typing preserved');
  assert.equal(tx(st, 'acc-t0-q').value, good().situations[0].question, 'only my typed fields kept');
  assert.equal(ui.isEditingDirty(), true);
  assert.match(textOf(st), /서버의 예상 질문을 내 값으로 덮어써요/);
  assert.equal(tx(st, 'acc-confirm').checked, false);
  click(st, SAVE); await tick();
  assert.equal(posts.length, 1, 'needs re-confirmation');
  check(st, 'acc-confirm'); click(st, SAVE); await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expectedRevision, R2);
  assert.equal(posts[1].data.situations[0].answer, '저장 중에 입력한 답변', 'explicit user choice, visible warning shown before');
});

test('update response absent/malformed/unexpected is unverified, never stale success', async () => {
  const bads = [
    ['no data', { revision: R2 }],
    ['malformed data', { revision: R2, data: { name: 1 } }],
    ['data without situations although page has them', { revision: R2, data: (() => { const x = good(); delete x.situations; return x; })() }],
    ['situations not pairs', { revision: R2, data: { ...good(), situations: [{ question: 1, answer: 2 }] } }],
    ['bad revision', { revision: 'nope', data: good() }],
  ];
  for (const [label, resp] of bads) {
    const r = await openEdit(good(), () => resp);
    type(r.st, 'acc-name', 'n'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
    assert.ok(find(r.st, (x) => x.attrs?.['data-conflict'] === 'unverified'), label);
    assert.doesNotMatch(textOf(r.st), /반영했어요\. 공개/, label);
    assert.equal(find(r.st, (x) => x.tag === 'button' && x.children.join('') === SAVE).disabled, true, label);
  }
  // sent situations but server returned different ones
  const r = await openEdit(good(), () => ({ revision: R2, data: withSitB() }));
  type(r.st, 'acc-t0-a', '내 답변'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.ok(find(r.st, (x) => x.attrs?.['data-conflict'] === 'unverified'));
  assert.equal(r.posts.length, 1);
  assert.equal(tx(r.st, 'acc-t0-a').value, '내 답변', 'input kept');
});

test('page without situations: ok without data; remotely added situations are shown after save', async () => {
  const noField = good(); delete noField.situations;
  let r = await openEdit(noField, () => ({ revision: R2 }));
  type(r.st, 'acc-name', 'n'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.equal(find(r.st, (x) => x.attrs?.['data-conflict']), null);
  assert.equal(find(r.st, (x) => x.attrs?.['data-situations']), null);
  assert.equal('situations' in r.posts[0][1].data, false);

  r = await openEdit(noField, () => ({ revision: R2, data: withSitB() }));
  type(r.st, 'acc-name', 'n'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.ok(find(r.st, (x) => x.attrs?.['data-situations']), 'section appears');
  assert.equal(tx(r.st, 'acc-t0-q').value, SIT_B[0].question);
  assert.match(textOf(r.st), /다른 곳에서 추가된 예상 질문/);
  assert.equal('situations' in r.posts[0][1].data, false, 'never sent what the user did not see');
  type(r.st, 'acc-name', 'm'); check(r.st, 'acc-confirm'); click(r.st, SAVE); await tick();
  assert.equal('situations' in r.posts[1][1].data, false);
});

test('HIGH: a late save response from a closed editor A never clears dirty or touches editor B', async () => {
  const ID2 = 'bbbbbbbbbbbbbbbbbbbbbb';
  for (const outcome of ['success', 'conflict', 'timeout', 'badresponse']) {
    let release; const gate = new Promise((res) => { release = res; });
    const asked = [];
    const calls = [];
    const { st, env } = makeEnv({
      post: async (p, b) => {
        calls.push(b);
        await gate;
        if (outcome === 'success') return { revision: R2, data: good() };
        if (outcome === 'badresponse') return { ok: true };
        const e = new Error('late'); if (outcome === 'conflict') e.status = 409; else e.code = 'TIMEOUT'; throw e;
      },
      fetcher: async (u) => json({ id: u.includes(ID2) ? ID2 : ID, data: good(), revision: R1 }),
    });
    env.confirmFn = (m) => { asked.push(m); return true; };
    const ui = makeAccountUI(env);
    location.hash = '#/my-stores/' + ID;
    await ui.renderAccountEdit(ID);
    type(st, 'acc-name', 'A의 변경'); check(st, 'acc-confirm');
    click(st, SAVE); // A pending
    assert.equal(calls.length, 1);
    // user confirms leaving A and opens B
    assert.equal(ui.confirmLeave(), true);
    location.hash = '#/my-stores/' + ID2;
    await ui.renderAccountEdit(ID2);
    type(st, 'acc-name', 'B의 저장 안 한 입력');
    assert.equal(ui.isEditingDirty(), true);
    const shownBefore = st.shown;
    const nameBefore = tx(st, 'acc-name').value;
    const msgBefore = textOf(st);
    // A's request now resolves
    release(); await tick();
    assert.equal(ui.isEditingDirty(), true, `${outcome}: dirty must stay true`);
    assert.equal(st.shown, shownBefore, `${outcome}: B screen untouched (no redraw)`);
    assert.equal(tx(st, 'acc-name').value, nameBefore);
    assert.equal(textOf(st), msgBefore);
    assert.equal(find(st, (x) => x.attrs?.['data-conflict']), null);
    // navigation guard still protects B
    const before = asked.length;
    assert.equal(ui.confirmLeave(), true);
    assert.equal(asked.length, before + 1, 'guard still asks');
    assert.equal(ui.isEditingDirty(), false);
  }
  location.hash = '';
});

test('HIGH: late "load latest" from a closed editor does not touch the new editor', async () => {
  const ID2 = 'bbbbbbbbbbbbbbbbbbbbbb';
  let release; const gate = new Promise((res) => { release = res; });
  let reads = 0;
  const { st, env } = makeEnv({
    post: async () => { const e = new Error('c'); e.status = 409; throw e; },
    fetcher: async (u) => { reads++; if (reads === 2) await gate; return json({ id: ID, data: good(), revision: R1 }); },
  });
  env.confirmFn = () => true;
  const ui = makeAccountUI(env);
  location.hash = '#/my-stores/' + ID;
  await ui.renderAccountEdit(ID);
  type(st, 'acc-name', 'A'); check(st, 'acc-confirm'); click(st, SAVE); await tick();
  click(st, '서버 최신 내용 불러와 비교하기'); // pending read
  assert.equal(ui.confirmLeave(), true);
  location.hash = '#/my-stores/' + ID2;
  await ui.renderAccountEdit(ID2);
  type(st, 'acc-name', 'B 입력');
  const shown = st.shown;
  release(); await tick();
  assert.equal(st.shown, shown);
  assert.equal(ui.isEditingDirty(), true);
  assert.equal(find(st, (x) => x.attrs?.['data-latest']), null);
  location.hash = '';
});

test('a stale editor\'s leftover input handlers do not mark the new editor dirty', async () => {
  const { st, env } = makeEnv({ post: async () => ({}), fetcher: async () => json({ id: ID, data: good(), revision: R1 }) });
  const ui = makeAccountUI(env);
  location.hash = '#/my-stores/' + ID;
  await ui.renderAccountEdit(ID);
  const oldInput = tx(st, 'acc-name');
  await ui.renderAccountEdit('cccccccccccccccccccccc');
  assert.equal(ui.isEditingDirty(), false);
  oldInput.value = 'x'; oldInput.handlers.input();
  assert.equal(ui.isEditingDirty(), false, 'old editor cannot dirty the new screen');
  location.hash = '';
});

test('provider login buttons: official image assets, exact src/alt/href, enabled providers only', async () => {
  const render = async (providers) => {
    const { st, env } = makeEnv({ post: async () => ({}), fetcher: async () => json({ authenticated: false, providers }) });
    await makeAccountUI(env).renderDashboard();
    return st;
  };
  const anchors = (st) => findAll(st, (x) => x.tag === 'a' && x.attrs?.['data-provider']);

  let st = await render({ kakao: true, naver: true });
  let as = anchors(st);
  assert.deepEqual(as.map((a) => a.attrs['data-provider']), ['kakao', 'naver']);
  assert.deepEqual(as.map((a) => a.attrs.href), ['/api/owner-auth?op=start&provider=kakao&return=dashboard', '/api/owner-auth?op=start&provider=naver&return=dashboard']);
  const imgs = as.map((a) => a.children.filter((c) => c && c.tag === 'img'));
  assert.ok(imgs.every((x) => x.length === 1), 'one nested img per anchor');
  assert.deepEqual(imgs.map(([i]) => [i.attrs.src, i.attrs.alt]), [['/kakao-login.svg', '카카오 로그인'], ['/naver-login.png', '네이버 로그인']]);
  assert.deepEqual(as.map((a) => a.attrs.class.split(' ')[0]), ['account-provider', 'account-provider']);
  assert.ok(as[0].attrs.class.includes('account-provider-kakao') && as[1].attrs.class.includes('account-provider-naver'));
  assert.ok(imgs.every(([i]) => i.attrs.class === 'account-provider-image'));
  // no duplicate screen-reader label: no text children, no aria-label on the anchor, no old plain-button classes
  for (const a of as) {
    assert.ok(a.children.every((c) => typeof c !== 'string'), 'anchor has no visible text');
    assert.equal(a.attrs['aria-label'], undefined);
    assert.ok(!/\bbtn\b|\bprimary\b/.test(a.attrs.class));
  }
  assert.doesNotMatch(textOf(st), /카카오로 로그인|네이버로 로그인/);

  // only enabled providers
  st = await render({ kakao: true, naver: false });
  as = anchors(st);
  assert.equal(as.length, 1);
  assert.equal(as[0].children[0].attrs.src, '/kakao-login.svg');
  assert.equal(findAll(st, (x) => x.tag === 'img' && /naver/.test(x.attrs.src)).length, 0);

  st = await render({ kakao: false, naver: true });
  as = anchors(st);
  assert.equal(as.length, 1);
  assert.equal(as[0].children[0].attrs.src, '/naver-login.png');
  assert.equal(as[0].children[0].attrs.alt, '네이버 로그인');

  // none / non-true values: no anchors, no images, honest "preparing" copy
  for (const p of [{ kakao: false, naver: false }, { kakao: 'yes', naver: 1 }, {}]) {
    st = await render(p);
    assert.equal(anchors(st).length, 0);
    assert.equal(findAll(st, (x) => x.tag === 'img').length, 0);
    assert.match(textOf(st), /준비 중/);
  }
  // loginLinks helper exposes the same data
  assert.deepEqual(loginLinks({ providers: { kakao: true } }).map((l) => [l.provider, l.imageSrc, l.imageAlt]), [['kakao', '/kakao-login.svg', '카카오 로그인']]);
});

test('Google login: text-only neutral button, only when server reports true, no external assets', async () => {
  const render = async (providers) => {
    const { st, env } = makeEnv({ post: async () => ({}), fetcher: async () => json({ authenticated: false, providers }) });
    await makeAccountUI(env).renderDashboard();
    return st;
  };
  const g = (st) => findAll(st, (x) => x.tag === 'a' && x.attrs?.['data-provider'] === 'google');
  let st = await render({ kakao: true, naver: true, google: true });
  assert.deepEqual(findAll(st, (x) => x.tag === 'a' && x.attrs?.['data-provider']).map((a) => a.attrs['data-provider']), ['kakao', 'naver', 'google']);
  const [a] = g(st);
  assert.equal(a.attrs.href, '/api/owner-auth?op=start&provider=google&return=dashboard');
  assert.ok(a.attrs.class.includes('account-provider-google') && a.attrs.class.includes('account-provider-text'));
  const kids = a.children.filter(Boolean);
  assert.equal(kids.length, 2);
  assert.equal(kids[0].tag, 'img');
  assert.equal(kids[0].attrs.src, '/google-g.svg');
  assert.equal(kids[0].attrs.alt, '');
  assert.equal(kids[1].tag, 'span');
  assert.equal(kids[1].children.join(''), 'Google 계정으로 로그인');
  assert.deepEqual(findAll(st, (x) => x.tag === 'img' && /google/i.test(x.attrs.src)).map((x) => x.attrs.src), ['/google-g.svg']);
  for (const p of [{ google: false }, { google: 'yes' }, { google: 1 }, { kakao: true }]) assert.equal(g(await render(p)).length, 0);
  st = await render({ google: true });
  assert.equal(g(st).length, 1);
  assert.ok(find(st, (x) => x.tag === 'button' && x.children.join('') === '로그인 없이 시작하기'), 'no-login flow kept');
  assert.deepEqual(loginLinks({ providers: { google: true } }).map((l) => [l.provider, l.imageSrc]), [['google', '']]);
  assert.equal(loginLinks({ providers: { google: true } })[0].iconSrc, '/google-g.svg');
  const { st: s2, env } = makeEnv({ post: async () => ({}), fetcher: async (u) => json(u.includes('owner-auth') ? { authenticated: true, provider: 'google', providers: { google: true } } : { stores: [] }) });
  await makeAccountUI(env).renderDashboard();
  assert.match(textOf(s2), /구글 계정/);
});
