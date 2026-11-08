// 보고서에 쓰는 숫자는 AI가 아니라 여기서 계산한다 (운영 설계 문서 3·4·15장)
// kind: 답변(사장님이 적은 값) · 계산(답변으로 계산) · 추정(대략 답·빠진 항목·가정이 섞여 정확하지 않음)
import { buildCtx, parseNum, resolve, QMAP } from '../public/questions.js';

// 2026년 최저임금 (시간당). 사장님·가족 노동 가치를 따로 반영할 때 쓴다.
export const MIN_WAGE = { year: 2026, won: 10320 };

// 농림축산식품부 「2025 외식업체 경영실태 조사」 (2024년 실적, 매출 대비 비율 %). 참고용.
const BENCH_SOURCE = '농림축산식품부 2025 외식업체 경영실태 조사 (2024년 실적, 매출 대비, 참고용)';
const BENCH = {
  all: { name: '외식업 전체', food: 40.7, labor: 14.3, rent: 7.7, profit: 8.7 },
  general: { name: '일반음식점', food: 40.9, labor: 14.2, rent: 7.1, profit: 8.8 },
  korean: { name: '한식', food: 41.2, labor: 14.0, rent: 6.9, profit: 8.8 },
  cafe: { name: '비알코올 음료점업', food: 38.9, labor: 15.9, rent: 8.5, profit: 9.1 },
};
const KOREAN_CATS = ['한식', '국밥·탕·찌개', '고기·구이'];
const CAFE_CATS = ['카페', '베이커리·디저트'];

export function benchFor(category) {
  const b = CAFE_CATS.includes(category) ? BENCH.cafe : KOREAN_CATS.includes(category) ? BENCH.korean : category ? BENCH.general : BENCH.all;
  return { ...b, source: BENCH_SOURCE };
}

const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
export function manwon(n) {
  const m = n / 10000;
  if (Math.abs(m) < 1) return won(n);
  const r = Math.abs(m) >= 100 ? Math.round(m) : Math.round(m * 10) / 10;
  return `${r.toLocaleString('ko-KR')}만 원`;
}
const pct = (x) => `${(Math.round(x * 1000) / 10).toLocaleString('ko-KR')}%`;

