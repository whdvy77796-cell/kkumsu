// 정해진 계산 로직 (AI가 아닌 코드로 계산하고, 계산식과 누락 항목을 함께 남긴다)
import { makeCtx, isQuestionVisible, openDaysPerMonth, hasValue, PERIOD_FACTOR } from './engine.js';
import { QMAP } from './questions.js';
import { isNum, median, UNIT_INFO, DIM_LABEL, DIM_DISPLAY_FACTOR, norm, WEEKS_PER_MONTH, fmtMan, fmtWon, fmtPct } from './format.js';
import { benchFor, minWageFor, RULES } from './benchmarks.js';
import { isStale } from './external.js';

export const BASIS_LABEL = {
  gross: '손님 결제금액 기준 (수수료 빼기 전)',
  net: '통장 입금액 기준 (수수료가 이미 빠진 금액)',
  mixed: '혼합 기준 (매장은 결제금액, 배달은 입금액)',
  unknown: '기준을 모름',
};

const pct = (c, id) => {
  if (c.status(id) === 'na') return 0;
  const n = c.num(id);
  return n === null ? null : n / 100;
};
const wonOrNa = (c, id) => {
  if (c.status(id) === 'na') return 0;
  return c.num(id);
};

function qVisible(c, id) {
  const q = QMAP[id];
  return q ? isQuestionVisible(q, c) : false;
}

// 비용 항목 하나를 읽는다: 모르는 값은 0이 아니라 'missing'
function readCost(c, id, label, group) {
  const a = c.data.answers?.[id];
  const visible = qVisible(c, id);
  if (!visible && !(a && hasValue(a.v))) return null;
  const base = { key: id, label, group, source: id };
  if (!a || a.s === 'later' || a.s === 'unknown' || (!hasValue(a.v) && a.s !== 'na')) {
    return { ...base, state: 'missing', monthly: null, note: a?.s === 'unknown' ? '정확히 모름' : '미입력' };
  }
  if (a.s === 'na') return { ...base, state: 'na', monthly: 0, note: '해당 없음' };
  const v = c.monthly(id);
  return { ...base, state: a.s === 'approx' ? 'approx' : 'known', monthly: v, period: a.p || 'month' };
}

