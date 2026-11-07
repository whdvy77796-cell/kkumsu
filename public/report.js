// 보고서 화면: 첫 화면은 핵심만, 근거는 펼쳐서 보기
import { h, downloadBlob } from './ui.js';
import { EVIDENCE_LABEL } from '/shared/diagnose.js';
import { MENU_GROUPS } from '/shared/calc.js';
import { AREAS } from '/shared/questions.js';
import { SOURCE_LABEL } from '/shared/external.js';
import { SURVEY } from '/shared/benchmarks.js';
import { fmtMan, fmtWon, fmtPct, fmtNum, isNum } from '/shared/format.js';

const GOAL = { sales: ['매출 개선', 'b-sales'], profit: ['수익성 개선', 'b-profit'], ops: ['운영 효율', 'b-ops'] };
const TAG = { hypo: ['개선 가설', 'ev-hypo'], need: ['추가 확인 필요', 'ev-need'] };
const STATE = {
  known: ['입력값', 'b-info'], approx: ['대략 입력', 'b-info'], computed: ['입력값으로 계산', 'b-info'], estimated: ['추정', 'b-warn'], missing: ['모름: 0원으로 계산 안 함', 'b-bad'],
  na: ['해당 없음', 'b-info'], deducted: ['이미 빠짐: 다시 안 뺌', 'b-ok'], uncertain: ['이미 빠졌는지 불명확', 'b-warn'],
};
const LEVEL = { same: ['같은 조건 비교', 'b-ok'], similar: ['참고 비교 (조건 다름)', 'b-warn'], incomparable: ['비교 불가', 'b-bad'], reference: ['참고 비교', 'b-warn'], none: ['비교 불가', 'b-bad'] };

export const evBadge = (t) => h('span', { class: `badge ev-${t}` }, EVIDENCE_LABEL[t] || t);
const badge = (pair) => h('span', { class: `badge ${pair[1]}` }, pair[0]);

function costText(cost) {
  const [a, b] = cost.cash;
  const cash = b === 0 ? '추가 지출 없음' : `${a === 0 ? '0원' : fmtMan(a)} ~ ${fmtMan(b)}`;
  const t = [cost.hoursTotal ? `처음 약 ${cost.hoursTotal}시간` : '', cost.hoursWeekly ? `이후 주 ${cost.hoursWeekly}시간` : ''].filter(Boolean).join(', ') || '거의 들지 않음';
  return { cash, time: t, who: cost.who };
}

export function solutionBody(s) {
  const c = costText(s.cost);
  return h('div', null,
    h('p', null, s.problem),
    h('h4', null, '판단 근거'),
    h('ul', { class: 'evlist' }, s.evidence.map((e) => h('li', null, evBadge(e.t), ' ', e.text))),
    h('h4', null, '추천 행동'),
    h('ol', null, s.actions.map((a) => h('li', null, a))),
    s.usedAlt ? h('div', { class: 'card note small' }, h('b', null, '예산·시간에 맞춘 대안: '), s.altNote,
      s.fullVersion ? h('details', { class: 'more' }, h('summary', null, '여유가 생기면 할 수 있는 원래 방법'), h('ol', null, s.fullVersion.steps.map((x) => h('li', null, x.text))), h('p', { class: 'tiny muted' }, `원래 방법 비용: ${costText(s.fullVersion.cost).cash}, ${costText(s.fullVersion.cost).time}`)) : null) : null,
    s.constraintNote ? h('div', { class: 'card warn small' }, s.constraintNote) : null,
    h('h4', null, '필요한 비용과 시간'),
    h('div', { class: 'kv' }, h('div', null, h('span', null, '예상 지출'), h('b', null, c.cash)), h('div', null, h('span', null, '작업 시간'), h('b', null, c.time)), h('div', null, h('span', null, '담당'), h('b', null, c.who))),
    h('h4', null, '기대 효과와 불확실성'),
    h('p', null, h('span', { class: `badge ${GOAL[s.goal][1]}` }, GOAL[s.goal][0]), ' ', s.effect.filter((e) => e !== GOAL[s.goal][0]).map((e) => h('span', { class: 'badge b-info' }, e)), ' ', s.effectText),
    h('p', { class: 'muted small' }, '아직 모르는 부분: ', s.uncertainty),
    h('h4', null, '효과 확인 방법'),
    h('div', { class: 'kv' },
      h('div', null, h('span', null, '기록할 것'), h('b', null, s.measure.metric)),
      h('div', null, h('span', null, '방법'), h('b', null, s.measure.how)),
      h('div', null, h('span', null, '기간'), h('b', null, s.measure.period)),
      s.measure.baseline ? h('div', null, h('span', null, '지금 값'), h('b', null, s.measure.baseline)) : null),
    h('details', { class: 'more' }, h('summary', null, '우선순위 점수 보기'),
      h('p', { class: 'small muted' }, `점수 ${s.score} = 영향도 ${s.scoreDetail.impact} × 근거 확실성 ${s.scoreDetail.confidence} × 실행 가능성 ${s.scoreDetail.feasibility} + 고민 관련 ${s.scoreDetail.concernBonus} + 원하는 변화 일치 ${s.scoreDetail.goalBonus}`)),
  );
}

