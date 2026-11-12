import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAccountUI } from '../public/account-ui.js';
globalThis.location = { hash: '#/my-stores' };
const reply = (data, status = 200, retry) => ({ ok: status >= 200 && status < 300, status, json: async () => data, headers: { get: () => retry } });
const walk = (el) => el && typeof el === 'object' ? [el, ...(el.children || []).flatMap(walk)] : [];
async function setup(status = { local: true }, respond = async () => reply({ ok: true })) {
  location.hash = '#/my-stores';
  let roots = [], statusCalls = 0;
  const calls = [];
  const h = (tag, attrs, ...kids) => {
    const el = { tag, attrs: attrs || {}, children: kids.flat(Infinity).filter(x => x != null && x !== false), value: attrs?.value || '', disabled: attrs?.disabled === true, textContent: '' };
    el.replaceChildren = (...children) => { el.children = children; };
    el.append = (...children) => { el.children.push(...children); };
    el.setAttribute = (k,v) => { el.attrs[k] = v; };
    el.focus = () => { el.focused = true; };
    el.reportValidity = () => true;
    return el;
  };
  const env = { h, btn: (label, onclick) => h('button', { onclick, type: 'button' }, label), post: async () => { throw new Error('unexpected legacy post'); }, storeName: {}, setNavbar() {}, show: (...v) => { roots = v; }, fetcher: async (url, options) => {
    if (url.includes('op=status')) { statusCalls++; return reply({ authenticated: false, ...status }); }
    calls.push({ url, options }); return respond(url, options);
  } };
  const ui = makeAccountUI(env); await ui.renderDashboard();
  const all = () => roots.flatMap(walk);
  const find = (fn) => all().find(fn);
  const field = (id) => find(x => x.attrs.id === id);
  const click = (text) => find(x => x.tag === 'button' && x.children.join('') === text).attrs.onclick();
  const submit = async () => { let prevented = false; await find(x => x.tag === 'form').attrs.onsubmit({ preventDefault() { prevented = true; } }); assert.ok(prevented); };
  const fill = () => { field('local-login-email').value = ' owner@example.test '; if (field('local-login-password')) field('local-login-password').value = 'private-test-password'; };
  const text = () => all().flatMap(x => [x.textContent, ...x.children.filter(k => typeof k === 'string')]).join('\n');
  return { all, find, field, click, submit, fill, text, calls, ui, status, statusCalls: () => statusCalls };
}
for (const local of [undefined, false, 'true', 1, null]) test('strict local flag disables requests: ' + local, async () => {
  const e = await setup({ local });
  assert.ok(e.field('local-login-email').disabled); assert.match(e.text(), /준비 중/);
  for (const mode of ['회원가입', '비밀번호 재설정', '로그인']) {
    e.click(mode); e.fill(); await e.submit(); assert.equal(e.calls.length, 0);
  }
});
test('all providers visible, only strict true becomes OAuth link', async () => {
  const e = await setup({ local: false, providers: { google: true, naver: 'true', kakao: false } });
  const a = e.all().filter(x => x.tag === 'a'); assert.equal(a.length, 1);
  assert.equal(a[0].attrs.href, '/api/owner-auth?op=start&provider=google&return=dashboard');
  for (const p of ['naver','kakao']) assert.ok(e.find(x => x.attrs['data-provider'] === p).disabled);
  assert.match(e.text(), /자동으로 합쳐지지/);
});
test('native form, labels, autofill, no automatic sensitive focus', async () => {
  const e = await setup();
  assert.equal(e.field('local-login-email').attrs.type, 'email');
  assert.equal(e.field('local-login-password').attrs.autocomplete, 'current-password');
  for (const id of ['local-login-email','local-login-password']) assert.ok(e.find(x => x.tag === 'label' && x.attrs.for === id));
  assert.ok(e.find(x => x.tag === 'button' && x.attrs.type === 'submit'));
  assert.ok(!e.all().some(x => x.attrs.autofocus || x.focused));
  e.fill(); const oldPw = e.field('local-login-password'); e.click('회원가입');
  assert.equal(oldPw.value, ''); assert.equal(e.field('local-login-password').attrs.autocomplete, 'new-password');
  assert.ok(e.field('local-login-title').focused);
  assert.equal(e.all().filter(x => x.tag === 'input').length, 2); assert.match(e.text(), /이메일 인증이 필요/);
});
test('login JSON body only, same origin, clears password and rechecks session', async () => {
  const x = await setup({ local: true }, async () => reply({ ok: true, authenticated: true }));
  x.fill(); const pw = x.field('local-login-password'); await x.submit();
  assert.equal(x.calls.length, 1); const { url, options } = x.calls[0];
  assert.equal(url, '/api/local-auth?op=login'); assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { email: 'owner@example.test', password: 'private-test-password' });
  assert.equal(pw.value, ''); assert.equal(x.statusCalls(), 2); assert.doesNotMatch(x.text(), /로그인됨/);
});
test('login needs explicit authenticated true', async () => {
  for (const data of [{ok:true}, {ok:true, authenticated:'true'}, {authenticated:true}, null]) {
    const e = await setup({local:true}, async () => reply(data)); e.fill(); await e.submit();
    assert.equal(e.statusCalls(), 1); assert.equal(e.field('local-login-password').value, '');
  }
});
test('signup email sent claim requires explicit complete response contract', async () => {
  for (const data of [{ok:true}, {ok:true, verificationEmailSent:true}, {ok:true, verificationRequired:true}, {ok:true, verificationRequired:true, verificationEmailSent:'true'}, {ok:true, verificationRequired:true, verificationEmailSent:true}]) {
    const e = await setup({local:true}, async () => reply(data)); e.click('회원가입'); e.fill(); await e.submit();
    assert.equal(e.calls[0].url, '/api/local-auth?op=signup'); assert.equal(e.field('local-login-password').value, '');
    assert.equal(e.text().includes('인증 안내 메일을 발송했어요'), data.verificationRequired === true && data.verificationEmailSent === true);
    assert.equal(e.statusCalls(), 1);
  }
});
test('reset only email, non-enumerating copy before and after success', async () => {
  const e = await setup(); e.click('비밀번호 재설정'); assert.equal(e.field('local-login-password'), undefined);
  assert.doesNotMatch(e.text(), /발송했|전송했|보냈/); e.fill(); await e.submit();
  assert.equal(e.calls[0].url, '/api/local-auth?op=reset');
  assert.deepEqual(JSON.parse(e.calls[0].options.body), {email:'owner@example.test'});
  assert.match(e.text(), /계정이 있는 경우/); assert.doesNotMatch(e.text(), /발송했|전송했|보냈/);
});
test('ID help explains email; guest retains route and clears password', async () => {
  const e = await setup(); e.fill(); e.click('아이디 안내');
  assert.match(e.text(), /아이디는 가입에 사용한 이메일/); assert.match(e.text(), /별도 아이디 찾기는 제공하지/);
  assert.equal(e.field('local-login-password').value, '');
  e.fill(); e.click('로그인 없이 시작하기'); assert.equal(location.hash, '#/');
  assert.equal(e.field('local-login-password').value, ''); assert.equal(e.calls.length, 0);
});
test('invalid input never posts and clears password', async () => {
  const e = await setup(); e.fill(); e.field('local-login-email').value = 'bad'; await e.submit();
  assert.equal(e.calls.length, 0); assert.equal(e.field('local-login-password').value, '');
});
test('duplicate submit blocked and mode cannot change during request', async () => {
  let release; const pending = new Promise(r => { release = r; });
  const e = await setup({local:true}, () => pending); e.fill(); const run = e.submit();
  assert.equal(e.field('local-login-password').value, ''); await e.submit(); e.click('회원가입');
  assert.equal(e.field('local-login-password').attrs.autocomplete, 'current-password');
  assert.equal(e.calls.length, 1); release(reply({ok:true})); await run;
  assert.equal(e.field('local-login-password').disabled, false);
});
test('429 retry cooldown survives mode changes, no reflected server message', async () => {
  const e = await setup({local:true}, async () => reply({error:'private-test-password'},429,'60'));
  e.fill(); await e.submit(); assert.match(e.text(), /요청이 많아요/);
  e.click('회원가입'); e.fill(); await e.submit(); assert.equal(e.calls.length, 1); assert.doesNotMatch(e.text(), /private-test-password/);
});
test('reset errors never disclose account existence or server echo', async () => {
  for (const status of [400,401,403,404,409,422,500,503]) {
    const e = await setup({local:true}, async () => reply({error:'exists owner@example.test private-test-password'},status));
    e.click('비밀번호 재설정'); e.fill(); await e.submit();
    assert.match(e.text(), /완료하지 못했/); assert.doesNotMatch(e.text(), /exists|owner@example.test|private-test-password|발송했/);
  }
});
test('network or malformed response clears secrets without success claim', async () => {
  for (const responder of [async () => {throw new Error('private-test-password');}, async () => ({ok:true,json:async () => {throw new Error('bad json');}})]) {
    const e = await setup({local:true}, responder); e.fill(); await e.submit();
    assert.equal(e.field('local-login-password').value, ''); assert.doesNotMatch(e.text(), /private-test-password/); assert.equal(e.statusCalls(), 1);
  }
});
test('late response after guest navigation cannot refresh dashboard', async () => {
  let release; const p = new Promise(r => {release=r;}); const e = await setup({local:true}, () => p);
  e.fill(); const run=e.submit(); e.click('로그인 없이 시작하기'); release(reply({ok:true,authenticated:true})); await run;
  assert.equal(location.hash,'#/'); assert.equal(e.statusCalls(),1);
});
test('OAuth click clears password and preserves destination', async () => {
  const e = await setup({local:true,providers:{google:true}}); e.fill();
  e.find(x => x.tag === 'a').attrs.onclick(); assert.equal(e.field('local-login-password').value,''); assert.equal(e.calls.length,0);
});