export function compute(data) {
  const c = makeCtx(data);
  const bench = benchFor(c.biz, c.sub);
  const notes = [];

  // ───── 1. 매출
  const S = c.monthly('s_monthly');
  const sAns = data.answers?.s_monthly;
  const basis = S ? (c.v('s_basis') || 'unknown') : null;
  const orders = c.num('s_orders');
  const ticket = c.num('s_ticket');
  const sales = {
    monthly: S, approx: sAns?.s === 'approx', basis, basisLabel: basis ? BASIS_LABEL[basis] : null,
    month: c.v('s_month') || null, orders, ticket,
    impliedTicket: S && orders ? S / orders : null,
    source: sAns?.src || 'owner',
  };

  // ───── 2. 배달 단위 계산
  const deliveryish = c.deliveryish();
  const dShare = c.share('delivery');
  const dOrders = c.num('d_orders');
  const dTicket = c.num('d_ticket');
  const commission = pct(c, 'd_commission');
  const payfee = pct(c, 'd_payfee');
  const dFee = wonOrNa(c, 'd_delivery_fee');
  const dDisc = wonOrNa(c, 'd_discount');
  const pack = wonOrNa(c, 'd_packaging');
  let dSales = null;
  let dSalesEstimated = false;
  if (dOrders && dTicket) dSales = dOrders * dTicket;
  else if (S && dShare !== null && deliveryish) { dSales = S * dShare; dSalesEstimated = true; }

  // 입금액에 이미 빠져 있는지 판단
  const feeIn = c.v('d_fee_in_deposit');
  function inclusion(kind) {
    if (!S) return 'cost';
    if (basis === 'gross') return 'cost';
    if (basis === 'unknown') return 'uncertain';
    // net, mixed
    if (feeIn === 'all') return 'deducted';
    if (feeIn === 'commission_only') return kind === 'deliveryFee' ? 'cost' : 'deducted';
    if (feeIn === 'none') return 'cost';
    return 'uncertain';
  }

  const costs = [];
  const push = (x) => { if (x) costs.push(x); };
  push(readCost(c, 'c_food', '식재료 구매액', 'variable'));
  if (c.staffCount() === 0) costs.push({ key: 'c_labor', label: '직원 인건비', group: 'fixed', state: 'na', monthly: 0, note: '직원 없음' });
  else push(readCost(c, 'c_labor', '직원 인건비', 'fixed'));
  push(readCost(c, 'c_rent', '월세', 'fixed'));
  push(readCost(c, 'c_mgmt', '관리비', 'fixed'));
  push(readCost(c, 'c_util', '전기·가스·수도', 'fixed'));
  const card = readCost(c, 'c_card_fee', '카드 결제 수수료', 'variable');
  if (card) {
    if (basis === 'unknown' && card.monthly) card.state = 'uncertain';
    push(card);
  } else if (basis === 'net') {
    costs.push({ key: 'c_card_fee', label: '카드 결제 수수료', group: 'variable', state: 'deducted', monthly: null, note: '입금액 기준 매출이라 이미 빠져 있음' });
  }

  if (deliveryish) {
    const comps = [
      { key: 'd_platform', label: '배달앱 중개·결제 수수료', kind: 'platform', rate: commission !== null && payfee !== null ? commission + payfee : null, perOrder: null },
      { key: 'd_fee', label: '가게 부담 배달비', kind: 'deliveryFee', perOrder: dFee },
      { key: 'd_disc', label: '가게 부담 할인·쿠폰', kind: 'discount', perOrder: dDisc },
    ];
    for (const comp of comps) {
      let monthly = null;
      if (comp.kind === 'platform') monthly = comp.rate !== null && dSales ? dSales * comp.rate : null;
      else monthly = comp.perOrder !== null && dOrders ? comp.perOrder * dOrders : (comp.perOrder === 0 ? 0 : null);
      const inc = inclusion(comp.kind);
      let state;
      if (inc === 'deducted') state = 'deducted';
      else if (monthly === null) state = 'missing';
      else if (inc === 'uncertain') state = 'uncertain';
      else state = dSalesEstimated && comp.kind === 'platform' ? 'estimated' : 'computed';
      costs.push({ key: comp.key, label: comp.label, group: 'variable', state, monthly: inc === 'deducted' ? monthly : monthly, deductedAmount: inc === 'deducted' ? monthly : null, note: inc === 'deducted' ? '입금액에서 이미 빠져 있어 다시 빼지 않음' : (state === 'uncertain' ? '이미 빠진 금액인지 불명확' : '') });
    }
    push(readCost(c, 'd_ads', '배달앱 광고비', 'fixed'));
  }
  // 포장재: 월 구매액이 있으면 우선, 없으면 건당 포장비로 추정
  const packCost = readCost(c, 'c_packaging', '포장재', 'variable');
  if (packCost) {
    if (packCost.state === 'missing' && isNum(pack) && pack > 0 && orders) {
      const takeShare = c.share('takeout') ?? 0;
      const pkOrders = (dOrders || (dShare !== null ? orders * dShare : 0)) + orders * takeShare;
      if (pkOrders > 0) Object.assign(packCost, { state: 'estimated', monthly: pack * pkOrders, note: `건당 포장비 ${fmtWon(pack)} × 포장·배달 주문 약 ${Math.round(pkOrders)}건으로 추정` });
    }
    push(packCost);
  }
  push(readCost(c, 'c_ads', '광고비', 'fixed'));
  push(readCost(c, 'c_outsourcing', '마케팅 외주비', 'fixed'));
  push(readCost(c, 'c_supplies', '소모품비', 'fixed'));
  push(readCost(c, 'c_other', '기타 고정비', 'fixed'));

  // ───── 3. 이익 (대표자 인건비 반영 전, 세금·대출 상환 전)
  const counted = costs.filter((x) => ['known', 'approx', 'estimated', 'computed'].includes(x.state));
  const missing = costs.filter((x) => x.state === 'missing');
  const uncertain = costs.filter((x) => x.state === 'uncertain');
  const deducted = costs.filter((x) => x.state === 'deducted');
  const sumCounted = counted.reduce((a, x) => a + x.monthly, 0);
  const sumUncertain = uncertain.reduce((a, x) => a + (x.monthly || 0), 0);
  let profit = { kind: 'unavailable', reason: '월매출 정보가 없어 계산할 수 없어요' };
  if (S) {
    const high = S - sumCounted;
    const low = S - sumCounted - sumUncertain;
    profit = {
      kind: missing.length ? 'upper_bound' : 'estimate',
      value: uncertain.length ? null : high,
      low: uncertain.length ? low : high,
      high,
      range: uncertain.length > 0,
      rate: high / S,
      missing: missing.map((x) => x.label),
      uncertain: uncertain.map((x) => x.label),
      deducted: deducted.map((x) => x.label),
      formula: `월매출 ${fmtMan(S)} − 입력된 비용 합계 ${fmtMan(sumCounted)}${uncertain.length ? ` (− 기준이 불명확한 ${fmtMan(sumUncertain)})` : ''}`,
      label: missing.length ? '입력된 비용만 뺀 금액 (빠진 비용이 있어 실제 이익은 이보다 적어요)' : '입력 자료 기준 추정 이익',
    };
  }
  const ownerMode = c.v('c_owner_pay');
  const ownerPay = ownerMode === 'fixed' ? c.monthly('c_owner_pay_amt') : null;
  if (profit.kind !== 'unavailable') {
    profit.ownerPayMode = ownerMode || 'unknown';
    profit.ownerPay = ownerPay;
    if (ownerMode === 'fixed' && isNum(ownerPay)) {
      profit.afterOwnerLow = profit.low - ownerPay;
      profit.afterOwnerHigh = profit.high - ownerPay;
    }
  }
  const loan = c.monthly('c_loan');

  // ───── 4. 사장님 시간당 소득
  const ownerHours = c.num('b_owner_hours');
  let ownerHourly = null;
  if (profit.kind !== 'unavailable' && ownerHours && ownerHours > 0 && profit.high > 0) {
    const mh = ownerHours * WEEKS_PER_MONTH;
    const year = new Date().getFullYear();
    const mw = minWageFor(year);
    ownerHourly = {
      monthlyHours: mh,
      low: profit.low / mh,
      high: profit.high / mh,
      isUpperBound: profit.kind === 'upper_bound',
      minWage: mw.hourly, minWageYear: MIN_WAGE_YEAR(year), minWageSource: mw.source,
      formula: `남는 금액 ÷ (주 ${ownerHours}시간 × ${WEEKS_PER_MONTH.toFixed(2)}주)`,
    };
  }

  // ───── 5. 비율 (같은 달·같은 기준 매출 대비)
  const ratios = [];
  const food = costs.find((x) => x.key === 'c_food');
  const labor = costs.find((x) => x.key === 'c_labor');
  const rent = costs.find((x) => x.key === 'c_rent');
  const basisNote = basis === 'net' ? '입금액 기준이라 결제금액 기준보다 비율이 조금 높게 나와요.' : basis === 'unknown' ? '매출 기준이 불명확해 비율도 참고용이에요.' : basis === 'mixed' ? '혼합 기준 매출이라 비율은 참고용이에요.' : '';
  if (S && food && isNum(food.monthly)) {
    ratios.push({ key: 'food', label: '식재료 구매 비율', value: food.monthly / S, formula: '식재료 구매액 ÷ 월매출 × 100', bench: bench.food, benchLabel: bench.label, note: `구매액 기준이라 재고 변화와 폐기가 섞여 있어요. ${basisNote}`.trim() });
  }
  if (S && labor && isNum(labor.monthly) && labor.state !== 'na') {
    ratios.push({ key: 'labor', label: '직원 인건비율', value: labor.monthly / S, formula: '같은 기간 직원 인건비 ÷ 월매출 × 100', bench: bench.labor, benchLabel: bench.label, note: `사장님 본인 몫은 포함하지 않았어요. ${basisNote}`.trim() });
  }
  if (S && rent && isNum(rent.monthly) && rent.state !== 'na') {
    ratios.push({ key: 'rent', label: '월세 비율', value: rent.monthly / S, formula: '월세 ÷ 월매출 × 100', bench: bench.rent, benchLabel: bench.label, note: basisNote });
  }
  const adsSum = ['c_ads', 'd_ads', 'c_outsourcing'].map((k) => costs.find((x) => x.key === k)).filter((x) => x && isNum(x.monthly));
  if (S && adsSum.length) {
    const t = adsSum.reduce((a, x) => a + x.monthly, 0);
    ratios.push({ key: 'ads', label: '광고·홍보비 비율', value: t / S, formula: '(광고비 + 배달앱 광고비 + 외주비) ÷ 월매출 × 100', note: basisNote });
  }
  if (S && food && labor && isNum(food.monthly) && isNum(labor.monthly)) {
    ratios.push({ key: 'prime', label: '식재료비 + 인건비 비율', value: (food.monthly + labor.monthly) / S, formula: '(식재료 구매액 + 직원 인건비) ÷ 월매출 × 100', note: '가게 운영에서 가장 큰 두 비용을 함께 본 값이에요.' });
  }
  for (const r of ratios) {
    if (isNum(r.bench)) r.gap = r.value - r.bench;
  }

  // ───── 6. 메뉴 분석
  const menu = analyzeMenu(c, S, food);

  // ───── 7. 배달 1건 단위 수익 (고정비 내기 전)
  let deliveryUnit = null;
  if (deliveryish && dTicket) {
    const foodRate = menu.theoreticalRate !== null && menu.coverageQty >= 0.3 ? { v: menu.theoreticalRate, src: '메뉴 원가 기준' }
      : (S && food && isNum(food.monthly) ? { v: food.monthly / S, src: '식재료 구매 비율로 추정' } : null);
    const comps = [
      { label: '중개 수수료', v: commission !== null ? dTicket * commission : null },
      { label: '결제 수수료', v: payfee !== null ? dTicket * payfee : null },
      { label: '가게 부담 배달비', v: dFee },
      { label: '가게 부담 할인', v: dDisc },
      { label: '포장비', v: c.packish() ? pack : 0 },
      { label: `재료비 (${foodRate ? foodRate.src : '미확인'})`, v: foodRate ? dTicket * foodRate.v : null },
    ];
    const known = comps.filter((x) => isNum(x.v));
    const left = dTicket - known.reduce((a, x) => a + x.v, 0);
    deliveryUnit = {
      ticket: dTicket, comps, left, rate: left / dTicket,
      missing: comps.filter((x) => !isNum(x.v)).map((x) => x.label),
      isUpperBound: comps.some((x) => !isNum(x.v)),
      monthlyOrders: dOrders,
      formula: '배달 1건 결제금액 − (수수료 + 가게 부담 배달비·할인 + 포장비 + 재료비)',
    };
  }

  // ───── 8. 손익분기 매출
  const fixedKeys = ['c_labor', 'c_rent', 'c_mgmt', 'c_util', 'c_supplies', 'c_other', 'c_ads', 'd_ads', 'c_outsourcing'];
  const fixedItems = costs.filter((x) => fixedKeys.includes(x.key));
  const fixedKnown = fixedItems.filter((x) => isNum(x.monthly) && x.state !== 'deducted').reduce((a, x) => a + x.monthly, 0);
  const fixedMissing = fixedItems.filter((x) => x.state === 'missing').map((x) => x.label);
  let bep = null;
  if (S && food && isNum(food.monthly)) {
    const varItems = costs.filter((x) => !fixedKeys.includes(x.key) && ['known', 'approx', 'estimated', 'computed', 'uncertain'].includes(x.state) && isNum(x.monthly));
    const varRate = varItems.reduce((a, x) => a + x.monthly, 0) / S;
    const varMissing = costs.filter((x) => !fixedKeys.includes(x.key) && x.state === 'missing').map((x) => x.label);
    if (varRate < 0.95) {
      const days = openDaysPerMonth(c);
      const mw = minWageFor(new Date().getFullYear()).hourly;
      const ownerTarget = ownerHours ? mw * ownerHours * WEEKS_PER_MONTH : null;
      const bep0 = fixedKnown / (1 - varRate);
      const bepOwner = ownerTarget ? (fixedKnown + ownerTarget) / (1 - varRate) : null;
      const avgTicket = ticket || sales.impliedTicket;
      bep = {
        sales: bep0, salesWithOwner: bepOwner, ownerTarget, varRate, fixed: fixedKnown,
        isLowerBound: fixedMissing.length > 0 || varMissing.length > 0,
        missing: [...fixedMissing, ...varMissing],
        dailyOrders: avgTicket && days ? bep0 / avgTicket / days : null,
        dailyOrdersWithOwner: avgTicket && days && bepOwner ? bepOwner / avgTicket / days : null,
        openDays: days,
        formula: '고정비 ÷ (1 − 변동비율). 변동비율 = (식재료·카드수수료·배달 관련 비용·포장재) ÷ 월매출',
      };
    }
  }

  // ───── 9. 매입 비교
  const purchase = analyzePurchase(c, data);

  // ───── 10. 폐기
  const wasteRows = (c.v('p_waste_detail') || []).filter((r) => r.item);
  const wasteMonthly = wasteRows.filter((r) => isNum(+r.weeklyCost) && r.weeklyCost !== '').reduce((a, r) => a + (+r.weeklyCost) * WEEKS_PER_MONTH, 0);
  const waste = {
    level: c.v('p_waste') || null,
    rows: wasteRows,
    monthly: wasteRows.some((r) => isNum(+r.weeklyCost) && r.weeklyCost !== '') ? wasteMonthly : null,
    shareOfFood: food && isNum(food.monthly) && food.monthly > 0 && wasteMonthly ? wasteMonthly / food.monthly : null,
    dessertWeekly: c.num('m_dessert_waste'),
  };

  // ───── 11. 매출 흐름
  const hist = (c.v('s_history') || []).filter((r) => r.month && isNum(+r.amount) && r.amount !== '').map((r) => ({ month: r.month, amount: +r.amount })).sort((a, b) => a.month.localeCompare(b.month));
  let trend = { answer: c.v('s_trend') || null, dropPct: c.num('s_drop_pct'), history: hist };
  if (hist.length >= 2) {
    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    trend.lastChange = (last.amount - prev.amount) / prev.amount;
    if (hist.length >= 4) {
      const half = Math.floor(hist.length / 2);
      const a = hist.slice(0, half).reduce((s, r) => s + r.amount, 0) / half;
      const b = hist.slice(half).reduce((s, r) => s + r.amount, 0) / (hist.length - half);
      trend.halfChange = (b - a) / a;
    }
    const ly = hist.find((r) => r.month === `${+last.month.slice(0, 4) - 1}${last.month.slice(4)}`);
    if (ly) trend.yoy = (last.amount - ly.amount) / ly.amount;
  }

  // ───── 12. 매장 좌석 (참고)
  const seats = c.num('b_seats');
  const hallShare = c.share('hall');
  const days = openDaysPerMonth(c);
  let seatUse = null;
  if (seats && orders && hallShare !== null && days) {
    const dailyHallOrders = (orders * hallShare) / days;
    seatUse = { seats, dailyHallOrders, perSeat: dailyHallOrders / seats, note: '주문 1건을 손님 1팀으로 본 대략적인 값이에요.' };
  }

  return {
    bench, sales, costs, missingCosts: missing, profit, loan, ownerHourly, ratios, menu, deliveryUnit, bep,
    purchase, waste, trend, seatUse, delivery: { share: dShare, orders: dOrders, ticket: dTicket, sales: dSales, salesEstimated: dSalesEstimated, commission, payfee, fee: dFee, discount: dDisc, pack, feeIn },
    notes,
  };
}