function solutionCard(s, opts = {}) {
  return h('div', { class: 'card', id: `sol-${s.id}` },
    h('div', { class: 'sol-title' }, s.rank ? h('span', { class: 'rank' }, s.rank) : null, h('span', null, s.title)),
    h('div', null, badge(GOAL[s.goal]), badge(TAG[s.tag] || TAG.hypo), s.usedAlt ? h('span', { class: 'badge b-warn' }, '예산·시간 맞춤 대안') : null),
    opts.collapsed
      ? h('details', { class: 'more' }, h('summary', null, '근거·행동·비용·효과 확인 방법 보기'), solutionBody(s))
      : solutionBody(s));
}

function sec(title, body, open = false) {
  return h('details', { class: 'sec', open }, h('summary', null, title), h('div', { class: 'body' }, body));
}

function numbersSection(calc) {
  const s = calc.sales;
  const p = calc.profit;
  const out = [];
  out.push(h('h3', null, '매출'));
  if (isNum(s.monthly)) {
    out.push(h('p', null, evBadge(s.source && String(s.source).startsWith('file') ? 'doc' : 'answer'), ' ', `월매출 ${fmtMan(s.monthly)}${s.approx ? ' (대략)' : ''}`, s.month ? ` · ${s.month.replace('-', '년 ')}월 기준` : ' · 기준 월 미입력', ` · ${s.basisLabel}`));
    if (isNum(s.orders) || isNum(s.ticket)) out.push(h('p', { class: 'small' }, `한 달 주문 ${fmtNum(s.orders, '건')} · 평균 결제금액 ${fmtWon(s.ticket)}${isNum(s.impliedTicket) ? ` (월매출 ÷ 주문 수 = ${fmtWon(s.impliedTicket)})` : ''}`));
  } else out.push(h('p', null, evBadge('need'), ' 월매출이 없어 이익·비율을 계산하지 못했어요.'));

  out.push(h('h3', null, '비용 (한 달 기준으로 맞춤)'));
  out.push(h('div', { class: 'rowlist' }, calc.costs.map((c) => h('div', null,
    h('div', { class: 'l' }, h('b', null, c.label), h('div', null, badge(STATE[c.state] || ['', 'b-info'])),
      c.note && !['미입력', '정확히 모름', '해당 없음'].includes(c.note) ? h('div', { class: 'tiny muted' }, c.note) : null),
    h('div', { class: 'r' }, c.state === 'missing' ? '모름' : isNum(c.monthly) ? fmtWon(c.monthly) : '-')))));
  out.push(h('p', { class: 'tiny muted' }, '주·년 단위로 입력한 금액은 한 달 기준(1년 ÷ 12, 1주 × 4.35)으로 바꿨어요.'));

  out.push(h('h3', null, '남는 금액'));
  if (p.kind === 'unavailable') out.push(h('p', null, evBadge('need'), ' ', p.reason));
  else {
    out.push(h('div', { class: 'card soft' },
      h('div', { class: 'small muted' }, p.label),
      h('div', { class: 'big-num' }, p.range ? `${fmtMan(p.low)} ~ ${fmtMan(p.high)}` : fmtMan(p.high), h('span', { class: 'small' }, ' / 월')),
      h('p', { class: 'small' }, evBadge('calc'), ' ', p.formula),
      p.missing.length ? h('p', { class: 'small' }, evBadge('need'), ` 빠진 비용: ${p.missing.join(', ')} → 실제 이익은 이보다 적어요.`) : null,
      p.range ? h('p', { class: 'small' }, evBadge('need'), ` ${p.uncertain.join(', ')}이(가) 매출에서 이미 빠진 금액인지 몰라 두 경우를 모두 계산했어요.`) : null,
      p.deducted.length ? h('p', { class: 'small' }, `${s.basis === 'mixed' ? '배달 매출이 입금액 기준이라' : '입금액 기준 매출이라'} ${p.deducted.join(', ')}은(는) 이미 빠져 있어 다시 빼지 않았어요.`) : null,
      h('p', { class: 'small' }, p.ownerPayMode === 'fixed'
        ? `사장님 급여(월 ${fmtMan(p.ownerPay)})를 빼면 ${fmtMan(p.afterOwnerHigh)}이 남아요.`
        : '사장님 본인 몫(대표자 인건비)은 빼지 않은 금액이에요. 이 금액이 곧 사장님 수입이에요.'),
      h('p', { class: 'tiny muted' }, '부가세·소득세 납부 전 금액이에요. 세금은 세무 대리인과 확인하세요.' + (isNum(calc.loan) && calc.loan > 0 ? ` 대출 상환(월 ${fmtMan(calc.loan)})은 이 계산에 넣지 않았어요. 실제로 손에 남는 돈은 그만큼 더 적어요.` : ''))));
  }

  if (!calc.ownerHourly && p.kind !== 'unavailable' && p.high <= 0) out.push(h('p', { class: 'small' }, evBadge('calc'), ' 남는 금액이 0원 이하로 계산돼 사장님 시간당 소득은 계산하지 않았어요.'));
  if (calc.ownerHourly) {
    const o = calc.ownerHourly;
    const v = Math.abs(o.high - o.low) < 1 ? fmtWon(o.high) : `${fmtWon(o.low)} ~ ${fmtWon(o.high)}`;
    out.push(h('h3', null, '사장님 시간당 소득'));
    out.push(h('p', null, evBadge('calc'), ' ', `${o.isUpperBound ? '최대 ' : ''}${v} = ${o.formula}`,
      h('br'), h('span', { class: 'small muted' }, `${o.minWageYear}년 최저임금 ${fmtWon(o.minWage)} (${o.minWageSource})`)));
  }

  if (calc.ratios.length) {
    out.push(h('h3', null, '주요 비율 (계산식 공개)'));
    out.push(h('div', { class: 'rowlist' }, calc.ratios.map((r) => h('div', null,
      h('div', { class: 'l' }, h('b', null, r.label), h('div', { class: 'small' }, evBadge('calc'), ' ', r.formula),
        isNum(r.bench) ? h('div', { class: 'small' }, evBadge('doc'), ` 참고 평균 ${fmtPct(r.bench)} (${r.benchLabel})${isNum(r.gap) ? ` · 차이 ${r.gap >= 0 ? '+' : ''}${(r.gap * 100).toFixed(1)}%p` : ''}`) : null,
        r.note ? h('div', { class: 'tiny muted' }, r.note) : null),
      h('div', { class: 'r big' }, fmtPct(r.value))))));
    out.push(h('p', { class: 'tiny muted' }, `참고 평균 출처: ${SURVEY.name}, ${SURVEY.org}, ${SURVEY.basis}. 평균은 목표치가 아니에요.`));
  }

  if (calc.bep) {
    const b = calc.bep;
    out.push(h('h3', null, '손익분기 매출'));
    out.push(h('p', null, evBadge('calc'), ` 고정비 ${fmtMan(b.fixed)}을 내려면 월매출 약 ${fmtMan(b.sales)}${b.isLowerBound ? ' 이상' : ''}이 필요해요 (변동비율 ${fmtPct(b.varRate)}).`,
      isNum(b.dailyOrders) ? ` 영업일 기준 하루 약 ${Math.ceil(b.dailyOrders)}건.` : ''));
    if (isNum(b.salesWithOwner)) out.push(h('p', { class: 'small' }, `사장님이 최저임금 수준(월 ${fmtMan(b.ownerTarget)})이라도 가져가려면 월매출 약 ${fmtMan(b.salesWithOwner)}${b.isLowerBound ? ' 이상' : ''}이 필요해요${isNum(b.dailyOrdersWithOwner) ? ` (하루 약 ${Math.ceil(b.dailyOrdersWithOwner)}건)` : ''}.`));
    if (b.isLowerBound) out.push(h('p', { class: 'tiny muted' }, `빠진 비용(${b.missing.join(', ')})이 있어 실제 손익분기 매출은 이보다 높아요.`));
    out.push(h('p', { class: 'tiny muted' }, b.formula));
  }

  if (calc.deliveryUnit) {
    const u = calc.deliveryUnit;
    out.push(h('h3', null, '배달 1건을 팔면 남는 돈'));
    out.push(h('div', { class: 'waterfall card' },
      h('div', null, h('span', null, '배달 1건 결제금액'), h('b', null, fmtWon(u.ticket))),
      u.comps.map((c) => h('div', null, h('span', null, `− ${c.label}`), h('span', null, isNum(c.v) ? fmtWon(c.v) : '모름'))),
      h('div', { class: 'total' }, h('span', null, '고정비(인건비·월세) 내기 전 남는 돈'), h('span', null, `${u.isUpperBound ? '최대 ' : ''}${fmtWon(u.left)} (${fmtPct(u.rate, 0)})`))));
    out.push(h('p', { class: 'tiny muted' }, `${u.formula}. 1건 단위 비교는 입금액 기준 여부와 관계없이 각 비용을 따로 계산해요.`));
  }
  if (calc.seatUse) out.push(h('p', { class: 'small muted' }, `참고: 매장 주문은 하루 약 ${Math.round(calc.seatUse.dailyHallOrders)}건, 좌석 1개당 약 ${calc.seatUse.perSeat.toFixed(1)}건이에요. ${calc.seatUse.note}`));
  return out;
}

