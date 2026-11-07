// 인터뷰 엔진: 가게 정보와 답변에 따라 보여줄 질문, 순서, 재확인 질문을 계산
import { QUESTIONS, QMAP, AREAS, CONCERNS, WEEKDAYS, TIME_SLOTS } from './questions.js';
import { isNum, fmtMan, fmtWon, fmtPct, fmtNum, WEEKS_PER_MONTH } from './format.js';
import { RULES } from './benchmarks.js';
import { publicInfoChecks } from './external.js';

export const STATUS_LABEL = {
  exact: '', approx: '대략', unknown: '정확히 모름', na: '해당 없음', later: '나중에 답하기',
};

export function hasValue(v) {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.values(v).some((x) => hasValue(x));
  return true;
}

// 실제로 답한 것(모름·해당 없음 포함). '나중에 답하기'는 미답변으로 본다.
export function isAnswered(a) {
  if (!a) return false;
  if (a.s === 'unknown' || a.s === 'na') return true;
  if (a.s === 'later') return false;
  return hasValue(a.v);
}

// 인터뷰 진행상 넘어간 것(나중에 답하기 포함)
export function isResolved(a) {
  return !!a && (a.s === 'later' || isAnswered(a));
}

export const PERIOD_FACTOR = { month: 1, week: WEEKS_PER_MONTH, year: 1 / 12 };

export function makeCtx(data) {
  const A = data?.answers || {};
  const P = data?.profile || {};
  const concerns = new Set(P.concerns || []);
  const st = (id) => A[id]?.s;
  const val = (id) => {
    const a = A[id];
    if (!a) return undefined;
    if (a.s === 'unknown' || a.s === 'na' || a.s === 'later') return undefined;
    return a.v;
  };
  const known = (id) => hasValue(val(id));
  const num = (id) => {
    const v = val(id);
    if (isNum(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) return +v;
    return null;
  };
  const monthly = (id) => {
    const n = num(id);
    if (n === null) return null;
    return n * (PERIOD_FACTOR[A[id]?.p || 'month'] ?? 1);
  };
  const share = (k) => {
    const s = val('b_split');
    if (!s || typeof s !== 'object') return null;
    const t = (+s.hall || 0) + (+s.takeout || 0) + (+s.delivery || 0);
    if (!t) return null;
    return (+s[k] || 0) / t;
  };
  const ctx = {
    biz: P.biz,
    sub: P.sub,
    profile: P,
    data,
    concerns,
    concern: (c) => concerns.has(c),
    status: st,
    v: val,
    known,
    num,
    monthly,
    answered: (id) => isAnswered(A[id]),
    has: (id, opt) => {
      const v = val(id);
      return Array.isArray(v) ? v.includes(opt) : v === opt;
    },
    share,
    staffCount: () => num('b_staff'),
    deliveryish: () => {
      const d = share('delivery');
      if (d !== null) return d >= 0.1;
      if (val('b_has_delivery') === 'yes') return true;
      if (val('b_has_delivery') === 'no') return false;
      return !!(P.channels && P.channels.deliveryApp);
    },
    packish: () => {
      const d = share('delivery');
      const t = share('takeout');
      if (d !== null) return d + t >= 0.2;
      return ctx.deliveryish();
    },
    hallish: () => {
      if (st('b_seats') === 'na') return false;
      const h = share('hall');
      if (h !== null) return h >= 0.2;
      return true;
    },
    adsSpend: () => (monthly('c_ads') || 0) + (monthly('d_ads') || 0),
  };
  return ctx;
}

export function resolveOptions(q, ctx) {
  return typeof q.options === 'function' ? q.options(ctx) : q.options || [];
}

const BASE_ORDER = ['basic', 'goal', 'sales', 'cost', 'delivery', 'hall', 'menu', 'purchase', 'staff', 'customer', 'marketing', 'price', 'env', 'clean'];

// 사장님이 고른 순서대로 관련 영역을 모은다
export function concernAreas(ctx) {
  const out = [];
  for (const id of ctx.profile?.concerns || []) {
    const c = CONCERNS.find((x) => x.id === id);
    if (c) for (const a of c.areas) if (!out.includes(a)) out.push(a);
  }
  return out;
}

// 고민과 관련된 영역을 먼저 묻는다. 기본 운영 형태·목표·매출은 항상 먼저.
export function areaOrder(ctx) {
  const first = ['basic', 'goal', 'sales'];
  const pri = concernAreas(ctx).filter((a) => !first.includes(a));
  const rest = BASE_ORDER.filter((a) => !first.includes(a) && !pri.includes(a));
  return [...first, ...pri, ...rest, 'check'];
}

export function isQuestionVisible(q, ctx) {
  if (q.when && !q.when(ctx)) return false;
  if (q.depth === 'deep') {
    const deepAll = !!ctx.data?.settings?.deepAll;
    if (!deepAll && !concernAreas(ctx).includes(q.area)) return false;
  }
  return true;
}

export function visibleQuestions(data) {
  const ctx = makeCtx(data);
  const order = areaOrder(ctx);
  const qs = QUESTIONS.filter((q) => isQuestionVisible(q, ctx));
  qs.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area));
  const checks = computeChecks(data).map((chk) => ({
    id: chk.id, area: 'check', type: 'check', depth: 'core', label: chk.title, text: chk.title,
    help: chk.message, related: chk.related, sig: chk.sig, kind: chk.kind,
    options: [{ v: 'confirm', label: chk.confirmLabel || '입력한 값이 맞아요' }, { v: 'fix', label: '다시 고칠게요' }],
    allow: ['later'],
  }));
  return [...qs, ...checks];
}