function MIN_WAGE_YEAR(year) {
  return year >= 2027 ? 2027 : 2026;
}

// ───────── 메뉴 분석: 판매량만 보고 없애라고 하지 않는다
export const MENU_GROUPS = {
  core: '잘 팔리고 많이 남는 메뉴 (품절 없이 유지)',
  promote: '더 잘 보이게 소개할 메뉴',
  improve: '설명·사진·구성을 개선할 메뉴',
  price_review: '가격 또는 제공 구성을 검토할 메뉴',
  merge: '재료를 공유하거나 통합할 메뉴',
  trial_stop: '제한적으로 판매 중단을 시험해볼 메뉴',
  info: '정보가 부족해 추가 확인이 필요한 메뉴',
  keep: '지금처럼 유지할 메뉴',
};

export function analyzeMenu(c, S, foodCost) {
  const rows = (c.v('m_list') || []).filter((r) => r && r.name);
  const items = rows.map((r) => {
    const price = r.price === '' || r.price == null ? null : +r.price;
    const qty = r.qty === '' || r.qty == null ? null : +r.qty;
    const cost = r.cost === '' || r.cost == null ? null : +r.cost;
    const prep = r.prep === '' || r.prep == null ? null : +r.prep;
    const margin = isNum(price) && isNum(cost) ? price - cost : null;
    return {
      name: r.name, price: isNum(price) ? price : null, qty: isNum(qty) ? qty : null, cost: isNum(cost) ? cost : null, prep: isNum(prep) ? prep : null,
      exclusive: r.exclusive || '', role: r.role || '',
      margin, marginRate: isNum(margin) && price ? margin / price : null,
      contribution: isNum(margin) && isNum(qty) ? margin * qty : null,
      revenue: isNum(price) && isNum(qty) ? price * qty : null,
    };
  });
  const medQty = median(items.map((i) => i.qty));
  const medRate = median(items.map((i) => i.marginRate));
  const medPrep = median(items.map((i) => i.prep));
  const protectedRoles = ['signature', 'draw', 'combo', 'season'];
  for (const it of items) {
    const notes = [];
    const hasQty = isNum(it.qty) && isNum(medQty) && medQty > 0;
    const lowSales = hasQty && it.qty < medQty * RULES.lowSalesRatio;
    const highSales = hasQty && it.qty >= medQty * RULES.highSalesRatio;
    const hasRate = isNum(it.marginRate) && isNum(medRate);
    const highMargin = hasRate && it.marginRate >= medRate;
    const lowMargin = hasRate && it.marginRate < medRate - 0.05;
    const longPrep = isNum(it.prep) && isNum(medPrep) && it.prep >= medPrep * 1.5 && it.prep - medPrep >= 3;
    const prot = protectedRoles.includes(it.role);
    it.flags = { lowSales, highSales, highMargin, lowMargin, longPrep, protected: prot };
    let g;
    if (!hasQty || !isNum(it.price)) { g = 'info'; notes.push('판매량이나 가격을 알면 분류할 수 있어요'); }
    else if (lowSales && lowMargin && (it.exclusive === 'yes' || longPrep) && !prot) g = 'trial_stop';
    else if (it.exclusive === 'yes' && !highSales) g = 'merge';
    else if (highSales && lowMargin) g = 'price_review';
    else if (highSales && highMargin) g = 'core';
    else if (highMargin && !highSales) g = 'promote';
    else if (lowSales && !hasRate) { g = 'info'; notes.push('원가를 알면 개선할지 정리할지 판단할 수 있어요'); }
    else if (lowSales) g = 'improve';
    else g = 'keep';
    if (prot && lowSales && lowMargin) notes.push('판매량은 적지만 가게에서 맡은 역할이 있어 판매 중단보다 개선을 먼저 검토해요');
    if (longPrep) notes.push(`조리 시간이 다른 메뉴보다 길어요 (${it.prep}분)`);
    it.group = g;
    it.notes = notes;
  }
  const withAll = items.filter((i) => isNum(i.price) && isNum(i.qty) && isNum(i.cost) && i.qty > 0);
  const revAll = withAll.reduce((a, i) => a + i.price * i.qty, 0);
  const costAll = withAll.reduce((a, i) => a + i.cost * i.qty, 0);
  const theoreticalRate = revAll > 0 ? costAll / revAll : null;
  const totalQty = items.reduce((a, i) => a + (i.qty || 0), 0);
  const coverageQty = totalQty > 0 ? withAll.reduce((a, i) => a + i.qty, 0) / totalQty : 0;
  const listedRevenue = items.reduce((a, i) => a + (i.revenue || 0), 0);
  const purchaseRate = S && foodCost && isNum(foodCost.monthly) ? foodCost.monthly / S : null;
  let gap = null;
  if (theoreticalRate !== null && purchaseRate !== null && coverageQty >= 0.4) gap = purchaseRate - theoreticalRate;
  const groups = {};
  for (const k of Object.keys(MENU_GROUPS)) groups[k] = items.filter((i) => i.group === k);
  // 판매 집중도: 상위 20% 메뉴가 판매량에서 차지하는 비율
  let topShare = null;
  const sorted = items.filter((i) => isNum(i.qty)).sort((a, b) => b.qty - a.qty);
  if (sorted.length >= 5 && totalQty > 0) {
    const n = Math.max(1, Math.round(sorted.length * 0.2));
    topShare = sorted.slice(0, n).reduce((a, i) => a + i.qty, 0) / totalQty;
  }
  return {
    count: c.num('m_count'), listed: items.length, items, groups, medQty, medRate,
    theoreticalRate, coverageQty, purchaseRate, gap, listedRevenue, topShare,
    salesCoverage: S && listedRevenue ? listedRevenue / S : null,
  };
}

