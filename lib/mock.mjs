// 로컬 개발·화면 점검용 모의 응답 (MOCK_AI=1). 운영 배포(VERCEL_ENV=production)에서는 쓰지 않는다.
import { normalizeStoreResult } from './validate.mjs';
import { normalizeReport, problemLabel, REPORT_VERSION } from './report.mjs';
import { normalizeResearch } from './research.mjs';
import { buildSolutions, LEVEL } from '../public/solutions.js';

export const mockEnabled = (env) => env.MOCK_AI === '1' && env.VERCEL_ENV !== 'production';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mockSearch({ name, address }, delayMs = 1200) {
  await wait(delayMs);
  if (/없는가게|notfound/i.test(name)) {
    return { ...normalizeStoreResult({ candidates: [], notFoundReason: '모의 응답: 검색 결과가 없다고 가정했어요.' }), mock: true, cached: false };
  }
  const base = {
    name,
    address,
    category: '분식',
    openedYear: '2019년 개업 (모의)',
    floor: '1층',
    phone: '02-000-0000',
    hours: '매일 11:00~21:00 (모의 데이터)',
    priceRange: '1인 8,000~12,000원',
    rating: '네이버 4.4 (모의)',
    reviewCount: '방문자 리뷰 320개 (모의)',
    services: { hall: true, takeout: true, delivery: true, reservation: false },
    menu: [{ name: '떡볶이', price: '5,000원' }, { name: '순대', price: '5,000원' }, { name: '김밥', price: '3,500원' }],
    strengths: ['떡볶이 양념이 맛있다는 후기가 많음', '포장 주문이 빠름'],
    weaknesses: ['점심시간 대기가 길다는 후기', '좌석이 좁다는 의견', '가격이 조금 비싸다는 의견'],
    reviewThemes: [{ theme: '맛', tone: 'good', note: '양념이 맛있다 (모의)' }, { theme: '대기', tone: 'bad', note: '점심 대기가 길다 (모의)' }, { theme: '가격', tone: 'mixed', note: '조금 비싸다는 의견 (모의)' }],
    features: ['배달·포장 가능', '주차 공간 없음'],
    channels: [{ type: '네이버 플레이스', url: 'https://map.naver.com/' }],
    matchLevel: 'high',
    matchReason: '모의 응답: 입력한 상호명과 주소를 그대로 사용했어요.',
  };
  const other = { ...base, name: `${name} 2호점`, address: `${address} 인근`, matchLevel: 'low', matchReason: '모의 응답: 이름이 비슷한 다른 지점 예시예요.' };
  const candidates = /지점|2곳/.test(name) ? [base, other] : [base];
  const out = normalizeStoreResult(
    { candidates, summary: '모의 응답이에요. 실제 인터넷 검색 결과가 아니에요.' },
    [{ type: 'url_citation', url_citation: { url: 'https://example.com/review', title: '모의 출처 (예시)' } }],
  );
  return { ...out, input: { name, address }, model: 'mock', mock: true, cached: false, searchedAt: new Date().toISOString() };
}

