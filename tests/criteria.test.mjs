// 기획서 12번 '완성 기준' 8가지를 자동으로 확인하는 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleQuestions } from '../shared/engine.js';
import { inputSignature } from '../shared/engine.js';
import { compute, compareQuote } from '../shared/calc.js';
import { generateReport } from '../shared/diagnose.js';
import { sampleDeliveryRestaurant, sampleHallCafe } from '../shared/samples.js';

const A = (v, s = 'exact', extra = {}) => ({ v, s, ...extra });
const ids = (data) => new Set(visibleQuestions(data).map((q) => q.id));
const base = (biz, split, extra = {}) => ({
  profile: { name: '테스트', address: '주소', biz, sub: '', concerns: [], channels: {} },
  answers: { b_split: A(split), ...extra }, attachments: [], external: { entries: [], quotes: [] }, settings: {},
});

test('1. 배달 중심 음식점과 홀 중심 카페에 서로 다른 추가 질문이 나온다', () => {
  const r = ids(base('restaurant', { hall: 20, takeout: 10, delivery: 70 }));
  const c = ids(base('cafe', { hall: 80, takeout: 20, delivery: 0 }));
  for (const q of ['d_orders', 'd_ticket', 'd_commission', 'd_delivery_fee', 'd_discount', 'd_fee_in_deposit'].filter((x) => x !== 'd_fee_in_deposit')) {
    assert.ok(r.has(q), `배달 음식점에 ${q} 질문이 있어야 함`);
    assert.ok(!c.has(q), `홀 카페에는 ${q} 질문이 없어야 함`);
  }
  assert.ok(r.has('d_packaging') && c.has('d_packaging'), '포장비는 포장 비중이 20% 이상인 카페에도 묻는다');
  assert.ok(!ids(base('cafe', { hall: 95, takeout: 5, delivery: 0 })).has('d_packaging'), '포장이 거의 없는 카페에는 포장비를 묻지 않는다');
  for (const q of ['h_stay', 'h_laptop', 'm_bean_kg', 'm_dessert_source']) {
    assert.ok(c.has(q), `카페에 ${q} 질문이 있어야 함`);
    assert.ok(!r.has(q), `배달 음식점에는 ${q} 질문이 없어야 함`);
  }
  // 답변에 따른 추가 질문
  const d = base('restaurant', { hall: 20, takeout: 10, delivery: 70 }, { s_monthly: A(30000000), m_count: A(40), c_ads: A(500000), cu_repeat: A('low'), p_waste: A('often'), pr_position: A('higher') });
  const x = ids(d);
  for (const q of ['s_month', 's_basis', 'm_best', 'm_exclusive', 'mk_ads_list', 'mk_ads_track', 'cu_repeat_basis', 'p_waste_detail', 'pr_reason']) assert.ok(x.has(q), `답변에 따라 ${q} 추가 질문이 나와야 함`);
  const y = ids(base('restaurant', { hall: 20, takeout: 10, delivery: 70 }, { m_count: A(12), c_ads: { s: 'na' }, p_waste: A('rare') }));
  for (const q of ['s_month', 'm_best', 'mk_ads_list', 'p_waste_detail', 'pr_reason']) assert.ok(!y.has(q), `${q}는 조건이 맞지 않으면 나오지 않아야 함`);
  // 입금액 기준일 때만 수수료 차감 여부 질문
  assert.ok(ids(base('restaurant', { hall: 20, takeout: 10, delivery: 70 }, { s_monthly: A(1e7), s_basis: A('net') })).has('d_fee_in_deposit'));
  assert.ok(!ids(base('restaurant', { hall: 20, takeout: 10, delivery: 70 }, { s_monthly: A(1e7), s_basis: A('gross') })).has('d_fee_in_deposit'));
});