// ───────── 매입가 비교: 브랜드·규격·등급·부가세·배송비가 같을 때만 절감액 계산
export function baseQty(x) {
  const u = UNIT_INFO[x?.unit];
  const size = +x?.size;
  if (!u || !isNum(size) || size <= 0) return null;
  const cnt = isNum(+x.count) && +x.count > 0 ? +x.count : 1;
  return { dim: u.dim, qty: size * u.factor * cnt };
}

export function specText(x) {
  if (!x || !x.size || !x.unit) return '규격 미기재';
  const cnt = +x.count > 1 ? ` × ${x.count}` : '';
  return `${x.size}${x.unit}${cnt}`;
}

const CYCLE_ORDERS = { daily: 26, '2to3': 2.5 * WEEKS_PER_MONTH, weekly: WEEKS_PER_MONTH, rare: 2 };

function perBase(x, cycle, isQuote) {
  const b = baseQty(x);
  const price = x.price === '' || x.price == null ? null : +x.price;
  if (!b || !isNum(price)) return null;
  const flags = [];
  let ship = x.ship === '' || x.ship == null ? null : +x.ship;
  let shipPerUnit = null;
  if (ship === 0) shipPerUnit = 0;
  else if (isNum(ship)) {
    const orders = isNum(+x.orders) && +x.orders > 0 ? +x.orders : (isQuote ? null : CYCLE_ORDERS[cycle] || null);
    const qty = isNum(+x.qty) && +x.qty > 0 ? +x.qty : null;
    if (isQuote) {
      const minUnits = isNum(+x.minUnits) && +x.minUnits > 0 ? +x.minUnits : null;
      if (minUnits) shipPerUnit = ship / minUnits;
      else { shipPerUnit = null; flags.push('ship_split_unknown'); }
    } else if (orders && qty) {
      shipPerUnit = (ship * orders) / qty;
      if (!(+x.orders > 0)) flags.push('ship_orders_estimated');
    } else flags.push('ship_split_unknown');
  } else flags.push('ship_unknown');
  let vatF = 1;
  if (x.vat === 'excl') vatF = 1.1;
  else if (x.vat !== 'incl') flags.push('vat_unknown');
  const unitTotal = (price + (shipPerUnit || 0)) * vatF;
  return { dim: b.dim, baseQty: b.qty, perBase: (unitTotal / b.qty) * DIM_DISPLAY_FACTOR[b.dim], unitTotal, flags, shipPerUnit };
}

