import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePageStart } from '../public/page-start.js';
import { readinessReviewSignature, scoreForDraft } from '../public/readiness-ui.js';

const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,String(v)) }; };
const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) });
const text = node => node == null ? '' : typeof node !== 'object' ? String(node) : node.textContent ?? (node.children || []).map(text).join(' ');
function find(node, pred) { if (!node || typeof node !== 'object') return null; if (pred(node)) return node; for (const x of node.children || []) { const result = find(x, pred); if (result) return result; } return null; }
const faqs = [{ question: '포장이 가능한가요?', answer: '포장할 수 있어요.', evidence: [] }];
function setup(answers = {}, withDraft = false) {
  globalThis.sessionStorage = storage(); globalThis.location = { hash: '#/page-questions' };
  const store = { name: '가상카페', address: '서울 마포구 예시로 12', verifiedFacts: [] };
  const candidate = { ...store, category: '카페', features: [], strengths: [], menu: [] };
  const draft = withDraft ? { headline: { text: '가상 카페', evidence: [] }, intro: { text: '가상 소개', evidence: [] }, sections: [], faqs, keywords: [] } : undefined;
  const state = { name: store.name, address: store.address, status: 'confirmed', confirmedIndex: 0, result: { candidates: [candidate] }, pageDraft: { store, answers, status: withDraft ? 'ready' : 'idle', ...(draft ? { draft } : {}) } };
  sessionStorage.setItem('yeogibwa.page.start.v1', JSON.stringify(state));
  sessionStorage.setItem('maechul.v3', '{"old":"keep"}');
  let out = [], posts = 0;
  const flow = makePageStart({ h, show: (...nodes) => { out = nodes; }, setNavbar: () => {}, btn: (label, onclick) => h('button', { onclick }, label), post: async () => { posts++; throw new Error('unexpected request'); }, storeName: { textContent: '' } });
  return { flow, get out() { return out; }, get posts() { return posts; }, node: pred => find({ children: out }, pred), saved: () => JSON.parse(sessionStorage.getItem('yeogibwa.page.start.v1')).pageDraft };
}
function input(value) { return { target: { value, removeAttribute() {} } }; }

test('질문 화면은 혜택·실제 점수를 표시하고 타이핑에 따라 점수를 갱신한다', () => {
  const ctx = setup(); ctx.flow.renderQuestions();
  const full = text({ children: ctx.out });
  assert.match(full, /AI가 접근하기 좋은 여기봐 AI에 가게 소개 페이지 공개/);
  assert.match(full, /공개 후 손님과 SNS에 공유/);
  assert.match(full, /현재 초안 · 비공개/);
  assert.match(full, /실제 AI 수집·검색 노출·추천을 뜻하지 않아요/);
  const number = () => ctx.node(n => n.attrs?.class === 'readiness-current-number');
  assert.equal(text(number()), '20');
  const offer = ctx.node(n => n.attrs?.id === 'page-answer-offer'); offer.attrs.oninput(input('라떼'));
  assert.equal(text(number()), '40');
  const diff = ctx.node(n => n.attrs?.id === 'page-answer-difference'); diff.attrs.oninput(input('조용한 분위기'));
  assert.equal(text(number()), '60');
  const audience = ctx.node(n => n.attrs?.id === 'page-answer-audience'); audience.attrs.oninput(input('친구 두 명'));
  const visit = ctx.node(n => n.attrs?.id === 'page-answer-visit'); visit.attrs.oninput(input('포장 가능'));
  assert.equal(text(number()), '85');
  assert.equal(ctx.posts, 0);
  assert.equal(sessionStorage.getItem('maechul.v3'), '{"old":"keep"}');
});

test('해당 없음은 빈 선택 항목만 분모에서 제외하며 기존 답변은 지우지 않는다', () => {
  const ctx = setup({ offer: '라떼' }); ctx.flow.renderQuestions();
  const na = ctx.node(n => n.attrs?.id === 'readiness-na-visit');
  na.attrs.onchange({ target: { checked: true } });
  assert.equal(ctx.saved().readinessNA.visit, true);
  assert.equal(text(ctx.node(n => n.attrs?.class === 'readiness-current-number')), '44');
  const visit = ctx.node(n => n.attrs?.id === 'page-answer-visit'); visit.attrs.oninput(input('포장 가능'));
  assert.notEqual(ctx.saved().readinessNA.visit, true);
  assert.equal(ctx.saved().answers.visit, '포장 가능');
  assert.equal(text(ctx.node(n => n.attrs?.class === 'readiness-current-number')), '50');
});

test('미리보기 FAQ 확인은 15점을 더하고 초안 수정 후 다시 확인하게 한다', () => {
  const answers = { offer: '라떼', difference: '조용한 분위기', audience: '친구 두 명', visit: '포장 가능' };
  const ctx = setup(answers, true); ctx.flow.renderPreview();
  const number = () => ctx.node(n => n.attrs?.class === 'readiness-current-number');
  assert.equal(text(number()), '85');
  const label = ctx.node(n => n.attrs?.class === 'readiness-review-label');
  const check = find(label, n => n.tag === 'input' && n.attrs.type === 'checkbox');
  assert.equal(check.attrs.checked, false);
  check.attrs.onchange({ target: { checked: true } });
  assert.equal(text(number()), '100');
  assert.equal(typeof ctx.saved().readinessReview, 'string');
  ctx.flow.renderEdit();
  const answer = ctx.node(n => n.attrs?.id === 'page-edit-faq-0-answer');
  answer.attrs.oninput(input('주말에는 포장만 가능해요.'));
  answer.attrs.oninput(input('포장할 수 있어요.')); // 원래 문구로 되돌려도 재확인이 필요하다.
  ctx.flow.renderPreview();
  assert.equal(text(number()), '85');
  const newLabel = ctx.node(n => n.attrs?.class === 'readiness-review-label');
  assert.equal(find(newLabel, n => n.tag === 'input').attrs.checked, false);
  assert.equal(ctx.posts, 0);
});

test('확인한 질문이 없거나 비어 있으면 15점을 줄 수 없다', () => {
  const d = { store: { name: '가상카페', address: '서울 마포구 예시로' }, answers: {}, draft: { faqs: [] } };
  d.readinessReview = readinessReviewSignature(d);
  assert.equal(scoreForDraft(d).score, 20);
  d.draft.faqs = [{ question: '질문', answer: '' }];
  d.readinessReview = readinessReviewSignature(d);
  assert.equal(scoreForDraft(d).score, 20);
});
