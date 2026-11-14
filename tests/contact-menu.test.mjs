import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupContactMenu } from '../public/contact-menu.js';
import { BUSINESS } from '../public/business.js';

function makeEnv({ clipboard = { async writeText() {} }, fallback = false } = {}) {
  function element(id) {
    return {
      id, handlers: {}, attrs: {}, textContent: '', hidden: false, open: false, focusCount: 0,
      addEventListener(name, fn) { this.handlers[name] = fn; },
      dispatch(name) { return this.handlers[name]?.({ target: this }); },
      setAttribute(name, value) { this.attrs[name] = value; if (name === 'open') this.open = true; },
      removeAttribute(name) { delete this.attrs[name]; if (name === 'open') this.open = false; },
      focus() { this.focusCount++; },
    };
  }
  const ids = ['contactOpen', 'contactDialog', 'contactClose', 'contactAddress', 'contactMail', 'contactCopy', 'contactStatus'];
  const nodes = Object.fromEntries(ids.map((id) => [id, element(id)]));
  if (!fallback) {
    nodes.contactDialog.showModal = function () { this.open = true; this.modalCount = (this.modalCount || 0) + 1; };
    nodes.contactDialog.close = function () { this.open = false; this.dispatch('close'); };
  }
  const doc = { getElementById(id) { return nodes[id] || null; } };
  const win = { navigator: { clipboard }, events: {}, addEventListener(name, fn) { this.events[name] = fn; } };
  return { nodes, doc, win };
}

test('shows business email and a mailto link, and opens/closes the dialog', () => {
  const e = makeEnv(); setupContactMenu(e.doc, e.win, BUSINESS.email); const n = e.nodes;
  assert.equal(n.contactAddress.textContent, BUSINESS.email);
  assert.equal(n.contactMail.attrs.href, 'mailto:' + BUSINESS.email + '?subject=' + encodeURIComponent('여기봐 AI 고객문의'));
  n.contactOpen.dispatch('click'); n.contactOpen.dispatch('click');
  assert.equal(n.contactDialog.open, true); assert.equal(n.contactDialog.modalCount, 1);
  n.contactClose.dispatch('click'); assert.equal(n.contactDialog.open, false);
});

test('copy sends the business address to clipboard and displays success', async () => {
  const writes = []; const e = makeEnv({ clipboard: { async writeText(value) { writes.push(value); } } });
  setupContactMenu(e.doc, e.win, BUSINESS.email); e.nodes.contactOpen.dispatch('click');
  await e.nodes.contactCopy.dispatch('click');
  assert.deepEqual(writes, [BUSINESS.email]); assert.match(e.nodes.contactStatus.textContent, /복사됐어요/);
  e.nodes.contactClose.dispatch('click'); assert.equal(e.nodes.contactStatus.textContent, '');
});

test('unavailable or rejected clipboard gives manual copy guidance', async () => {
  for (const clipboard of [null, { async writeText() { throw new Error('denied'); } }]) {
    const e = makeEnv({ clipboard }); setupContactMenu(e.doc, e.win, BUSINESS.email);
    await e.nodes.contactCopy.dispatch('click');
    assert.match(e.nodes.contactStatus.textContent, /직접 선택해 복사/);
    assert.equal(e.nodes.contactAddress.textContent, BUSINESS.email);
  }
});

test('fallback dialog can close and route changes clear it', () => {
  const e = makeEnv({ fallback: true }); setupContactMenu(e.doc, e.win, BUSINESS.email);
  e.nodes.contactOpen.dispatch('click'); assert.equal(e.nodes.contactDialog.open, true);
  e.win.events.hashchange(); assert.equal(e.nodes.contactDialog.open, false);
  assert.equal(e.nodes.contactOpen.focusCount, 1);
});

test('invalid email or missing markup fails safely', () => {
  const e = makeEnv(); setupContactMenu(e.doc, e.win, 'bad@example.com?bcc=other');
  assert.equal(e.nodes.contactOpen.hidden, true); assert.equal(e.nodes.contactMail.attrs.href, undefined);
  assert.doesNotThrow(() => setupContactMenu({ getElementById: () => null }, {}, BUSINESS.email));
});

test('accessible markup, responsive navigation and business address integration are present', async () => {
  const [html, css, app, code] = await Promise.all(['index.html', 'styles.css', 'app.js', 'contact-menu.js'].map((f) => readFile(new URL('../public/' + f, import.meta.url), 'utf8')));
  assert.match(html, /id="contactOpen"[^>]*aria-haspopup="dialog"[^>]*aria-controls="contactDialog"/);
  assert.match(html, /<dialog class="contact-dialog" id="contactDialog" aria-labelledby="contactTitle" aria-describedby="contactDescription"/);
  assert.match(html, /id="contactStatus" role="status" aria-live="polite"/);
  assert.match(app, /setupContactMenu\(document, window, BUSINESS\.email\)/);
  assert.match(css, /body\[data-page="home"\] \.home-jump-nav:not\(\[hidden\]\) \{ flex-basis: 100%/);
  assert.match(css, /\.home-pricing, \.home-faq \{ scroll-margin-top: 116px; \}/);
  assert.doesNotMatch(code, /fetch\(|localStorage|sessionStorage/);
});
