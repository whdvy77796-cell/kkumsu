import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HOME_PRICE_STEPS, FIRST_HOME_PRICE, makeHomePricing } from '../public/home-pricing.js';

const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) });
const textOf = n => n == null ? '' : typeof n === 'object' ? n.children.map(textOf).join(' ') : String(n);
function all(n, pred, out = []) { if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out); } return out; }

test('six proposed cumulative price tiers are exact and use the same first price', () => {
  assert.deepEqual(HOME_PRICE_STEPS, [
    { range: '첫 100명', price: '3,900원' },
    { range: '101~1,000명', price: '9,900원' },
    { range: '1,001~5,000명', price: '12,900원' },
    { range: '5,001~1만 명', price: '19,900원' },
    { range: '1만 1명~3만 명', price: '29,900원' },
    { range: '3만 1명~10만 명', price: '39,900원' },
  ]);
  assert.equal(FIRST_HOME_PRICE, '3,900원');
  assert.ok(Object.isFrozen(HOME_PRICE_STEPS) && HOME_PRICE_STEPS.every(Object.isFrozen));
});

test('plans are marked future and current free beta is disclosed without enabling payment', () => {
  const node = makeHomePricing(h, () => {}); const text = textOf(node);
  for (const s of ['현재 무료 베타','공개 페이지·QR·공유 문구도 무료','현재 실제 결제는 운영하지 않아요','유료 공개 · 도입 예정','유료 서비스 도입 후 적용 예정','1회 결제 · 월 정기결제 없음','여기봐AI 안에 가게 소개 페이지 공개','내 가게 AI 검색 봇 접근 현황 (준비중)']) assert.ok(text.includes(s), s);
  assert.match(text, /AI 답변의 추천·인용이나 실제 손님 방문을 뜻하지 않아요/);
  assert.match(text, /검색 노출과 AI 추천은 보장하지 않아요/);
});

test('unconnected purchase progress is explicitly unknown and never fabricated as zero', () => {
  const node = makeHomePricing(h, () => {});
  const total = all(node, n => n.attrs.class === 'pricing-progress-total')[0];
  const meter = all(node, n => n.attrs.class === 'pricing-meter')[0];
  assert.match(textOf(total), /누적 유료 구매자\s+집계 준비 중\s+현재 유료 결제 미운영/);
  assert.doesNotMatch(textOf(total), /\d+\s*명|\d+\s*%/);
  assert.equal(meter.attrs.role, 'img');
  assert.match(meter.attrs['aria-label'], /집계가 연결되지 않아 진행률을 표시하지 않아요/);
  assert.equal(all(meter, n => n.attrs.class === 'pricing-meter-segment').length, 6);
  assert.ok(!all(meter, n => 'aria-valuenow' in n.attrs || n.attrs.style).length);
});

test('the free start button reuses the existing start callback', () => {
  let calls = 0; const node = makeHomePricing(h, () => calls++);
  const button = all(node, n => n.tag === 'button')[0];
  assert.equal(textOf(button), '지금 무료로 페이지 만들기');
  assert.equal(button.attrs.type, 'button'); button.attrs.onclick();
  assert.equal(calls, 1);
});

test('home section is after the privacy card, full-width and does not replace the form', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const home = app.slice(app.indexOf('function renderHome()'), app.indexOf('// ───────── 2.'));
  assert.ok(home.indexOf("id: 'startCard'") < home.indexOf('개인정보처리방침 자세히 보기'));
  assert.ok(home.indexOf('개인정보처리방침 자세히 보기') < home.indexOf('makeHomePricing(h, focusStart)'));
  assert.match(css, /body\[data-page="home"\] #view > \.home-pricing \{ grid-column: 1 \/ -1; grid-row: auto;/);
  assert.match(css, /\.pricing-meter-segment \{[^}]*background: #dbe4f0/);
  assert.match(css, /@media \(max-width: 600px\)/);
});

test('planned one-year offer is clearly future only with seven-day refund and no automatic renewal', () => {
  const text = textOf(makeHomePricing(h, () => {}));
  for (const value of ['유료 출시 계획', '1년간 유지', '자동 갱신이나 정기결제는 없어요', '결제일과 공개 시작일 중 더 늦은 날부터 7일 안에는 이용 여부와 관계없이 전액 환불', '현재 실제 결제는 운영하지 않아요']) assert.ok(text.includes(value), value);
});