function menuSection(menu) {
  const out = [];
  if (!menu.items.length) return [h('p', null, evBadge('need'), ' 메뉴별 가격·판매량 정보가 없어 메뉴 진단을 하지 못했어요.')];
  if (isNum(menu.theoreticalRate)) out.push(h('p', null, evBadge('calc'), ` 메뉴 원가 기준 원가율 ${fmtPct(menu.theoreticalRate)} (원가를 아는 메뉴가 판매량의 ${fmtPct(menu.coverageQty, 0)})${isNum(menu.purchaseRate) ? ` · 실제 식재료 구매 비율 ${fmtPct(menu.purchaseRate)}` : ''}${isNum(menu.gap) ? ` · 차이 ${fmtPct(menu.gap)}p` : ''}`));
  if (isNum(menu.topShare)) out.push(h('p', { class: 'small' }, `판매량 상위 20% 메뉴가 입력한 메뉴 판매량의 ${fmtPct(menu.topShare, 0)}를 차지해요.`));
  for (const g of ['core', 'promote', 'improve', 'price_review', 'merge', 'trial_stop', 'info', 'keep']) {
    const items = menu.groups[g];
    if (!items || !items.length) continue;
    out.push(h('h4', null, MENU_GROUPS[g]));
    out.push(h('ul', null, items.map((i) => h('li', null, h('b', null, i.name), ` · ${fmtWon(i.price)} · 월 ${fmtNum(i.qty, '개')}${isNum(i.marginRate) ? ` · 남는 비율 ${fmtPct(i.marginRate, 0)}` : ' · 원가 모름'}`,
      i.notes.length ? h('div', { class: 'tiny muted' }, i.notes.join(' / ')) : null))));
  }
  out.push(h('p', { class: 'tiny muted' }, '판매량이 적다는 이유만으로 바로 없애라고 하지 않아요. 대표·유입·세트 역할이 있는 메뉴는 판매 중단 후보에서 빼요.'));
  return out;
}