test('2. 모르는 비용을 0원으로 처리하지 않는다', () => {
  const d = base('restaurant', { hall: 100, takeout: 0, delivery: 0 }, {
    s_monthly: A(20000000), s_basis: A('gross'), b_staff: A(2), c_food: A(8000000), c_labor: { s: 'unknown' }, c_rent: A(2000000),
    c_mgmt: { s: 'na' }, c_util: A(500000), c_card_fee: A(200000), c_ads: { s: 'na' }, c_supplies: A(200000), c_other: A(300000),
  });
  const c = compute(d);
  const labor = c.costs.find((x) => x.key === 'c_labor');
  assert.equal(labor.state, 'missing');
  assert.equal(labor.monthly, null);
  assert.equal(c.profit.kind, 'upper_bound');
  assert.ok(c.profit.missing.includes('직원 인건비'));
  assert.match(c.profit.label, /빠진 비용/);
  assert.equal(c.costs.find((x) => x.key === 'c_mgmt').state, 'na', '"해당 없음"은 0원으로 처리 가능');
  const rep = generateReport(d);
  const s = rep.solutions.find((x) => x.id === 'missing_costs');
  assert.ok(s, '빠진 비용 확인 해결책이 있어야 함');
  assert.ok(s.evidence.some((e) => e.t === 'need' && e.text.includes('0원으로 계산하지 않았어요')));
  assert.ok(!rep.calc.ratios.some((r) => r.key === 'labor'), '모르는 인건비로 비율을 만들지 않음');
});

test('3. 수수료나 비용을 중복 차감하지 않는다', () => {
  const common = { s_monthly: A(30000000), b_staff: A(0), d_orders: A(1000), d_ticket: A(20000), d_commission: A(7.8), d_payfee: A(3), d_delivery_fee: A(3000), d_discount: A(1000), d_packaging: A(500), c_food: A(10000000), c_rent: A(2000000) };
  const split = { hall: 33, takeout: 0, delivery: 67 };
  const gross = compute(base('restaurant', split, { ...common, s_basis: A('gross') }));
  const netAll = compute(base('restaurant', split, { ...common, s_basis: A('net'), d_fee_in_deposit: A('all') }));
  const netComm = compute(base('restaurant', split, { ...common, s_basis: A('net'), d_fee_in_deposit: A('commission_only') }));
  const unk = compute(base('restaurant', split, { ...common, s_basis: A('unknown') }));
  const platform = 20000000 * (0.078 + 0.03);
  assert.equal(gross.costs.find((x) => x.key === 'd_platform').state, 'computed');
  assert.equal(netAll.costs.find((x) => x.key === 'd_platform').state, 'deducted');
  assert.equal(netAll.costs.find((x) => x.key === 'd_fee').state, 'deducted');
  assert.equal(netComm.costs.find((x) => x.key === 'd_platform').state, 'deducted');
  assert.equal(netComm.costs.find((x) => x.key === 'd_fee').state, 'computed', '수수료만 빠진 경우 배달비는 비용으로 뺌');
  assert.ok(Math.abs(netAll.profit.high - gross.profit.high - (platform + 3000000 + 1000000)) < 1, '입금액 기준이면 이미 빠진 수수료·배달비·할인을 다시 빼지 않음');
  assert.equal(netAll.costs.find((x) => x.key === 'c_card_fee').state, 'deducted', '입금액 기준이면 카드 수수료도 이미 빠진 것으로 처리');
  assert.equal(unk.profit.range, true, '기준을 모르면 범위로 표시');
  assert.ok(Math.abs(unk.profit.high - unk.profit.low - (platform + 3000000 + 1000000)) < 1);
});

