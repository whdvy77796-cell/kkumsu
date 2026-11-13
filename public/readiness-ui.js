// 입력 정보의 자체 준비도 표시. 점수·확인 표시는 현재 탭에서만 사용한다.
import { calculateReadiness } from './readiness-score.js';

const str = value => typeof value === 'string' ? value : '';
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];

// 내용이 바뀌면 이전 확인을 다시 요구한다. 보안 인증값이 아닌 이 탭의 변경 감지용이다.
export function readinessReviewSignature(value) {
  const d = obj(value), store = obj(d.store), answers = obj(d.answers), draft = obj(d.draft), na = obj(d.readinessNA);
  const raw = JSON.stringify({
    name: str(store.name), address: str(store.address), verifiedFacts: list(store.verifiedFacts),
    answers: ['offer', 'difference', 'audience', 'visit'].map(key => str(answers[key])),
    na: ['difference', 'audience', 'visit'].map(key => na[key] === true),
    headline: str(obj(draft.headline).text), intro: str(obj(draft.intro).text),
    sections: list(draft.sections).map(item => [str(obj(item).heading), str(obj(item).body)]),
    faqs: list(draft.faqs).map(item => [str(obj(item).question), str(obj(item).answer)]),
  });
  let a = 2166136261, b = 2246822519;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 3266489917);
  }
  return 'v1-' + (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export function scoreForDraft(value) {
  const d = obj(value), store = obj(d.store), draft = obj(d.draft);
  const signature = readinessReviewSignature(d);
  return calculateReadiness({
    name: store.name, address: store.address, answers: d.answers, notApplicable: d.readinessNA,
    faqReviewed: typeof d.readinessReview === 'string' && d.readinessReview === signature,
    faqs: list(draft.faqs),
  });
}

function updateText(node, value) { node.textContent = value; }
function updateChildren(node, children) {
  if (typeof node.replaceChildren === 'function') node.replaceChildren(...children);
  else node.children = children;
}
function updateAttr(node, name, value) {
  if (typeof node.setAttribute === 'function') node.setAttribute(name, String(value));
  else { node.attrs ||= {}; node.attrs[name] = String(value); }
}

export function makeReadinessCard(h, d) {
  const initial = scoreForDraft(d);
  const number = h('strong', { class: 'readiness-current-number' }, String(initial.score));
  const meterFill = h('span', { class: 'readiness-meter-fill', style: { width: initial.score + '%' } });
  const meter = h('div', { class: 'readiness-meter', role: 'progressbar', 'aria-label': '가게정보 입력 준비도', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(initial.score) }, meterFill);
  const tip = h('p', { class: 'readiness-next' });
  const criteria = h('ul', { class: 'readiness-criteria' });
  const renderItems = result => result.items.map(item => h('li', { class: 'readiness-criterion readiness-' + item.status },
    h('span', null, item.label),
    h('span', null, item.status === 'completed' ? (item.key === 'faq' ? '직접 확인' : '입력됨') : item.status === 'not-applicable' ? '계산 제외' : '확인 필요')));
  const update = () => {
    const result = scoreForDraft(d);
    updateText(number, String(result.score));
    updateAttr(meter, 'aria-valuenow', result.score);
    if (meterFill.style) meterFill.style.width = result.score + '%';
    else if (meterFill.attrs?.style) meterFill.attrs.style.width = result.score + '%';
    const missing = result.items.find(item => item.status === 'missing');
    updateText(tip, missing ? missing.tip : '입력한 항목과 예상 질문·답변 확인을 마쳤어요. 공개할 내용이 실제와 맞는지 한 번 더 살펴봐 주세요.');
    updateChildren(criteria, renderItems(result));
    return result;
  };
  update();
  return {
    element: h('section', { class: 'readiness-current', 'aria-labelledby': 'readiness-current-title' },
      h('div', { class: 'readiness-current-heading' },
        h('div', null, h('p', { class: 'readiness-current-label' }, '여기봐 AI 자체 기준'), h('h3', { id: 'readiness-current-title' }, 'AI 가게정보 준비도')),
        h('span', { class: 'readiness-current-badge' }, '현재 초안 · 비공개')),
      h('p', { class: 'readiness-current-score', role: 'status', 'aria-live': 'polite' }, number, h('span', null, ' / 100점')),
      meter,
      tip,
      h('details', { class: 'readiness-details' }, h('summary', null, '점수 기준 자세히 보기'), criteria,
        h('p', { class: 'readiness-fineprint' }, '기본 배점: 가게명·주소 20, 대표 메뉴·서비스 20, 차별점 20, 손님·방문 상황 15, 이용 정보 10, 예상 질문·답변 확인 15점. 해당 없음을 선택한 항목은 제외하고 환산해요.')),
      h('p', { class: 'readiness-caveat' }, '입력과 확인 여부만 계산해요. 사실 여부나 공개 내용 반영은 자동 검증하지 않으며, 실제 AI 수집·검색 노출·추천을 뜻하지 않아요.')),
    update,
  };
}

export function makeReadinessBenefits(h, d) {
  const score = makeReadinessCard(h, d);
  const item = (title, description) => h('li', null,
    h('span', { class: 'readiness-benefit-mark', 'aria-hidden': 'true' }, '✓'),
    h('div', null, h('strong', null, title), h('p', null, description)));
  return {
    element: h('aside', { class: 'readiness-aside', tabindex: '0', 'aria-label': '작성을 마치면 받을 수 있는 것' },
      h('section', { class: 'readiness-benefits' },
        h('p', { class: 'readiness-benefits-kicker' }, '우리 가게를 위한 준비'),
        h('h3', null, '작성을 마치면 받을 수 있어요'),
        h('ul', null,
          item('AI가 접근하기 좋은 여기봐 AI에 가게 소개 페이지 공개', '내용을 직접 확인한 뒤, AI·검색 봇이 접근할 수 있도록 설정된 여기봐 AI에 우리 가게 페이지를 공개해요.'),
          item('우리 가게 소개글과 손님 예상 질문·답변', '가게 특징을 바탕으로 만든 초안을 확인하고 수정해요.'),
          item('AI 가게정보 준비도 점수와 보완할 내용', '입력한 정보와 확인 여부를 기준으로 살펴봐요.'),
          item('공개 후 가게 페이지 링크·QR코드와 SNS 공유 문구', '공개 후 손님과 SNS에 공유할 수 있어요.')),
        h('details', { class: 'readiness-benefits-more' }, h('summary', null, '나머지 혜택 자세히 보기'),
          h('p', null, '가게 특징으로 소개글과 손님 예상 질문·답변을 만든 뒤, 내용을 확인하고 수정할 수 있어요.'),
          h('p', null, '준비도 점수는 입력한 정보와 확인 여부를 기준으로 해요.'),
          h('p', null, '페이지를 공개한 후 링크와 QR코드, SNS 공유 문구를 이용할 수 있어요.')),
        h('p', { class: 'readiness-benefits-note' }, '현재 베타 기간에는 무료로 공개할 수 있어요. AI·검색 봇의 방문과 검색 노출·추천은 보장하지 않아요.')),
      score.element),
    update: score.update,
  };
}

export function makeReadinessReview(h, d, save, update) {
  const draft = obj(d.draft), faqs = list(draft.faqs), store = obj(d.store);
  const canReview = calculateReadiness({ name: store.name, address: store.address, answers: d.answers, notApplicable: d.readinessNA, faqReviewed: true, faqs }).items.find(item => item.key === 'faq')?.status === 'completed';
  const checked = canReview && d.readinessReview === readinessReviewSignature(d);
  return h('section', { class: 'readiness-review-check' },
    h('h3', null, '예상 질문·답변 확인'),
    h('p', null, '위 질문과 답변이 실제 가게와 맞는지 직접 확인해 주세요. 입력한 내용이나 초안이 바뀌면 다시 확인해야 해요.'),
    h('label', { class: 'readiness-review-label' },
      h('input', { type: 'checkbox', checked, disabled: !canReview, onchange: e => {
        if (e.target.checked && canReview) d.readinessReview = readinessReviewSignature(d);
        else delete d.readinessReview;
        save(); update();
      } }),
      h('span', null, '예상 질문과 답변을 확인했어요 (기본 배점 15점)')),
    !canReview ? h('p', { class: 'readiness-review-help' }, '확인할 질문·답변이 없거나 비어 있어요. 필요하면 내용 수정에서 직접 추가하거나 고칠 수 있어요.') : null);
}