function purchaseSection(pur) {
  if (!pur.rows.length) return [h('p', null, evBadge('need'), ' 주요 식재료 구매 정보(브랜드·규격·단가)가 없어 매입가를 비교하지 못했어요.')];
  const out = [];
  for (const r of pur.rows) {
    out.push(h('div', { class: 'filebox' },
      h('b', null, r.item.name), ` · ${r.spec}${r.item.brand ? ` · ${r.item.brand}` : ''}${r.item.grade ? ` · ${r.item.grade}` : ''}`,
      r.mine ? h('div', { class: 'small' }, `지금 구매 단가: ${fmtWon(r.mine.perBase)} (${r.mine.dim === 'mass' ? '1kg' : r.mine.dim === 'volume' ? '1L' : '1개'}당, 배송비·부가세 반영${r.mine.flags.length ? ', 일부 조건 미확인' : ''})`) : h('div', { class: 'small' }, evBadge('need'), ' 규격이나 가격이 없어 단위 가격을 계산하지 못했어요.'),
      r.comparisons.length ? r.comparisons.map((x) => h('div', { class: 'small', style: { marginTop: '8px' } },
        badge(LEVEL[x.level]), ' ', `${SOURCE_LABEL[x.quote.sourceType] || '견적'} "${x.quote.sourceName || ''}" (${x.quote.observedAt || '날짜 없음'} 확인${x.quote.sample ? ', 가상 예시' : ''})`,
        x.theirs ? h('div', null, `${x.dimLabel} ${fmtWon(x.theirs.perBase)}${isNum(x.diffPct) ? ` · 지금 구매가가 ${x.diffPct > 0 ? `${fmtPct(x.diffPct, 0)} 높음` : `${fmtPct(-x.diffPct, 0)} 낮음`}` : ''}`) : null,
        x.reasons.length ? h('div', { class: 'tiny muted' }, x.reasons.join(' · ')) : null,
        x.conditions && x.conditions.length ? h('div', { class: 'tiny muted' }, `조건: ${x.conditions.join(' · ')}`) : null,
        isNum(x.monthlySaving) ? h('div', null, evBadge('calc'), ` 예상 절감액 월 약 ${fmtWon(x.monthlySaving)} (지금 구매량 기준, 견적이 유지될 때)`) : null))
        : h('div', { class: 'tiny muted' }, '비교할 견적·시세가 아직 없어요.')));
  }
  out.push(h('p', { class: 'tiny muted' }, '다른 가게들의 실제 구매가는 알 수 없어서 "다른 사장님보다 비싸다"고 판단하지 않아요. 확인한 견적·시세와 같은 조건일 때만 절감액을 계산해요.'));
  return out;
}

