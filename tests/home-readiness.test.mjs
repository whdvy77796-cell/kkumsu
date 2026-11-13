import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeHomeReadiness } from '../public/home-readiness.js';
import { calculateReadiness } from '../public/readiness-score.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const squash = s => s.replace(/\s+/g, ' ');

function h(tag, props, ...children) {
  return { tag, props: props || {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) };
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  return node.children.map(textOf).join(node.tag === 'br' ? '\n' : '');
}
function find(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  node.children.forEach(c => find(c, pred, out));
  return out;
}
const byClass = (node, cls) => find(node, n => String(n.props.class || '').split(/\s+/).includes(cls));

const tree = makeHomeReadiness(h);
const allText = squash(textOf(tree));

test('3개 예시 단계와 20/60/85 점수가 실제 calculateReadiness 결과와 일치한다', () => {
  const steps = byClass(tree, 'home-readiness-step');
  assert.equal(steps.length, 3);
  const base = { name: '예시 가게', address: '서울 마포구 예시로' };
  const expectedAnswers = [
    {},
    { offer: '고소한 라떼', difference: '조용한 공간' },
    { offer: '고소한 라떼', difference: '조용한 공간', audience: '친구 두 명의 방문', visit: '포장 가능' },
  ];
  const expected = expectedAnswers.map(answers => calculateReadiness({ ...base, answers }).score);
  assert.deepEqual(expected, [20, 60, 85]);

  const shown = steps.map(step => Number(textOf(byClass(step, 'home-readiness-dial-inner')[0]).replace(/[^0-9]/g, '')));
  assert.deepEqual(shown, expected);
  steps.forEach((step, i) => {
    const dial = byClass(step, 'home-readiness-dial')[0];
    assert.match(dial.props.style.background, new RegExp(`${expected[i]}%`));
  });
});

test('예시는 가상이며 비보장과 정보 진위/공개본 반영 미검증을 고지한다', () => {
  assert.match(allText, /가상의 예시/);
  const disclaimer = squash(textOf(byClass(tree, 'home-readiness-disclaimer')[0]));
  assert.match(disclaimer, /가상의 예시/);
  assert.match(disclaimer, /진위/);
  assert.match(disclaimer, /공개 내용 반영/);
  assert.match(disclaimer, /검증하지 않/);
  assert.match(disclaimer, /보장하지 않/);
});

test('여기봐 AI에 공개한다는 핵심 설명과 +15 FAQ 확인이 있다', () => {
  assert.match(allText, /AI·검색 봇이 접근할 수 있도록 설정된 여기봐 AI에 가게 소개 페이지를 공개/);
  const review = squash(textOf(byClass(tree, 'home-readiness-review')[0]));
  assert.match(textOf(byClass(tree, 'home-readiness-plus')[0]), /\+15/);
  assert.match(review, /예상 질문과 답변/);
  assert.match(review, /직접 확인/);
  assert.equal(calculateReadiness({ name: '예시 가게', address: '서울 마포구 예시로', answers: {} }).score, 20);
});

test('renderHome은 AI 접근 패널, 준비도, 예시 순서로 배치한다', () => {
  const app = read('../public/app.js');
  const a = app.search(/makeAiAccessPanel\s*\(\s*\{[^}]*kind:\s*'site'/);
  const r = app.indexOf('makeHomeReadiness(h)');
  const e = app.indexOf('makeHomeExample(h)');
  assert.ok(a > 0 && r > 0 && e > 0, '세 호출이 모두 있어야 한다');
  assert.ok(a < r && r < e, '순서: makeAiAccessPanel < makeHomeReadiness < makeHomeExample');
  assert.match(app, /import\s*\{\s*makeHomeReadiness\s*\}\s*from\s*'\.\/home-readiness\.js'/);
});

test('desktop/mobile 반응형 스타일이 있다', () => {
  const css = squash(read('../public/styles.css'));
  assert.match(css, /\.home-readiness-steps\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media \(min-width: 1024px\)\s*\{[^@]*\.home-readiness\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  const mobile = css.match(/@media \(max-width: 700px\)\s*\{(.*)/);
  assert.ok(mobile, 'mobile 미디어쿼리');
  assert.match(mobile[1], /\.home-readiness-steps\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobile[1], /\.home-readiness-step\s*\{[^}]*display:\s*grid/);
});
