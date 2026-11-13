import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReadiness, READINESS_WEIGHTS } from '../public/readiness-score.js';

const base = { name: '꿈수 식당', address: '서울 강남구 1' };
const faqs = [{ question: '주차 되나요?', answer: '건물 지하 주차장을 이용할 수 있어요.' }];
const status = (r, key) => r.items.find((i) => i.key === key).status;

test('가중치 합계는 100', () => {
  assert.equal(Object.values(READINESS_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('기본만 20점', () => {
  const r = calculateReadiness(base);
  assert.equal(r.score, 20);
  assert.equal(r.earned, 20);
  assert.equal(r.possible, 100);
  assert.equal(r.items.length, 6);
});

test('기본+offer+difference 60점', () => {
  const r = calculateReadiness({ ...base, answers: { offer: '수제 돈까스', difference: '매일 직접 반죽' } });
  assert.equal(r.score, 60);
});

test('audience+visit까지 85점, FAQ 검토 후 100점', () => {
  const answers = { offer: '수제 돈까스', difference: '매일 직접 반죽', audience: '점심 직장인', visit: '11시 오픈, 월요일 휴무' };
  assert.equal(calculateReadiness({ ...base, answers }).score, 85);
  assert.equal(calculateReadiness({ ...base, answers, faqReviewed: true, faqs }).score, 100);
});

test('FAQ는 검토 true + 유효한 항목이 모두 있어야 인정', () => {
  assert.equal(status(calculateReadiness({ ...base, faqs }), 'faq'), 'missing');
  assert.equal(status(calculateReadiness({ ...base, faqReviewed: 'true', faqs }), 'faq'), 'missing');
  assert.equal(status(calculateReadiness({ ...base, faqReviewed: true, faqs: [] }), 'faq'), 'missing');
  assert.equal(status(calculateReadiness({ ...base, faqReviewed: true, faqs: [...faqs, { question: '  ', answer: '답' }] }), 'faq'), 'missing');
  assert.equal(status(calculateReadiness({ ...base, faqReviewed: true, faqs: [{ question: '질문', answer: 5 }] }), 'faq'), 'missing');
  assert.equal(status(calculateReadiness({ ...base, faqReviewed: true, faqs: [null] }), 'faq'), 'missing');
  assert.equal(status(calculateReadiness({ ...base, faqReviewed: true, faqs }), 'faq'), 'completed');
});

test('N/A는 분모에서 제외하고 100점 기준 반올림', () => {
  const r = calculateReadiness({
    ...base,
    answers: { offer: '수제 돈까스' },
    notApplicable: { difference: true, audience: true, visit: true },
  });
  assert.equal(r.possible, 55);
  assert.equal(r.earned, 40);
  assert.equal(r.score, 73); // 40/55
  assert.equal(status(r, 'difference'), 'not-applicable');
  const all = calculateReadiness({ ...base, answers: { offer: '수제 돈까스' }, notApplicable: { difference: true, audience: true, visit: true }, faqReviewed: true, faqs });
  assert.equal(all.score, 100);
});

test('offer/기본/FAQ는 N/A로 제외 불가, true만 인정', () => {
  const r = calculateReadiness({ notApplicable: { basic: true, offer: true, faq: true, difference: 'yes', audience: 1 } });
  assert.equal(r.possible, 100);
  assert.equal(r.score, 0);
  for (const k of ['basic', 'offer', 'faq', 'difference', 'audience']) assert.equal(status(r, k), 'missing');
});

test('이름/주소/offer 최소 길이', () => {
  assert.equal(status(calculateReadiness({ name: '', address: '서울 강남' }), 'basic'), 'missing');
  assert.equal(status(calculateReadiness({ name: '가', address: '서울' }), 'basic'), 'missing');
  assert.equal(status(calculateReadiness({ name: '가', address: '서울시' }), 'basic'), 'missing');
  assert.equal(status(calculateReadiness({ name: '가', address: '서울 1' }), 'basic'), 'completed');
  assert.equal(status(calculateReadiness({ ...base, answers: { offer: '떡' } }), 'offer'), 'missing');
  assert.equal(status(calculateReadiness({ ...base, answers: { offer: '떡볶' } }), 'offer'), 'completed');
});

test('기본값/모름/해당없음/템플릿/빈 칸은 미완료', () => {
  const bad = ['', '   ', '모름', '잘 모르겠어요', '해당 없음', '해당없음', '미입력', '선택 안 함', 'N/A', 'n/a', 'TBD', '...', '[ ]', '[..]', '[대표 메뉴를 입력]', '우리 가게는 [..] 입니다', 'ㅇㅇ', 'aaaa', '테스트'];
  for (const text of bad) {
    const r = calculateReadiness({ ...base, answers: { offer: text, difference: text, audience: text, visit: text } });
    assert.equal(r.score, 20, `"${text}" 는 완료로 치면 안 됨`);
  }
  assert.equal(status(calculateReadiness({ name: '모름', address: '미입력' }), 'basic'), 'missing');
  assert.equal(status(calculateReadiness({ name: '[가게 이름]', address: '서울 강남구 1' }), 'basic'), 'missing');
});

test('placeholder 답변이어도 사용자가 N/A를 선택했으면 제외', () => {
  const r = calculateReadiness({ ...base, answers: { offer: '수제 돈까스', visit: '해당 없음' }, notApplicable: { visit: true } });
  assert.equal(status(r, 'visit'), 'not-applicable');
  assert.equal(r.possible, 90);
});

test('잘못된 입력 타입에도 throw하지 않음', () => {
  const inputs = [
    undefined, null, 5, 'x', [], () => {},
    { name: 5, address: {}, answers: null, notApplicable: 'x', faqReviewed: 1, faqs: 'x' },
    { name: [], address: [], answers: [], notApplicable: [], faqs: {} },
    { answers: { offer: 5, difference: {}, audience: [1, null], visit: Symbol('x') } },
  ];
  for (const input of inputs) {
    let r;
    assert.doesNotThrow(() => { r = calculateReadiness(input); });
    assert.equal(r.score, 0);
    assert.equal(r.possible, 100);
    assert.equal(r.items.length, 6);
  }
});

test('반환 형태와 tip', () => {
  const r = calculateReadiness();
  assert.deepEqual(Object.keys(r).sort(), ['earned', 'items', 'possible', 'score']);
  assert.deepEqual(r.items.map((i) => i.key), ['basic', 'offer', 'difference', 'audience', 'visit', 'faq']);
  for (const item of r.items) {
    assert.deepEqual(Object.keys(item).sort(), ['key', 'label', 'points', 'status', 'tip']);
    assert.ok(['completed', 'missing', 'not-applicable'].includes(item.status));
    assert.ok(item.tip.length > 10);
  }
  const full = calculateReadiness({ ...base, answers: { offer: '수제 돈까스' } });
  assert.equal(full.items[0].tip, '');
});

test('tip과 label에 AI 노출 보장/AI가 읽었다는 표현이 없음', () => {
  const r = calculateReadiness();
  const text = r.items.map((i) => `${i.label} ${i.tip}`).join(' ');
  assert.ok(!/AI.{0,12}(노출|추천|읽|학습|인용)|보장|확률|상위/.test(text));
  assert.ok(!/거짓|허위|없는 .{0,6}(적어|입력)/.test(text.replace('실제', '')) || /실제/.test(text));
});

test('실제 상호와 대괄호가 든 사실은 임의로 미입력 처리하지 않음', () => {
  const r = calculateReadiness({ name: '쑥쑥', address: '서울시 마포구 1', answers: { offer: '[계절] 라떼', visit: '[주말] 포장 가능' } });
  assert.equal(status(r, 'basic'), 'completed');
  assert.equal(status(r, 'offer'), 'completed');
  assert.equal(status(r, 'visit'), 'completed');
});