export function questionDone(data, q) {
  const a = data.answers?.[q.id];
  if (q.type === 'check') return !!a && a.v === 'confirm' && a.sig === q.sig;
  if (q.type === 'upload') {
    if (a && (a.s === 'na' || a.s === 'later')) return a.s === 'na' ? true : false;
    return (data.attachments || []).some((f) => f.kind === q.kind);
  }
  return isAnswered(a);
}

export function questionResolved(data, q) {
  const a = data.answers?.[q.id];
  if (q.type === 'check') return questionDone(data, q) || a?.s === 'later';
  if (q.type === 'upload') return questionDone(data, q) || a?.s === 'later';
  return isResolved(a);
}

export function nextQuestionId(data, currentId) {
  const qs = visibleQuestions(data);
  const idx = currentId ? qs.findIndex((q) => q.id === currentId) : -1;
  for (let i = idx + 1; i < qs.length; i++) if (!questionResolved(data, qs[i])) return qs[i].id;
  for (let i = 0; i <= idx && i < qs.length; i++) if (!questionResolved(data, qs[i])) return qs[i].id;
  return null;
}

export function prevQuestionId(data, currentId) {
  const qs = visibleQuestions(data);
  const idx = qs.findIndex((q) => q.id === currentId);
  if (idx > 0) return qs[idx - 1].id;
  return null;
}

export function progress(data) {
  const qs = visibleQuestions(data);
  const byArea = {};
  let done = 0;
  for (const q of qs) {
    const d = questionDone(data, q);
    if (d) done++;
    byArea[q.area] = byArea[q.area] || { total: 0, done: 0 };
    byArea[q.area].total++;
    if (d) byArea[q.area].done++;
  }
  return { total: qs.length, done, byArea };
}

