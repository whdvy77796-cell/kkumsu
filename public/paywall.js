// 무료 핵심 진단과 유료 맞춤 실행 패키지를 나누는 규칙 (서버 api/report.js·api/pay.js 와 화면이 같이 쓴다)
//
// 무료 핵심 진단 (누구나 봄)
//   핵심 진단 · 가장 중요한 문제 · 지금 바로 할 일 · 위생·안전 · 인터넷에서 본 우리 가게 · 숫자로 본 우리 가게
//   · 우선 개선안 목록(제목·발견한 문제) · 1순위 개선안 전체 · 더 정확한 진단을 위해 확인할 것
// 유료 맞춤 실행 패키지 (결제 후)
//   나머지 개선안의 확인 근거·실행 방법·기대 효과·담당·비용과 기간·준비물·확인 지표
//   · 수익 구조·메뉴·고객 경험 연결 분석 · 실행 계획(이번 주·2~3주 차·한 달 안·마케팅·예산·성과 확인) · PDF 저장
//
// 잠긴 부분은 서버가 아예 보내지 않는다. 화면은 개수만 받아서 흐리게 처리한 자리표시(가짜 글자)를 그린다.

export const FREE_SOLUTIONS = 1; // 앞에서부터 이 개수만큼은 개선안을 전부 보여 준다

const count = (x) => (Array.isArray(x) ? x.length : 0);
const ANALYSIS_KEYS = ['profit', 'menu', 'customer', 'connection'];

export function redactReport(full) {
  if (!full || typeof full !== 'object' || !full.report || full.locked) return full;
  const r = full.report;
  const sols = Array.isArray(r.solutions) ? r.solutions : [];
  const plan = r.plan && typeof r.plan === 'object' ? r.plan : {};
  const a = r.analysis && typeof r.analysis === 'object' ? r.analysis : {};
  return {
    ...full,
    locked: true,
    report: {
      oneLine: r.oneLine,
      situation: r.situation,
      situationMessage: r.situationMessage,
      keyMetrics: r.keyMetrics,
      topProblem: r.topProblem,
      firstAction: r.firstAction,
      urgent: r.urgent,
      publicView: r.publicView,
      needCheck: r.needCheck,
      analysis: { locked: ANALYSIS_KEYS.filter((k) => a[k]) },
      solutions: sols.map((s, i) => (i < FREE_SOLUTIONS ? s : {
        stars: s.stars,
        area: s.area,
        title: s.title,
        problem: s.problem,
        web: (s.evidence || []).some((e) => /^\[공개 정보\]/.test(String(e))),
        locked: {
          evidence: count(s.evidence),
          actions: count(s.actions),
          effect: !!s.effect,
          meta: ['owner', 'cost', 'supplies', 'metric'].filter((k) => s[k]).length,
        },
      })),
      plan: {
        locked: {
          thisWeek: count(plan.thisWeek),
          nextWeeks: count(plan.nextWeeks),
          thisMonth: count(plan.thisMonth),
          marketing: !!plan.marketing,
          budget: !!plan.budget,
          check: !!plan.check,
        },
      },
    },
  };
}

// 결제하면 열리는 분량 (안내 문구용). 잠긴 보고서·전체 보고서 모두 계산할 수 있다.
export function packageSize(data) {
  const sols = data?.report?.solutions || [];
  const paidSols = sols.slice(FREE_SOLUTIONS);
  const steps = paidSols.reduce((t, s) => t + (s.locked ? s.locked.actions || 0 : count(s.actions)), 0);
  const p = data?.report?.plan || {};
  const pl = p.locked || { thisWeek: count(p.thisWeek), nextWeeks: count(p.nextWeeks), thisMonth: count(p.thisMonth) };
  return {
    solutions: paidSols.length,
    steps,
    planItems: (pl.thisWeek || 0) + (pl.nextWeeks || 0) + (pl.thisMonth || 0),
    analysis: data?.report?.analysis?.locked ? data.report.analysis.locked.length : ANALYSIS_KEYS.filter((k) => data?.report?.analysis?.[k]).length,
  };
}
