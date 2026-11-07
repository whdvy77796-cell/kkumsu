// 규칙 기반 진단·우선순위·실행 계획 (데모 모드). 모든 판단에 근거 표시와 효과 확인 방법을 붙인다.
import { compute, MENU_GROUPS, BASIS_LABEL } from './calc.js';
import { makeCtx, visibleQuestions, questionDone, answerText, concernAreas, isAnswered } from './engine.js';
import { QMAP, CONCERNS, AREAS, TIME_SLOTS } from './questions.js';
import { confirmedMismatches, competitorComparisons, reviewThemes, uncheckedChannels, excludedEntries, publicInfoChecks, SOURCE_LABEL } from './external.js';
import { SURVEY, RULES } from './benchmarks.js';
import { fmtMan, fmtWon, fmtPct, fmtNum, isNum, WEEKS_PER_MONTH } from './format.js';

export const EVIDENCE_LABEL = {
  answer: '사장님 답변',
  doc: '자료에서 확인',
  calc: '계산 결과',
  hypo: '개선 가설',
  need: '추가 확인 필요',
};

export const ENGINE_VERSION = 'rules-2026.11.08b-demo';
const BUDGET_CAP = [10000, 300000, 1000000, 3000000, Infinity];
const TIME_CAP = [1, 3, 5, Infinity];
const DELIVERY_LEFT_RULE = 0.25;

function evA(D, id, label) {
  const q = QMAP[id];
  const a = D.data.answers?.[id];
  if (!q || !a || !isAnswered(a)) return null;
  const fromFile = typeof a.src === 'string' && a.src.startsWith('file');
  return { t: fromFile ? 'doc' : 'answer', text: `${label || q.label}: ${answerText(q, a, D.c)}${fromFile ? ' (첨부 파일에서 추출 후 사장님이 확인)' : ''}` };
}
const evC = (text) => ({ t: 'calc', text });
const evD = (text) => ({ t: 'doc', text });
const evN = (text) => ({ t: 'need', text });

function slotText(v) {
  if (!v) return '';
  const d = (v.days || []).join('·');
  const t = (v.times || []).map((x) => TIME_SLOTS.find((s) => s.v === x)?.label.split(' ')[0] || x).join('·');
  return [d && `${d}요일`, t].filter(Boolean).join(' ');
}

function match(text, re) {
  return re.test(String(text || ''));
}