// ───────── 재확인(모순·이상값) 질문
export function computeChecks(data) {
  const c = makeCtx(data);
  const out = [];
  const S = c.monthly('s_monthly');
  const orders = c.num('s_orders');
  const ticket = c.num('s_ticket');

  if (S && orders && ticket) {
    const implied = orders * ticket;
    const diff = Math.abs(implied - S) / S;
    if (diff > RULES.contradictionSales) {
      out.push({
        id: 'chk_sales_orders', kind: 'contradiction', related: ['s_monthly', 's_orders', 's_ticket'], sig: `${S}|${orders}|${ticket}`,
        title: '월매출과 주문 수·평균 결제금액이 서로 맞지 않아요',
        message: `월매출은 ${fmtMan(S)}인데, 주문 ${fmtNum(orders, '건')} × 평균 ${fmtWon(ticket)} = ${fmtMan(implied)}으로 계산돼요 (차이 ${fmtPct(diff, 0)}). 기간이나 기준이 다를 수 있어요. 값이 맞다면 그대로 두고, 아니면 고쳐주세요.`,
      });
    }
  }
  if (ticket && (ticket < 1000 || ticket > 300000)) {
    out.push({
      id: 'chk_ticket_range', kind: 'outlier', related: ['s_ticket'], sig: `${ticket}`,
      title: '평균 결제금액이 흔하지 않은 값이에요',
      message: `평균 결제금액이 ${fmtWon(ticket)}으로 입력됐어요. 원 단위가 맞는지 확인해 주세요.`,
    });
  }
  const dShare = c.share('delivery');
  const dOrders = c.num('d_orders');
  const dTicket = c.num('d_ticket');
  if (S && dShare !== null && dOrders && dTicket) {
    const implied = (dOrders * dTicket) / S;
    if (Math.abs(implied - dShare) > RULES.deliveryShareGap) {
      out.push({
        id: 'chk_delivery_share', kind: 'contradiction', related: ['b_split', 'd_orders', 'd_ticket'], sig: `${S}|${dShare}|${dOrders}|${dTicket}`,
        title: '배달 비중과 배달 주문 금액이 서로 맞지 않아요',
        message: `배달 비중을 ${fmtPct(dShare, 0)}로 답했는데, 배달 주문 ${fmtNum(dOrders, '건')} × ${fmtWon(dTicket)} = ${fmtMan(dOrders * dTicket)}는 월매출의 ${fmtPct(implied, 0)}예요.`,
      });
    }
  }
  const food = c.monthly('c_food');
  if (S && food) {
    const r = food / S;
    if (r > 0.7 || r < 0.1) {
      out.push({
        id: 'chk_food_ratio', kind: 'outlier', related: ['c_food', 's_monthly'], sig: `${S}|${food}`,
        title: '식재료 구매액이 매출에 비해 매우 크거나 작아요',
        message: `식재료 구매액이 월매출의 ${fmtPct(r, 0)}로 계산돼요. 기간(월·주·년)이나 금액 단위(만 원)를 확인해 주세요.`,
      });
    }
  }
  const labor = c.monthly('c_labor');
  const staff = c.staffCount();
  if (labor && staff) {
    const per = labor / staff;
    if (per < 200000 || per > 6000000) {
      out.push({
        id: 'chk_labor_staff', kind: 'outlier', related: ['c_labor', 'b_staff'], sig: `${labor}|${staff}`,
        title: '직원 1명당 인건비가 흔하지 않은 값이에요',
        message: `직원 ${staff}명에 월 인건비 ${fmtMan(labor)}면 1명당 ${fmtMan(per)}이에요. 단위나 인원 수를 확인해 주세요.`,
      });
    }
  }
  const menus = (c.v('m_list') || []).filter((m) => isNum(+m.qty) && +m.qty > 0);
  const totalQty = menus.reduce((a, m) => a + (+m.qty || 0), 0);
  if (orders && totalQty > orders * 6) {
    out.push({
      id: 'chk_menu_qty', kind: 'outlier', related: ['m_list', 's_orders'], sig: `${totalQty}|${orders}`,
      title: '메뉴 판매량 합계가 주문 수보다 지나치게 많아요',
      message: `메뉴별 한 달 판매량을 더하면 ${fmtNum(totalQty, '개')}인데, 한 달 주문은 ${fmtNum(orders, '건')}이에요. 주문 1건에 평균 ${fmtNum(totalQty / orders, '개')}를 산 셈이에요. 판매량이 일주일·하루 기준은 아닌지 확인해 주세요.`,
    });
  }
  const items = (c.v('p_items') || []).filter((it) => isNum(+it.price) && isNum(+it.qty) && +it.price > 0 && +it.qty > 0);
  const itemsSpend = items.reduce((a, it) => a + (+it.price) * (+it.qty), 0);
  if (food && itemsSpend > food * 1.3) {
    out.push({
      id: 'chk_purchase_total', kind: 'outlier', related: ['p_items', 'c_food'], sig: `${itemsSpend}|${food}`,
      title: '주요 식재료 구매액이 전체 식재료비보다 커요',
      message: `주요 식재료의 단가 × 수량 합계가 ${fmtMan(itemsSpend)}인데, 전체 식재료 구매액은 ${fmtMan(food)}이에요. 수량(예: 30과 300)이나 단가를 다시 확인해 주세요.`,
    });
  }
  for (const pc of publicInfoChecks(data)) out.push(pc);
  return out;
}