function externalSection(ext, data) {
  const out = [h('p', null, evBadge('need'), ' ', ext.statusText)];
  if (ext.hasSample) out.push(h('p', { class: 'small' }, h('span', { class: 'badge b-warn' }, '가상 예시 데이터'), ' 아래 공개 정보 일부는 예시용으로 만든 가상 데이터예요.'));
  if (ext.used.length) {
    out.push(h('h4', null, '대조에 사용한 공개 정보'));
    out.push(h('ul', null, ext.used.map((e) => h('li', { class: 'small' }, evBadge('doc'), ` ${SOURCE_LABEL[e.source] || e.source} · ${e.observedAt || '날짜 없음'} 확인 · ${e.kind === 'review' ? (e.field === 'praise' ? '리뷰 칭찬' : '리뷰 불편') : e.field}: ${e.menuName ? `${e.menuName} ${fmtWon(+e.price)}` : e.value}${e.count ? ` (${e.count}건)` : ''}`))));
  }
  if (ext.confirmed.length) {
    out.push(h('h4', null, '답변과 다른 공개 정보 (사장님 재확인 완료)'));
    out.push(h('ul', null, ext.confirmed.map((c) => h('li', { class: 'small' }, c.title))));
  }
  if (ext.pending.length) {
    out.push(h('h4', null, '재확인을 기다리는 차이'));
    out.push(h('ul', null, ext.pending.map((c) => h('li', { class: 'small' }, c.title))));
  }
  if (ext.excluded.length) {
    out.push(h('h4', null, '분석에서 뺀 정보'));
    out.push(h('ul', null, ext.excluded.map((e) => h('li', { class: 'small' }, `${SOURCE_LABEL[e.source] || e.source} (${e.observedAt || '날짜 없음'}): 가게명·주소가 모두 일치하는지 확인되지 않아 같은 이름의 다른 가게일 수 있어요.`))));
  }
  if (ext.unchecked.length) {
    out.push(h('h4', null, '확인하지 못한 공개 페이지'));
    out.push(h('ul', null, ext.unchecked.map((u) => h('li', { class: 'small' }, `${u.label}: 자동 검색이 연결되지 않아 열어보지 못했어요. 메뉴·영업시간 화면 캡처를 올려주면 대조할 수 있어요.`))));
  }
  if (ext.competitors.length) {
    out.push(h('h4', null, '주변 가게 가격 비교'));
    out.push(h('div', { class: 'rowlist' }, ext.competitors.map((x) => h('div', null,
      h('div', { class: 'l' }, h('b', null, `${x.name}${x.distance ? ` (${x.distance}m)` : ''}`),
        h('div', { class: 'small' }, `${x.menu || ''} ${fmtWon(x.theirPrice)} · ${x.portion || '양·구성 미기재'}`),
        h('div', { class: 'small' }, `우리: ${x.myPrice ? `${x.myMenu} ${fmtWon(x.myPrice)} · ${x.myPortion || '양·구성 미기재'}` : '비교할 메뉴 가격 없음'}`),
        h('div', { class: 'tiny muted' }, `${SOURCE_LABEL[x.source] || x.source || '확인 방법 미기재'} ${x.date || '날짜 없음'}${x.reason ? ` · ${x.reason}` : ''}`)),
      h('div', { class: 'r' }, badge(LEVEL[x.level]))))));
    out.push(h('p', { class: 'tiny muted' }, '주변 가게의 매출·원가는 공개되지 않은 정보라 추정하지 않아요.'));
  }
  const rv = ext.reviews;
  if (rv.praise.length || rv.complaint.length) {
    out.push(h('h4', null, '공개 리뷰에서 반복된 내용'));
    out.push(h('ul', null, [...rv.praise, ...rv.complaint].map((e) => h('li', { class: 'small' }, `${e.field === 'praise' ? '칭찬' : '불편'}: ${e.value}${e.count ? ` ${e.count}건` : ''} (${SOURCE_LABEL[e.source] || e.source}, ${e.observedAt || ''})`))));
  }
  return out;
}