test('4. 규격이 다른 식재료를 같은 상품처럼 비교하지 않는다', () => {
  const item = { name: '밀떡', brand: '가상식품', size: 1, unit: 'kg', count: 1, grade: '냉장', qty: 100, price: 4000, vat: 'incl', ship: 0, orders: 8 };
  const today = new Date().toISOString().slice(0, 10);
  const same = compareQuote(item, { item: '밀떡', brand: '가상식품', size: 1, unit: 'kg', count: 1, grade: '냉장', price: 3500, vat: 'incl', ship: 0, observedAt: today });
  assert.equal(same.level, 'same');
  assert.ok(Math.abs(same.monthlySaving - 50000) < 1, '같은 조건이면 (4000-3500)×100 = 5만 원 예상 절감');
  const bigger = compareQuote(item, { item: '밀떡', brand: '가상식품', size: 2, unit: 'kg', count: 1, grade: '냉장', price: 6000, vat: 'incl', ship: 0, observedAt: today });
  assert.equal(bigger.level, 'similar');
  assert.equal(bigger.monthlySaving, null, '포장 규격이 다르면 절감액을 계산하지 않음');
  assert.ok(bigger.reasons.some((r) => r.includes('포장 규격')));
  const countUnit = compareQuote(item, { item: '밀떡', brand: '가상식품', size: 10, unit: '개', price: 3000, vat: 'incl', ship: 0, observedAt: today });
  assert.equal(countUnit.level, 'incomparable', '무게와 개수는 비교 불가');
  const otherBrand = compareQuote(item, { item: '밀떡', brand: '다른식품', size: 1, unit: 'kg', grade: '냉장', price: 3000, vat: 'incl', ship: 0, observedAt: today });
  assert.equal(otherBrand.level, 'similar');
  const vatUnknown = compareQuote(item, { item: '밀떡', brand: '가상식품', size: 1, unit: 'kg', grade: '냉장', price: 3000, vat: '', ship: 0, observedAt: today });
  assert.equal(vatUnknown.level, 'similar');
  const vatExcl = compareQuote(item, { item: '밀떡', brand: '가상식품', size: 1, unit: 'kg', grade: '냉장', price: 3500, vat: 'excl', ship: 0, observedAt: today });
  assert.equal(vatExcl.level, 'same');
  assert.ok(Math.abs(vatExcl.theirs.perBase - 3850) < 1, '부가세 별도 가격은 10%를 더해 맞춤');
  const stale = compareQuote(item, { item: '밀떡', brand: '가상식품', size: 1, unit: 'kg', grade: '냉장', price: 3000, vat: 'incl', ship: 0, observedAt: '2025-01-01' });
  assert.equal(stale.level, 'similar', '오래된 견적은 절감액 계산에서 제외');
  const shipUnknown = compareQuote({ ...item, ship: '' }, { item: '밀떡', brand: '가상식품', size: 1, unit: 'kg', grade: '냉장', price: 3000, vat: 'incl', ship: 0, observedAt: today });
  assert.equal(shipUnknown.level, 'similar', '현재 배송비를 모르면 같은 조건으로 보지 않음');
});

test('5. 외부 정보를 찾지 못했을 때 만들어내지 않는다', () => {
  const cafe = sampleHallCafe();
  const rep = generateReport(cafe);
  assert.equal(rep.external.autoSearch, false);
  assert.equal(rep.external.used.length, 0);
  assert.equal(rep.external.competitors.length, 0);
  assert.equal(rep.external.confirmed.length, 0);
  assert.ok(rep.external.unchecked.some((u) => u.key === 'insta'), '확인하지 못한 채널은 미확인으로 표시');
  assert.ok(rep.needMore.some((x) => x.includes('자동으로 확인하지 못했어요')));
  for (const s of rep.solutions) for (const e of s.evidence) assert.ok(!(e.t === 'doc' && /플레이스|공개 페이지|리뷰/.test(e.text)), `외부 근거를 만들어내면 안 됨: ${e.text}`);
  // 가게명·주소가 일치하지 않는 정보는 제외
  const res = generateReport(sampleDeliveryRestaurant());
  assert.ok(res.external.excluded.some((e) => e.id === 'e3'));
  assert.ok(!res.external.used.some((e) => e.id === 'e3'));
});

