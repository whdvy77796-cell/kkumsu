// 공개 참고 통계 (출처·기준 시점을 함께 보관하고, 목표치가 아니라 '참고'로만 사용)

export const SURVEY = {
  name: '2025 외식업체 경영실태 조사 보고서',
  org: '농림축산식품부·한국농촌경제연구원',
  basis: '2024년 1~12월 사업실적, 전국 3,138개 외식업체 표본 가중 평균',
  table: '표 3-16-1 업종 중분류별 사업실적 (보고서 321쪽)',
  url: 'https://mafra.go.kr/bbs/home/798/595246/download.do',
  checkedAt: '2026-11-08',
  note: '이 조사의 영업이익은 대표자 인건비(매출의 약 13%)와 가족 종사자 인건비를 비용으로 뺀 값입니다. 사장님 몫을 빼지 않은 금액과 바로 비교하면 안 됩니다.',
};

// 매출액 대비 비율
export const BENCH = {
  all: { label: '전체 외식업체', food: 0.407, labor: 0.143, rent: 0.077, op: 0.087, owner: 0.133, family: 0.033 },
  restaurant: { label: '일반음식점', food: 0.409, labor: 0.142, rent: 0.071, op: 0.088, owner: 0.132, family: 0.037 },
  hansik: { label: '한식 음식점', food: 0.412, labor: 0.140, rent: 0.069, op: 0.088, owner: 0.135, family: 0.036 },
  cafe: { label: '비알코올 음료점업(카페 등)', food: 0.389, labor: 0.159, rent: 0.085, op: 0.091, owner: 0.133, family: 0.026 },
};

export function benchFor(biz, sub) {
  if (biz === 'cafe') return BENCH.cafe;
  if (sub === '한식') return BENCH.hansik;
  if (biz === 'restaurant') return BENCH.restaurant;
  return BENCH.all;
}

export const MIN_WAGE = {
  2026: { hourly: 10320, source: '최저임금위원회 2026년 적용 최저임금 (2025-08-05 고시)', url: 'https://www.minimumwage.go.kr/minWage/policy/decisionMain.do' },
  2027: { hourly: 10700, source: '고용노동부 고시 제2026-60호 (2027년 적용)', url: 'https://www.minimumwage.go.kr/minWage/policy/decisionMain.do' },
};

export function minWageFor(year) {
  return MIN_WAGE[year] || MIN_WAGE[2026];
}

// 서비스 내부 판단 기준 (보고서에 그대로 공개)
export const RULES = {
  foodGapPctPoint: 0.05, // 통계 평균보다 5%p 이상 높으면 점검 대상
  laborGapPctPoint: 0.05,
  recipeGapPctPoint: 0.05, // 메뉴 원가 기준 원가율과 실제 구매 비율 차이
  contradictionSales: 0.25, // 월매출과 주문수×객단가 차이 25% 이상이면 재확인
  deliveryShareGap: 0.2,
  quoteStaleDays: 30,
  lowSalesRatio: 0.5, // 판매량이 메뉴 중앙값의 50% 미만이면 '판매 적음'
  highSalesRatio: 1.5,
};
