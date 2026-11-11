import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupHomeLogo } from '../public/logo-home.js';
import { readFile } from 'node:fs/promises';

function fixture({ hash = '', fields = {}, confirm = true, reduced = false } = {}) {
  let handler, scrolls = [], messages = [];
  const logo = { addEventListener(type, fn) { assert.equal(type, 'click'); handler = fn; } };
  const doc = { querySelector(s) { return s === 'header .logo' ? logo : fields[s] || null; } };
  const win = { location: { hash }, scrollTo(o) { scrolls.push(o); }, matchMedia() { return { matches: reduced }; }, confirm(m) { messages.push(m); return confirm; } };
  setupHomeLogo(doc, win);
  const click = (options = {}) => { const e = { button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options }; handler(e); return e; };
  return { click, win, scrolls, messages };
}

test('home logo scrolls to top without navigating or re-rendering', () => {
  for (const hash of ['', '#/']) {
    const f = fixture({ hash }); const e = f.click();
    assert.equal(e.defaultPrevented, true); assert.deepEqual(f.scrolls, [{ top: 0, left: 0, behavior: 'smooth' }]);
    assert.equal(f.win.location.hash, hash); assert.equal(f.messages.length, 0);
  }
});
test('reduced-motion preference is respected', () => {
  const f = fixture({ reduced: true }); f.click(); assert.equal(f.scrolls[0].behavior, 'auto');
});
test('another route follows the existing home link without an unnecessary reload', () => {
  const f = fixture({ hash: '#/privacy' }); const e = f.click();
  assert.equal(e.defaultPrevented, false); assert.equal(f.scrolls.length, 0); assert.equal(f.messages.length, 0);
});
test('modified and non-primary clicks keep their native link behavior', () => {
  for (const opts of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    const f = fixture(); f.click(opts); assert.equal(f.scrolls.length, 0); assert.equal(f.messages.length, 0);
  }
});
test('diagnosis start protects temporary input if the user cancels', () => {
  const f = fixture({ hash: '#/diagnosis-start', fields: { '#view input[name="diagnosisName"]': { value: '예시 가게' } }, confirm: false });
  assert.equal(f.click().defaultPrevented, true); assert.match(f.messages[0], /저장되지 않았어요/);
});
test('diagnosis start can leave when empty or the user accepts', () => {
  assert.equal(fixture({ hash: '#/diagnosis-start' }).click().defaultPrevented, false);
  const f = fixture({ hash: '#/diagnosis-start', fields: { '#diagnosisSearchConsent': { checked: true } } });
  assert.equal(f.click().defaultPrevented, false); assert.equal(f.messages.length, 1);
});
test('publication password is not saved and is protected by a navigation warning', () => {
  const f = fixture({ hash: '#/page-publish', fields: { '#publish-password': { value: 'test-only' } }, confirm: false });
  assert.equal(f.click().defaultPrevented, true); assert.match(f.messages[0], /관리 비밀번호/); assert.ok(!f.messages[0].includes('test-only'));
  assert.equal(fixture({ hash: '#/page-publish', fields: { '#publish-password': { value: '   ' } }, confirm: false }).click().defaultPrevented, true);
  assert.equal(fixture({ hash: '#/page-publish' }).click().defaultPrevented, false);
});
test('management editor and typed login password are protected', () => {
  for (const fields of [{ '#view .manage #f-name': {} }, { '#view .manage #manage-pw': { value: 'test-only' } }]) {
    const f = fixture({ hash: '#/manage/abcdefghijklmnopqrstuv', fields, confirm: false });
    assert.equal(f.click().defaultPrevented, true); assert.match(f.messages[0], /저장하지 않은/);
  }
  assert.equal(fixture({ hash: '#/manage/abcdefghijklmnopqrstuv' }).click().defaultPrevented, false);
});
test('homepage wiring keeps native logo link and existing route behavior', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(app, /import \{ setupHomeLogo \} from '\.\/logo-home\.js'/);
  assert.match(app, /setupHomeLogo\(document, window\)/);
  assert.match(html, /class="logo" href="#\/"/);
  assert.match(app, /window\.addEventListener\('hashchange'/);
});