// ───────── 규칙들
const RULESET = [
  // 1. 손익 파악에 빠진 비용
  function missingCosts(D) {
    const { calc, c } = D;
    const p = calc.profit;
    const miss = calc.missingCosts.map((x) => x.label);
    if (p.kind === 'estimate' && !p.range) return null;
    const ev = [];
    if (p.kind === 'unavailable') ev.push(evN('월매출이 입력되지 않아 이익을 계산하지 못했어요'));
    if (miss.length) ev.push(evN(`빠진 비용 ${miss.length}개: ${miss.join(', ')} (0원으로 계산하지 않았어요)`));
    if (p.range) ev.push(evN(`이미 빠진 금액인지 불명확한 항목: ${p.uncertain.join(', ')}`));
    if (p.kind !== 'unavailable') ev.push(evC(`${p.formula} → ${p.range ? `${fmtMan(p.low)} ~ ${fmtMan(p.high)}` : fmtMan(p.high)} (${p.label})`));
    const where = {
      '식재료 구매액': '거래명세서·카드 사용 내역 합계',
      '직원 인건비': '급여 이체 내역(주휴수당·4대보험 사업주 부담분 포함)',
      '월세': '임대차 계약서·이체 내역',
      '관리비': '관리비 고지서',
      '전기·가스·수도': '최근 3개월 고지서 평균',
      '카드 결제 수수료': '카드사 가맹점 매출 조회의 수수료 합계',
      '배달앱 중개·결제 수수료': '배달앱 정산명세서',
      '가게 부담 배달비': '배달대행 정산 내역 또는 배달앱 정산명세서',
      '가게 부담 할인·쿠폰': '배달앱 정산명세서의 할인 부담 항목',
      '포장재': '포장재 구매 내역',
      '광고비': '광고 결제 내역',
      '소모품비': '마트·온라인 구매 내역',
      '기타 고정비': '통장 자동이체 목록',
    };
    const steps = miss.slice(0, 6).map((m) => ({ when: 'week', text: `${m}: ${where[m] || '관련 결제 내역'}에서 같은 달 금액 확인`, hours: 0.3 }));
    if (c.v('s_basis') === 'unknown' || !c.v('s_basis')) steps.unshift({ when: 'week', text: '월매출이 "손님 결제금액" 기준인지 "통장 입금액" 기준인지 정하고, 모든 숫자를 같은 기준·같은 달로 맞추기', hours: 0.5 });
    steps.push({ when: 'month', text: '매달 1장짜리 손익표(매출·비용 같은 달 기준) 작성 습관 만들기', hours: 1 });
    return {
      id: 'missing_costs', area: 'cost', goal: 'profit', effect: ['정확한 손익 파악'], tag: 'need',
      title: '얼마가 남는지 아직 정확히 알 수 없어요',
      problem: '빠진 비용이 있거나 매출 기준이 불명확해, 지금 계산한 이익은 실제보다 많게 보일 수 있어요.',
      evidence: ev,
      actions: ['아래 순서대로 빠진 비용을 같은 달 기준으로 채워 주세요.', ...steps.map((s) => s.text)],
      steps,
      cost: { cash: [0, 0], hoursTotal: 2, hoursWeekly: 1, who: '사장님' },
      effectText: '비용을 줄이거나 매출을 늘리는 효과는 없지만, 어떤 개선이 실제로 이익을 늘렸는지 판단하는 기준이 생겨요.',
      uncertainty: '지금 숫자로는 이익이 과대 계산됐을 가능성이 있어요.',
      measure: { metric: '보고서의 "추가 확인 필요" 비용 항목 수', how: '빠진 항목을 채운 뒤 다시 분석해 0개가 되는지 확인', period: '2주', baseline: `${miss.length + (p.range ? p.uncertain.length : 0)}개` },
      impact: c.concern('profit_unknown') ? 3 : 2, confidence: 3,
    };
  },

  // 2. 식재료비: 메뉴 원가와 구매액 차이 또는 평균 대비 높음
  function foodCost(D) {
    const { calc, c } = D;
    const r = calc.ratios.find((x) => x.key === 'food');
    const gap = calc.menu.gap;
    const high = r && isNum(r.gap) && r.gap >= RULES.foodGapPctPoint;
    const recipeGap = isNum(gap) && gap >= RULES.recipeGapPctPoint;
    if (!high && !recipeGap) return null;
    const S = calc.sales.monthly;
    const ev = [];
    if (r) ev.push(evC(`식재료 구매 비율 ${fmtPct(r.value)} = ${r.formula}`));
    if (r && isNum(r.bench)) ev.push(evD(`공개 통계(참고): ${r.benchLabel} 평균 식재료비 비중 ${fmtPct(r.bench)} (${SURVEY.name}, ${SURVEY.basis.split(',')[0]})`));
    if (recipeGap) ev.push(evC(`메뉴 원가 기준 원가율 ${fmtPct(calc.menu.theoreticalRate)} (판매량의 ${fmtPct(calc.menu.coverageQty, 0)}를 차지하는 메뉴 반영) vs 실제 구매 비율 ${fmtPct(calc.menu.purchaseRate)} → 차이 ${fmtPct(gap)}p`));
    const w = evA(D, 'p_waste');
    if (w) ev.push(w);
    const onePct = S ? S * 0.01 : null;
    const steps = [
      { when: 'week', text: '2주 동안 버리는 재료를 품목·양·이유로 기록하기 (폐기 기록표)', hours: 0.5 },
      { when: 'week', text: '판매량 상위 3개 메뉴의 1인분 정량을 저울로 다시 재고, 국자·스쿱 등 계량 도구를 정하기', hours: 1 },
      { when: 'month', text: '주 1회 같은 요일에 주요 재료 5개의 재고를 세어 구매량과 비교하기', hours: 0.5 },
    ];
    if (recipeGap && calc.menu.coverageQty < 0.8) steps.push({ when: 'month', text: '원가를 모르는 메뉴의 원가를 계산해, 차이가 원가 계산 누락 때문인지 확인하기', hours: 1 });
    return {
      id: 'food_cost', area: 'purchase', goal: 'profit', effect: ['비용 절감'], tag: 'hypo',
      title: recipeGap ? `메뉴 원가로 계산한 재료비보다 실제 구매가 ${fmtPct(gap)}p 많아요` : '식재료 구매 비율이 업종 평균보다 높은 편이에요',
      problem: recipeGap ? '판매된 메뉴에 들어간 재료보다 더 많은 재료를 사고 있어요. 폐기, 정량보다 많이 담기, 재고 증가, 원가 계산 누락 중 무엇인지 확인이 필요해요.' : '평균은 목표치가 아니지만, 차이가 커서 재료가 새는 곳이 있는지 점검할 가치가 있어요.',
      evidence: ev,
      actions: steps.map((s) => s.text),
      steps,
      cost: { cash: [0, 30000], hoursTotal: 3, hoursWeekly: 1, who: '사장님 + 주방 담당' },
      effectText: onePct ? `수익성 개선(비용 절감): 식재료비를 매출의 1%p만 줄여도 같은 매출에서 월 ${fmtMan(onePct)}이 더 남아요 (계산값, 예측 아님).` : '수익성 개선(비용 절감) 효과를 기대할 수 있어요.',
      uncertainty: '구매액에는 재고 변화가 섞여 있어 한 달 자료만으로 실제 손실 규모를 확정할 수 없어요.',
      measure: { metric: '식재료 구매 비율과 주간 폐기 금액', how: '4주 동안 주간 구매액·폐기 금액을 기록해 매출 대비 비율 비교', period: '4주', baseline: r ? `현재 ${fmtPct(r.value)}` : '' },
      impact: 3, confidence: recipeGap ? 3 : 2,
    };
  },

  // 3. 인건비
  function laborCost(D) {
    const { calc, c } = D;
    const r = calc.ratios.find((x) => x.key === 'labor');
    const high = r && isNum(r.gap) && r.gap >= RULES.laborGapPctPoint;
    if (!high) return null;
    const ev = [evC(`직원 인건비율 ${fmtPct(r.value)} = ${r.formula}`), evD(`공개 통계(참고): ${r.benchLabel} 평균 고용인 인건비 비중 ${fmtPct(r.bench)} (${SURVEY.name})`)];
    const idle = evA(D, 's_idle');
    if (idle) ev.push(idle);
    const st = evA(D, 'st_list');
    if (st) ev.push(st);
    const steps = [
      { when: 'week', text: '1주일 동안 시간대별 주문 수와 근무 인원을 같은 표에 기록하기', hours: 1 },
      { when: 'month', text: `한가한 시간대${idle ? `(${slotText(D.c.v('s_idle'))})` : ''}에 다음 날 재료 준비를 몰아서 하도록 업무 순서 바꾸기`, hours: 1 },
      { when: 'month', text: '피크 인원은 유지하고, 주문이 적은 시간대의 근무 배치를 조정할 수 있는지 검토하기 (근무시간 변경은 근로계약과 직원 합의 필요)', hours: 1 },
    ];
    return {
      id: 'labor_cost', area: 'staff', goal: 'profit', effect: ['비용 절감', '운영 효율'], tag: 'hypo',
      title: '직원 인건비 비율이 업종 평균보다 높은 편이에요',
      problem: '바쁜 시간과 한가한 시간의 근무 인원이 주문량과 맞는지 확인이 필요해요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 3, hoursWeekly: 1, who: '사장님' },
      effectText: '수익성 개선(비용 절감) 또는 같은 인원으로 더 많은 주문 처리.',
      uncertainty: '인건비가 높아도 서비스 품질·대기시간에 필요한 인원일 수 있어요. 줄이기 전에 시간대별 주문 기록으로 확인해야 해요.',
      measure: { metric: '인건비율, 시간대별 주문 수 ÷ 근무 인원', how: '조정 전 1주와 조정 후 2주 비교', period: '3주', baseline: `현재 ${fmtPct(r.value)}` },
      impact: 2, confidence: 2,
    };
  },

  // 4. 배달 1건 단위 수익
  function deliveryUnit(D) {
    const { calc, c } = D;
    const u = calc.deliveryUnit;
    if (!u) return null;
    const share = calc.delivery.share;
    const weak = u.rate < DELIVERY_LEFT_RULE;
    if (!weak && !c.concern('delivery_profit')) return null;
    const ev = [evC(`배달 1건 ${fmtWon(u.ticket)} 중 ${u.comps.filter((x) => isNum(x.v)).map((x) => `${x.label} ${fmtWon(x.v)}`).join(', ')}을 빼면 약 ${fmtWon(u.left)} (${fmtPct(u.rate, 0)})가 남아요${u.isUpperBound ? ` (미확인: ${u.missing.join(', ')} → 실제로는 더 적음)` : ''}`)];
    for (const id of ['d_commission', 'd_delivery_fee', 'd_discount', 'd_packaging']) { const e = evA(D, id); if (e) ev.push(e); }
    const steps = [];
    const disc = calc.delivery.discount;
    const pack = calc.delivery.pack;
    steps.push({ when: 'week', text: '배달 메뉴 중 재료비 비율이 낮은 메뉴(음료·사이드)를 묶은 세트 1개를 만들어 1건 결제금액을 높이는 시험 시작', hours: 1 });
    if (isNum(disc) && disc > 0) steps.push({ when: 'month', text: `가게 부담 할인(건당 ${fmtWon(disc)})을 2주 동안 줄이거나 조건을 바꿔, 주문 수가 얼마나 변하는지 비교`, hours: 0.5 });
    if (isNum(pack) && pack > 0) steps.push({ when: 'month', text: `포장 용기(건당 ${fmtWon(pack)})를 같은 규격으로 2곳 이상 재견적`, hours: 1 });
    steps.push({ when: 'month', text: '매장 직접 포장 주문은 중개 수수료가 없으니, 포장 주문 고객에게 줄 작은 혜택을 검토', hours: 0.5 });
    return {
      id: 'delivery_unit', area: 'delivery', goal: 'profit', effect: ['비용 절감', '객단가'], tag: 'hypo',
      title: u.left >= 0 ? `배달 1건을 팔면 고정비를 내기 전 약 ${fmtWon(u.left)}이 남아요` : `배달 1건을 팔 때마다 약 ${fmtWon(-u.left)} 손해로 계산돼요`,
      problem: weak ? `결제금액의 ${fmtPct(u.rate, 0)}만 남아 월세·인건비를 감당하기 빠듯한 구조예요 (서비스 내부 점검 기준 ${fmtPct(DELIVERY_LEFT_RULE, 0)} 미만).` : '배달 수익성을 걱정하셔서 1건 단위로 계산해 봤어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 50000], hoursTotal: 3, hoursWeekly: 1, who: '사장님' },
      effectText: '수익성 개선: 배달 1건당 남는 금액 증가. 세트 구성은 객단가 개선 효과도 있어요.',
      uncertainty: '할인을 줄이거나 가격 구성을 바꾸면 주문 수가 줄 수 있어요. 주문 수와 1건당 남는 금액을 함께 봐야 해요.',
      measure: { metric: '배달 1건당 남는 금액, 주간 배달 주문 수', how: '정산명세서로 2주마다 같은 공식으로 다시 계산', period: '4주', baseline: `현재 약 ${fmtWon(u.left)} / 건` },
      impact: share !== null && share >= 0.4 ? 3 : 2, confidence: u.isUpperBound ? 2 : 3,
    };
  },

  // 5. 메뉴 정리 시험
  function menuSimplify(D) {
    const { calc, c } = D;
    const g = calc.menu.groups;
    const many = (calc.menu.count || 0) >= (c.biz === 'cafe' ? 30 : 25);
    if (!g.trial_stop.length && !g.merge.length && !(many && c.concern('menu_complex'))) return null;
    const ev = [];
    const mc = evA(D, 'm_count');
    if (mc) ev.push(mc);
    if (isNum(calc.menu.topShare)) ev.push(evC(`판매량 상위 20% 메뉴가 전체 판매량의 ${fmtPct(calc.menu.topShare, 0)}를 차지해요 (입력한 메뉴 ${calc.menu.listed}개 기준)`));
    if (g.trial_stop.length) ev.push(evC(`판매량이 적고 남는 비율도 낮으며 전용 재료나 긴 조리시간이 필요한 메뉴: ${g.trial_stop.map((i) => i.name).join(', ')}`));
    if (g.merge.length) ev.push(evC(`전용 재료를 쓰는 메뉴: ${g.merge.map((i) => i.name).join(', ')}`));
    const ex = evA(D, 'm_exclusive');
    if (ex) ev.push(ex);
    const slowWaste = (calc.waste.rows || []).filter((r) => r.reason === 'slow');
    if (slowWaste.length) ev.push({ t: 'answer', text: `잘 안 팔리는 메뉴 전용이라 버리는 재료: ${slowWaste.map((r) => r.item).join(', ')}` });
    const protectedLow = calc.menu.items.filter((i) => i.flags?.protected && i.flags?.lowSales);
    const steps = [];
    if (g.trial_stop.length) steps.push({ when: 'week', text: `${g.trial_stop.map((i) => i.name).join(', ')}: 2~4주 동안 메뉴판에서 내리거나 "한정 판매"로 바꾸고, 찾는 손님 수를 기록`, hours: 0.5 });
    if (g.merge.length) steps.push({ when: 'month', text: `${g.merge.map((i) => i.name).join(', ')}: 전용 재료를 다른 메뉴와 함께 쓰는 구성으로 바꿀 수 있는지 검토`, hours: 1 });
    if (!g.trial_stop.length && !g.merge.length) steps.push({ when: 'week', text: '메뉴별 한 달 판매량·원가·조리시간·전용 재료를 메뉴 목록에 입력해 정리 후보를 찾기', hours: 1 });
    steps.push({ when: 'month', text: '시험 기간에는 해당 전용 재료 발주를 줄여 폐기와 재고가 줄었는지 확인', hours: 0.5 });
    return {
      id: 'menu_simplify', area: 'menu', goal: 'profit', effect: ['비용 절감', '운영 효율'], tag: g.trial_stop.length || g.merge.length ? 'hypo' : 'need',
      title: '메뉴 정리로 재료 낭비와 준비 일을 줄일 여지가 있어요',
      problem: '판매량이 적은데 재료와 손이 따로 드는 메뉴는 폐기와 준비 시간을 늘려요. 다만 바로 없애지 않고 제한적으로 시험해요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 10000], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님' },
      effectText: '수익성 개선(폐기·재고 감소)과 운영 효율(준비 시간 감소).',
      uncertainty: `판매량이 적어도 특정 손님을 부르거나 다른 메뉴와 함께 팔리는 역할이 있을 수 있어요.${protectedLow.length ? ` ${protectedLow.map((i) => i.name).join(', ')}은(는) 그런 역할이 있다고 답해서 중단 후보에서 뺐어요.` : ''}`,
      measure: { metric: '시험 메뉴를 찾은 손님 수, 전용 재료 폐기량, 전체 주문 수', how: '시험 전 2주와 시험 기간 비교', period: '4주', baseline: '' },
      impact: c.concern('menu_complex') ? 3 : 2, confidence: g.trial_stop.length ? 2 : 1,
    };
  },

  // 6. 많이 남는데 덜 알려진 메뉴
  function menuPromote(D) {
    const { calc } = D;
    const list = calc.menu.groups.promote;
    if (!list.length) return null;
    const ev = list.slice(0, 3).map((i) => evC(`${i.name}: 남는 비율 ${fmtPct(i.marginRate, 0)} (메뉴 중앙값 ${fmtPct(calc.menu.medRate, 0)}), 한 달 ${fmtNum(i.qty, '개')} 판매`));
    const ph = evA(D, 'm_photo');
    if (ph) ev.push(ph);
    const rc = evA(D, 'm_recommend');
    if (rc) ev.push(rc);
    const names = list.slice(0, 3).map((i) => i.name).join(', ');
    const steps = [
      { when: 'week', text: `${names}에 "추천" 표시를 하고 메뉴판·배달앱에서 눈에 띄는 위치로 옮기기`, hours: 0.5 },
      { when: 'week', text: `${names}의 사진과 한 줄 설명(재료·양·맛) 추가`, hours: 1 },
      { when: 'month', text: '주문 받을 때 한 문장으로 권하기 (예: "오늘은 ○○가 잘 나와요")', hours: 0 },
    ];
    return {
      id: 'menu_promote', area: 'menu', goal: 'sales', effect: ['구매 전환', '객단가'], tag: 'hypo',
      title: '많이 남는데 덜 알려진 메뉴가 있어요',
      problem: `${names}은(는) 남는 비율이 높은 편인데 판매량은 많지 않아요.`,
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 10000], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님' },
      effectText: '매출 개선(구매 전환)과 수익성 개선: 같은 손님 수에서 남는 금액이 늘 수 있어요.',
      uncertainty: '노출을 늘려도 손님 취향에 맞지 않으면 판매가 늘지 않을 수 있어요.',
      measure: { metric: '해당 메뉴 주간 판매량, 평균 결제금액', how: '변경 전 2주와 변경 후 4주 비교', period: '6주', baseline: list.slice(0, 3).map((i) => `${i.name} 월 ${fmtNum(i.qty, '개')}`).join(', ') },
      impact: 2, confidence: 2,
    };
  },

  // 7. 잘 팔리지만 남는 게 적은 메뉴
  function menuPriceReview(D) {
    const { calc, c } = D;
    const list = calc.menu.groups.price_review;
    if (!list.length) return null;
    const noRaise = c.has('g_fixed', 'price');
    const names = list.slice(0, 3).map((i) => i.name).join(', ');
    const ev = list.slice(0, 3).map((i) => evC(`${i.name}: 한 달 ${fmtNum(i.qty, '개')}로 많이 팔리지만 남는 비율 ${fmtPct(i.marginRate, 0)} (메뉴 중앙값 ${fmtPct(calc.menu.medRate, 0)})`));
    if (noRaise) ev.push(evA(D, 'g_fixed'));
    const steps = noRaise
      ? [
        { when: 'week', text: `${names}의 1인분 재료 구성과 양을 다시 재서, 맛에 영향이 적은 부분(곁들임·토핑)을 조정할 수 있는지 검토`, hours: 1 },
        { when: 'month', text: '가격은 그대로 두고 추가 옵션(곱빼기·토핑)을 만들어 선택하게 하기', hours: 1 },
      ]
      : [
        { when: 'week', text: `${names}의 1인분 재료 구성과 양을 다시 재서 원가를 확인`, hours: 1 },
        { when: 'month', text: '가격 조정이 필요하면 소폭(예: 500원) 조정 후 4주간 판매량 변화를 기록. 재료·양을 설명하는 문구를 함께 보완', hours: 1 },
        { when: 'month', text: '또는 가격은 유지하고 구성(곁들임)을 조정하는 방안과 비교', hours: 0.5 },
      ];
    return {
      id: 'menu_price_review', area: 'price', goal: 'profit', effect: ['수익성'], tag: 'hypo',
      title: '잘 팔리지만 남는 금액이 적은 메뉴가 있어요',
      problem: `${names}은(는) 판매량이 많아 남는 금액을 조금만 개선해도 전체 이익에 영향이 커요.`,
      evidence: ev.filter(Boolean), actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님' },
      effectText: '수익성 개선: 메뉴 1개당 남는 금액 증가.',
      uncertainty: '가격이나 구성을 바꾸면 판매량이 줄 수 있어요. 판매량과 1개당 남는 금액을 함께 봐야 해요.',
      measure: { metric: '해당 메뉴 판매량 × 1개당 남는 금액', how: '변경 전후 4주 비교', period: '4주', baseline: list.slice(0, 3).map((i) => `${i.name} 1개당 ${fmtWon(i.margin)}`).join(', ') },
      impact: 2, confidence: 2,
    };
  },

  // 8. 메뉴 원가 정보 부족
  function menuCostUnknown(D) {
    const { calc } = D;
    const items = calc.menu.items;
    if (!items.length) {
      if (!D.c.concern('menu_complex') && !D.c.concern('profit_unknown')) return null;
    } else if (calc.menu.coverageQty >= 0.5) return null;
    const ev = items.length ? [evN(`원가를 아는 메뉴가 판매량의 ${fmtPct(calc.menu.coverageQty, 0)}뿐이라 메뉴별로 얼마 남는지 판단하기 어려워요`)] : [evN('메뉴별 가격·판매량·원가 정보가 아직 없어요')];
    const top = items.filter((i) => isNum(i.qty)).sort((a, b) => b.qty - a.qty).slice(0, 5).map((i) => i.name);
    const steps = [
      { when: 'week', text: `판매량 상위 5개 메뉴${top.length ? `(${top.join(', ')})` : ''}의 1인분 원가 계산: 재료별 사용량 × 구매 단가`, hours: 2 },
      { when: 'month', text: '나머지 메뉴도 한 달에 5개씩 원가표에 추가', hours: 1 },
    ];
    return {
      id: 'menu_cost_unknown', area: 'menu', goal: 'profit', effect: ['정확한 메뉴 판단'], tag: 'need',
      title: '잘 팔리는 메뉴의 원가를 알아야 가격과 메뉴를 판단할 수 있어요',
      problem: '원가를 모르면 많이 팔아도 남는지, 어떤 메뉴를 밀어야 하는지 알 수 없어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 3, hoursWeekly: 1, who: '사장님' },
      effectText: '직접적인 매출·비용 효과는 없지만 메뉴·가격 결정의 정확도가 올라가요.',
      uncertainty: '원가 계산에 쓰는 구매 단가가 최근 것이어야 해요.',
      measure: { metric: '원가를 아는 메뉴의 판매량 비율', how: '원가 입력 후 다시 분석', period: '2주', baseline: items.length ? `현재 ${fmtPct(calc.menu.coverageQty, 0)}` : '0%' },
      impact: 2, confidence: 3,
    };
  },

  // 9. 같은 조건 견적이 더 낮음
  function purchaseSavings(D) {
    const { calc } = D;
    const sv = calc.purchase.savings;
    if (!sv.length) return null;
    const ev = [];
    for (const s of sv) {
      const row = calc.purchase.rows.find((r) => r.item.name === s.item);
      const cmp = row?.comparisons.find((x) => x.quote === s.quote);
      ev.push(evD(`${s.item} 비교 대상: ${SOURCE_LABEL[s.quote.sourceType] || '견적'} "${s.quote.sourceName || '이름 없음'}" (${s.quote.observedAt} 확인${s.quote.sample ? ', 가상 예시 데이터' : ''})`));
      if (cmp) ev.push(evC(`${s.item} ${cmp.dimLabel}: 현재 ${fmtWon(cmp.mine.perBase)} vs 견적 ${fmtWon(cmp.theirs.perBase)} (배송비·부가세 포함 환산, 브랜드·규격·등급 동일) → 현재 구매량 기준 월 약 ${fmtWon(s.amount)} 차이`));
    }
    const steps = [
      { when: 'week', text: '현재 거래처에 같은 조건(브랜드·규격·등급·배송)으로 재견적 요청', hours: 0.5 },
      { when: 'month', text: '새 견적처는 소량 시험 주문으로 품질·배송 시간·최소 주문 조건 확인 후 결정', hours: 1 },
    ];
    return {
      id: 'purchase_savings', area: 'purchase', goal: 'profit', effect: ['비용 절감'], tag: 'hypo',
      title: '같은 조건으로 비교했을 때 더 낮은 견적이 있어요',
      problem: '브랜드·규격·등급·배송비·부가세를 맞춘 비교에서 현재 구매 단가가 더 높게 나왔어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님' },
      effectText: `수익성 개선(비용 절감): 견적 조건이 유지되면 월 약 ${fmtWon(calc.purchase.savingsTotal)} (예상액, 현재 구매량 기준).`,
      uncertainty: '견적은 날짜·수량·지역에 따라 바뀌고, 품질·배송 안정성은 숫자로 비교되지 않아요. 다른 가게들의 실제 구매가와 비교한 것이 아니에요.',
      measure: { metric: '품목별 단위 구매가 (배송비·부가세 포함)', how: '다음 3번의 구매 기록으로 비교', period: '1개월', baseline: '' },
      impact: calc.purchase.savingsTotal > 100000 ? 3 : 2, confidence: 3,
    };
  },

  // 10. 조건이 다른 비교만 있음 / 비교 자료 없음
  function purchaseNeedQuotes(D) {
    const { calc, c } = D;
    const rows = calc.purchase.rows;
    const onlySimilar = rows.filter((r) => r.comparisons.length && !r.comparisons.some((x) => x.level === 'same'));
    const noCompare = c.concern('purchase_price') && (!rows.length || rows.every((r) => !r.comparisons.length));
    if (!onlySimilar.length && !noCompare) return null;
    const ev = [];
    for (const r of onlySimilar.slice(0, 3)) {
      const x = r.comparisons[0];
      ev.push(evN(`${r.item.name}: ${x.level === 'incomparable' ? '비교 불가' : '참고 비교만 가능'} - ${x.reasons.join(' · ')}`));
    }
    if (noCompare) ev.push(evN(rows.length ? '주요 식재료의 비교 견적이 아직 없어요' : '주요 식재료 구매 정보(브랜드·규격·단가)가 아직 없어요'));
    const pc = evA(D, 'p_compared');
    if (pc) ev.push(pc);
    const steps = [
      { when: 'week', text: rows.length ? '구매액이 큰 품목 3개를 골라 거래명세서를 모으기' : '구매액이 큰 식재료 5개의 거래명세서를 모아 브랜드·규격·단가·배송비를 입력', hours: 1 },
      { when: 'month', text: '같은 조건으로 2곳 이상에 견적 요청: 브랜드, 규격(예: 1kg × 10), 등급·원산지, 월 구매량, 배송비, 부가세 포함 여부, 최소 주문금액', hours: 1.5 },
    ];
    return {
      id: 'purchase_quotes', area: 'purchase', goal: 'profit', effect: ['비용 절감'], tag: 'need',
      title: '정확한 매입가 비교를 하려면 같은 조건의 견적이 필요해요',
      problem: '규격·브랜드·배송 조건이 다른 가격을 같은 상품처럼 비교하면 잘못된 결론이 나와요. 그래서 절감액을 계산하지 않았어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 2.5, hoursWeekly: 1, who: '사장님' },
      effectText: '같은 조건 견적이 모이면 절감 가능액을 근거 있게 계산할 수 있어요.',
      uncertainty: '비교 결과 지금 가격이 적정할 수도 있어요.',
      measure: { metric: '같은 조건으로 비교한 품목 수', how: '견적을 입력하고 다시 분석', period: '2~4주', baseline: `${rows.filter((r) => r.comparisons.some((x) => x.level === 'same')).length}개` },
      impact: c.concern('purchase_price') ? 2 : 1, confidence: 3,
    };
  },

  // 11. 폐기
  function wasteRule(D) {
    const { calc, c } = D;
    const w = calc.waste;
    const dessert = isNum(w.dessertWeekly) && w.dessertWeekly >= 5;
    if (!(w.level === 'often' || (w.level === 'sometimes' && w.rows.length)) && !dessert) return null;
    const ev = [];
    const pw = evA(D, 'p_waste');
    if (pw) ev.push(pw);
    if (w.rows.length) ev.push({ t: 'answer', text: `버리는 재료: ${w.rows.map((r) => `${r.item}${r.amount ? `(${r.amount}/주)` : ''}`).join(', ')}` });
    if (isNum(w.monthly)) ev.push(evC(`버리는 재료 금액 약 월 ${fmtWon(w.monthly)} = 주간 금액 × ${WEEKS_PER_MONTH.toFixed(2)}주${isNum(w.shareOfFood) ? ` (식재료 구매액의 ${fmtPct(w.shareOfFood)})` : ''}`));
    if (dessert) ev.push(evA(D, 'm_dessert_waste'));
    const reasons = new Set(w.rows.map((r) => r.reason));
    const steps = [];
    if (reasons.has('over') || !reasons.size) steps.push({ when: 'week', text: '품목별 발주량을 최근 2주 실제 사용량 기준으로 정한 발주 기준표 만들기', hours: 1 });
    if (reasons.has('prep')) steps.push({ when: 'week', text: '미리 손질하는 양을 요일별 판매량에 맞춰 줄이고, 부족하면 중간에 추가 손질', hours: 0.5 });
    if (reasons.has('expiry')) steps.push({ when: 'week', text: '입고 날짜 라벨을 붙이고 먼저 들어온 재료부터 쓰기(선입선출)', hours: 0.5 });
    if (reasons.has('storage')) steps.push({ when: 'week', text: '냉장·냉동 온도와 보관 용기를 점검하고 상하는 재료의 보관 방법 바꾸기', hours: 0.5 });
    if (reasons.has('slow')) steps.push({ when: 'month', text: '잘 안 팔리는 메뉴 전용 재료는 메뉴 정리 시험과 함께 발주를 줄이기', hours: 0.5 });
    if (dessert) steps.push({ when: 'week', text: '디저트 준비·발주량을 요일별 판매량에 맞추고, 마감 전 남는 양을 기록', hours: 0.5 });
    steps.push({ when: 'month', text: '주간 폐기 금액을 4주 동안 기록해 줄었는지 확인', hours: 0.3 });
    return {
      id: 'waste', area: 'purchase', goal: 'profit', effect: ['비용 절감'], tag: 'hypo',
      title: isNum(w.monthly) ? `버리는 재료가 매달 약 ${fmtMan(w.monthly)}이에요` : '재료 폐기가 자주 생기고 있어요',
      problem: '버리는 재료는 그대로 비용이에요. 이유별로 대응 방법이 달라요.',
      evidence: ev.filter(Boolean), actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 10000], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님 + 주방 담당' },
      effectText: '수익성 개선(비용 절감): 폐기 금액만큼 식재료비가 줄어요.',
      uncertainty: '발주를 너무 줄이면 품절로 판매 기회를 놓칠 수 있어요. 품절 횟수도 함께 기록하세요.',
      measure: { metric: '주간 폐기 금액, 품절 횟수', how: '폐기 기록표', period: '4주', baseline: isNum(w.monthly) ? `월 ${fmtWon(w.monthly)}` : '' },
      impact: isNum(w.shareOfFood) && w.shareOfFood >= 0.05 ? 3 : 2, confidence: w.rows.length ? 2 : 1,
    };
  },

  // 12. 광고 효과 미확인
  function adsUntracked(D) {
    const { c, calc } = D;
    const spend = c.adsSpend();
    if (!(spend > 0)) return null;
    const track = c.v('mk_ads_track');
    if (track === 'number') return null;
    const ev = [];
    for (const id of ['c_ads', 'd_ads', 'mk_ads_track']) { const e = evA(D, id); if (e) ev.push(e); }
    const list = c.v('mk_ads_list') || [];
    if (list.length) ev.push({ t: 'answer', text: `광고 내역: ${list.map((r) => `${r.channel}${isNum(+r.monthly) && r.monthly !== '' ? ` 월 ${fmtWon(+r.monthly)}` : ''}`).join(', ')}` });
    const S = calc.sales.monthly;
    if (S) ev.push(evC(`광고비 합계 월 ${fmtMan(spend)} = 월매출의 ${fmtPct(spend / S)}`));
    const steps = [
      { when: 'week', text: '광고마다 유입 확인 방법을 하나씩 정하기: 계산대 "어떻게 알고 오셨어요?" 체크표, 광고 전용 쿠폰 문구, 배달앱 광고 리포트(노출·클릭·주문)', hours: 1 },
      { when: 'month', text: '4주 뒤 광고별 "광고비 ÷ 확인된 주문 수"를 계산해 비교', hours: 0.5 },
      { when: 'month', text: '효과를 확인할 수 없는 광고는 2주 중단 시험 후 주문 수 비교', hours: 0.3 },
    ];
    return {
      id: 'ads_untracked', area: 'marketing', goal: 'profit', effect: ['비용 절감', '신규 유입'], tag: 'hypo',
      title: '광고비를 쓰고 있지만 효과를 확인하지 못하고 있어요',
      problem: '어떤 광고가 실제 주문·예약으로 이어지는지 모르면 광고비를 늘릴지 줄일지 정할 수 없어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님 + 계산 담당' },
      effectText: '효과 없는 광고비를 줄이면 수익성 개선, 효과 있는 광고에 집중하면 신규 유입 개선.',
      uncertainty: '광고는 바로 주문하지 않고 나중에 오는 손님에게도 영향을 줄 수 있어 4주보다 길게 봐야 할 수 있어요.',
      measure: { metric: '광고별 확인된 주문·예약 수, 주문 1건당 광고비', how: '체크표·쿠폰 회수·배달앱 리포트', period: '4주', baseline: `광고비 월 ${fmtMan(spend)}` },
      impact: S && spend / S >= 0.03 ? 3 : 2, confidence: 3,
    };
  },

  // 13. 온라인 정보 불일치
  function onlineInfo(D) {
    const { c, data } = D;
    const mism = confirmedMismatches(data);
    const pending = publicInfoChecks(data).filter((x) => !mism.some((m) => m.id === x.id));
    const partly = c.v('mk_place_updated') === 'partly';
    const unknown = c.v('mk_place_updated') === 'unknown';
    if (!mism.length && !partly && !unknown && !pending.length) return null;
    const ev = [];
    for (const m of mism) {
      const e = (data.external?.entries || []).find((x) => x.id === m.entryId);
      ev.push(evD(`${m.title}: ${m.message.split(' 지금 실제')[0]}${e?.sample ? ' (가상 예시 데이터)' : ''}`));
    }
    for (const p of pending) ev.push(evN(`${p.title} (사장님 재확인 전)`));
    const mp = evA(D, 'mk_place_updated');
    if (mp) ev.push(mp);
    const steps = [
      { when: 'week', text: '현재 메뉴판 기준으로 네이버 플레이스·배달앱의 메뉴·가격·영업시간·휴무일을 수정', hours: 1 },
      { when: 'week', text: '대표 메뉴 사진과 한 줄 설명을 지금 메뉴에 맞게 보완', hours: 1 },
      { when: 'month', text: '수정 후 메뉴·영업시간 관련 문의와 주문·예약 기록을 확인', hours: 0.3 },
    ];
    return {
      id: 'online_info', area: 'marketing', goal: 'sales', effect: ['구매 전환', '신규 유입'], tag: mism.length ? 'hypo' : 'need',
      title: mism.length ? '온라인에 보이는 가게 정보가 지금과 달라요' : '온라인 가게 정보가 최신인지 확인이 필요해요',
      problem: '손님은 방문 전에 온라인 정보를 보고 결정해요. 영업시간·가격이 다르면 헛걸음이나 불만으로 이어질 수 있어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님' },
      effectText: '매출 개선(구매 전환): 검색 후 방문·주문으로 이어지는 손님의 혼란이 줄어요.',
      uncertainty: '정보 수정만으로 주문이 얼마나 늘지는 알 수 없어요.',
      measure: { metric: '메뉴·영업시간 관련 문의 수, 플레이스 길찾기·전화 수(제공되는 경우)', how: '수정 전후 4주 비교', period: '4주', baseline: '' },
      impact: mism.length ? 2 : 1, confidence: mism.length ? 3 : 1,
    };
  },

  // 14. 홍보 채널 우선순위
  function channelFocus(D) {
    const { c, data } = D;
    const channels = c.v('mk_channels') || [];
    const freq = c.v('mk_freq');
    const scattered = channels.filter((x) => x !== 'none').length >= 3 && ['m1', 'rare'].includes(freq);
    if (!c.concern('marketing_focus') && !c.concern('sales_down') && !scattered && !channels.includes('none')) return null;
    const src = c.v('cu_source') || [];
    const seg = c.v('cu_segments') || [];
    const skills = c.v('mk_skill') || [];
    const timeLv = c.v('g_time');
    let pick = 'place';
    let why = '';
    if (c.deliveryish() && (c.share('delivery') ?? 0) >= 0.5) { pick = 'app'; why = '매출의 절반 이상이 배달이라 배달앱 가게 페이지가 손님이 가장 먼저 보는 곳이에요'; }
    else if (src.includes('insta') && skills.some((s) => ['photo', 'video'].includes(s)) && (c.biz === 'cafe' || seg.includes('friends') || seg.includes('student'))) { pick = 'insta'; why = '새 손님이 인스타그램으로 온다고 답했고, 사진을 직접 찍을 수 있어요'; }
    else if (src.includes('naver') || src.includes('walk') || !src.length || src.includes('unknown')) { pick = 'place'; why = src.includes('naver') ? '새 손님이 네이버 지도·검색으로 온다고 답했어요' : '방문 전 지도 검색을 하는 손님이 많은 업종이라, 먼저 정보 정확도를 갖추는 게 기본이에요'; }
    else if (seg.includes('local') && c.has('cu_repeat', 'low')) { pick = 'local'; why = '동네 손님이 많아 단골 연락 채널이 효과적일 수 있어요'; }
    const NAMES = { place: '네이버 플레이스', insta: '인스타그램', app: '배달앱 가게 페이지', local: '카카오톡 채널·당근 비즈프로필' };
    const PLAN = {
      place: [
        { when: 'week', text: '대표 사진 5장 교체 (대표 메뉴 3장, 매장 1장, 외관 1장), 메뉴·가격·영업시간 최신화', hours: 1.5 },
        { when: 'month', text: '주 1회 "소식"에 이번 주 메뉴·변경 사항 1개 올리기', hours: 0.3 },
      ],
      insta: [
        { when: 'week', text: '위치·영업시간·대표 메뉴를 담은 고정 게시물 1개 만들기', hours: 1 },
        { when: 'month', text: '주 2회, 그날 메뉴 사진과 짧은 설명 올리기 (같은 시간대에)', hours: 0.5 },
      ],
      app: [
        { when: 'week', text: '대표 메뉴 3개의 사진·설명·구성 정보를 보완하고 가게 소개 문구를 손님 입장에서 다시 쓰기', hours: 1.5 },
        { when: 'month', text: '주 2회 리뷰 답글 달기 (불만 리뷰는 원인과 조치를 짧게)', hours: 0.3 },
      ],
      local: [
        { when: 'week', text: '계산대에 카카오톡 채널(또는 당근 비즈프로필) 추가 안내 문구 비치', hours: 0.5 },
        { when: 'month', text: '월 2회 신메뉴·한정 메뉴 소식 보내기', hours: 0.3 },
      ],
    };
    const ev = [];
    for (const id of ['cu_source', 'cu_source_basis', 'mk_channels', 'mk_freq', 'mk_skill', 'g_time']) { const e = evA(D, id); if (e) ev.push(e); }
    const lowTime = timeLv === 0;
    const steps = PLAN[pick];
    const alt = lowTime ? {
      steps: [{ when: 'week', text: `이번 주 30분: ${NAMES[pick]}의 영업시간·위치·대표 메뉴 정보와 사진 점검하기 (이후 한 달에 한 번 반복)`, hours: 0.5 }],
      cost: { cash: [0, 0], hoursTotal: 0.5, hoursWeekly: 0.2, who: '사장님' },
      note: '주당 시간이 1시간 미만이라고 해서 가장 작은 단위로 줄였어요.',
    } : null;
    return {
      id: 'channel_focus', area: 'marketing', goal: 'sales', effect: ['신규 유입'], tag: 'hypo',
      title: `홍보는 "${NAMES[pick]}" 하나에 먼저 집중하세요`,
      problem: scattered ? '여러 채널을 운영하지만 올리는 빈도가 낮아 어느 곳도 충분히 관리되지 않고 있어요.' : '모든 채널을 다 할 필요는 없어요. 손님이 실제로 오는 경로부터 정리해요.',
      evidence: [...ev, { t: 'hypo', text: why }],
      actions: steps.map((s) => s.text), steps, alt,
      cost: { cash: [0, 0], hoursTotal: 2, hoursWeekly: 1.5, who: '사장님' },
      effectText: '매출 개선(신규 유입). 직접 운영하는 홍보도 사장님 시간이 들어요 (위 작업 시간 참고).',
      uncertainty: c.v('cu_source_basis') === 'guess' || !c.v('cu_source_basis') ? '유입 경로가 짐작이라면, 2주 동안 새 손님에게 물어 확인한 뒤 채널을 다시 정하세요.' : '채널 효과는 업종·상권에 따라 달라 4주 이상 기록이 필요해요.',
      measure: { metric: '새 손님 유입 경로 체크표, 채널 지표(플레이스 저장·길찾기, 게시물 도달 등)', how: '계산대 체크표 + 채널 통계 화면', period: '4주', baseline: '' },
      impact: c.concern('marketing_focus') ? 3 : 2, confidence: src.length && !src.includes('unknown') ? 2 : 1,
    };
  },

  // 15. 재방문
  function repeatRule(D) {
    const { c } = D;
    const rep = c.v('cu_repeat');
    const basis = c.v('cu_repeat_basis');
    if (!c.concern('repeat_low') && rep !== 'low' && basis !== 'feeling' && rep !== 'unknown') return null;
    const ev = [];
    for (const id of ['cu_repeat', 'cu_repeat_basis', 'cu_complaint']) { const e = evA(D, id); if (e) ev.push(e); }
    const noRecord = basis !== 'record' && basis !== 'app';
    const steps = [];
    if (noRecord) steps.push({ when: 'week', text: c.deliveryish() && (c.share('delivery') ?? 0) >= 0.5 ? '배달앱 사장님 화면에서 재주문 고객 비율 확인하기' : '재방문을 셀 방법 하나 도입: 종이 스탬프(예: 10개 채우면 메뉴 1개) 또는 포인트 적립', hours: 1 });
    const comp = c.v('cu_complaint');
    if (comp) steps.push({ when: 'week', text: `자주 듣는 불편("${String(comp).slice(0, 40)}") 중 1가지를 이번 달에 먼저 고치기`, hours: 1 });
    steps.push({ when: 'month', text: '두 번째 방문한 손님에게 신메뉴 맛보기·사이즈 업 등 비용이 적은 감사 표시하기', hours: 0.3 });
    const alt = {
      steps: [
        { when: 'week', text: '스탬프 대신 계산대 노트에 다시 온 손님이 있을 때마다 체크 표시하기 (비용 0원)', hours: 0.3 },
        ...steps.filter((s) => !s.text.startsWith('재방문을 셀 방법')),
      ],
      cost: { cash: [0, 0], hoursTotal: 1, hoursWeekly: 0.3, who: '사장님 + 계산 담당' },
      note: '예산이 거의 없어서 스탬프 인쇄 대신 비용이 들지 않는 기록 방법부터 시작해요.',
    };
    return {
      id: 'repeat', area: 'customer', goal: 'sales', effect: ['재방문'], tag: noRecord ? 'need' : 'hypo', alt,
      title: noRecord ? '다시 오는 손님이 얼마나 되는지부터 기록해야 해요' : '단골을 늘릴 장치가 필요해요',
      problem: noRecord ? '지금은 재방문을 체감으로만 알고 있어서, 개선해도 효과를 확인할 수 없어요.' : '기록상 다시 오는 손님 비율이 낮아요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [10000, 50000], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님 + 계산 담당' },
      effectText: '매출 개선(재방문).',
      uncertainty: '스탬프는 원래 오던 단골에게 할인만 주는 결과가 될 수도 있어요. 새로 생긴 재방문인지 기록으로 봐야 해요.',
      measure: { metric: '재방문 비율 = 스탬프 2개 이상 손님 수 ÷ 스탬프 발급 수', how: '스탬프 회수·포인트 기록', period: '8주', baseline: '' },
      impact: c.concern('repeat_low') ? 3 : 2, confidence: 2,
    };
  },

  // 16. 바쁜 시간 대기
  function peakDelay(D) {
    const { c } = D;
    const serve = c.num('h_serve_time');
    const comp = c.v('cu_complaint') || '';
    const waitComplaint = match(comp, /기다|대기|늦|오래|느려|느림/);
    const loss = ['often', 'sometimes'].includes(c.v('h_wait_loss'));
    const slow = isNum(serve) && serve >= (c.biz === 'cafe' ? 8 : 15);
    const delayTasks = (c.v('st_delay') || []).filter((x) => ['prep', 'order', 'cook', 'drink', 'pack'].includes(x));
    if (!waitComplaint && !loss && !slow) return null;
    const ev = [];
    for (const id of ['h_serve_time', 'h_full', 'h_wait_loss', 'cu_complaint', 'st_delay', 'st_peak']) { const e = evA(D, id); if (e) ev.push(e); }
    const steps = [
      { when: 'week', text: '피크 시작 1시간 전까지 준비할 재료·양을 적은 "피크 준비 목록" 만들기', hours: 1 },
      c.biz === 'cafe'
        ? { when: 'week', text: '많이 팔리는 음료 3종의 베이스·시럽을 미리 준비하고, 제조 동선(컵·얼음·원두 위치)을 한 방향으로 정리', hours: 1 }
        : { when: 'month', text: '점심 피크에만 메뉴 수를 줄인 "빠른 메뉴판" 2주 시험', hours: 1 },
    ];
    if (c.hallish() && (loss || ['often', 'sometimes'].includes(c.v('h_full')))) steps.push({ when: 'week', text: '대기 손님 이름·인원·도착 시각 기록표와 예상 대기시간 안내 문구 비치', hours: 0.5 });
    if (c.deliveryish() && match(comp, /배달/)) steps.push({ when: 'week', text: '배달이 늦다는 불만: 피크 시간 주문 10건의 주문 접수→조리 완료→라이더 픽업 시각을 적어, 조리 지연인지 배달 지연인지 구분하기', hours: 0.5 });
    if (c.has('b_order_method', 'counter') && loss) steps.push({ when: 'quarter', text: '테이블 주문·키오스크는 월 이용료 대비 효과를 계산해 본 뒤 결정 (바로 도입하지 않기)', hours: 1 });
    return {
      id: 'peak_delay', area: 'hall', goal: 'sales', effect: ['구매 전환', '재방문', '운영 효율'], tag: 'hypo',
      title: '바쁜 시간에 손님이 기다리는 시간이 길어요',
      problem: `${slow ? `주문 후 제공까지 약 ${serve}분 걸린다고 답했어요. ` : ''}대기가 길면 돌아가는 손님과 불만이 생겨요.`,
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 50000], hoursTotal: 3, hoursWeekly: 1, who: '사장님 + 직원' },
      effectText: '매출 개선(대기 이탈 감소, 재방문)과 운영 효율.',
      uncertainty: '대기 시간이 줄어도 돌아가던 손님이 얼마나 다시 올지는 기록으로 확인해야 해요.',
      measure: { metric: '피크 시간 주문~제공 시간(표본 10건), 대기 중 돌아간 팀 수', how: '주 2회 피크 시간 기록', period: '4주', baseline: isNum(serve) ? `현재 약 ${serve}분` : '' },
      impact: loss ? 3 : 2, confidence: slow || loss ? 2 : 1,
    };
  },

  // 17. 한가한 시간대 활용
  function idleTime(D) {
    const { c } = D;
    const idle = c.v('s_idle');
    if (!idle || !(idle.times || []).length) return null;
    if (c.v('s_trend') !== 'down' && !c.concern('sales_down') && !(c.v('g_change') || []).includes('new')) return null;
    const ev = [evA(D, 's_idle'), evA(D, 's_busy')].filter(Boolean);
    const cafe = c.biz === 'cafe';
    const steps = cafe
      ? [{ when: 'week', text: `한가한 시간(${slotText(idle)})에만 음료+디저트 세트(소폭 혜택)를 2주 시험`, hours: 1 }, { when: 'month', text: '그 시간대 손님층(공부·모임·테이크아웃)에 맞는 안내 문구를 매장 앞과 온라인에 노출', hours: 0.5 }]
      : [{ when: 'week', text: `한가한 시간(${slotText(idle)})에 포장 주문 혜택 또는 다음 식사 예약 주문을 2주 시험`, hours: 1 }, { when: 'month', text: '영업시간을 바꿀 수 있다면, 주문이 거의 없는 시간을 쉬는 시간으로 바꿀 때 아끼는 비용과 비교', hours: 1 }];
    return {
      id: 'idle_time', area: 'sales', goal: 'sales', effect: ['신규 유입', '객단가'], tag: 'hypo',
      title: `한가한 시간(${slotText(idle)})을 활용하는 방법을 시험해 보세요`,
      problem: '월세·인건비는 한가한 시간에도 나가요. 이 시간에 생기는 주문은 대부분 추가 이익이 돼요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      alt: { steps: steps.slice(0, 1), cost: { cash: [0, 10000], hoursTotal: 1, hoursWeekly: 0.5, who: '사장님' }, note: '혜택은 기존 메뉴 구성으로 만들고, 홍보물 없이 매장 안내만 해요.' },
      cost: { cash: [0, 30000], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님' },
      effectText: '매출 개선(한가한 시간대 주문 증가).',
      uncertainty: '혜택을 주면 원래 오던 손님까지 할인받는 효과가 생길 수 있어요. 시간대 매출로 확인하세요.',
      measure: { metric: '해당 시간대 주문 수·매출', how: 'POS 시간대별 매출 비교', period: '2주 시험 + 2주 비교', baseline: '' },
      impact: 2, confidence: 1,
    };
  },

  // 18. 카페: 음료만 사는 손님
  function cafeAttach(D) {
    const { c } = D;
    if (c.biz !== 'cafe') return null;
    const att = c.v('m_attach');
    if (!['low', 'mid'].includes(att)) return null;
    const ev = [evA(D, 'm_attach'), evA(D, 's_ticket'), evA(D, 'm_set')].filter(Boolean);
    const steps = [
      { when: 'week', text: '계산대 옆에 디저트 2~3종을 보이게 진열하고 "오늘의 추천" 표시', hours: 0.5 },
      { when: 'week', text: '많이 팔리는 음료와 어울리는 디저트 세트 1종 만들기 (소폭 혜택)', hours: 1 },
      { when: 'month', text: '주문 받을 때 한 문장으로 권하기', hours: 0 },
    ];
    return {
      id: 'cafe_attach', area: 'menu', goal: 'sales', effect: ['객단가'], tag: 'hypo',
      title: '음료만 사는 손님이 많아 1인 결제금액을 올릴 여지가 있어요',
      problem: '같은 손님 수에서도 함께 사는 메뉴가 늘면 매출이 늘어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      alt: { steps: [steps[0], steps[2]], cost: { cash: [0, 0], hoursTotal: 0.5, hoursWeekly: 0.2, who: '사장님 + 계산 담당' }, note: '예산이 적어 세트 할인 없이 진열과 권유부터 해요.' },
      cost: { cash: [0, 50000], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님 + 계산 담당' },
      effectText: '매출 개선(객단가).',
      uncertainty: '디저트를 늘리면 남는 디저트 폐기도 늘 수 있어요. 폐기 수량을 함께 보세요.',
      measure: { metric: '디저트 동반 구매율 = 디저트 판매 수 ÷ 음료 주문 수, 평균 결제금액', how: 'POS 메뉴별 판매 수', period: '4주', baseline: '' },
      impact: 2, confidence: 2,
    };
  },

  // 19. 카페: 좌석 장시간 점유
  function cafeSeats(D) {
    const { c } = D;
    if (c.biz !== 'cafe') return null;
    if (c.v('h_laptop') !== 'many' || !['often', 'sometimes'].includes(c.v('h_full')) || !['1to2h', 'gt2h'].includes(c.v('h_stay'))) return null;
    const ev = [evA(D, 'h_laptop'), evA(D, 'h_full'), evA(D, 'h_stay'), evA(D, 'h_wait_loss')].filter(Boolean);
    const steps = [
      { when: 'week', text: '바쁜 시간대에만 적용하는 정중한 좌석 이용 안내 문구 만들기 (예: 2시간 이후 추가 주문 부탁)', hours: 0.5 },
      { when: 'month', text: '콘센트 좌석 구역을 정하고, 오래 머무는 손님용 리필·추가 메뉴 안내', hours: 1 },
    ];
    return {
      id: 'cafe_seats', area: 'hall', goal: 'sales', effect: ['구매 전환', '객단가'], tag: 'hypo',
      title: '좌석이 오래 쓰여 바쁜 시간 손님을 놓치고 있을 수 있어요',
      problem: '좌석은 한정돼 있어서, 오래 머무는 손님이 많으면 바쁜 시간에 새 손님이 앉을 자리가 없어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 10000], hoursTotal: 1.5, hoursWeekly: 0.3, who: '사장님' },
      effectText: '매출 개선(바쁜 시간 좌석 회전, 추가 주문).',
      uncertainty: '공부·업무 손님이 단골의 큰 부분이라면 안내가 이탈로 이어질 수 있어요. 문구는 부드럽게 하고 반응을 보세요.',
      measure: { metric: '바쁜 시간 자리가 없어 돌아간 팀 수, 좌석당 매출', how: '피크 시간 기록', period: '4주', baseline: '' },
      impact: 2, confidence: 1,
    };
  },

  // 20. 외부에서 잘 안 보임
  function outsideVisibility(D) {
    const { c } = D;
    if (!c.hallish()) return null;
    const vis = c.v('e_visible');
    const menuOut = c.v('e_outside_menu');
    const access = c.v('e_access');
    if (!['no', 'day'].includes(vis) && menuOut !== 'no' && !['hidden', 'both'].includes(access)) return null;
    const ev = [evA(D, 'e_visible'), evA(D, 'e_outside_menu'), evA(D, 'e_access'), evA(D, 'e_control')].filter(Boolean);
    const landlord = c.has('e_control', 'sign') || c.has('e_control', 'facade') || c.has('g_fixed', 'landlord');
    const photo = (D.data.attachments || []).some((f) => f.kind === 'store');
    if (!photo) ev.push(evN('입구·간판 사진이 없어 사진으로 확인하지 못했어요 (답변 기준 판단)'));
    const steps = [];
    if (menuOut === 'no') steps.push({ when: 'week', text: '가게 앞에서 보이는 메뉴·가격판(입간판 또는 창문 메뉴판) 설치', hours: 1 });
    if (vis === 'day' || vis === 'no') steps.push({ when: 'month', text: `${vis === 'day' ? '저녁에도 보이도록 간판 조명 점검·교체' : '길에서 보이는 위치에 가게 이름 표시 보완'}${landlord ? ' (건물주·관리사무소 협의 필요)' : ''}`, hours: 1 });
    if (['hidden', 'both'].includes(access)) steps.push({ when: 'month', text: `골목 입구·건물 1층에 방향 안내 표지 설치${landlord ? ' (협의 필요)' : ''}, 온라인에 찾아오는 길 사진 추가`, hours: 1 });
    return {
      id: 'outside', area: 'env', goal: 'sales', effect: ['신규 유입'], tag: 'hypo',
      title: '지나가는 손님이 가게를 알아보기 어려워요',
      problem: '밖에서 무엇을 얼마에 파는지 보이지 않으면 처음 오는 손님이 들어오기 망설여요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      alt: { steps: [{ when: 'week', text: '출력한 A4 메뉴판(대표 메뉴 3개·가격)을 창문이나 출입문에 붙이기', hours: 0.5 }], cost: { cash: [0, 10000], hoursTotal: 0.5, hoursWeekly: 0, who: '사장님' }, note: '예산이 적어 가장 작은 비용으로 시작하는 방법이에요.' },
      cost: { cash: [50000, 300000], hoursTotal: 2, hoursWeekly: 0, who: '사장님' },
      effectText: '매출 개선(신규 유입: 지나가다 들어오는 손님).',
      uncertainty: '간판·입간판은 지자체 옥외광고물 규정과 건물 관리 규칙을 확인해야 해요. 유입 증가는 기록으로 확인해야 해요.',
      measure: { metric: '"지나가다 왔다"는 새 손님 수', how: '계산대 체크표 (어떻게 알고 오셨어요?)', period: '4주', baseline: '' },
      impact: 2, confidence: photo ? 2 : 1,
    };
  },

  // 21. 메뉴판
  function menuBoard(D) {
    const { c } = D;
    const mb = c.v('e_menu_board') || [];
    const issues = mb.filter((x) => ['small', 'crowded', 'old'].includes(x));
    const noPhoto = c.v('m_photo') === 'none';
    const noRec = c.v('m_recommend') === 'no';
    if (!issues.length && !(noPhoto && noRec) && !(mb.length && !mb.includes('price_clear'))) return null;
    const ev = [evA(D, 'e_menu_board'), evA(D, 'm_photo'), evA(D, 'm_recommend')].filter(Boolean);
    const photo = (D.data.attachments || []).some((f) => f.kind === 'menu_board');
    ev.push(photo ? evN('메뉴판 사진이 첨부됐지만 자동 판독이 연결되지 않아, 사진 내용은 판단에 쓰지 않았어요') : evN('메뉴판 사진이 없어 답변만으로 판단했어요'));
    const steps = [
      { when: 'week', text: '대표 메뉴 3개에 "추천" 표시와 사진을 넣은 메뉴판으로 다시 출력', hours: 1.5 },
      { when: 'month', text: '글씨 크기를 키우고, 가격을 덧붙인 흔적은 새 출력물로 정리. 메뉴가 많다면 대분류로 묶기', hours: 1 },
    ];
    return {
      id: 'menu_board', area: 'env', goal: 'sales', effect: ['구매 전환', '객단가'], tag: 'hypo',
      title: '처음 온 손님이 메뉴를 고르기 어려운 메뉴판이에요',
      problem: '무엇이 대표 메뉴인지, 얼마인지 바로 보이지 않으면 주문이 늦어지고 무난한 메뉴만 고르게 돼요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      alt: { steps: [{ when: 'week', text: '기존 메뉴판 옆에 "추천 메뉴 3" 안내 1장만 붙이기', hours: 0.5 }], cost: { cash: [0, 5000], hoursTotal: 0.5, hoursWeekly: 0, who: '사장님' }, note: '예산·시간이 적을 때의 최소 버전이에요.' },
      cost: { cash: [20000, 100000], hoursTotal: 2.5, hoursWeekly: 0, who: '사장님' },
      effectText: '매출 개선(구매 전환, 추천 메뉴 판매).',
      uncertainty: '메뉴판 변경 효과는 다른 변화와 섞이기 쉬워요. 추천 메뉴 판매 비중으로 확인하세요.',
      measure: { metric: '추천 메뉴 판매 비중, 평균 결제금액', how: 'POS 메뉴별 판매', period: '4주', baseline: '' },
      impact: 2, confidence: 1,
    };
  },

  // 22. 매장 불편 요소
  function envIssues(D) {
    const { c } = D;
    const iss = (c.v('e_issues') || []).filter((x) => x !== 'none');
    const comp = c.v('cu_complaint') || '';
    const compEnv = match(comp, /의자|좁|시끄|덥|춥|어둡|냄새|불편/);
    if (!iss.length && !compEnv) return null;
    const ev = [evA(D, 'e_issues'), compEnv ? evA(D, 'cu_complaint') : null].filter(Boolean);
    const MAP = {
      dark: '조명: 전구 몇 개부터 밝기·색온도를 바꿔 손님 반응 보기',
      noise: '소음: 음악 볼륨 기준 정하기, 의자 다리 소음 패드, 패브릭 소품으로 울림 줄이기',
      smell: '냄새: 방향제로 덮기 전에 배수구 트랩·후드 필터·쓰레기통 위치부터 점검',
      seat: '좌석: 불편한 좌석 일부에 쿠션·등받이를 먼저 시험',
      temp: '냉난방: 출입문 바람막이와 냉난방기 필터 청소부터',
      flow: '동선: 주문·픽업·반납 위치 안내판 붙이기',
    };
    const steps = iss.map((x) => ({ when: 'month', text: MAP[x], hours: 1 })).filter((s) => s.text);
    if (!steps.length) steps.push({ when: 'month', text: '손님 불편 중 비용이 적게 드는 것부터 1가지 고치기', hours: 1 });
    const noInterior = c.has('g_fixed', 'interior');
    return {
      id: 'env_issues', area: 'env', goal: 'sales', effect: ['재방문'], tag: 'hypo',
      title: '매장 이용 중 불편한 요소가 있어요',
      problem: '맛과 별개로, 머무는 동안의 불편은 재방문을 줄일 수 있어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      alt: { steps: [{ when: 'week', text: `비용이 거의 들지 않는 것 1가지부터: ${steps[0].text}`, hours: 1 }], cost: { cash: [0, 10000], hoursTotal: 1, hoursWeekly: 0, who: '사장님' }, note: '예산이 적어 배치·설정 변경처럼 돈이 거의 들지 않는 방법 1가지만 먼저 해요.' },
      cost: { cash: [30000, 300000], hoursTotal: 3, hoursWeekly: 0, who: '사장님' },
      effectText: '매출 개선(재방문·체류 만족).',
      uncertainty: `인테리어를 바꾸는 것만으로 매출이 오른다고 단정할 수 없어요. 큰 공사 전에 적은 비용으로 시험해요.${noInterior ? ' 공사가 어렵다고 해서 공사 없는 방법만 넣었어요.' : ''}`,
      measure: { metric: '관련 불만·리뷰 언급 수, 재방문 지표', how: '불만 기록·리뷰 확인', period: '6주', baseline: '' },
      impact: c.concern('env_service') ? 2 : 1, confidence: 1,
    };
  },

  // 23. 청소 기준
  function cleaningRule(D) {
    const { c } = D;
    const chk = c.v('cl_check');
    const who = c.v('cl_who');
    const deep = c.v('cl_deep');
    if (!['none', 'unused'].includes(chk) && who !== 'adhoc' && !['older', 'unknown'].includes(deep)) return null;
    const ev = [evA(D, 'cl_who'), evA(D, 'cl_check'), evA(D, 'cl_deep')].filter(Boolean);
    const comp = c.v('cu_complaint') || '';
    if (match(comp, /더럽|위생|청결|냄새|벌레|화장실/)) ev.push(evA(D, 'cu_complaint'));
    const steps = [
      { when: 'week', text: '매일·매주 청소 체크리스트(주방·홀·화장실)를 만들어 벽에 붙이고 담당자가 서명', hours: 1 },
      { when: 'week', text: '영업 중 2시간마다 화장실·테이블 점검 칸 넣기', hours: 0.3 },
      { when: 'quarter', text: '분기 1회 대청소 날을 달력에 정하기', hours: 0.2 },
    ];
    return {
      id: 'cleaning', area: 'clean', goal: 'sales', effect: ['재방문'], tag: 'hypo',
      title: '청소를 "누가, 언제 확인하는지" 정해진 기준이 없어요',
      problem: '어떤 세제를 쓰는지보다 확인하는 기준이 있어야 청결이 유지돼요. 지금 상태가 나쁘다는 뜻은 아니에요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 1.5, hoursWeekly: 0.5, who: '사장님 + 직원' },
      effectText: '매출 개선(재방문·신뢰). 위생 문제 예방.',
      uncertainty: '사진이나 방문 확인 없이 답변으로만 판단했어요. 보이지 않는 위생 상태는 이 보고서로 확인할 수 없어요.',
      measure: { metric: '체크리스트 완료율, 청결 관련 불만·리뷰 수', how: '체크리스트 주간 집계', period: '4주', baseline: '' },
      impact: c.concern('env_service') ? 2 : 1, confidence: 2,
    };
  },

  // 24. 화장실
  function restroomRule(D) {
    const { c, data } = D;
    const where = c.v('cl_rest_where');
    if (!c.hallish() || !where || where === 'none') return null;
    const items = c.v('cl_rest_items');
    const issues = (c.v('cl_rest_issues') || []).filter((x) => x !== 'none');
    const BASIC = { lock: '잘 잠기는 문', soap: '비누·손 세정제', paper: '휴지', towel: '핸드타월·핸드드라이어', light: '밝은 조명', mirror: '거울', bin: '뚜껑 있는 휴지통' };
    const missing = Array.isArray(items) ? Object.keys(BASIC).filter((k) => !items.includes(k)) : [];
    if (!missing.length && !issues.length) return null;
    const building = ['building', 'mixed'].includes(c.v('cl_rest_manage')) || c.has('e_control', 'restroom');
    const ev = [evA(D, 'cl_rest_where'), evA(D, 'cl_rest_sep'), evA(D, 'cl_rest_items'), evA(D, 'cl_rest_issues'), evA(D, 'cl_rest_manage')].filter(Boolean);
    const photo = (data.attachments || []).some((f) => f.kind === 'restroom');
    ev.push(photo ? evN('화장실 사진이 첨부됐지만 자동 판독이 연결되지 않아 답변 기준으로 판단했어요') : evN('화장실 사진 없이 답변 기준으로 판단했어요'));
    const now = [];
    const nego = [];
    for (const k of missing) {
      const t = { lock: '잠금장치 수리·설치 (안전·사생활)', soap: '손 세정제 비치', paper: '휴지 보충 기준 정하기', towel: '핸드타월 비치', light: '조명 교체', mirror: '거울 설치', bin: '뚜껑 있는 휴지통 비치' }[k];
      if (building && ['lock', 'light', 'mirror'].includes(k)) nego.push(t); else now.push(t);
    }
    if (issues.includes('smell')) (building ? nego : now).push('냄새: 배수구·환기팬 점검 (방향제로 덮지 않기)');
    if (issues.includes('supplies')) now.push('소모품 점검 시간을 체크리스트에 넣기');
    if (issues.includes('lockbroken') && !missing.includes('lock')) (building ? nego : now).push('잠금장치 수리');
    const steps = [];
    if (now.length) steps.push({ when: 'week', text: `우리 가게가 바로 할 수 있는 것: ${now.join(', ')}`, hours: 1 });
    if (nego.length) steps.push({ when: 'month', text: `건물주·관리사무소와 협의할 것: ${nego.join(', ')}`, hours: 1 });
    const altNow = now.filter((t) => /세정제|핸드타월|휴지|소모품|휴지통/.test(t));
    const alt = {
      steps: [
        ...(altNow.length ? [{ when: 'week', text: `소모품부터: ${altNow.join(', ')}`, hours: 0.5 }] : []),
        ...(nego.length ? [{ when: 'week', text: `관리사무소에 수리·점검 요청: ${nego.join(', ')}`, hours: 0.3 }] : []),
        { when: 'week', text: '영업 중 화장실 점검 시간을 청소 체크리스트에 넣기', hours: 0.2 },
      ],
      cost: { cash: [0, 10000], hoursTotal: 1, hoursWeekly: 0.2, who: '사장님' },
      note: '예산이 적어 소모품과 수리 요청처럼 돈이 거의 들지 않는 것부터 해요.',
    };
    return {
      id: 'restroom', area: 'clean', goal: 'sales', effect: ['재방문'], tag: 'hypo', alt,
      title: '화장실에 손님이 바로 느끼는 불편이 있어요',
      problem: missing.length ? `없다고 답한 것: ${missing.map((k) => BASIC[k]).join(', ')}` : '화장실 관련 문제가 있다고 답했어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [10000, 100000], hoursTotal: 2, hoursWeekly: 0.3, who: building ? '사장님 (일부 관리사무소 협의)' : '사장님' },
      effectText: '매출 개선(재방문·신뢰).',
      uncertainty: '화장실이 매출에 주는 영향은 크기를 알 수 없어요. 불만 감소로 확인해요.',
      measure: { metric: '화장실 점검 기록, 관련 불만 수', how: '체크리스트·불만 기록', period: '4주', baseline: '' },
      impact: issues.includes('complaint') || missing.includes('lock') ? 2 : 1, confidence: 2,
    };
  },

  // 25. 리뷰 답글
  function reviewReply(D) {
    const { c } = D;
    const rr = c.v('cu_review_reply');
    if (!['no', 'some'].includes(rr)) return null;
    const ch = c.v('mk_channels') || [];
    if (!ch.includes('place') && !ch.includes('app')) return null;
    const ev = [evA(D, 'cu_review_reply'), evA(D, 'cu_complaint')].filter(Boolean);
    const themes = reviewThemes(D.data);
    if (themes.complaint.length) ev.push(evD(`공개 리뷰 불편 내용: ${themes.complaint.map((t) => `${t.value}${t.count ? ` ${t.count}건` : ''}`).join(', ')}`));
    const steps = [
      { when: 'week', text: '자주 쓰는 답글 문장 5개를 미리 만들어 두기 (감사·불만 사과·조치 안내)', hours: 0.5 },
      { when: 'month', text: '주 2회 10분씩 최근 리뷰에 답글 달기. 불만 리뷰는 원인과 바꾼 점을 짧게', hours: 0.4 },
    ];
    return {
      id: 'review_reply', area: 'customer', goal: 'sales', effect: ['구매 전환', '재방문'], tag: 'hypo',
      title: '리뷰에 답하지 않아 손님의 불만이 그대로 남아 있을 수 있어요',
      problem: '처음 오는 손님은 리뷰와 답글을 보고 가게 분위기를 판단해요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 1.5, hoursWeekly: 0.4, who: '사장님' },
      effectText: '매출 개선(구매 전환·재방문).',
      uncertainty: '답글만으로 주문이 늘었는지는 구분하기 어려워요.',
      measure: { metric: '답글 비율, 같은 불만의 재발 건수', how: '리뷰 화면 주간 확인', period: '4주', baseline: '' },
      impact: 1, confidence: 1,
    };
  },

  // 26. 매출 감소 원인 좁히기
  function salesDecline(D) {
    const { c, calc } = D;
    const down = c.v('s_trend') === 'down' || (isNum(calc.trend.lastChange) && calc.trend.lastChange <= -0.1) || (isNum(calc.trend.halfChange) && calc.trend.halfChange <= -0.1);
    if (!down) return null;
    const ev = [evA(D, 's_trend'), evA(D, 's_drop_pct'), evA(D, 's_drop_reason')].filter(Boolean);
    if (isNum(calc.trend.halfChange)) ev.push(evC(`월별 매출 기록의 앞 절반 평균 대비 뒤 절반 평균 ${fmtPct(calc.trend.halfChange)}`));
    if (isNum(calc.trend.yoy)) ev.push(evC(`최근 달 매출의 전년 같은 달 대비 변화 ${fmtPct(calc.trend.yoy)}`));
    const reasons = c.v('s_drop_reason') || [];
    const steps = [{ when: 'week', text: '최근 3개월과 1년 전 같은 달의 매출을 요일·시간대·판매 방식(매장/포장/배달)별로 비교 (POS 리포트 또는 매출 파일 첨부)', hours: 1 }];
    if (reasons.includes('competitor')) steps.push({ when: 'week', text: '경쟁 가게의 같은 메뉴를 양·구성까지 맞춰 비교하고 출처·날짜를 기록 (가격·경쟁 항목에 입력)', hours: 1 });
    if (reasons.includes('delivery')) steps.push({ when: 'week', text: '배달앱 통계에서 노출 수·클릭 수·주문 수 중 어디서 줄었는지 확인', hours: 0.5 });
    if (reasons.includes('regulars')) steps.push({ when: 'month', text: '단골 감소: 재방문 기록부터 시작 (재방문 항목 참고)', hours: 0.3 });
    steps.push({ when: 'month', text: '가장 많이 줄어든 구간 1곳을 정해, 그 구간에 맞는 조치 1개만 4주 시험', hours: 1 });
    return {
      id: 'sales_decline', area: 'sales', goal: 'sales', effect: ['신규 유입', '재방문'], tag: 'need',
      title: '매출이 줄어든 원인을 시간대·판매 방식별로 좁혀야 해요',
      problem: '전체 매출만으로는 원인을 알 수 없어요. 어느 요일·시간·판매 방식에서 줄었는지 찾아야 맞는 처방을 할 수 있어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 2, hoursWeekly: 1, who: '사장님' },
      effectText: '원인을 좁히면 다음 조치의 성공 가능성이 높아져요.',
      uncertainty: '계절·상권 변화처럼 가게가 바꿀 수 없는 원인일 수도 있어요.',
      measure: { metric: '구간별 주간 매출·주문 수', how: 'POS 리포트', period: '4주', baseline: isNum(c.num('s_drop_pct')) ? `감소 폭 약 ${c.num('s_drop_pct')}%` : '' },
      impact: c.concern('sales_down') ? 3 : 2, confidence: 2,
    };
  },

  // 27. 가격이 주변보다 높음
  function pricePosition(D) {
    const { c, data } = D;
    const comps = competitorComparisons(data);
    const same = comps.filter((x) => x.level === 'same' && isNum(x.diffPct) && x.diffPct >= 0.1);
    if (c.v('pr_position') !== 'higher' && !same.length) return null;
    const reasons = c.v('pr_reason') || [];
    const valueReason = reasons.some((r) => ['quality', 'portion', 'handmade', 'space'].includes(r));
    const ev = [evA(D, 'pr_position'), evA(D, 'pr_reason'), evA(D, 'pr_diff')].filter(Boolean);
    for (const x of same) ev.push(evD(`${x.name} ${x.menu} ${fmtWon(x.theirPrice)} vs 우리 ${x.myMenu} ${fmtWon(x.myPrice)} (${fmtPct(x.diffPct, 0)} 높음, 양·구성: ${x.portion}, ${x.date} 확인)`));
    const refOnly = comps.filter((x) => x.level !== 'same');
    if (refOnly.length) ev.push(evN(`조건이 달라 참고만 한 비교 ${refOnly.length}건: ${refOnly.map((x) => `${x.name}(${x.reason})`).join(' / ')}`));
    const steps = valueReason
      ? [
        { when: 'week', text: `가격이 높은 이유(${reasons.filter((r) => ['quality', 'portion', 'handmade', 'space'].includes(r)).map((r) => ({ quality: '재료', portion: '양', handmade: '직접 만드는 과정', space: '공간·서비스' }[r])).join('·')})를 메뉴판·플레이스·배달앱 설명에 한 줄로 보여주기`, hours: 1 },
        { when: 'month', text: '대표 메뉴 사진에 양과 재료가 보이게 다시 찍기', hours: 1 },
      ]
      : [
        { when: 'week', text: '가격을 내리기 전에, 같은 메뉴의 양·구성을 주변 가게와 같은 조건으로 다시 비교', hours: 1 },
        { when: 'month', text: '소용량·단품 메뉴 1개를 추가해 처음 오는 손님의 부담을 낮추는 시험', hours: 1 },
      ];
    return {
      id: 'price_position', area: 'price', goal: 'sales', effect: ['구매 전환'], tag: 'hypo',
      title: '가격이 주변보다 높다면, 먼저 그 이유를 손님이 알 수 있게 해야 해요',
      problem: '가격 인하는 마지막 선택이에요. 이유가 있다면 보여주고, 없다면 구성으로 조정할 수 있어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 10000], hoursTotal: 2, hoursWeekly: 0.5, who: '사장님' },
      effectText: '매출 개선(구매 전환). 가격을 유지하면 수익성도 지켜요.',
      uncertainty: same.length ? '공개 가격은 확인 날짜 이후 바뀌었을 수 있어요.' : '같은 조건 비교 자료가 없어 "높다"는 판단은 사장님 답변 기준이에요.',
      measure: { metric: '해당 메뉴 주문 비율, 처음 온 손님 수', how: 'POS 메뉴별 판매 + 유입 체크표', period: '4주', baseline: '' },
      impact: 2, confidence: same.length ? 2 : 1,
    };
  },

  // 28. 반복 업무로 사장님 시간 부족
  function ownerTime(D) {
    const { c } = D;
    const tasks = (c.v('st_delay') || []).filter((x) => x !== 'none');
    const hours = c.num('b_owner_hours');
    if (!tasks.length || !(c.concern('labor') || (isNum(hours) && hours >= 60))) return null;
    const MAP = {
      stock: '발주·재고: 품목별 최소 재고와 주문량을 적은 발주 기준표로 매번 고민하는 시간 줄이기',
      prep: '재료 손질: 한가한 시간대에 몰아서 하고, 손질된 재료(전처리 식재료) 구매와 비용 비교',
      online: '리뷰·SNS: 답글 문장 5개 미리 만들고 주 2회 시간을 정해 몰아서 하기',
      order: '주문·계산: 자주 묻는 질문(메뉴·포장·주차) 안내문을 계산대에 붙이기',
      dish: '설거지: 식기 종류 줄이기, 애벌 세척 위치를 동선에 맞게 옮기기',
      clean: '청소: 체크리스트로 직원과 나누기',
      pack: '포장: 포장 용기·소스를 미리 세팅한 포장대 만들기',
      cook: '조리: 피크 전 준비 목록으로 조리 단계 줄이기',
      drink: '음료: 베이스 미리 준비, 제조 동선 한 방향으로 정리',
    };
    const steps = tasks.slice(0, 4).map((t) => ({ when: 'month', text: MAP[t], hours: 1 })).filter((s) => s.text);
    steps.unshift({ when: 'week', text: '1주일 동안 사장님이 하는 일을 30분 단위로 적어, 시간이 가장 많이 드는 일 3가지 찾기', hours: 1 });
    const ev = [evA(D, 'b_owner_hours'), evA(D, 'st_delay'), evA(D, 'b_staff')].filter(Boolean);
    return {
      id: 'owner_time', area: 'staff', goal: 'ops', effect: ['운영 효율'], tag: 'hypo',
      title: '반복되는 일을 줄여 사장님 시간을 확보하세요',
      problem: '사장님 시간은 개선 작업에도 필요해요. 반복 업무를 줄이지 않으면 다른 개선을 실행할 시간이 없어요.',
      evidence: ev, actions: steps.map((s) => s.text), steps,
      cost: { cash: [0, 0], hoursTotal: 3, hoursWeekly: 1, who: '사장님' },
      effectText: '운영 효율(사장님·직원 시간 절약). 간접적으로 수익성 개선.',
      uncertainty: '업무를 바꾸는 초기에는 오히려 시간이 더 들 수 있어요.',
      measure: { metric: '해당 업무의 주간 소요 시간', how: '2주 기록 비교', period: '4주', baseline: isNum(hours) ? `사장님 주 ${hours}시간` : '' },
      impact: 2, confidence: 2,
    };
  },
];

// ───────── 우선순위
function constraints(c) {
  const b = c.v('g_budget');
  const t = c.v('g_time');
  const bLv = isNum(+b) && +b >= 0 ? +b : null;
  const tLv = isNum(+t) ? +t : null;
  return {
    cash: bLv === null ? BUDGET_CAP[1] : BUDGET_CAP[bLv],
    weekly: tLv === null ? TIME_CAP[1] : TIME_CAP[tLv],
    assumed: bLv === null || tLv === null,
    budgetLabel: bLv === null ? '모름 (30만 원 이하로 가정)' : ['1만 원 이하', '30만 원 이하', '30만~100만 원', '100만~300만 원', '300만 원 이상'][bLv],
    timeLabel: tLv === null ? '모름 (주 1~3시간으로 가정)' : ['주 1시간 미만', '주 1~3시간', '주 3~5시간', '주 5시간 이상'][tLv],
  };
}

const fits = (cost, cap) => cost.cash[1] <= cap.cash && cost.hoursWeekly <= cap.weekly;

const GOAL_MAP = { new: ['신규 유입'], ticket: ['객단가'], repeat: ['재방문'], cost: ['비용 절감'], ops: ['운영 효율'], delivery: ['비용 절감', '객단가'] };

function scoreSolution(s, c, cap) {
  let feas = 3;
  s.usedAlt = false;
  if (!fits(s.cost, cap)) {
    if (s.alt && fits(s.alt.cost, cap)) {
      s.usedAlt = true;
      s.altNote = s.alt.note || '예산·시간을 고려해 작은 규모로 시작하는 방법이에요.';
      s.fullVersion = { steps: s.steps, cost: s.cost };
      s.steps = s.alt.steps;
      s.cost = s.alt.cost;
      s.actions = s.steps.map((x) => x.text);
      feas = 3;
    } else {
      feas = 1;
      s.constraintNote = `지금 예산(${cap.budgetLabel})·시간(${cap.timeLabel}) 안에서는 한 번에 하기 어려워요. 첫 단계만 먼저 하거나 다음 달 이후로 미루세요.`;
    }
  }
  const areas = concernAreas(c);
  const concernBonus = areas.includes(s.area) ? 3 : 0;
  const goals = c.v('g_change') || [];
  const goalBonus = goals.some((g) => (GOAL_MAP[g] || []).some((e) => s.effect.includes(e))) ? 2 : 0;
  s.feasibility = feas;
  s.score = s.impact * s.confidence * feas + concernBonus + goalBonus;
  s.scoreDetail = { impact: s.impact, confidence: s.confidence, feasibility: feas, concernBonus, goalBonus };
  return s;
}

function wantedGoals(c) {
  const g = c.v('g_change') || [];
  return {
    sales: g.some((x) => ['new', 'ticket', 'repeat'].includes(x)) || ['sales_down', 'marketing_focus', 'repeat_low', 'env_service'].some((x) => c.concern(x)),
    profit: g.some((x) => ['cost', 'delivery'].includes(x)) || ['profit_unknown', 'purchase_price', 'delivery_profit', 'labor', 'menu_complex'].some((x) => c.concern(x)),
  };
}

function pickTop(sols, wants) {
  const sorted = [...sols].sort((a, b) => b.score - a.score);
  const top = [];
  for (const s of sorted) {
    if (top.length >= 3) break;
    if (top.some((t) => t.area === s.area)) continue;
    top.push(s);
  }
  for (const s of sorted) { if (top.length >= 3) break; if (!top.includes(s)) top.push(s); }
  // 사장님이 매출과 수익성을 모두 원하는데 한쪽으로만 쏠리면, 점수 차이가 크지 않은 다른 목표의 해결책을 하나 넣는다
  const goalsIn = new Set(top.map((t) => t.goal));
  if (top.length === 3 && goalsIn.size === 1 && wants && wants.sales && wants.profit) {
    const other = sorted.find((s) => !top.includes(s) && s.goal !== top[0].goal && s.goal !== 'ops' && s.score >= top[2].score * 0.6);
    if (other) top[2] = other;
  }
  return top;
}

// ───────── 잘하고 있는 점
function strengths(D) {
  const { c, calc, data } = D;
  const out = [];
  const core = calc.menu.groups.core;
  if (core.length) out.push({ text: `많이 팔리면서 남는 비율도 높은 메뉴: ${core.map((i) => i.name).join(', ')}. 품절 없이 유지하고 대표 메뉴로 보여주세요.`, ev: { t: 'calc', text: '메뉴별 판매량·남는 비율 계산' } });
  const praise = c.v('cu_praise');
  if (praise) out.push({ text: `손님이 자주 칭찬하는 점: "${praise}". 메뉴판·온라인 소개에 그대로 살릴 수 있어요.`, ev: { t: 'answer', text: '사장님 답변' } });
  const th = reviewThemes(data).praise;
  if (th.length) out.push({ text: `공개 리뷰에서 반복된 칭찬: ${th.map((t) => `${t.value}${t.count ? ` ${t.count}건` : ''}`).join(', ')}`, ev: { t: 'doc', text: th.map((t) => `${SOURCE_LABEL[t.source] || '리뷰'} ${t.observedAt || ''}${t.sample ? ' (가상 예시)' : ''}`).join(', ') } });
  if (c.v('cl_check') === 'daily') out.push({ text: '청소 점검표를 매일 확인하고 있어요. 이 습관을 유지하세요.', ev: { t: 'answer', text: '사장님 답변 (사진·방문 확인 아님)' } });
  if (c.v('mk_ads_track') === 'number') out.push({ text: '광고 성과를 숫자로 확인하고 있어요. 광고별 주문당 비용을 계속 비교하세요.', ev: { t: 'answer', text: '사장님 답변' } });
  if (['record', 'app'].includes(c.v('cu_repeat_basis'))) out.push({ text: '재방문을 기록으로 확인하고 있어요. 개선 효과를 측정할 기반이 있어요.', ev: { t: 'answer', text: '사장님 답변' } });
  if (c.v('s_trend') === 'up') out.push({ text: '최근 매출이 늘고 있어요. 무엇이 효과가 있었는지 기록해 두세요.', ev: { t: 'answer', text: '사장님 답변' } });
  if (c.v('p_compared') === 'recent') out.push({ text: '최근 3개월 안에 매입가를 비교해 봤어요.', ev: { t: 'answer', text: '사장님 답변' } });
  const r = calc.ratios.find((x) => x.key === 'food');
  if (r && isNum(r.gap) && r.gap <= -0.03) out.push({ text: `식재료 구매 비율(${fmtPct(r.value)})이 ${r.benchLabel} 평균(${fmtPct(r.bench)})보다 낮은 편이에요. 품질을 유지하는지 함께 보세요.`, ev: { t: 'calc', text: `계산 결과 + 공개 통계(${SURVEY.name})` } });
  for (const row of calc.purchase.rows) {
    for (const x of row.comparisons) {
      if (x.level === 'same' && x.diff < 0) out.push({ text: `${row.item.name}은(는) 같은 조건 견적보다 낮은 단가로 사고 있어요 (${x.dimLabel} ${fmtWon(x.mine.perBase)} vs ${fmtWon(x.theirs.perBase)}).`, ev: { t: 'calc', text: `${x.quote.sourceName || '견적'} ${x.quote.observedAt || ''} 확인${x.quote.sample ? ' (가상 예시)' : ''}` } });
    }
  }
  if (c.v('mk_place_updated') === 'yes' && !publicInfoChecks(data).length) out.push({ text: '온라인 가게 정보를 최신으로 관리하고 있다고 답했어요.', ev: { t: 'answer', text: '사장님 답변' } });
  return out;
}

// ───────── 추가로 확보하면 좋은 자료
function needMore(D, qs) {
  const { c, calc, data } = D;
  const out = [];
  for (const m of calc.missingCosts) out.push(`비용: ${m.label}`);
  const coreUnanswered = qs.filter((q) => q.type !== 'check' && q.type !== 'upload' && q.depth === 'core' && !questionDone(data, q));
  for (const q of coreUnanswered.slice(0, 8)) out.push(`답변: ${q.label}`);
  if (coreUnanswered.length > 8) out.push(`그 밖에 미답변 ${coreUnanswered.length - 8}개`);
  const checks = qs.filter((q) => q.type === 'check' && !questionDone(data, q));
  for (const ch of checks) out.push(`재확인: ${ch.label}`);
  const noCost = calc.menu.items.filter((i) => !isNum(i.cost) && isNum(i.qty)).sort((a, b) => b.qty - a.qty).slice(0, 3);
  if (noCost.length) out.push(`메뉴 원가: ${noCost.map((i) => i.name).join(', ')}`);
  for (const r of calc.purchase.rows) {
    const miss = [];
    if (!r.item.size || !r.item.unit) miss.push('규격');
    if (r.item.ship === '' || r.item.ship == null) miss.push('배송비');
    if (!r.item.vat) miss.push('부가세 포함 여부');
    if (miss.length) out.push(`매입 정보: ${r.item.name}의 ${miss.join('·')}`);
  }
  for (const u of uncheckedChannels(data)) out.push(`공개 정보: ${u.label}(${u.url}) - 자동으로 확인하지 못했어요. 메뉴·영업시간 화면 캡처를 올려주세요`);
  const kinds = new Set((data.attachments || []).map((f) => f.kind));
  if (!kinds.has('menu_board')) out.push('사진: 메뉴판·가격표');
  if (c.hallish() && !kinds.has('store')) out.push('사진: 입구·간판·매장 내부');
  if (!kinds.has('sales_file')) out.push('파일: POS 매출 내역(CSV) - 요일·시간대별 분석에 필요');
  return out;
}

// ───────── 보고서 생성
export function generateReport(data, opts = {}) {
  const c = makeCtx(data);
  const calc = compute(data);
  const D = { data, c, calc };
  const qs = visibleQuestions(data);
  const cap = constraints(c);
  // 아직 확인되지 않은 모순·이상값이 있으면, 그 값에 기대는 계산 결과의 확실성을 낮춘다
  const openChecks = qs.filter((q) => q.type === 'check' && q.kind !== 'public' && !questionDone(data, q));
  const shaky = new Set(openChecks.flatMap((q) => q.related || []));
  const DEPENDS = {
    missing_costs: ['s_monthly'], food_cost: ['c_food', 's_monthly', 'm_list'], labor_cost: ['c_labor', 's_monthly', 'b_staff'],
    delivery_unit: ['d_orders', 'd_ticket', 'b_split', 'c_food', 's_monthly'], ads_untracked: ['s_monthly'], purchase_savings: ['p_items'],
    menu_simplify: ['m_list'], menu_promote: ['m_list'], menu_price_review: ['m_list'], waste: ['c_food'],
  };
  D.shaky = shaky;
  const sols = [];
  let rulesApplied = 0;
  for (const rule of RULESET) {
    const s = rule(D);
    if (!s) continue;
    rulesApplied++;
    s.evidence = (s.evidence || []).filter(Boolean);
    const dep = (DEPENDS[s.id] || []).filter((k) => shaky.has(k));
    if (dep.length) {
      s.confidence = 1;
      s.evidence.unshift(evN(`관련 값(${dep.map((k) => QMAP[k]?.label || k).join(', ')})이 서로 맞지 않거나 흔하지 않아 재확인 중이에요. 확인 전까지 이 계산은 참고만 하세요.`));
    }
    if (!s.evidence.length) s.evidence.push(evN('근거 자료가 부족해 일반적인 점검 항목으로 제안해요'));
    if (!s.steps || !s.steps.length) s.steps = s.actions.map((a) => ({ when: 'month', text: a, hours: 0.5 }));
    sols.push(scoreSolution(s, c, cap));
  }
  sols.sort((a, b) => b.score - a.score);
  const top = pickTop(sols, wantedGoals(c));
  for (const [i, s] of top.entries()) s.rank = i + 1;

  // 실행 계획: 이번 주 할 일은 주당 가능 시간 안에서
  const plan = { week: [], month: [], quarter: [] };
  let weekHours = 0;
  const ordered = [...top, ...sols.filter((s) => !top.includes(s))];
  for (const s of ordered) {
    for (const st of s.steps) {
      const item = { text: st.text, hours: st.hours || 0, solutionId: s.id, solutionTitle: s.title, top: top.includes(s) };
      if (st.when === 'week') {
        if (weekHours + item.hours <= Math.max(cap.weekly, 1) || plan.week.length === 0) { plan.week.push(item); weekHours += item.hours; }
        else plan.month.push({ ...item, moved: true });
      } else if (st.when === 'quarter') plan.quarter.push(item);
      else plan.month.push(item);
    }
  }
  plan.month = plan.month.slice(0, 12);
  plan.weekHours = weekHours;

  const measurement = ordered.slice(0, 8).map((s) => ({ solutionId: s.id, title: s.title, ...s.measure }));

  const ext = {
    autoSearch: false,
    statusText: '자동 인터넷 검색이 연결되지 않은 데모예요. 사람이 직접 확인해 입력한 공개 정보만 사용했어요.',
    used: (data.external?.entries || []).filter((e) => e.nameMatch && e.addrMatch),
    excluded: excludedEntries(data),
    confirmed: confirmedMismatches(data),
    pending: publicInfoChecks(data).filter((p) => !confirmedMismatches(data).some((m) => m.id === p.id)),
    unchecked: uncheckedChannels(data),
    competitors: competitorComparisons(data),
    reviews: reviewThemes(data),
    quotes: (data.external?.quotes || []).length,
    hasSample: (data.external?.entries || []).some((e) => e.sample) || (data.external?.quotes || []).some((q) => q.sample),
  };

  const P = data.profile || {};
  const split = c.v('b_split');
  const key = [];
  if (openChecks.length) key.push(`먼저 확인이 필요해요: ${openChecks.map((q) => q.label).join(' / ')}. 이 값들이 맞는지 확인해야 아래 계산을 믿을 수 있어요.`);
  if (calc.profit.kind !== 'unavailable' && calc.profit.high < 0) {
    key.push(`입력된 숫자로는 한 달에 약 ${fmtMan(-calc.profit.high)} 적자로 계산돼요${openChecks.length ? ' (값 확인 필요)' : ''}.`);
  } else if (calc.profit.kind !== 'unavailable' && calc.ownerHourly) {
    const oh = calc.ownerHourly;
    if (oh.high < oh.minWage) key.push(`입력된 숫자로 계산하면 사장님 시간당 소득은 최대 약 ${fmtWon(oh.high)}으로, ${oh.minWageYear}년 최저임금(${fmtWon(oh.minWage)})보다 낮아요.`);
    else if (oh.low < oh.minWage) key.push(`사장님 시간당 소득은 약 ${fmtWon(Math.max(0, oh.low))}~${fmtWon(oh.high)}으로, 최저임금(${fmtWon(oh.minWage)}) 근처예요.`);
  }
  if (calc.bep && calc.sales.monthly && calc.bep.sales > calc.sales.monthly) key.push(`현재 월매출(${fmtMan(calc.sales.monthly)})이 입력된 고정비 기준 손익분기 매출(${fmtMan(calc.bep.sales)})보다 낮아요.`);
  for (const s of top) key.push(`${s.rank}순위: ${s.title}`);

  const report = {
    engine: ENGINE_VERSION,
    mode: 'demo',
    modeText: '데모 모드: AI와 인터넷 검색이 연결되지 않았어요. 이 보고서는 입력값과 공개된 판단 기준으로 계산한 규칙 기반 결과예요.',
    generatedAt: new Date().toISOString(),
    inputVersion: opts.inputVersion ?? null,
    store: {
      name: P.name || '이름 없는 가게', address: P.address || '', biz: P.biz, bizLabel: P.biz === 'cafe' ? '카페' : '음식점', sub: P.sub || '',
      split, open: answerText(QMAP.b_open, data.answers?.b_open, c),
      concerns: (P.concerns || []).map((id) => CONCERNS.find((x) => x.id === id)?.label).filter(Boolean),
      main: c.v('g_main') || '',
      goals: answerText(QMAP.g_change, data.answers?.g_change, c),
      constraints: cap,
    },
    keyFindings: key,
    openChecks: openChecks.map((q) => ({ id: q.id, label: q.label })),
    strengths: strengths(D),
    calc,
    solutions: sols,
    top: top.map((s) => s.id),
    plan,
    measurement,
    needMore: needMore(D, qs),
    external: ext,
    completeness: (() => { const done = qs.filter((q) => questionDone(data, q)).length; return { done, total: qs.length }; })(),
    steps: [
      { label: '입력 확인', detail: `질문 ${qs.length}개 중 ${qs.filter((q) => questionDone(data, q)).length}개 답변, 재확인 필요 ${qs.filter((q) => q.type === 'check' && !questionDone(data, q)).length}건` },
      { label: '매출·비용 계산', detail: `비용 항목 ${calc.costs.length}개 중 빠진 항목 ${calc.missingCosts.length}개, 이미 빠진 수수료 ${calc.costs.filter((x) => x.state === 'deducted').length}개는 다시 빼지 않음` },
      { label: '메뉴·매입 비교', detail: `메뉴 ${calc.menu.items.length}개 분류, 견적 비교 ${calc.purchase.rows.reduce((a, r) => a + r.comparisons.length, 0)}건 (같은 조건 ${calc.purchase.rows.reduce((a, r) => a + r.comparisons.filter((x) => x.level === 'same').length, 0)}건)` },
      { label: '외부 정보 대조', detail: `자동 검색 미연결. 직접 입력된 공개 정보 ${ext.used.length}건 대조, 불일치 ${ext.confirmed.length + ext.pending.length}건, 제외 ${ext.excluded.length}건` },
      { label: '진단 규칙 적용', detail: `규칙 ${RULESET.length}개 중 ${rulesApplied}개 해당` },
      { label: '우선순위·실행 계획', detail: `우선 해결 ${top.length}개, 이번 주 할 일 ${plan.week.length}개 (약 ${Math.round(weekHours * 10) / 10}시간)` },
    ],
    criteria: [
      `식재료 구매 비율·인건비율은 ${SURVEY.name}(${SURVEY.org}, ${SURVEY.basis})의 업종 평균보다 ${RULES.foodGapPctPoint * 100}%p 이상 높을 때 점검 대상으로 표시해요. 평균은 목표치가 아니에요. ${SURVEY.note}`,
      `메뉴 원가로 계산한 원가율과 실제 식재료 구매 비율의 차이가 ${RULES.recipeGapPctPoint * 100}%p 이상이면 재료가 새는지 점검해요 (원가를 아는 메뉴가 판매량의 40% 이상일 때만 계산).`,
      `메뉴 분류는 이 가게 메뉴들 사이의 비교예요: 판매량이 메뉴 중앙값의 ${RULES.lowSalesRatio * 100}% 미만이면 "판매 적음", ${RULES.highSalesRatio * 100}% 이상이면 "판매 많음", 남는 비율이 중앙값 이상이면 "많이 남음". 대표·유입·세트 역할이 있는 메뉴는 판매 중단 후보에서 빼요.`,
      '매입가는 품목·브랜드·규격·등급·부가세·배송비가 모두 같고 확인한 지 30일 이내일 때만 "같은 조건 비교"로 보고 절감액을 계산해요. 그 밖에는 참고 비교 또는 비교 불가로 표시해요.',
      `배달 1건에서 고정비를 내기 전 남는 비율이 ${DELIVERY_LEFT_RULE * 100}% 미만이면 점검 대상으로 표시해요 (서비스 내부 기준).`,
      '모르는 비용은 0원으로 계산하지 않아요. 빠진 비용이 있으면 이익을 "입력된 비용만 뺀 금액"으로 표시하고, 실제 이익은 그보다 적을 수 있다고 알려요.',
      '입금액 기준 매출이면 이미 빠진 수수료를 비용에서 다시 빼지 않아요. 기준을 모르면 두 경우를 모두 계산해 범위로 보여줘요.',
      '우선순위 점수 = 영향도(1~3) × 근거 확실성(1~3) × 실행 가능성(1~3) + 고민과 관련된 영역 가산점(3) + 원하는 변화와 맞을 때 가산점(2). 예산·시간을 넘는 해결책은 작은 대안이 있으면 대안으로 바꿔 제시해요.',
      `사장님 시간당 소득 = 남는 금액 ÷ 월 근무시간(주 근무시간 × ${WEEKS_PER_MONTH.toFixed(2)}). 최저임금은 최저임금위원회·고용노동부 고시 기준이에요.`,
      '가게 점수는 매기지 않아요. 정보가 없다는 이유로 나쁘게 평가하지 않고 "추가 확인 필요"로 표시해요.',
    ],
  };
  return report;
}

export { MENU_GROUPS, BASIS_LABEL };