test('6. 예산과 시간이 부족하면 실행 가능한 대안을 준다', () => {
  const low = generateReport(sampleHallCafe());
  const alts = low.solutions.filter((s) => s.usedAlt);
  assert.ok(alts.length >= 3, '예산·시간이 부족하면 대안으로 바꾼 해결책이 있어야 함');
  for (const id of low.top) {
    const s = low.solutions.find((x) => x.id === id);
    assert.ok(s.cost.cash[1] <= 10000 && s.cost.hoursWeekly <= 1, `우선 해결책 ${id}는 예산(1만 원 이하)·시간(주 1시간 미만) 안에서 실행 가능해야 함`);
  }
  const richData = sampleHallCafe();
  richData.answers.g_budget = A(4);
  richData.answers.g_time = A(3);
  const rich = generateReport(richData);
  assert.equal(rich.solutions.find((s) => s.id === 'outside').usedAlt, false, '예산이 충분하면 원래 방법을 제시');
  assert.equal(low.solutions.find((s) => s.id === 'outside').usedAlt, true);
  const cons = low.solutions.filter((s) => s.feasibility === 1);
  for (const s of cons) assert.ok(s.constraintNote, '대안도 어려우면 그 이유와 미루는 방법을 알려야 함');
});

test('7. 각 해결책에 근거와 효과 확인 방법이 있다', () => {
  for (const data of [sampleDeliveryRestaurant(), sampleHallCafe()]) {
    const rep = generateReport(data);
    assert.ok(rep.solutions.length >= 8);
    for (const s of rep.solutions) {
      assert.ok(s.title && s.problem, `${s.id} 발견한 문제`);
      assert.ok(s.evidence.length > 0, `${s.id} 판단 근거`);
      assert.ok(s.actions.length > 0, `${s.id} 추천 행동`);
      assert.ok(Array.isArray(s.cost.cash) && s.cost.who, `${s.id} 비용·담당`);
      assert.ok(s.effectText && s.uncertainty, `${s.id} 기대 효과와 불확실성`);
      assert.ok(s.measure.metric && s.measure.how && s.measure.period, `${s.id} 효과 확인 방법`);
      assert.ok(['sales', 'profit', 'ops'].includes(s.goal), `${s.id} 매출/수익성 구분`);
      for (const t of [s.title, s.effectText, ...s.actions]) assert.ok(!/\d+\s*%\s*(상승|증가)\s*(예상|기대)/.test(t), `${s.id} 근거 없는 상승률 예측 금지`);
    }
    assert.equal(rep.top.length, 3);
    assert.ok(rep.plan.week.length > 0);
  }
});

test('8. 입력을 수정하면 관련 계산과 보고서가 함께 갱신된다', () => {
  const d = sampleDeliveryRestaurant();
  const r1 = generateReport(d);
  const sig1 = inputSignature(d);
  d.answers.c_labor = A(4000000);
  d.answers.c_card_fee = A(300000);
  const r2 = generateReport(d);
  assert.notEqual(inputSignature(d), sig1);
  assert.equal(r1.calc.profit.kind, 'upper_bound');
  assert.equal(r2.calc.profit.kind, 'estimate', '빠진 카드 수수료를 채우면 추정 이익으로 바뀜');
  assert.ok(Math.abs(r2.calc.profit.high - (r1.calc.profit.high + 1600000 - 300000)) < 1, '인건비·카드 수수료 수정이 이익에 반영');
  assert.notEqual(r2.calc.ratios.find((x) => x.key === 'labor').value, r1.calc.ratios.find((x) => x.key === 'labor').value);
  assert.ok(r2.calc.ownerHourly.high > r1.calc.ownerHourly.high);
  assert.ok(!r2.solutions.some((s) => s.id === 'missing_costs'), '빠진 비용이 없으면 해당 해결책이 사라짐');
});
