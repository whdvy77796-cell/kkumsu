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

test('요청한 AI 검색 최적화 설명은 그래픽 아래에 중요 문구를 강조해 표시한다', () => {
  const explanation = byClass(tree, 'home-readiness-aeo')[0];
  assert.equal(explanation.tag, 'section');
  assert.equal(explanation.props['aria-label'], 'AI 검색 최적화 안내');
  assert.equal(explanation.children.filter(n => n.tag === 'p').length, 2);
  const copy = squash(textOf(explanation));
  assert.match(copy, /AI 검색 최적화\(AEO·GEO\)는 손님이 ChatGPT·클로드·구글 AI 개요·네이버 AI 브리핑에 업체를 물을 때 AI가 우리 업체를 바르게 소개하도록 정보를 정리해 두는 일입니다\./);
  assert.match(copy, /국내 주요 지도·블로그 서비스 중에는 해외 AI 검색 로봇의 수집을 제한하는 곳도 있어, AI가 읽을 수 있는 업체 정보가 제한될 수 있습니다\./);
  assert.doesNotMatch(copy, /상당수|생각보다 적습니다|보장합니다/);
  const emphasized = find(explanation, n => n.tag === 'strong').map(textOf);
  assert.ok(emphasized.includes('AI 검색 최적화(AEO·GEO)'));
  assert.ok(emphasized.includes('AI가 우리 업체를 바르게 소개하도록'));
  assert.ok(emphasized.includes('해외 AI 검색 로봇의 수집을 제한하는 곳'));
  assert.ok(emphasized.includes('AI가 읽을 수 있는 업체 정보가 제한될 수 있습니다.'));
  const classes = tree.children.map(n => n?.props?.class);
  assert.ok(classes.indexOf('home-readiness-steps') < classes.indexOf('home-readiness-review'));
  assert.ok(classes.indexOf('home-readiness-review') < classes.indexOf('home-readiness-aeo'));
  assert.ok(classes.indexOf('home-readiness-aeo') < classes.indexOf('home-readiness-disclaimer'));
});

test('첫 화면 소개와 가상 예시 다음에 봇 현황과 준비도가 순서대로 나온다', () => {
  const app = read('../public/app.js');
  const hero = app.indexOf("h('section', { class: 'hero' }");
  const e = app.indexOf('makeHomeExample(h)');
  const intro = app.indexOf("h('section', { class: 'ai-access-intro'");
  const a = app.search(/makeAiAccessPanel\s*\(\s*\{[^}]*kind:\s*'site'/);
  const r = app.indexOf('makeHomeReadiness(h)');
  assert.ok(hero > 0 && e > 0 && intro > 0 && a > 0 && r > 0, '다섯 요소가 모두 있어야 한다');
  assert.ok(hero < e && e < intro && intro < a && a < r, '순서: 소개, 가상 예시, 봇 소개, 봇 현황, 준비도');
  assert.match(app, /import\s*\{\s*makeHomeReadiness\s*\}\s*from\s*'\.\/home-readiness\.js'/);
  assert.match(app, /AI·검색 봇/);
  assert.match(app, /접근할 수 있도록 설정되어 있어요/);
  assert.doesNotMatch(app, /날마다 등록된/); // 봇의 방문 빈도를 보장하지 않는다.
});

test('desktop/mobile 반응형 스타일이 있다', () => {
  const css = squash(read('../public/styles.css'));
  assert.match(css, /\.home-readiness-steps\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  const heroRules = [...css.matchAll(/body\[data-page="home"\] #view > \.hero \{([^}]*)\}/g)];
  const exampleRules = [...css.matchAll(/body\[data-page="home"\] #view > \.home-sample \{([^}]*)\}/g)];
  assert.match(heroRules.at(-1)?.[1] || '', /grid-column:\s*1\s*;\s*grid-row:\s*1/);
  assert.match(exampleRules.at(-1)?.[1] || '', /grid-column:\s*2\s*;\s*grid-row:\s*1/);
  assert.match(css, /@media \(min-width: 1024px\)\s*\{[^@]*\.home-readiness\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  const mobile = css.match(/@media \(max-width: 700px\)\s*\{(.*)/);
  assert.ok(mobile, 'mobile 미디어쿼리');
  assert.match(mobile[1], /\.home-readiness-steps\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobile[1], /\.home-readiness-step\s*\{[^}]*display:\s*grid/);
});