// ───────── 답변을 사람이 읽는 문장으로
export function answerText(q, a, ctx) {
  if (!q) return '';
  if (!a) return '미답변';
  if (a.s === 'unknown' || a.s === 'na' || a.s === 'later') return STATUS_LABEL[a.s];
  const v = a.v;
  const tag = a.s === 'approx' ? ' (대략)' : '';
  const per = a.p && a.p !== 'month' ? (a.p === 'week' ? ' / 주' : ' / 년') : '';
  switch (q.type) {
    case 'money': return `${q.inputUnit === 'man' ? fmtMan(+v) : fmtWon(+v)}${per}${tag}`;
    case 'number': return `${fmtNum(+v)}${q.unit ? ' ' + q.unit : ''}${tag}`;
    case 'percent': return `${fmtNum(+v)}%${tag}`;
    case 'choice': {
      const o = resolveOptions(q, ctx).find((x) => String(x.v) === String(v));
      return o ? o.label : String(v);
    }
    case 'multi': {
      const opts = resolveOptions(q, ctx);
      return (v || []).map((x) => opts.find((o) => o.v === x)?.label || x).join(', ');
    }
    case 'month': return v ? `${String(v).slice(0, 4)}년 ${+String(v).slice(5, 7)}월` : '미답변';
    case 'split': return `매장 ${v.hall || 0}% · 포장 ${v.takeout || 0}% · 배달 ${v.delivery || 0}%${tag}`;
    case 'hours': {
      const closed = (v.closed || []).length ? `휴무 ${v.closed.join('·')}` : '휴무 없음';
      return `${v.open || '?'}~${v.close || '?'}${v.breakTime ? `, 쉬는 시간 ${v.breakTime}` : ''}, ${closed}`;
    }
    case 'slots': {
      const d = (v.days || []).join('·');
      const t = (v.times || []).map((x) => TIME_SLOTS.find((s) => s.v === x)?.label.split(' ')[0] || x).join('·');
      return [d, t].filter(Boolean).join(' / ') || '미답변';
    }
    case 'list': return `${(v || []).length}개 항목`;
    case 'check': return v === 'confirm' ? '값 확인함' : '수정 예정';
    default: return String(v);
  }
}

export function openDaysPerMonth(ctx) {
  const h = ctx.v('b_hours');
  if (!h || !Array.isArray(h.closed)) return null;
  const closed = h.closed.filter((d) => WEEKDAYS.includes(d)).length;
  return (7 - closed) * WEEKS_PER_MONTH;
}

export { QUESTIONS, QMAP, AREAS };

// 보고서가 최신 입력으로 만들어졌는지 확인하는 서명 (실행 계획 체크 등 설정 변경은 제외)
export function inputSignature(data) {
  const s = JSON.stringify({
    p: data?.profile || {}, a: data?.answers || {}, e: data?.external || {}, d: !!data?.settings?.deepAll,
    f: (data?.attachments || []).map((x) => [x.id, x.kind, !!x.confirmed]),
  });
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0; }
  return `${s.length}-${h1.toString(16)}`;
}