export function renderReport(report, data, opts = {}) {
  const root = h('div', null);
  const calc = report.calc;
  if (opts.sample) root.append(h('div', { class: 'card warn' }, h('b', null, '가상의 가게로 만든 예시 보고서예요. '), '실제 가게 정보가 아니며, 화면 구성과 판단 방식을 보여주기 위한 것이에요.'));
  root.append(h('div', { class: 'card note small' }, report.modeText));
  if (opts.stale) root.append(h('div', { class: 'card warn' }, '보고서를 만든 뒤 답변이 바뀌었어요. ', opts.onReanalyze ? h('button', { class: 'btn small primary', onclick: opts.onReanalyze }, '최신 답변으로 다시 분석') : null));
  if (opts.changes && opts.changes.length) root.append(h('div', { class: 'card soft' }, h('h3', null, '이전 보고서와 달라진 점'), h('ul', null, opts.changes.map((c) => h('li', null, c)))));

  const st = report.store;
  const split = st.split ? `매장 ${st.split.hall || 0}% · 포장 ${st.split.takeout || 0}% · 배달 ${st.split.delivery || 0}%` : '판매 비중 미입력';
  root.append(h('div', { class: 'card' },
    h('div', { class: 'tiny muted' }, `보고서 생성 ${new Date(report.generatedAt).toLocaleString('ko-KR')} · ${report.engine}`),
    h('h1', null, st.name),
    h('p', { class: 'muted' }, `${st.bizLabel}${st.sub ? ` · ${st.sub}` : ''} · ${split}${st.open && st.open !== '미답변' ? ` · 영업 ${st.open}` : ''}`),
    st.concerns.length ? h('p', null, h('b', null, '고민: '), st.concerns.join(' / ')) : null,
    st.main ? h('p', { class: 'small' }, `"${st.main}"`) : null,
    h('p', { class: 'small muted' }, `예산 ${st.constraints.budgetLabel} · 시간 ${st.constraints.timeLabel} · 답변 ${report.completeness.done}/${report.completeness.total}`)));

  if (report.openChecks && report.openChecks.length && !opts.sample) root.append(h('div', { class: 'card warn' }, h('h3', null, `먼저 확인해 주세요 (${report.openChecks.length})`),
    h('p', { class: 'small' }, '서로 맞지 않거나 흔하지 않은 값이 있어요. 확인하기 전까지 관련 계산은 참고만 하세요.'),
    h('ul', null, report.openChecks.map((q) => h('li', null, opts.caseId ? h('a', { href: `#/c/${opts.caseId}/interview/${q.id}` }, q.label) : q.label)))));
  if (report.keyFindings.length) root.append(h('div', { class: 'card dark' }, h('h2', null, '핵심 진단'), h('ul', null, report.keyFindings.map((k) => h('li', null, k)))));

  // 우선 해결 3가지
  const tops = report.top.map((id) => report.solutions.find((s) => s.id === id)).filter(Boolean);
  root.append(h('h2', null, '우선 해결할 문제'));
  if (!tops.length) root.append(h('p', { class: 'card' }, '입력된 정보로는 우선 과제를 정하기 어려워요. 인터뷰를 더 진행해 주세요.'));
  for (const s of tops) {
    const first = s.steps.find((x) => x.when === 'week') || s.steps[0];
    root.append(h('div', { class: 'card' },
      h('div', { class: 'sol-title' }, h('span', { class: 'rank' }, s.rank), h('span', null, s.title)),
      h('div', null, badge(GOAL[s.goal]), s.effect.filter((e) => e !== GOAL[s.goal][0]).map((e) => h('span', { class: 'badge b-info' }, e)), badge(TAG[s.tag] || TAG.hypo), s.usedAlt ? h('span', { class: 'badge b-warn' }, '예산·시간 맞춤 대안') : null),
      first ? h('p', { style: { marginTop: '8px' } }, h('b', null, first.when === 'week' ? '이번 주 첫 행동: ' : '첫 행동: '), first.text) : null,
      h('details', { class: 'more top-detail' }, h('summary', null, '근거·비용·효과 확인 방법 자세히'), solutionBody(s)),
      h('p', { class: 'print-only tiny muted' }, '자세한 근거·비용·효과 확인 방법은 뒤쪽 "영역별 진단"에 있어요.')));
  }

  // 실행 계획
  const done = (data && data.settings && data.settings.planDone) || {};
  const planItem = (it) => h('label', { class: 'plan-item' },
    h('input', { type: 'checkbox', checked: !!done[it.text], disabled: !opts.onTogglePlan, onchange: (e) => opts.onTogglePlan && opts.onTogglePlan(it.text, e.target.checked) }),
    h('span', null, it.text, h('div', { class: 'src' }, `${it.solutionTitle}${it.hours ? ` · 약 ${it.hours}시간` : ''}${it.moved ? ' · 이번 주 시간이 넘쳐 다음 주로' : ''}`)));
  root.append(sec('실행 계획', [
    h('h3', null, `이번 주 (약 ${Math.round(report.plan.weekHours * 10) / 10}시간)`), report.plan.week.map(planItem),
    report.plan.month.length ? [h('h3', { style: { marginTop: '14px' } }, '2~4주 안에'), report.plan.month.map(planItem)] : null,
    report.plan.quarter.length ? [h('h3', { style: { marginTop: '14px' } }, '1~3개월 안에'), report.plan.quarter.map(planItem)] : null,
  ], true));

  root.append(sec('잘하고 있는 점', report.strengths.length
    ? h('ul', { class: 'evlist' }, report.strengths.map((s) => h('li', null, evBadge(s.ev.t), ' ', s.text, h('div', { class: 'tiny muted' }, s.ev.text))))
    : h('p', null, '입력된 정보로는 강점을 판단하기 어려워요. 손님이 자주 칭찬하는 점을 알려주시면 반영할게요. (정보가 없다고 나쁘게 평가하지 않아요)')));

  root.append(sec('매출·비용 분석', numbersSection(calc)));
  root.append(sec('메뉴 진단', menuSection(calc.menu)));
  root.append(sec('매입가 비교', purchaseSection(calc.purchase)));

  const byArea = {};
  for (const s of report.solutions) (byArea[s.area] = byArea[s.area] || []).push(s);
  root.append(sec(`영역별 진단 (해결책 ${report.solutions.length}개)`, AREAS.filter((a) => byArea[a.id]).map((a) => [
    h('h3', { style: { marginTop: '12px' } }, a.name), byArea[a.id].map((s) => solutionCard(s, { collapsed: true })),
  ])));

  root.append(sec('외부 조사 결과', externalSection(report.external, data)));

  root.append(sec('효과 확인 방법', [
    h('div', { class: 'rowlist' }, report.measurement.map((m) => h('div', null,
      h('div', { class: 'l' }, h('b', null, m.title), h('div', { class: 'small' }, `기록: ${m.metric}`), h('div', { class: 'tiny muted' }, `방법: ${m.how}${m.baseline ? ` · 지금 값: ${m.baseline}` : ''}`)),
      h('div', { class: 'r small' }, m.period)))),
    h('button', { class: 'btn small no-print', onclick: () => downloadMeasureCSV(report) }, '기록표 내려받기 (CSV)'),
  ]));

  root.append(sec('추가로 확보하면 좋은 자료', report.needMore.length ? h('ul', null, report.needMore.map((x) => h('li', null, x))) : h('p', null, '지금 단계에서 꼭 필요한 추가 자료는 없어요.')));

  root.append(sec('판단 기준과 근거 표시', [
    h('h4', null, '근거 표시의 뜻'),
    h('ul', { class: 'evlist' },
      h('li', null, evBadge('answer'), ' 사장님이 알려준 정보예요. 따로 검증하지 않았어요.'),
      h('li', null, evBadge('doc'), ' 첨부 파일·공개 페이지·공개 통계에서 확인한 내용이에요.'),
      h('li', null, evBadge('calc'), ' 입력값과 공개한 계산식으로 계산한 값이에요.'),
      h('li', null, evBadge('hypo'), ' 실행한 뒤 효과를 확인해야 하는 제안이에요.'),
      h('li', null, evBadge('need'), ' 정보가 부족해 판단을 미룬 부분이에요.')),
    h('h4', null, '이 보고서가 쓰는 기준'),
    h('ol', { class: 'small' }, report.criteria.map((c) => h('li', null, c))),
    h('p', { class: 'tiny muted' }, '사진 속 음식의 맛, 보이지 않는 위생 상태, 사진에 없는 공간은 확인했다고 보지 않아요. 근거 없는 "매출 30% 상승" 같은 예측 숫자는 만들지 않아요.'),
  ]));
  return root;
}

export function downloadMeasureCSV(report) {
  const rows = [['해결책', '기록할 것', '방법', '기간', '지금 값', '1주차', '2주차', '3주차', '4주차']];
  for (const m of report.measurement) rows.push([m.title, m.metric, m.how, m.period, m.baseline || '', '', '', '', '']);
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `효과확인_기록표_${report.store.name}.csv`);
}