export function compareQuote(it, q, cycle) {
  const a = baseQty(it);
  const b = baseQty(q);
  const reasons = [];
  if (!a || !b) return { level: 'incomparable', reasons: ['규격(양·단위) 정보가 없는 쪽이 있어요'] };
  if (a.dim !== b.dim) return { level: 'incomparable', reasons: [`단위 종류가 달라요 (${DIM_LABEL[a.dim]} / ${DIM_LABEL[b.dim]} 기준)`] };
  const pa = perBase(it, cycle, false);
  const pb = perBase(q, cycle, true);
  if (!pa || !pb) return { level: 'incomparable', reasons: ['가격 정보가 없는 쪽이 있어요'] };
  let level = 'same';
  if (!it.brandAny) {
    if (!it.brand || !q.brand) { level = 'similar'; reasons.push('브랜드를 모르는 쪽이 있어요'); }
    else if (norm(it.brand) !== norm(q.brand)) { level = 'similar'; reasons.push(`브랜드가 달라요 (${it.brand} / ${q.brand})`); }
  }
  if ((it.grade || q.grade) && norm(it.grade) !== norm(q.grade)) { level = 'similar'; reasons.push(`등급·원산지·종류가 달라요 (${it.grade || '미기재'} / ${q.grade || '미기재'})`); }
  if (a.qty !== b.qty) { level = 'similar'; reasons.push(`포장 규격이 달라요 (${specText(it)} / ${specText(q)})`); }
  if (pa.flags.includes('vat_unknown') || pb.flags.includes('vat_unknown')) { level = 'similar'; reasons.push('부가세 포함 여부를 모르는 쪽이 있어요'); }
  if (pa.flags.some((f) => f.startsWith('ship_')) && !pa.flags.includes('ship_orders_estimated')) { level = 'similar'; reasons.push('현재 구매의 배송비를 단위당으로 나눌 수 없어요'); }
  if (pb.flags.some((f) => f.startsWith('ship_'))) { level = 'similar'; reasons.push('비교 대상의 배송비 조건을 알 수 없어요'); }
  if (isStale(q.observedAt, RULES.quoteStaleDays)) { level = 'similar'; reasons.push('확인한 지 30일이 넘었거나 날짜가 없어 지금 가격과 다를 수 있어요'); }
  const diff = pa.perBase - pb.perBase;
  const diffPct = diff / pb.perBase;
  let monthlySaving = null;
  const qtyM = isNum(+it.qty) && +it.qty > 0 ? +it.qty : null;
  if (level === 'same' && diff > 0 && qtyM) monthlySaving = (diff / DIM_DISPLAY_FACTOR[a.dim]) * a.qty * qtyM;
  const conditions = [];
  if (isNum(+q.minOrder) && +q.minOrder > 0) {
    const perOrder = qtyM && isNum(+it.orders) && +it.orders > 0 ? (+it.price * qtyM) / +it.orders : null;
    if (perOrder !== null && perOrder < +q.minOrder) conditions.push(`최소 주문금액 ${fmtWon(+q.minOrder)}: 지금 1회 주문액(${fmtWon(perOrder)})보다 커서 묶어서 주문해야 해요`);
    else conditions.push(`최소 주문금액 ${fmtWon(+q.minOrder)}`);
  }
  if (q.conditions) conditions.push(q.conditions);
  if (pa.flags.includes('ship_orders_estimated')) reasons.push('현재 배송비는 구매 주기로 나눠 추정했어요');
  return { level, reasons, mine: pa, theirs: pb, diff, diffPct, monthlySaving, conditions, dimLabel: DIM_LABEL[a.dim] };
}