// 모의 보고서: 실제 AI 대신 규칙 솔루션과 서버 계산값으로 같은 형식을 만든다 (화면 점검용).
export async function mockReport(input, computed, delayMs = 1500, research = null) {
  await wait(delayMs);
  const sols = buildSolutions({ answers: input.answers }, input.store);
  const problem = problemLabel(input.answers) || '가장 큰 고민';
  const base = sols.length ? sols : [{
    stars: 1, area: '기본 점검', title: '이번 주 손님 반응을 기록해 보세요.', problem: '아직 바로 고칠 문제가 뚜렷하지 않아요.',
    evidence: ['모의 응답'], actions: ['하루 손님 수와 대기 시간을 적어요.', '자주 듣는 말을 적어요.', '일주일 뒤 다시 봐요.'],
    cost: '추가 비용 없음 · 일주일', metric: '일주일 기록이 남았는지 확인해요.',
  }];
  const raw = {
    oneLine: `(모의) ${input.store?.name || input.name}: "${problem}" 고민을 기준으로 정리한 예시 보고서예요.`,
    situation: /손님이 부족/.test(problem) ? '유입 부족' : /남는 게/.test(problem) ? '팔아도 남지 않음' : '고객 불편 반복',
    keyMetricLabels: computed.metrics.slice(0, 3).map((x) => x.label),
    topProblem: { title: base[0].problem, evidence: base[0].evidence.slice(0, 3).map((e) => `[답변] ${e}`) },
    firstAction: { title: base[0].title, how: base[0].actions.slice(0, 2).join(' ') },
    urgent: [],
    publicView: {
      summary: '(모의) 인터넷 조사 결과와 사장님 답변을 합쳐 손님이 보는 우리 가게를 정리하는 자리예요.',
      keep: ['(모의) 손님이 반복해서 칭찬하는 강점'],
      gaps: ['(모의) 사장님 답변과 후기가 다른 점'],
    },
    analysis: {
      profit: computed.metrics.length ? `(모의) 계산값 ${computed.metrics.length}개를 바탕으로 수익 구조를 정리하는 자리예요.` : '(모의) 매출·비용 자료가 없어 수익 구조는 기록부터 필요해요.',
      menu: '(모의) 대표 메뉴의 원가와 판매량을 함께 보는 자리예요.',
      customer: '(모의) 손님 경험과 반복되는 불편을 정리하는 자리예요.',
      connection: '(모의) 세 가지가 어떻게 이어지는지 정리하는 자리예요.',
    },
    solutions: base.slice(0, 6).map((s) => ({
      priority: LEVEL[s.stars], area: s.area, title: s.title, problem: s.problem,
      evidence: s.evidence.slice(0, 3).map((e) => `[답변] ${e}`), actions: s.actions.slice(0, 4),
      owner: '사장님', cost: s.cost || '', supplies: '', metric: s.metric,
    })),
    plan: {
      thisWeek: base.slice(0, 2).map((s) => s.title), nextWeeks: ['(모의) 바꾼 것의 효과를 기록해요.'], thisMonth: ['(모의) 한 달 기록을 보고 다음 개선을 정해요.'],
      marketing: '', budget: '(모의) 추가 비용이 없는 것부터 해요.', check: '(모의) 매주 같은 요일에 기록을 확인해요.',
    },
    needCheck: ['(모의) 실제 보고서는 AI가 답변과 공개 정보를 함께 분석해 만들어요.'],
  };
  return {
    v: REPORT_VERSION,
    report: normalizeReport(raw, computed.metrics),
    metrics: computed.metrics,
    cautions: computed.cautions,
    bench: computed.bench,
    research,
    pasted: !!input.pasted,
    store: { name: input.store?.name || input.name, address: input.store?.address || input.address },
    model: 'mock',
    truncated: false,
    createdAt: new Date().toISOString(),
    mock: true,
    cached: false,
  };
}

// 모의 인터넷 조사: 같은 형식의 예시 (화면 점검용, 실제 검색 아님)
export async function mockResearch({ name, address }, delayMs = 1500) {
  await wait(delayMs);
  return {
    ...normalizeResearch({
      period: '2025년 1월~2026년 10월 (모의)',
      reviewsChecked: 6,
      platforms: [
        { platform: '카카오맵', status: '확인 못 함', note: '(모의) 자동 수집이 막혀 있어 직접 읽지 않음' },
        { platform: '네이버 플레이스', status: '일부 확인', reviewCount: '방문자 리뷰 1,200개 (모의)', note: '(모의) 블로그 글에 인용된 숫자' },
        { platform: '네이버 블로그', status: '확인함', checked: '블로그 5편 (모의)', url: 'https://m.blog.naver.com/' },
        { platform: '구글 지도', status: '확인 못 함', note: '(모의) 검색 결과에 평점이 나오지 않음' },
        { platform: '다이닝코드', status: '확인함', rating: '4.1/5 (모의)', checked: '가게 정보 1곳' },
      ],
      themes: [
        { theme: '맛', tone: 'good', count: 5, repeated: true, summary: '(모의) 대표 메뉴 맛을 칭찬하는 글이 많아요.', examples: ['(블로그, 2026년 9월) 양념이 맛있다'] },
        { theme: '대기', tone: 'bad', count: 4, repeated: true, summary: '(모의) 점심 대기가 길다는 글이 반복돼요.', examples: ['(블로그, 2026년 8월) 점심 30분 대기'] },
        { theme: '가격', tone: 'mixed', count: 2, repeated: true, summary: '(모의) 조금 비싸지만 양이 넉넉하다는 의견이 엇갈려요.', examples: [] },
      ],
      menuPrices: [{ name: '대표 메뉴', price: '9,000원', source: '블로그 (모의)', date: '2026년 8월' }],
      infoIssues: ['(모의) 영업시간이 플랫폼마다 달라요.'],
      competitors: [{ name: '근처 같은 업종 가게 (모의)', category: '같은 업종', priceRange: '8,000~10,000원', note: '(모의) 걸어서 5분' }],
      area: '(모의) 직장인 점심 수요가 많은 상권이에요.',
      sponsored: '블로그 5편 중 1편 (모의)',
      limits: ['(모의) 카카오맵·네이버 플레이스·구글 지도 리뷰 본문은 자동 수집이 막혀 있어 직접 읽지 않았어요.'],
      sources: [{ title: '(모의) 블로그 후기', url: 'https://m.blog.naver.com/', platform: '네이버 블로그', date: '2026-09' }],
    }),
    input: { name, address },
    model: 'mock',
    engine: 'mock',
    searches: 0,
    toolCalls: 0,
    searchedAt: new Date().toISOString(),
    mock: true,
    cached: false,
  };
}
