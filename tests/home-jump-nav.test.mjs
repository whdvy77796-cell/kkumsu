import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupHomeJumpNav } from '../public/home-jump-nav.js';
import { makeHomePricing } from '../public/home-pricing.js';
import { makeHomeFaq } from '../public/home-faq.js';

function makeEnv(reduced = false) {
  const handlers = {};
  const calls = [];
  const nav = {
    hidden: true,
    querySelector(selector) {
      const m = selector.match(/data-home-jump="(price|faq)"/);
      return m ? { addEventListener(event, cb) { assert.equal(event, 'click'); handlers[m[1]] = cb; } } : null;
    },
  };
  const sections = Object.fromEntries(['home-pricing', 'home-faq'].map((id) => [id, {
    scrollIntoView(options) { calls.push({ id, action: 'scroll', options }); },
    focus(options) { calls.push({ id, action: 'focus', options }); },
  }]));
  const doc = { getElementById(id) { return id === 'homeJumpNav' ? nav : sections[id]; } };
  const win = { matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return { matches: reduced }; } };
  return { nav, calls, handlers, doc, win, sections };
}

test('PRICE and FAQ move to the correct sections without routing or touching form state', () => {
  const e = makeEnv(); const control = setupHomeJumpNav(e.doc, e.win);
  e.handlers.price(); assert.equal(e.calls.length, 0, 'hidden outside home');
  control.show(); assert.equal(e.nav.hidden, false);
  e.handlers.price(); e.handlers.faq();
  assert.deepEqual(e.calls, [
    { id: 'home-pricing', action: 'scroll', options: { behavior: 'smooth', block: 'start' } },
    { id: 'home-pricing', action: 'focus', options: { preventScroll: true } },
    { id: 'home-faq', action: 'scroll', options: { behavior: 'smooth', block: 'start' } },
    { id: 'home-faq', action: 'focus', options: { preventScroll: true } },
  ]);
  control.hide(); e.handlers.price(); assert.equal(e.calls.length, 4);
});

test('reduced-motion preference avoids animated scrolling', () => {
  const e = makeEnv(true); setupHomeJumpNav(e.doc, e.win).show(); e.handlers.faq();
  assert.equal(e.calls[0].options.behavior, 'auto');
});

test('missing navigation or section is handled without errors', () => {
  assert.doesNotThrow(() => setupHomeJumpNav({ getElementById: () => null }, {}).show());
  const e = makeEnv(); setupHomeJumpNav(e.doc, e.win).show(); delete e.sections['home-pricing'];
  assert.doesNotThrow(() => e.handlers.price()); assert.equal(e.calls.length, 0);
});

test('section IDs are unique, focusable and preserve their accessible labels', () => {
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children });
  const price = makeHomePricing(h, () => {}), faq = makeHomeFaq(h);
  assert.equal(price.attrs.id, 'home-pricing'); assert.equal(price.attrs.tabindex, '-1');
  assert.equal(price.attrs['aria-labelledby'], 'home-pricing-title');
  assert.equal(faq.attrs.id, 'home-faq'); assert.equal(faq.attrs.tabindex, '-1');
  assert.equal(faq.attrs['aria-labelledby'], 'home-faq-title');
});

test('navigation is hidden on initial load and other routes with sticky-header offsets', async () => {
  const [html, app, css, navCode] = await Promise.all(['index.html', 'app.js', 'styles.css', 'home-jump-nav.js'].map((f) => readFile(new URL('../public/' + f, import.meta.url), 'utf8')));
  assert.match(html, /<nav id="homeJumpNav"[^>]*\shidden>/);
  assert.match(html, /data-home-jump="price">PRICE/);
  assert.match(html, /data-home-jump="faq">FAQ/);
  assert.ok(html.indexOf('id="storeName"') < html.indexOf('id="homeJumpNav"'));
  const route = app.slice(app.indexOf('function route()'), app.indexOf("window.addEventListener('hashchange'"));
  assert.match(route, /homeJumpNav\.hide\(\)/);
  const home = app.slice(app.indexOf('function renderHome()'), app.indexOf('// ───────── 2.'));
  assert.match(home, /homeJumpNav\.show\(\)/);
  assert.match(css, /\.home-jump-nav\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.home-jump-nav button \{[^}]*min-width: 44px; min-height: 44px;/);
  assert.match(css, /\.home-pricing, \.home-faq \{ scroll-margin-top: 76px; \}/);
  assert.doesNotMatch(navCode, /location\.|history\.|localStorage|sessionStorage|fetch\(/);
});
