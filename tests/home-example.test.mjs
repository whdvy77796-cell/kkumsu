import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeHomeExample } from '../public/home-example.js';
import { makeHomeExplainer } from '../public/home-explainer.js';

const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) });
const allText = n => n == null ? '' : typeof n === 'object' ? n.children.map(allText).join(' ') : String(n);
function find(n, pred) { if (!n || typeof n !== 'object') return null; if (pred(n)) return n; for (const c of n.children || []) { const found = find(c, pred); if (found) return found; } return null; }

test('example is an accessible portrait image with explicit fictional-outcome disclosure', () => {
  const node = makeHomeExample(h); const img = find(node, n => n.tag === 'img');
  assert.equal(node.tag, 'figure'); assert.equal(node.attrs.class, 'home-sample');
  assert.equal(img.attrs.src, '/yeogibwa-ai-example-v3.png'); assert.equal(img.attrs.width, '1000'); assert.equal(img.attrs.height, '1225');
  assert.match(img.attrs.alt, /가상 예시/); assert.match(img.attrs.alt, /주소 일부를 가렸으며/); assert.match(img.attrs.alt, /실제 AI 답변이나 인용 사례가 아닙니다/);
  assert.match(allText(node), /가상 대화와 가상 출처 연결/); assert.match(allText(node), /보장하지 않아요/);
});

test('the real store preview links to the observed public page without claiming a real citation', () => {
  const node = makeHomeExample(h); const link = find(node, n => n.tag === 'a');
  assert.equal(link.attrs.href, '/stores/Sv7dlOYSMMVctFPtL1xI8w'); assert.equal(link.attrs.target, '_blank');
  assert.match(link.attrs.rel, /noopener/); assert.match(allText(link), /실제 연어로 소개 페이지 보기/);
});

test('home keeps its CTA and input while putting the example in a separate grid item', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /makeHomeExample\(h\),\s*makeHomeExplainer\(h, focusStart\),\s*pageSearchWarning, pendingDiagnosis/);
  assert.match(app, /onclick: focusStart \}, '무료로 페이지 만들기'/); assert.match(app, /id: 'startCard'/);
  assert.match(css, /#view > \.home-sample \{ grid-column: 2; grid-row: 1/);
  assert.match(css, /#view > #startCard \{ grid-column: 1 \/ -1; grid-row: auto/);
});

test('home hides the three pictured cards but keeps interrupted-search protection and input instructions', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const home = app.slice(app.indexOf('function renderHome()'), app.indexOf('// ───────── 2.'));
  assert.doesNotMatch(home, /작성하던 가게 소개가 있어요|이전에 작성한 진단이 있어요|가게 운영을 진단하고 싶으신가요/);
  assert.match(home, /이전 가게 조회가 이미 처리됐을 수 있어요/);
  const title = home.indexOf("h('h2', null, '가게 이름과 주소를 알려주세요')");
  const description = home.indexOf('몇 가지 질문에 답하면, 우리 가게의 특징을');
  const descriptionEnd = home.indexOf(' 고객과 AI가 이해하기 쉬운 소개 페이지로 만들어드립니다.');
  const input = home.indexOf("h('label', { class: 'field' }");
  assert.ok(title >= 0 && title < description && description < descriptionEnd && descriptionEnd < input);
});

test('portrait asset exists and has dimensions matching the reserved image space', async () => {
  const image = await readFile(new URL('../public/yeogibwa-ai-example-v3.png', import.meta.url));
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.readUInt32BE(16), 1000); assert.equal(image.readUInt32BE(20), 1225);
});


test('homepage introduction uses the requested wording without removing the existing start controls', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes(`h('h1', null, 'AI 시대,', h('br'), '우리 가게가 ', h('span', { class: 'hero-highlight' }, "'추천'"), ' 되는 방법.')`));
  assert.ok(app.includes("h('h2', { class: 'hero-sub' }, '손님이 AI에게 물을 때,', h('br', { class: 'hero-break-mobile' }), ' 우리 가게도 ', h('span', { class: 'hero-highlight' }, '발견될 수 있도록'), '.')"));
  assert.ok(app.includes("h('p', { class: 'hero-intro' }, '손님이 물어볼 만한 질문과', h('br', { class: 'hero-break-mobile' }), ' 우리 가게가 그 답이 되는 이유를 담아,', h('br'), ' AI가 읽기 쉬운 ', h('span', { class: 'hero-highlight' }, '가게 소개 페이지'), '를 만들고 여기봐ai에 배포해 드려요.')"));
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.hero \.hero-highlight \{\s*color: var\(--brand\)/);
  assert.match(css, /\.hero \.hero-intro \{[^}]*line-height: 1\.6/);
  assert.match(css, /@media \(max-width: 600px\) \{ \.hero-break-mobile \{ display: inline; \} \}/);
  assert.ok(!app.includes("h('h2', { class: 'hero-sub' }, '가게 이름과 주소를 알려주세요.'"));
  assert.ok(app.includes("onclick: focusStart }, '무료로 페이지 만들기'"));
});

test('WHY and four-step guide are accessible, use the existing start action and describe the real beta flow', () => {
  let called = 0; const start = () => { called++; };
  const node = makeHomeExplainer(h, start);
  const sections = node.children.filter(n => n.tag === 'section');
  assert.equal(node.attrs.class, 'home-explainer'); assert.equal(sections.length, 2);
  const [why, how] = sections; const whyText = allText(why); const howText = allText(how);
  assert.equal(why.attrs['aria-labelledby'], 'home-why-title');
  assert.equal(how.attrs['aria-labelledby'], 'home-how-title');
  assert.match(whyText, /WHY\?/); assert.match(whyText, /외부 AI가 그 내용을 자유롭게 읽을 수 있는 건 아니에요/);
  assert.match(whyText, /첫 100명 공개 1회 3,900원\s+\(유료 전환 후 적용 예정\)/); assert.match(whyText, /현재 베타 기간에는 공개와 QR·소개글도 무료/);
  assert.match(whyText, /결제는 운영하지 않아요/); assert.match(whyText, /검색 노출·AI 추천·인용은 보장하지 않아요/);
  const button = find(why, n => n.tag === 'button'); assert.equal(button.attrs.type, 'button');
  assert.equal(button.attrs.onclick, start); button.attrs.onclick(); assert.equal(called, 1);
  const list = find(how, n => n.tag === 'ol'); assert.equal(list.children.filter(n => n.tag === 'li').length, 4);
  assert.match(howText, /동의 후/); assert.match(howText, /5개 항목/); assert.match(howText, /대표 메뉴·서비스만 필수/);
  assert.match(howText, /실제 고객의 질문 기록은 아니에요/); assert.match(howText, /3,900원은 유료 전환 후 적용 예정/);
  assert.match(howText, /현재 베타 기간에는 무료/); assert.match(howText, /QR코드/);
});