export function computeMetrics(S, store) {
  const A = S.answers || {};
  const val = (id) => (A[id] && (A[id].s === 'ok' || A[id].s === 'approx') ? A[id].v : undefined);
  const isApprox = (id) => A[id]?.s === 'approx';
  const c = buildCtx(S, store);
  const metrics = [];
  const cautions = [];
  const add = (label, value, kind, note) => metrics.push({ label, value, kind, note: note || null });
  const known = c.costKnow === 'exact' || c.costKnow === 'approx';

  // ── 매출
  const rows = (val('b_sales') || []).map((r) => ({ sales: parseNum(r?.sales), days: parseNum(r?.days) }));
  const last = rows[0];
  let salesWon = null;
  let days = null;
  if (known && last && last.sales !== null && last.sales > 0) {
    salesWon = last.sales * 10000;
    days = last.days && last.days > 0 && last.days <= 31 ? last.days : null;
    add('지난달 매출', manwon(salesWon), isApprox('b_sales') ? '추정' : '답변', isApprox('b_sales') ? '사장님이 대략으로 답함' : null);
    if (days) add('영업일당 매출', manwon(salesWon / days), '계산', `지난달 매출 ÷ 영업일 ${days}일`);
    const prevIdx = [2, 1].find((i) => rows[i] && rows[i].sales !== null && rows[i].sales > 0);
    if (prevIdx) {
      const ch = (last.sales - rows[prevIdx].sales) / rows[prevIdx].sales;
      add(`${prevIdx === 2 ? '3달 전' : '2달 전'}보다 지난달 매출`, `${ch >= 0 ? '+' : ''}${pct(ch)}`, '계산', '월매출 비교 (영업일 수 차이도 함께 봐야 해요)');
    }
  }

  // ── 비용과 이익 (문서 3장: 추정 영업이익 · 사장님 노동비 반영 이익 · 현금 흐름 구분)
  const costs = val('b_costs') || {};
  const costItems = known ? resolve(QMAP.b_costs.items, c) : [];
  let costSum = 0;
  let costN = 0;
  const missing = [];
  for (const it of costItems) {
    const n = parseNum(costs[it.key]);
    if (n === null) missing.push(it.label);
    else { costSum += n * 10000; costN++; }
  }
  const stock = (val('b_records') || {}).stock || null;
  const noStock = stock === '기록하지 않아요' || stock === '폐기량만 기록해요';
  if (costN) {
    add('지난달 비용 합계', manwon(costSum), missing.length || isApprox('b_costs') ? '추정' : '답변', missing.length ? `빠진 항목: ${missing.join(', ')}` : null);
  }
  let profit = null;
  if (salesWon !== null && costN) {
    profit = salesWon - costSum;
    const notes = [
      '매출 − 비용 합계',
      missing.length ? '빠진 비용 항목이 있어 실제보다 많게 나올 수 있어요' : null,
      noStock ? '재고 기록이 없어 식재료는 구매액 기준' : stock ? null : '재고 변동은 반영하지 못했어요',
    ].filter(Boolean);
    add('추정 영업이익', manwon(profit), '추정', notes.join(' · '));
    if (salesWon > 0) add('추정 영업이익률', pct(profit / salesWon), '추정', '추정 영업이익 ÷ 지난달 매출');
    for (const [key, label] of [['food', '매출 대비 식재료비'], ['labor', '매출 대비 직원 인건비'], ['rent', '매출 대비 임차료']]) {
      const n = parseNum(costs[key]);
      if (n !== null && salesWon > 0) add(label, pct((n * 10000) / salesWon), isApprox('b_costs') ? '추정' : '계산', null);
    }
  }

  const staffV = val('a_staff') || {};
  const ownerH = parseNum(staffV.owner);
  const famH = parseNum(staffV.family) || 0;
  if (ownerH && ownerH > 0 && ownerH <= 24) {
    const workDays = days || 26;
    const hours = (ownerH + Math.min(famH, 24)) * workDays;
    add('사장님·가족 한 달 일한 시간', `${Math.round(hours).toLocaleString('ko-KR')}시간`, days ? '계산' : '추정',
      `하루 ${ownerH + famH}시간 × ${workDays}일${days ? '' : ' (영업일을 몰라 26일로 가정)'}`);
    if (profit !== null) {
      const ownerPay = hours * MIN_WAGE.won;
      add('사장님·가족 노동비 (최저임금 기준)', manwon(ownerPay), '계산', `${Math.round(hours).toLocaleString('ko-KR')}시간 × ${MIN_WAGE.year}년 최저임금 ${won(MIN_WAGE.won)}`);
      add('사장님 노동비를 반영한 이익', manwon(profit - ownerPay), '추정', '추정 영업이익 − 사장님·가족 노동비');
      if (profit > 0) add('사장님·가족 1시간당 남는 돈', won(profit / hours), '추정', '추정 영업이익 ÷ 일한 시간');
      if (profit <= 0) cautions.push('추정 영업이익이 0원 이하예요. 빠진 매출이나 두 번 적은 비용이 없는지 먼저 확인이 필요해요.');
    }
  }

  // ── 배달 매출 기준 (수수료를 두 번 빼지 않게)
  const ch = val('b_channel_sales') || {};
  if (c.hasDelivery && /정산 입금액/.test(ch.basis || '') && parseNum(costs.fee) !== null) {
    cautions.push('배달 매출을 수수료 뺀 정산 입금액으로 적었는데, 비용에도 수수료를 적었어요. 배달앱 수수료가 비용에 들어 있다면 두 번 빠진 거라 이익이 실제보다 적게 나와요.');
  }
  const split = val('a_split') || {};
  const shares = ['hall', 'takeout', 'delivery'].filter((k) => split[k]?.on && parseNum(split[k].pct) !== null);
  if (shares.length >= 2) {
    const names = { hall: '홀', takeout: '포장', delivery: '배달' };
    add('판매 방식 비중', shares.map((k) => `${names[k]} ${parseNum(split[k].pct)}%`).join(' · '), isApprox('a_split') ? '추정' : '답변', null);
  }

  // ── 메뉴별 매출과 1개당 남는 금액 (고정비 빼기 전 = 공헌이익)
  const menus = (val('c_menus') || []).filter((r) => r && String(r.name || '').trim());
  menus.forEach((m) => {
    const price = parseNum(m.price);
    const qty = parseNum(m.qty);
    if (price && qty) {
      const rev = price * qty;
      add(`${m.name.trim()} 지난달 매출`, manwon(rev), isApprox('c_menus') ? '추정' : '계산',
        `${won(price)} × ${qty.toLocaleString('ko-KR')}개${salesWon ? ` · 전체 매출의 ${pct(rev / salesWon)}` : ''}`);
    }
  });
  const margin = (name, price, cost, kind, note) => {
    if (!price || cost === null || cost < 0) return;
    add(`${name} 재료비 비율`, pct(cost / price), kind, `재료비 ${won(cost)} ÷ 판매가 ${won(price)}${note ? ` ${note}` : ''}`);
    add(`${name} 1개 팔면 남는 금액`, won(price - cost), kind, '판매가 − 재료비 (임차료 같은 고정비 빼기 전)');
  };
  const mc = val('c_cost');
  const top = menus[0];
  if (top && mc && (mc.know === 'known' || mc.know === 'approx')) {
    const inc = (mc.includes || []).filter((x) => x !== '포함 안 됨');
    margin(top.name.trim(), parseNum(top.price), parseNum(mc.amount), mc.know === 'approx' ? '추정' : '계산',
      inc.length ? `(${inc.join('·')} 포함)` : '(반찬·소스·포장 포함 여부는 확인 필요)');
  }
  const more = val('c_cost_more') || {};
  menus.slice(1).forEach((m, i) => margin(m.name.trim(), parseNum(m.price), parseNum(more[`m${i + 2}`]), isApprox('c_cost_more') ? '추정' : '계산'));
  if (c.worry?.name) margin(`${String(c.worry.name).trim()} (걱정 메뉴)`, parseNum(c.worry.price), parseNum(more.worry), isApprox('c_cost_more') ? '추정' : '계산');

  // ── 배달 1건 (문서 15장)
  const mu = val('m_unit');
  if (mu && parseNum(mu.order)) {
    const order = parseNum(mu.order);
    const parts = ['food', 'pack', 'fee', 'rider', 'coupon'].map((k) => parseNum(mu[k]));
    if (parts.some((x) => x !== null)) {
      const sum = parts.reduce((s, x) => s + (x || 0), 0);
      const partial = parts.some((x) => x === null);
      add('배달 1건 남는 금액', won(order - sum), partial || isApprox('m_unit') ? '추정' : '계산',
        `평균 결제 ${won(order)} − 드는 비용 ${won(sum)}${partial ? ' (빠진 비용 항목 있음)' : ''} · 고정비 빼기 전`);
    }
  }

  // ── 마케팅 비용
  const es = val('e_spend');
  if (es) {
    const sum = Object.values(es).map(parseNum).filter((x) => x !== null).reduce((a, b) => a + b, 0);
    if (sum > 0) add('한 달 마케팅 비용', manwon(sum * 10000), isApprox('e_spend') ? '추정' : '답변', salesWon ? `지난달 매출의 ${pct((sum * 10000) / salesWon)}` : null);
  }

  if (c.costKnow === 'unknown') cautions.push('사장님이 지난달 매출·비용·남은 돈을 잘 모른다고 답해서 이익은 계산하지 않았어요.');
  if (profit !== null) cautions.push('대출 원금 상환·설비 구입 같은 실제 입출금은 묻지 않아 현금 흐름은 계산하지 않았어요.');
  return { metrics: metrics.slice(0, 20), cautions, bench: benchFor(c.category) };
}