export function analyzePurchase(c, data) {
  const cycle = c.v('p_cycle');
  const items = (c.v('p_items') || []).filter((r) => r && r.name);
  const quotes = (data.external?.quotes || []).filter((q) => q && q.item);
  const rows = items.map((it) => {
    const mine = perBase(it, cycle, false);
    const cmp = quotes.filter((q) => norm(q.item) === norm(it.name)).map((q) => ({ quote: q, ...compareQuote(it, q, cycle) }));
    const monthlySpend = isNum(+it.price) && isNum(+it.qty) ? +it.price * +it.qty : null;
    return { item: it, mine, comparisons: cmp, monthlySpend, spec: specText(it) };
  });
  const savings = rows.flatMap((r) => r.comparisons.filter((x) => isNum(x.monthlySaving) && x.monthlySaving > 0).map((x) => ({ item: r.item.name, amount: x.monthlySaving, quote: x.quote })));
  // 품목별 최대 절감 하나만 합산 (같은 품목을 두 번 세지 않음)
  const best = {};
  for (const s of savings) if (!best[s.item] || best[s.item].amount < s.amount) best[s.item] = s;
  const unmatchedQuotes = quotes.filter((q) => !items.some((it) => norm(it.name) === norm(q.item)));
  return { rows, savings: Object.values(best), savingsTotal: Object.values(best).reduce((a, s) => a + s.amount, 0), unmatchedQuotes, cycle };
}
