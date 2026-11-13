import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HOME_FAQ, makeHomeFaq } from '../public/home-faq.js';
import { FIRST_HOME_PRICE } from '../public/home-pricing.js';

const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) });
const textOf = n => n == null ? '' : typeof n === 'object' ? n.children.map(textOf).join(' ') : String(n);
function all(n, pred, out = []) { if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out); } return out; }

test('FAQ contains six concise, initially closed native disclosure items', () => {
  const node = makeHomeFaq(h);
  assert.equal(node.tag, 'section');
  assert.equal(node.attrs['aria-labelledby'], 'home-faq-title');
  assert.equal(HOME_FAQ.length, 6);
  const details = all(node, n => n.tag === 'details');
  assert.equal(details.length, 6);
  for (const [i, item] of details.entries()) {
    assert.ok(!('open' in item.attrs));
    assert.equal(item.children[0].tag, 'summary');
    assert.match(textOf(item.children[0]), new RegExp(HOME_FAQ[i].question.replace(/[?]/g, '\\?')));
    assert.ok(textOf(item.children[1]).length > 20);
  }
});

test('prices distinguish current free beta, a planned price, and undecided existing-page terms', () => {
  const text = textOf(makeHomeFaq(h));
  for (const value of ['현재 베타 기간', '무료', '결제는 운영하지 않아요', '유료 서비스 도입 시', '첫 100명', FIRST_HOME_PRICE, '예정', '기존 무료 페이지', '아직 정해지지 않았으며']) assert.ok(text.includes(value), value);
  assert.match(text, /추천·인용 여부나 시점은 보장하지 않아요/);
  assert.match(text, /실제 손님 방문을 뜻하지 않아요/);
});

test('guest access, management, and external transmission disclosures stay visible in FAQ content', () => {
  const node = makeHomeFaq(h); const text = textOf(node);
  for (const value of ['회원가입 없이', '비밀번호는 잃어버리면 복구할 수 없어요', '관리 비밀번호로', '주소와 QR코드', 'OpenRouter', '별도 동의 후']) assert.ok(text.includes(value), value);
  const privacy = all(node, n => n.tag === 'a');
  assert.equal(privacy.length, 1);
  assert.equal(privacy[0].attrs.href, '#/privacy');
});

test('FAQ is placed last on the home page with responsive and keyboard focus styles', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const home = app.slice(app.indexOf('function renderHome()'), app.indexOf('// ───────── 2.'));
  assert.ok(home.indexOf('makeHomePricing(h, focusStart)') < home.indexOf('makeHomeFaq(h)'));
  assert.match(home, /makeHomeFaq\(h\),\s*\);/);
  assert.match(css, /body\[data-page="home"\] #view > \.home-faq \{ grid-column: 1 \/ -1;/);
  assert.match(css, /\.faq-question:focus-visible/);
  assert.match(css, /\.faq-answer a:focus-visible/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.home-faq/);
});
