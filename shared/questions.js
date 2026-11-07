// 질문 은행: 공통 질문 + 업종·답변에 따라 나타나는 추가 질문
// when(ctx): 질문을 보여줄 조건. depth: 'core'(항상) | 'deep'(관련 고민이 있거나 '자세히 답하기'를 켰을 때)

export const CONCERNS = [
  { id: 'sales_down', label: '매출이 낮거나 줄었는데 원인을 모르겠어요', areas: ['sales', 'customer', 'marketing', 'price', 'env'] },
  { id: 'profit_unknown', label: '매출은 나는데 실제로 얼마 남는지 모르겠어요', areas: ['cost', 'sales', 'delivery', 'staff'] },
  { id: 'menu_complex', label: '메뉴가 많아 복잡하고 재료가 자주 남아요', areas: ['menu', 'purchase', 'staff'] },
  { id: 'marketing_focus', label: '마케팅을 어디에 집중해야 할지 모르겠어요', areas: ['marketing', 'customer'] },
  { id: 'purchase_price', label: '식재료를 적절한 가격에 사고 있는지 궁금해요', areas: ['purchase', 'cost'] },
  { id: 'env_service', label: '매장 환경·서비스에 객관적인 의견이 필요해요', areas: ['env', 'clean', 'customer'] },
  { id: 'repeat_low', label: '다시 오는 손님(단골)이 적은 것 같아요', areas: ['customer', 'menu', 'clean'] },
  { id: 'delivery_profit', label: '배달은 파는데 남는 게 없는 것 같아요', areas: ['delivery', 'cost', 'menu'] },
  { id: 'labor', label: '일손이 부족하거나 인건비가 부담돼요', areas: ['staff', 'cost'] },
];

export const AREAS = [
  { id: 'basic', name: '운영 형태' },
  { id: 'goal', name: '목표와 제약' },
  { id: 'sales', name: '매출' },
  { id: 'delivery', name: '배달·포장' },
  { id: 'hall', name: '매장 손님' },
  { id: 'cost', name: '비용' },
  { id: 'staff', name: '직원·업무' },
  { id: 'menu', name: '메뉴' },
  { id: 'purchase', name: '매입·재고' },
  { id: 'customer', name: '고객' },
  { id: 'marketing', name: '마케팅' },
  { id: 'price', name: '가격·경쟁' },
  { id: 'env', name: '매장 환경' },
  { id: 'clean', name: '청결·화장실' },
  { id: 'check', name: '재확인' },
];

export const BIZ_TYPES = [
  { v: 'restaurant', label: '음식점' },
  { v: 'cafe', label: '카페' },
];

export const SUB_TYPES = {
  restaurant: ['한식', '분식', '중식', '일식', '양식', '치킨·피자', '고기·구이', '면 요리', '식사 겸 주점', '기타'],
  cafe: ['커피 중심', '디저트·베이커리 카페', '브런치 카페', '테이크아웃 전문', '기타'],
};

export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
export const TIME_SLOTS = [
  { v: 'morning', label: '아침 (7~10시)' },
  { v: 'lunch', label: '점심 (11~14시)' },
  { v: 'afternoon', label: '오후 (14~17시)' },
  { v: 'dinner', label: '저녁 (17~20시)' },
  { v: 'night', label: '밤 (20시 이후)' },
];

const UNKNOWN_NUM = ['unknown', 'approx', 'later'];
const UNKNOWN_NUM_NA = ['unknown', 'approx', 'na', 'later'];
const LATER = ['later'];

const BUDGET_OPTS = [
  { v: 0, label: '거의 없어요 (1만 원 이하)' },
  { v: 1, label: '30만 원 이하' },
  { v: 2, label: '30만~100만 원' },
  { v: 3, label: '100만~300만 원' },
  { v: 4, label: '300만 원 이상' },
  { v: -1, label: '아직 모르겠어요' },
];

const TIME_OPTS = [
  { v: 0, label: '1시간 미만' },
  { v: 1, label: '1~3시간' },
  { v: 2, label: '3~5시간' },
  { v: 3, label: '5시간 이상' },
];

export const QUESTIONS = [
  // ───────── 운영 형태
  {
    id: 'b_split', area: 'basic', type: 'split', depth: 'core', label: '홀·포장·배달 비중',
    text: '매출에서 매장 식사, 포장, 배달이 각각 어느 정도인가요?',
    help: '대략이어도 괜찮아요. 합계가 100%가 되게 맞춰 주세요.',
    why: '배달 중심인지 매장 중심인지에 따라 확인할 비용과 개선 방법이 완전히 달라져요.',
    allow: ['unknown', 'approx', 'later'],
  },
  {
    id: 'b_has_delivery', area: 'basic', type: 'choice', depth: 'core', label: '배달 판매 여부',
    text: '배달 판매를 하고 있나요?',
    options: [{ v: 'yes', label: '네, 하고 있어요' }, { v: 'no', label: '아니요' }],
    when: (c) => c.status('b_split') === 'unknown' || c.status('b_split') === 'later',
    allow: LATER,
  },
  {
    id: 'b_open', area: 'basic', type: 'choice', depth: 'core', label: '영업 기간',
    text: '가게를 연 지 얼마나 되었나요?',
    options: [
      { v: 'lt6m', label: '6개월 미만' }, { v: '6m1y', label: '6개월~1년' }, { v: '1y3y', label: '1~3년' },
      { v: '3y5y', label: '3~5년' }, { v: 'gt5y', label: '5년 이상' },
    ],
    why: '문을 연 지 얼마 안 된 가게와 오래된 가게는 먼저 할 일이 달라요.',
    allow: LATER,
  },
  {
    id: 'b_hours', area: 'basic', type: 'hours', depth: 'core', label: '영업시간·휴무일',
    text: '영업시간과 쉬는 날을 알려주세요.',
    help: '쉬는 시간(브레이크 타임)이 있으면 함께 적어주세요.',
    why: '공개된 온라인 정보와 맞는지 확인하고, 한 달 영업일수를 계산하는 데 써요.',
    allow: LATER,
  },
  {
    id: 'b_seats', area: 'basic', type: 'number', unit: '석', depth: 'core', label: '좌석 수',
    text: '손님이 앉을 수 있는 자리는 몇 석인가요?',
    help: '배달·포장만 한다면 "해당 없음"을 눌러주세요.',
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'b_staff', area: 'basic', type: 'number', unit: '명', depth: 'core', label: '직원 수',
    text: '사장님을 빼고 함께 일하는 사람은 몇 명인가요?',
    help: '아르바이트, 가족 직원도 포함해 주세요. 혼자 운영하면 0을 입력하세요.',
    allow: ['unknown', 'approx', 'later'],
  },
  {
    id: 'b_owner_hours', area: 'basic', type: 'number', unit: '시간/주', depth: 'core', label: '사장님 근무시간',
    text: '사장님은 일주일에 몇 시간 정도 가게 일을 하시나요?',
    help: '장보기, 재료 준비, 정리, 서류 일까지 포함한 시간이에요.',
    why: '가게에서 남는 돈을 사장님 시간으로 나눠, 시간당 얼마를 버는지 계산해요.',
    allow: UNKNOWN_NUM,
  },
  {
    id: 'b_order_method', area: 'basic', type: 'multi', depth: 'core', label: '주문 방식',
    text: '매장 손님은 주로 어떻게 주문하나요?',
    options: [
      { v: 'counter', label: '카운터에서 직원에게' }, { v: 'kiosk', label: '키오스크' },
      { v: 'table', label: '테이블 주문(태블릿·QR)' }, { v: 'server', label: '직원이 테이블에서 받음' },
    ],
    when: (c) => c.hallish(),
    allow: LATER,
  },

  // ───────── 목표와 제약
  {
    id: 'g_main', area: 'goal', type: 'text', long: true, depth: 'core', label: '가장 큰 고민',
    text: '지금 가게에서 가장 해결하고 싶은 문제를 편하게 적어주세요.',
    example: '예: 평일 저녁 손님이 작년보다 줄었어요 / 바쁜데 통장에 남는 게 없어요',
    allow: LATER,
  },
  {
    id: 'g_change', area: 'goal', type: 'multi', max: 2, depth: 'core', label: '원하는 변화',
    text: '가장 원하는 변화를 최대 2개 골라주세요.',
    options: [
      { v: 'new', label: '새 손님 늘리기' }, { v: 'ticket', label: '손님 1명(1주문)당 결제금액 올리기' },
      { v: 'repeat', label: '다시 오는 손님 늘리기' }, { v: 'cost', label: '비용 줄여서 남는 돈 늘리기' },
      { v: 'ops', label: '일을 덜 힘들게 하기' }, { v: 'delivery', label: '배달 수익성 높이기' },
    ],
    allow: LATER,
  },
  {
    id: 'g_budget', area: 'goal', type: 'choice', depth: 'core', label: '개선 예산',
    text: '앞으로 1~3개월 동안 개선에 쓸 수 있는 돈은 어느 정도인가요?',
    options: BUDGET_OPTS,
    why: '예산 안에서 할 수 있는 방법부터 추천하고, 부족하면 더 작은 대안을 드려요.',
    allow: LATER,
  },
  {
    id: 'g_time', area: 'goal', type: 'choice', depth: 'core', label: '투입 가능 시간',
    text: '개선 작업에 사장님이 일주일에 낼 수 있는 시간은요?',
    options: TIME_OPTS,
    allow: LATER,
  },
  {
    id: 'g_fixed', area: 'goal', type: 'multi', depth: 'core', label: '바꾸기 어려운 조건',
    text: '바꿀 수 없거나 바꾸기 어려운 조건이 있나요?',
    options: [
      { v: 'price', label: '메뉴 가격은 올리기 어려워요' }, { v: 'interior', label: '인테리어 공사는 어려워요' },
      { v: 'hours', label: '영업시간은 바꾸기 어려워요' }, { v: 'hire', label: '직원을 더 뽑기 어려워요' },
      { v: 'signature', label: '대표 메뉴는 바꾸고 싶지 않아요' }, { v: 'landlord', label: '간판·외관은 건물주 허락이 필요해요' },
      { v: 'none', label: '특별히 없어요' },
    ],
    allow: LATER,
  },

  // ───────── 매출
  {
    id: 's_monthly', area: 'sales', type: 'money', inputUnit: 'man', depth: 'core', label: '최근 월매출',
    text: '최근 한 달 매출은 얼마인가요?',
    help: '포스(POS)나 카드 단말기, 배달앱 매출을 모두 합친 금액이에요.',
    example: '예: 3,000만 원이면 3000 입력',
    allow: UNKNOWN_NUM,
  },
  {
    id: 's_month', area: 'sales', type: 'month', depth: 'core', label: '매출 기준 월',
    text: '방금 입력한 매출은 어느 달 기준인가요?',
    why: '비용과 같은 달끼리 비교해야 계산이 맞아요.',
    when: (c) => c.known('s_monthly'),
    allow: ['unknown', 'later'],
  },
  {
    id: 's_basis', area: 'sales', type: 'choice', depth: 'core', label: '매출 금액 기준',
    text: '그 금액은 어떤 기준인가요?',
    options: [
      { v: 'gross', label: '손님이 결제한 금액', desc: '카드·현금·배달앱 주문금액 합계 (수수료 빼기 전)' },
      { v: 'net', label: '통장에 들어온 금액', desc: '카드 수수료·배달앱 수수료가 이미 빠진 금액' },
      { v: 'mixed', label: '섞여 있어요', desc: '매장 매출은 결제금액, 배달은 입금액' },
      { v: 'unknown', label: '잘 모르겠어요' },
    ],
    why: '이미 빠진 수수료를 비용에서 또 빼면 이익이 실제보다 적게 계산돼요.',
    when: (c) => c.known('s_monthly'),
    allow: LATER,
  },
  {
    id: 's_trend', area: 'sales', type: 'choice', depth: 'core', label: '최근 매출 흐름',
    text: '최근 3~6개월 매출은 어땠나요?',
    options: [{ v: 'up', label: '늘었어요' }, { v: 'flat', label: '비슷해요' }, { v: 'down', label: '줄었어요' }, { v: 'unknown', label: '잘 모르겠어요' }],
    allow: LATER,
  },
  {
    id: 's_drop_pct', area: 'sales', type: 'percent', depth: 'core', label: '매출 감소 폭',
    text: '예전과 비교해 대략 몇 % 줄었나요?',
    help: '예: 월 3,000만 원에서 2,400만 원이 되었다면 20%',
    when: (c) => c.v('s_trend') === 'down',
    allow: UNKNOWN_NUM,
  },
  {
    id: 's_drop_reason', area: 'sales', type: 'multi', depth: 'core', label: '짐작되는 감소 이유',
    text: '짐작되는 이유가 있나요? (여러 개 선택 가능)',
    options: [
      { v: 'competitor', label: '근처에 경쟁 가게가 생겼어요' }, { v: 'delivery', label: '배달 주문이 줄었어요' },
      { v: 'regulars', label: '단골이 줄었어요' }, { v: 'price', label: '가격을 올린 뒤부터예요' },
      { v: 'area', label: '공사·상권 변화가 있었어요' }, { v: 'season', label: '계절 영향 같아요' },
      { v: 'unknown', label: '잘 모르겠어요' },
    ],
    when: (c) => c.v('s_trend') === 'down',
    allow: LATER,
  },
  {
    id: 's_history', area: 'sales', type: 'list', depth: 'core', label: '월별 매출 기록',
    text: '최근 몇 달의 월매출을 알면 흐름을 정확히 볼 수 있어요.',
    help: '매출 파일(POS·카드사 CSV)을 올리면 자동으로 채울 수도 있어요.',
    fields: [
      { key: 'month', label: '월', type: 'month', required: true },
      { key: 'amount', label: '매출', type: 'man', unit: '만 원' },
    ],
    when: (c) => c.v('s_trend') === 'down' || c.concern('sales_down') || c.concern('profit_unknown'),
    allow: ['later'],
  },
  {
    id: 's_orders', area: 'sales', type: 'number', unit: '건/월', depth: 'core', label: '월 주문(결제) 건수',
    text: '한 달 주문(결제) 건수는 대략 몇 건인가요?',
    help: 'POS나 카드 매출 화면의 "건수"를 보면 알 수 있어요. 매장·포장·배달을 모두 합쳐 주세요.',
    allow: UNKNOWN_NUM,
  },
  {
    id: 's_ticket', area: 'sales', type: 'money', inputUnit: 'won', depth: 'core', label: '평균 결제금액',
    text: '손님 한 명 또는 한 주문이 평균 얼마를 결제하나요?',
    help: '이 값을 흔히 "객단가"라고 불러요. 월매출 ÷ 주문 건수로 계산해도 돼요.',
    allow: UNKNOWN_NUM,
  },
  {
    id: 's_busy', area: 'sales', type: 'slots', depth: 'core', label: '바쁜 요일·시간',
    text: '가장 바쁜 요일과 시간대를 골라주세요.',
    allow: ['unknown', 'later'],
  },
  {
    id: 's_idle', area: 'sales', type: 'slots', depth: 'core', label: '한가한 요일·시간',
    text: '가장 한가한 요일과 시간대를 골라주세요.',
    why: '고정비(월세·인건비)는 한가한 시간에도 나가요. 이 시간을 어떻게 쓸지가 중요해요.',
    allow: ['unknown', 'later'],
  },
  {
    id: 's_season', area: 'sales', type: 'text', depth: 'deep', label: '성수기·비수기',
    text: '성수기와 비수기가 있나요? 있다면 언제인가요?',
    example: '예: 여름에 빙수로 매출이 1.5배, 1~2월은 조용해요',
    allow: ['unknown', 'later'],
  },

  // ───────── 배달·포장
  {
    id: 'd_apps', area: 'delivery', type: 'multi', depth: 'core', label: '사용하는 배달 채널',
    text: '어떤 배달 채널을 쓰고 있나요?',
    options: [
      { v: 'baemin', label: '배달의민족' }, { v: 'coupang', label: '쿠팡이츠' }, { v: 'yogiyo', label: '요기요' },
      { v: 'ddangyo', label: '땡겨요' }, { v: 'phone', label: '전화·자체 주문' }, { v: 'other', label: '기타' },
    ],
    when: (c) => c.deliveryish(),
    allow: LATER,
  },
  {
    id: 'd_orders', area: 'delivery', type: 'number', unit: '건/월', depth: 'core', label: '월 배달 주문 수',
    text: '한 달 배달 주문은 몇 건인가요?',
    when: (c) => c.deliveryish(),
    allow: UNKNOWN_NUM,
  },
  {
    id: 'd_ticket', area: 'delivery', type: 'money', inputUnit: 'won', depth: 'core', label: '배달 1건 평균 결제금액',
    text: '배달 주문 1건의 평균 결제금액은 얼마인가요?',
    help: '손님이 낸 배달팁은 빼고, 음식 주문금액 기준이에요.',
    when: (c) => c.deliveryish(),
    allow: UNKNOWN_NUM,
  },
  {
    id: 'd_commission', area: 'delivery', type: 'percent', depth: 'core', label: '배달앱 중개 수수료율',
    text: '배달앱 중개 수수료는 주문금액의 몇 %인가요?',
    help: '정산 내역의 "중개이용료" 또는 "수수료" 항목을 보면 돼요. 앱과 요금제마다 달라요.',
    when: (c) => c.deliveryish(),
    allow: UNKNOWN_NUM,
  },
  {
    id: 'd_payfee', area: 'delivery', type: 'percent', depth: 'core', label: '배달 결제 수수료율',
    text: '배달 주문의 결제 수수료는 몇 %인가요?',
    help: '정산 내역에 "결제정산수수료"처럼 따로 적혀 있는 경우가 많아요.',
    when: (c) => c.deliveryish(),
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'd_delivery_fee', area: 'delivery', type: 'money', inputUnit: 'won', depth: 'core', label: '가게 부담 배달비(건당)',
    text: '배달비 중 가게가 부담하는 금액은 1건당 얼마인가요?',
    help: '손님이 낸 배달팁을 뺀, 가게가 내는 배달비(대행비)만 적어주세요.',
    when: (c) => c.deliveryish(),
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'd_discount', area: 'delivery', type: 'money', inputUnit: 'won', depth: 'core', label: '가게 부담 할인·쿠폰(건당)',
    text: '쿠폰·할인 중 가게가 부담하는 금액은 1건당 평균 얼마인가요?',
    when: (c) => c.deliveryish(),
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'd_packaging', area: 'delivery', type: 'money', inputUnit: 'won', depth: 'core', label: '포장비(건당)',
    text: '포장 용기·봉투·수저 등 포장비는 주문 1건당 얼마인가요?',
    when: (c) => c.packish(),
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'd_fee_in_deposit', area: 'delivery', type: 'choice', depth: 'core', label: '입금액의 수수료 차감 여부',
    text: '배달앱 수수료·배달비·할인 부담금은 입금액에서 이미 빠져 있나요?',
    options: [
      { v: 'all', label: '네, 모두 빠진 뒤 입금돼요' },
      { v: 'commission_only', label: '수수료·할인은 빠지고, 배달비는 따로 내요' },
      { v: 'none', label: '아니요, 따로 내요' },
      { v: 'unknown', label: '잘 모르겠어요' },
    ],
    why: '이미 빠진 금액을 비용에서 한 번 더 빼지 않기 위해 확인해요.',
    when: (c) => c.deliveryish() && ['net', 'mixed'].includes(c.v('s_basis')),
    allow: LATER,
  },
  {
    id: 'd_ads', area: 'delivery', type: 'money', inputUnit: 'man', depth: 'core', label: '배달앱 광고비(월)',
    text: '배달앱 안에서 따로 내는 광고비는 한 달에 얼마인가요?',
    help: '주문마다 수수료로 빠지는 광고형 상품은 수수료에 포함하고, 따로 결제하는 광고비만 적어주세요.',
    when: (c) => c.deliveryish(),
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'd_min_order', area: 'delivery', type: 'money', inputUnit: 'won', depth: 'deep', label: '배달 최소 주문금액',
    text: '배달 최소 주문금액은 얼마인가요?',
    when: (c) => c.deliveryish(),
    allow: UNKNOWN_NUM,
  },
  {
    id: 'd_menu_diff', area: 'delivery', type: 'choice', depth: 'deep', label: '배달 메뉴 가격 차이',
    text: '배달 메뉴 가격이 매장 가격과 다른가요?',
    options: [{ v: 'same', label: '같아요' }, { v: 'higher', label: '배달이 더 비싸요' }, { v: 'set', label: '배달 전용 구성이 있어요' }],
    when: (c) => c.deliveryish(),
    allow: LATER,
  },

  // ───────── 매장 손님(홀)
  {
    id: 'h_full', area: 'hall', type: 'choice', depth: 'core', label: '피크 시간 만석 여부',
    text: '가장 바쁜 시간에 자리가 꽉 차나요?',
    options: [
      { v: 'often', label: '자주 꽉 차고 기다리는 손님이 있어요' }, { v: 'sometimes', label: '가끔 꽉 차요' },
      { v: 'rarely', label: '거의 꽉 차지 않아요' },
    ],
    when: (c) => c.hallish(),
    allow: LATER,
  },
  {
    id: 'h_wait_loss', area: 'hall', type: 'choice', depth: 'core', label: '대기 이탈',
    text: '기다리다 그냥 돌아가는 손님이 있나요?',
    options: [{ v: 'often', label: '자주 있어요' }, { v: 'sometimes', label: '가끔 있어요' }, { v: 'rarely', label: '거의 없어요' }, { v: 'unknown', label: '잘 모르겠어요' }],
    when: (c) => c.hallish() && c.v('h_full') === 'often',
    allow: LATER,
  },
  {
    id: 'h_serve_time', area: 'hall', type: 'number', unit: '분', depth: 'core', label: '바쁠 때 제공 시간',
    text: '바쁜 시간에 주문 후 음식(음료)이 나오기까지 보통 몇 분 걸리나요?',
    when: (c) => c.hallish() || c.packish(),
    allow: UNKNOWN_NUM,
  },
  {
    id: 'h_turn', area: 'hall', type: 'number', unit: '회', depth: 'deep', label: '피크 회전 수',
    text: '가장 바쁜 식사 시간에 한 자리에 손님이 몇 번 바뀌나요?',
    help: '예: 점심 11시 30분~1시 30분에 한 테이블에 두 팀이 앉으면 2회',
    when: (c) => c.hallish() && c.biz === 'restaurant',
    allow: UNKNOWN_NUM,
  },
  {
    id: 'h_stay', area: 'hall', type: 'choice', depth: 'core', label: '평균 체류 시간',
    text: '매장 손님은 보통 얼마나 머무르나요?',
    options: [
      { v: 'lt30', label: '30분 이내' }, { v: '30to60', label: '30분~1시간' }, { v: '1to2h', label: '1~2시간' },
      { v: 'gt2h', label: '2시간 이상' }, { v: 'mixed', label: '손님마다 많이 달라요' },
    ],
    when: (c) => c.hallish() && c.biz === 'cafe',
    allow: LATER,
  },
  {
    id: 'h_laptop', area: 'hall', type: 'choice', depth: 'core', label: '공부·업무 손님 비중',
    text: '노트북이나 공부하는 손님은 얼마나 되나요?',
    options: [{ v: 'many', label: '많아요' }, { v: 'some', label: '보통이에요' }, { v: 'few', label: '적어요' }, { v: 'unknown', label: '잘 모르겠어요' }],
    when: (c) => c.hallish() && c.biz === 'cafe',
    allow: LATER,
  },
  {
    id: 'h_amenities', area: 'hall', type: 'multi', depth: 'deep', label: '좌석 편의',
    text: '매장에 있는 것을 모두 골라주세요.',
    options: [
      { v: 'outlet', label: '콘센트 좌석' }, { v: 'wifi', label: '와이파이' }, { v: 'group', label: '단체석' },
      { v: 'solo', label: '1인석' }, { v: 'pet', label: '반려동물 동반 가능' }, { v: 'kids', label: '아이 의자' },
    ],
    when: (c) => c.hallish(),
    allow: LATER,
  },

  // ───────── 비용
  {
    id: 'c_food', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '식재료 구매액',
    text: '식재료 구매에 한 달 얼마를 쓰나요?',
    help: '카페라면 원두·우유·시럽·디저트 재료 포함. 포장용기·소모품은 빼고 적어주세요(따로 물어봐요). 거래명세서나 카드 내역 합계면 정확해요.',
    why: '구매액은 실제 사용한 양과 다를 수 있어요(재고·폐기). 메뉴 원가와 비교해 새는 곳을 찾아요.',
    allow: UNKNOWN_NUM,
  },
  {
    id: 'c_labor', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '직원 인건비',
    text: '직원 인건비는 한 달에 모두 얼마인가요?',
    help: '아르바이트·가족 직원 급여 포함. 사장님 본인 몫은 다음 질문에서 따로 물어봐요.',
    when: (c) => c.staffCount() !== 0,
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_labor_incl', area: 'cost', type: 'multi', depth: 'core', label: '인건비 포함 항목',
    text: '그 인건비에 포함된 것을 골라주세요.',
    options: [
      { v: 'weekly', label: '주휴수당' }, { v: 'insurance', label: '4대보험 사업주 부담분' },
      { v: 'severance', label: '퇴직금 적립' }, { v: 'unknown', label: '잘 모르겠어요' },
    ],
    when: (c) => c.known('c_labor'),
    allow: LATER,
  },
  {
    id: 'c_owner_pay', area: 'cost', type: 'choice', depth: 'core', label: '사장님 본인 급여 처리',
    text: '사장님 본인 급여를 따로 정해서 가져가시나요?',
    options: [
      { v: 'none', label: '따로 없어요 (남는 돈이 곧 제 수입)' },
      { v: 'fixed', label: '매달 정해진 금액을 가져가요' },
    ],
    why: '대표자 인건비를 비용에 넣었는지에 따라 "이익"의 의미가 달라져요.',
    allow: LATER,
  },
  {
    id: 'c_owner_pay_amt', area: 'cost', type: 'money', inputUnit: 'man', depth: 'core', label: '사장님 월 급여',
    text: '매달 가져가는 금액은 얼마인가요?',
    when: (c) => c.v('c_owner_pay') === 'fixed',
    allow: UNKNOWN_NUM,
  },
  {
    id: 'c_rent_type', area: 'cost', type: 'choice', depth: 'core', label: '점포 형태',
    text: '가게 공간은 임대인가요?',
    options: [{ v: 'lease', label: '임대(월세)예요' }, { v: 'own', label: '자가(내 건물)예요' }, { v: 'other', label: '기타' }],
    allow: LATER,
  },
  {
    id: 'c_rent', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '월세',
    text: '월세(임대료)는 얼마인가요?',
    help: '부가세를 따로 낸다면 포함한 금액을 적어주세요.',
    when: (c) => c.v('c_rent_type') !== 'own',
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_mgmt', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '관리비',
    text: '관리비는 한 달에 얼마인가요?',
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_util', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '전기·가스·수도',
    text: '전기·가스·수도 요금은 한 달 평균 얼마인가요?',
    help: '계절마다 다르면 최근 3개월 평균으로 적어주세요.',
    allow: UNKNOWN_NUM,
  },
  {
    id: 'c_card_fee', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '카드 결제 수수료',
    text: '카드 결제 수수료는 한 달에 얼마인가요?',
    help: '카드사 매출 조회나 여신금융협회 가맹점 매출 조회에서 확인할 수 있어요.',
    when: (c) => ['gross', 'mixed', 'unknown'].includes(c.v('s_basis')) || !c.known('s_monthly'),
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_packaging', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '포장재 구매액',
    text: '포장 용기·봉투 등 포장재 구매에 한 달 얼마를 쓰나요?',
    when: (c) => c.packish(),
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_ads', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '광고비(배달앱 제외)',
    text: '배달앱 말고 쓰는 광고비는 한 달에 얼마인가요?',
    help: '네이버 광고, 인스타그램 광고, 전단지, 체험단 비용 등이에요.',
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_outsourcing', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'deep', label: '마케팅 대행·외주비',
    text: '마케팅 대행이나 외주(사진 촬영·SNS 관리 등)에 한 달 얼마를 쓰나요?',
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_supplies', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '소모품비',
    text: '세제·물티슈·냅킨·컵 같은 소모품에 한 달 얼마를 쓰나요?',
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_other', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'core', label: '기타 고정비',
    text: '그 밖에 매달 나가는 돈은 합쳐서 얼마인가요?',
    help: '세무 대행, 렌탈(정수기·식기세척기), 보험, 통신·POS 이용료, 방역 등',
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'c_loan', area: 'cost', type: 'money', inputUnit: 'man', period: true, depth: 'deep', label: '대출 상환액',
    text: '대출 이자와 원금 상환으로 한 달에 얼마가 나가나요?',
    help: '영업 이익 계산에서는 빼고, 실제 손에 쥐는 돈을 볼 때 따로 참고해요.',
    allow: UNKNOWN_NUM_NA,
  },

  // ───────── 직원·업무
  {
    id: 'st_list', area: 'staff', type: 'list', depth: 'core', label: '직원 구성',
    text: '함께 일하는 사람의 역할과 근무시간을 알려주세요.',
    help: '정확하지 않아도 괜찮아요. 이름은 적지 마세요.',
    fields: [
      { key: 'role', label: '역할', type: 'select', options: [['kitchen', '주방'], ['hall', '홀·서빙'], ['counter', '카운터·주문'], ['barista', '음료 제조'], ['delivery', '배달·포장'], ['etc', '기타']] },
      { key: 'hours', label: '주당 근무시간', type: 'number', unit: '시간' },
      { key: 'slot', label: '주로 일하는 시간', type: 'text', placeholder: '예: 평일 11~15시' },
    ],
    when: (c) => (c.staffCount() ?? 0) > 0,
    allow: LATER,
  },
  {
    id: 'st_peak', area: 'staff', type: 'number', unit: '명', depth: 'core', label: '피크 시간 근무 인원',
    text: '가장 바쁜 시간에는 사장님 포함 몇 명이 일하나요?',
    allow: UNKNOWN_NUM,
  },
  {
    id: 'st_delay', area: 'staff', type: 'multi', depth: 'core', label: '늦어지거나 반복되는 일',
    text: '자주 늦어지거나 반복돼서 힘든 일을 골라주세요.',
    options: [
      { v: 'prep', label: '재료 손질·준비' }, { v: 'order', label: '주문 받기·계산' }, { v: 'cook', label: '조리' },
      { v: 'drink', label: '음료 제조' }, { v: 'pack', label: '포장' }, { v: 'dish', label: '설거지' },
      { v: 'stock', label: '발주·재고 확인' }, { v: 'online', label: '리뷰 답글·SNS' }, { v: 'clean', label: '청소' },
      { v: 'none', label: '특별히 없어요' },
    ],
    allow: LATER,
  },
  {
    id: 'st_turnover', area: 'staff', type: 'choice', depth: 'deep', label: '직원 교체 빈도',
    text: '최근 1년 동안 직원이 자주 바뀌었나요?',
    options: [{ v: 'often', label: '자주 바뀌었어요' }, { v: 'some', label: '한두 번' }, { v: 'stable', label: '거의 그대로예요' }],
    when: (c) => (c.staffCount() ?? 0) > 0,
    allow: LATER,
  },

  // ───────── 메뉴
  {
    id: 'm_count', area: 'menu', type: 'number', unit: '개', depth: 'core', label: '전체 메뉴 수',
    text: '판매 중인 메뉴는 모두 몇 개인가요?',
    help: '음료·사이드 메뉴도 포함해서 세어주세요.',
    allow: UNKNOWN_NUM,
  },
  {
    id: 'm_best', area: 'menu', type: 'text', depth: 'core', label: '잘 팔리는 메뉴',
    text: '잘 팔리는 메뉴 3개와 거의 안 팔리는 메뉴를 알려주세요.',
    example: '예: 잘 팔림 - 김치찌개, 제육볶음 / 거의 안 팔림 - 해물순두부, 오므라이스',
    when: (c) => (c.num('m_count') ?? 0) >= (c.biz === 'cafe' ? 30 : 25),
    allow: ['unknown', 'later'],
  },
  {
    id: 'm_exclusive', area: 'menu', type: 'text', depth: 'core', label: '한 메뉴 전용 재료',
    text: '특정 메뉴에만 쓰는 재료가 있나요?',
    example: '예: 해물순두부에만 쓰는 냉동 해물믹스',
    why: '한 메뉴에만 쓰는 재료는 폐기와 재고 부담의 주요 원인이 돼요.',
    when: (c) => (c.num('m_count') ?? 0) >= (c.biz === 'cafe' ? 30 : 25) || c.concern('menu_complex'),
    allow: ['unknown', 'na', 'later'],
  },
  {
    id: 'm_list', area: 'menu', type: 'list', depth: 'core', label: '메뉴별 정보',
    text: '메뉴별 가격과 판매량을 알려주세요.',
    help: '전부 적기 어렵다면 잘 팔리는 메뉴 5개와 거의 안 팔리는 메뉴 3~5개만 적어도 돼요. 원가를 모르면 비워두세요.',
    fields: [
      { key: 'name', label: '메뉴 이름', type: 'text', required: true, placeholder: '예: 김치찌개' },
      { key: 'price', label: '가격', type: 'won', unit: '원' },
      { key: 'qty', label: '한 달 판매량(대략)', type: 'number', unit: '개' },
      { key: 'cost', label: '1개 재료원가', type: 'won', unit: '원', placeholder: '모르면 비움' },
      { key: 'prep', label: '조리·제조 시간', type: 'number', unit: '분' },
      { key: 'exclusive', label: '이 메뉴에만 쓰는 재료', type: 'select', options: [['yes', '있어요'], ['no', '없어요'], ['', '모름']] },
      { key: 'role', label: '이 메뉴의 역할', type: 'select', options: [['signature', '대표 메뉴'], ['draw', '이 메뉴를 찾아오는 손님이 있음'], ['combo', '다른 메뉴와 함께 잘 팔림'], ['season', '계절·한정 메뉴'], ['none', '특별한 역할 없음'], ['', '모름']] },
    ],
    allow: LATER,
  },
  {
    id: 'm_upload', area: 'menu', type: 'upload', kind: 'menu_board', depth: 'core', label: '메뉴판 사진',
    text: '메뉴판이나 가격표 사진이 있으면 올려주세요. (선택)',
    help: '사진이 없어도 진행할 수 있어요. 올린 사진은 사장님만 볼 수 있어요.',
    allow: ['na', 'later'],
  },
  {
    id: 'm_photo', area: 'menu', type: 'choice', depth: 'core', label: '메뉴 사진 유무',
    text: '메뉴판(또는 배달앱)에 메뉴 사진이 있나요?',
    options: [{ v: 'most', label: '대부분 있어요' }, { v: 'some', label: '일부만 있어요' }, { v: 'none', label: '없어요' }],
    allow: LATER,
  },
  {
    id: 'm_recommend', area: 'menu', type: 'choice', depth: 'core', label: '추천 표시',
    text: '메뉴판에 "추천"이나 "대표" 표시가 있나요?',
    options: [{ v: 'yes', label: '있어요' }, { v: 'no', label: '없어요' }],
    allow: LATER,
  },
  {
    id: 'm_set', area: 'menu', type: 'choice', depth: 'core', label: '세트 구성',
    text: '세트 메뉴나 함께 주문하면 좋은 구성이 있나요?',
    options: [{ v: 'yes', label: '있어요' }, { v: 'no', label: '없어요' }],
    allow: LATER,
  },
  {
    id: 'm_price_change', area: 'menu', type: 'choice', depth: 'deep', label: '마지막 가격 조정',
    text: '마지막으로 메뉴 가격을 조정한 때는 언제인가요?',
    options: [{ v: 'lt6m', label: '6개월 이내' }, { v: 'lt1y', label: '1년 이내' }, { v: '1to2y', label: '1~2년 전' }, { v: 'gt2y', label: '2년 이상 전' }, { v: 'unknown', label: '잘 모르겠어요' }],
    allow: LATER,
  },
  {
    id: 'm_bean_kg', area: 'menu', type: 'number', unit: 'kg/월', depth: 'core', label: '원두 사용량',
    text: '원두는 한 달에 몇 kg 정도 쓰나요?',
    when: (c) => c.biz === 'cafe',
    allow: UNKNOWN_NUM_NA,
  },
  {
    id: 'm_bean_price', area: 'menu', type: 'money', inputUnit: 'won', depth: 'core', label: '원두 kg당 가격',
    text: '원두는 1kg에 얼마에 사나요? (배송비 포함)',
    when: (c) => c.biz === 'cafe' && c.status('m_bean_kg') !== 'na',
    allow: UNKNOWN_NUM,
  },
  {
    id: 'm_dessert_source', area: 'menu', type: 'choice', depth: 'core', label: '디저트 조달 방식',
    text: '디저트는 어떻게 준비하나요?',
    options: [{ v: 'make', label: '직접 만들어요' }, { v: 'buy', label: '납품받아요' }, { v: 'both', label: '둘 다요' }, { v: 'none', label: '디저트는 팔지 않아요' }],
    when: (c) => c.biz === 'cafe',
    allow: LATER,
  },
  {
    id: 'm_dessert_waste', area: 'menu', type: 'number', unit: '개/주', depth: 'core', label: '버리는 디저트',
    text: '팔지 못하고 버리는 디저트는 일주일에 몇 개 정도인가요?',
    when: (c) => c.biz === 'cafe' && ['make', 'buy', 'both'].includes(c.v('m_dessert_source')),
    allow: UNKNOWN_NUM,
  },
  {
    id: 'm_attach', area: 'menu', type: 'choice', depth: 'core', label: '음료+디저트 동반 구매',
    text: '음료와 디저트를 함께 사는 손님은 어느 정도인가요?',
    options: [{ v: 'high', label: '많아요 (절반 이상)' }, { v: 'mid', label: '보통이에요' }, { v: 'low', label: '적어요 (열에 한두 명)' }, { v: 'unknown', label: '잘 모르겠어요' }],
    when: (c) => c.biz === 'cafe' && ['make', 'buy', 'both'].includes(c.v('m_dessert_source')),
    allow: LATER,
  },

  // ───────── 매입·재고
  {
    id: 'p_suppliers', area: 'purchase', type: 'multi', depth: 'core', label: '주요 구매처',
    text: '식재료는 주로 어디서 사나요?',
    options: [
      { v: 'vendor', label: '식자재 납품업체' }, { v: 'wholesale', label: '식자재 마트·도매시장' },
      { v: 'online', label: '온라인 식자재몰' }, { v: 'retail', label: '일반 마트·온라인 쇼핑' },
      { v: 'hq', label: '본사·가맹 공급' }, { v: 'other', label: '기타' },
    ],
    allow: LATER,
  },
  {
    id: 'p_cycle', area: 'purchase', type: 'choice', depth: 'core', label: '구매 주기',
    text: '얼마나 자주 주문(구매)하나요?',
    options: [{ v: 'daily', label: '거의 매일' }, { v: '2to3', label: '일주일에 2~3번' }, { v: 'weekly', label: '일주일에 1번' }, { v: 'rare', label: '그보다 드물게' }],
    allow: LATER,
  },
  {
    id: 'p_items', area: 'purchase', type: 'list', depth: 'deep', label: '주요 식재료 구매 정보',
    text: '돈이 많이 드는 식재료부터 3~10개를 알려주세요.',
    help: '가격 비교는 브랜드·규격·등급·배송비가 같을 때만 정확해요. 거래명세서를 보면서 적으면 좋아요.',
    fields: [
      { key: 'name', label: '품목', type: 'text', required: true, placeholder: '예: 돼지 앞다리살, 우유, 원두' },
      { key: 'brand', label: '브랜드·제조사', type: 'text', placeholder: '모르면 비움' },
      { key: 'brandAny', label: '브랜드는 상관없음', type: 'check' },
      { key: 'size', label: '규격(한 단위의 양)', type: 'number', placeholder: '예: 1' },
      { key: 'unit', label: '규격 단위', type: 'select', options: [['kg', 'kg'], ['g', 'g'], ['L', 'L'], ['ml', 'ml'], ['개', '개']] },
      { key: 'count', label: '입수(한 단위에 든 개수)', type: 'number', placeholder: '1' },
      { key: 'grade', label: '등급·원산지·종류', type: 'text', placeholder: '예: 국내산 냉장 1등급' },
      { key: 'qty', label: '한 달 구매 수량(단위 기준)', type: 'number' },
      { key: 'price', label: '1단위 가격', type: 'won', unit: '원' },
      { key: 'vat', label: '부가세', type: 'select', options: [['incl', '포함'], ['excl', '별도'], ['', '모름']] },
      { key: 'ship', label: '배송비(주문 1회당)', type: 'won', unit: '원', placeholder: '무료면 0' },
      { key: 'orders', label: '한 달 주문 횟수', type: 'number' },
      { key: 'minOrder', label: '최소 주문금액', type: 'won', unit: '원' },
      { key: 'date', label: '최근 구매일', type: 'date' },
      { key: 'supplier', label: '구매처', type: 'text' },
    ],
    allow: LATER,
  },
  {
    id: 'p_upload', area: 'purchase', type: 'upload', kind: 'receipt', depth: 'deep', label: '거래명세서·영수증',
    text: '거래명세서나 매입 영수증이 있으면 올려주세요. (선택)',
    help: '숫자를 옮겨 적은 뒤 사장님이 확인한 값만 분석에 써요.',
    allow: ['na', 'later'],
  },
  {
    id: 'p_compared', area: 'purchase', type: 'choice', depth: 'core', label: '가격 비교 경험',
    text: '다른 곳 가격과 비교해 본 적이 있나요?',
    options: [{ v: 'recent', label: '최근 3개월 안에 해봤어요' }, { v: 'old', label: '오래전에 해봤어요' }, { v: 'never', label: '해본 적 없어요' }],
    allow: LATER,
  },
  {
    id: 'p_waste', area: 'purchase', type: 'choice', depth: 'core', label: '재료 폐기 빈도',
    text: '재료가 남아서 버리는 일이 얼마나 있나요?',
    options: [{ v: 'rare', label: '거의 없어요' }, { v: 'sometimes', label: '가끔 있어요' }, { v: 'often', label: '자주 있어요' }],
    allow: LATER,
  },
  {
    id: 'p_waste_detail', area: 'purchase', type: 'list', depth: 'core', label: '버리는 재료',
    text: '어떤 재료를, 얼마나, 왜 버리게 되나요?',
    fields: [
      { key: 'item', label: '재료', type: 'text', required: true, placeholder: '예: 양상추' },
      { key: 'amount', label: '버리는 양(일주일)', type: 'text', placeholder: '예: 2kg, 반 박스' },
      { key: 'weeklyCost', label: '대략 금액(일주일)', type: 'won', unit: '원' },
      { key: 'reason', label: '이유', type: 'select', options: [['expiry', '유통기한이 지나서'], ['over', '너무 많이 주문해서'], ['prep', '미리 손질했는데 남아서'], ['slow', '잘 안 팔리는 메뉴 전용이라'], ['storage', '보관 문제(상함)'], ['etc', '기타']] },
    ],
    when: (c) => ['sometimes', 'often'].includes(c.v('p_waste')),
    allow: LATER,
  },
  {
    id: 'p_stock', area: 'purchase', type: 'choice', depth: 'core', label: '재고 확인 방법',
    text: '재고는 어떻게 확인하나요?',
    options: [{ v: 'sheet', label: '정해진 표로 확인해요' }, { v: 'eye', label: '눈으로 대충 봐요' }, { v: 'none', label: '따로 확인하지 않아요' }],
    allow: LATER,
  },

  // ───────── 고객
  {
    id: 'cu_segments', area: 'customer', type: 'multi', depth: 'core', label: '주요 고객층',
    text: '주로 어떤 손님이 오나요?',
    options: [
      { v: 'office', label: '근처 직장인' }, { v: 'student', label: '학생' }, { v: 'local', label: '동네 주민·가족' },
      { v: 'single', label: '1인 가구' }, { v: 'visitor', label: '관광객·외부 방문객' }, { v: 'friends', label: '연인·친구 모임' },
      { v: 'delivery', label: '배달 손님' },
    ],
    allow: LATER,
  },
  {
    id: 'cu_purpose', area: 'customer', type: 'multi', depth: 'core', label: '방문 목적',
    text: '손님들은 주로 어떤 목적으로 오나요?',
    options: (c) => c.biz === 'cafe'
      ? [{ v: 'takeout', label: '테이크아웃' }, { v: 'talk', label: '대화·모임' }, { v: 'work', label: '공부·업무' }, { v: 'dessert', label: '디저트' }, { v: 'meal', label: '식사 대용' }]
      : [{ v: 'lunch', label: '점심 식사' }, { v: 'dinner', label: '저녁 식사' }, { v: 'group', label: '회식·모임' }, { v: 'drink', label: '술자리' }, { v: 'quick', label: '간단한 한 끼' }],
    allow: LATER,
  },
  {
    id: 'cu_repeat', area: 'customer', type: 'choice', depth: 'core', label: '단골 비중',
    text: '다시 오는 손님(단골)은 어느 정도인가요?',
    options: [{ v: 'high', label: '절반 이상이에요' }, { v: 'mid', label: '비슷해요' }, { v: 'low', label: '적어요' }, { v: 'unknown', label: '잘 모르겠어요' }],
    allow: LATER,
  },
  {
    id: 'cu_repeat_basis', area: 'customer', type: 'choice', depth: 'core', label: '단골 판단 근거',
    text: '그렇게 판단한 근거는 무엇인가요? 실제 기록이 있나요?',
    options: [
      { v: 'record', label: '스탬프·포인트·예약 기록이 있어요' }, { v: 'app', label: '배달앱 재주문 통계를 봤어요' },
      { v: 'feeling', label: '체감이에요 (얼굴로 기억)' },
    ],
    when: (c) => c.answered('cu_repeat') && c.v('cu_repeat') !== 'unknown',
    allow: LATER,
  },
  {
    id: 'cu_source', area: 'customer', type: 'multi', depth: 'core', label: '새 손님 유입 경로',
    text: '새 손님은 주로 어떻게 알고 오나요?',
    options: [
      { v: 'walk', label: '지나가다가' }, { v: 'naver', label: '네이버 지도·검색' }, { v: 'insta', label: '인스타그램' },
      { v: 'blog', label: '블로그 후기' }, { v: 'app', label: '배달앱' }, { v: 'friend', label: '지인 추천' }, { v: 'unknown', label: '잘 모르겠어요' },
    ],
    allow: LATER,
  },
  {
    id: 'cu_source_basis', area: 'customer', type: 'choice', depth: 'core', label: '유입 경로 판단 근거',
    text: '유입 경로는 어떻게 알게 되셨나요?',
    options: [{ v: 'asked', label: '손님에게 물어봤어요' }, { v: 'stats', label: '통계 화면(플레이스·인스타 등)을 봤어요' }, { v: 'guess', label: '짐작이에요' }],
    when: (c) => c.answered('cu_source') && !c.has('cu_source', 'unknown'),
    allow: LATER,
  },
  {
    id: 'cu_praise', area: 'customer', type: 'text', depth: 'core', label: '자주 듣는 칭찬',
    text: '손님들이 자주 하는 칭찬은 무엇인가요?',
    example: '예: 양이 많아요, 사장님이 친절해요, 커피가 진해요',
    allow: ['unknown', 'later'],
  },
  {
    id: 'cu_complaint', area: 'customer', type: 'text', depth: 'core', label: '자주 듣는 불편',
    text: '손님들이 자주 말하는 불편이나 불만은 무엇인가요?',
    example: '예: 점심에 너무 오래 기다려요, 의자가 불편해요, 화장실이 멀어요',
    allow: ['unknown', 'later'],
  },
  {
    id: 'cu_review_reply', area: 'customer', type: 'choice', depth: 'core', label: '리뷰 답글',
    text: '온라인 리뷰에 답글을 다나요?',
    options: [{ v: 'most', label: '대부분 달아요' }, { v: 'some', label: '가끔 달아요' }, { v: 'no', label: '안 달아요' }, { v: 'few', label: '리뷰가 거의 없어요' }],
    allow: LATER,
  },
  {
    id: 'cu_upload', area: 'customer', type: 'upload', kind: 'review', depth: 'deep', label: '리뷰·문의 화면',
    text: '고객 리뷰나 문의 화면 캡처가 있으면 올려주세요. (선택)',
    allow: ['na', 'later'],
  },

  // ───────── 마케팅
  {
    id: 'mk_channels', area: 'marketing', type: 'multi', depth: 'core', label: '운영 중인 온라인 채널',
    text: '현재 운영하는 온라인 채널을 모두 골라주세요.',
    options: [
      { v: 'place', label: '네이버 플레이스(지도)' }, { v: 'blog', label: '블로그' }, { v: 'insta', label: '인스타그램' },
      { v: 'threads', label: '스레드' }, { v: 'app', label: '배달앱 가게 페이지' }, { v: 'daangn', label: '당근 비즈프로필' },
      { v: 'kakao', label: '카카오톡 채널' }, { v: 'none', label: '운영하는 채널이 없어요' },
    ],
    allow: LATER,
  },
  {
    id: 'mk_place_updated', area: 'marketing', type: 'choice', depth: 'core', label: '플레이스 정보 최신 여부',
    text: '네이버 플레이스의 메뉴·가격·영업시간·사진이 지금과 같나요?',
    options: [{ v: 'yes', label: '모두 지금과 같아요' }, { v: 'partly', label: '일부 달라요' }, { v: 'unknown', label: '확인해 보지 않았어요' }],
    when: (c) => c.has('mk_channels', 'place'),
    allow: LATER,
  },
  {
    id: 'mk_freq', area: 'marketing', type: 'choice', depth: 'core', label: 'SNS 게시 빈도',
    text: '새 글이나 사진은 얼마나 자주 올리나요?',
    options: [{ v: 'w2', label: '일주일에 2번 이상' }, { v: 'w1', label: '일주일에 1번' }, { v: 'm1', label: '한 달에 1~3번' }, { v: 'rare', label: '거의 안 올려요' }],
    when: (c) => ['blog', 'insta', 'threads', 'kakao', 'daangn'].some((x) => c.has('mk_channels', x)),
    allow: LATER,
  },
  {
    id: 'mk_ads_list', area: 'marketing', type: 'list', depth: 'core', label: '광고 집행 내역',
    text: '광고는 어디에 얼마씩 쓰고 있나요?',
    fields: [
      { key: 'channel', label: '광고 채널', type: 'text', required: true, placeholder: '예: 네이버 플레이스 광고, 배달앱 깃발' },
      { key: 'monthly', label: '한 달 금액', type: 'won', unit: '원' },
      { key: 'since', label: '시작 시기', type: 'text', placeholder: '예: 2026년 3월부터' },
      { key: 'track', label: '성과 확인', type: 'select', options: [['number', '숫자로 확인해요'], ['feel', '느낌으로만'], ['none', '확인 안 해요']] },
    ],
    when: (c) => c.adsSpend() > 0,
    allow: LATER,
  },
  {
    id: 'mk_ads_track', area: 'marketing', type: 'choice', depth: 'core', label: '광고 성과 확인',
    text: '광고로 들어온 주문이나 예약을 확인하고 있나요?',
    options: [{ v: 'number', label: '숫자로 확인해요' }, { v: 'feel', label: '대략 느낌으로만 알아요' }, { v: 'none', label: '확인하지 않아요' }],
    when: (c) => c.adsSpend() > 0,
    allow: LATER,
  },
  {
    id: 'mk_skill', area: 'marketing', type: 'multi', depth: 'core', label: '직접 할 수 있는 홍보 작업',
    text: '직접 할 수 있는 것을 모두 골라주세요.',
    options: [
      { v: 'photo', label: '휴대폰으로 음식 사진 찍기' }, { v: 'video', label: '짧은 영상 찍기' },
      { v: 'write', label: '짧은 글쓰기' }, { v: 'reply', label: '리뷰 답글 달기' }, { v: 'none', label: '모두 어려워요' },
    ],
    why: '직접 하는 홍보도 시간과 노동이 들어요. 할 수 있는 것부터 추천해요.',
    allow: LATER,
  },
  {
    id: 'mk_upload', area: 'marketing', type: 'upload', kind: 'ads', depth: 'deep', label: '광고 성과 화면',
    text: '광고 집행 내역이나 성과 화면 캡처가 있으면 올려주세요. (선택)',
    when: (c) => c.adsSpend() > 0,
    allow: ['na', 'later'],
  },

  // ───────── 가격·경쟁
  {
    id: 'pr_rival', area: 'price', type: 'text', depth: 'core', label: '경쟁 상대',
    text: '사장님이 생각하는 가장 큰 경쟁 상대는 어디인가요?',
    example: '예: 길 건너 ○○국밥, 편의점 도시락, 저가 커피 프랜차이즈',
    allow: ['unknown', 'later'],
  },
  {
    id: 'pr_position', area: 'price', type: 'choice', depth: 'core', label: '주변 대비 가격 수준',
    text: '주변 비슷한 가게와 비교하면 우리 가격은 어떤가요?',
    options: [{ v: 'higher', label: '더 비싸요' }, { v: 'similar', label: '비슷해요' }, { v: 'lower', label: '더 싸요' }, { v: 'unknown', label: '잘 모르겠어요' }],
    allow: LATER,
  },
  {
    id: 'pr_reason', area: 'price', type: 'multi', depth: 'core', label: '가격이 높은 이유',
    text: '가격이 더 높은 이유가 있다면 무엇인가요?',
    options: [
      { v: 'quality', label: '더 좋은 재료를 써요' }, { v: 'portion', label: '양이 더 많아요' },
      { v: 'handmade', label: '직접 만드는 과정이 많아요' }, { v: 'space', label: '공간·서비스가 달라요' },
      { v: 'cost', label: '임대료 등 비용 때문이에요' }, { v: 'none', label: '특별한 이유는 없어요' },
    ],
    why: '가격을 내리기 전에, 손님이 그 가치를 알 수 있게 보여주는 방법을 먼저 검토해요.',
    when: (c) => c.v('pr_position') === 'higher',
    allow: LATER,
  },
  {
    id: 'pr_basis', area: 'price', type: 'choice', depth: 'core', label: '가격 책정 방식',
    text: '가격은 어떻게 정하셨나요?',
    options: [{ v: 'cost', label: '원가를 계산해서' }, { v: 'market', label: '주변 시세를 보고' }, { v: 'feel', label: '감으로' }, { v: 'hq', label: '본사가 정해요' }],
    allow: LATER,
  },
  {
    id: 'pr_diff', area: 'price', type: 'text', depth: 'core', label: '차별점',
    text: '우리 가게만의 차별점은 무엇인가요?',
    example: '예: 매일 아침 직접 끓이는 육수, 원두를 직접 볶아요',
    allow: ['unknown', 'later'],
  },
  {
    id: 'pr_competitors', area: 'price', type: 'list', depth: 'deep', label: '주변 경쟁점 비교',
    text: '비교해 보고 싶은 주변 가게를 알려주세요.',
    help: '메뉴 이름이 같아도 양·재료·서비스가 다를 수 있어요. 확인한 방법과 날짜를 함께 적어주세요.',
    fields: [
      { key: 'name', label: '가게 이름', type: 'text', required: true },
      { key: 'distance', label: '거리', type: 'number', unit: 'm' },
      { key: 'menu', label: '비교할 메뉴', type: 'text', placeholder: '예: 김치찌개' },
      { key: 'price', label: '그 메뉴 가격', type: 'won', unit: '원' },
      { key: 'portion', label: '양·구성', type: 'text', placeholder: '예: 1인분, 공기밥 포함' },
      { key: 'myMenu', label: '우리 가게 비교 메뉴', type: 'text', placeholder: '예: 김치찌개' },
      { key: 'myPortion', label: '우리 메뉴 양·구성', type: 'text', placeholder: '예: 1인분, 공기밥 포함' },
      { key: 'diff', label: '다른 점', type: 'text' },
      { key: 'source', label: '확인 방법', type: 'select', options: [['visit', '직접 방문'], ['place', '네이버 플레이스'], ['app', '배달앱'], ['sns', 'SNS'], ['hearsay', '들은 이야기']] },
      { key: 'date', label: '확인 날짜', type: 'date' },
    ],
    when: (c) => c.concern('sales_down') || c.v('pr_position') !== 'unknown' && c.answered('pr_position'),
    allow: LATER,
  },

  // ───────── 매장 환경
  {
    id: 'e_visible', area: 'env', type: 'choice', depth: 'core', label: '간판 가시성',
    text: '가게 앞 길에서 간판이 잘 보이나요?',
    options: [{ v: 'yes', label: '낮이나 밤이나 잘 보여요' }, { v: 'day', label: '낮에만 잘 보여요' }, { v: 'no', label: '잘 안 보여요' }, { v: 'unknown', label: '잘 모르겠어요' }],
    when: (c) => c.hallish() || c.v('b_split') == null,
    allow: LATER,
  },
  {
    id: 'e_outside_menu', area: 'env', type: 'choice', depth: 'core', label: '밖에서 보이는 메뉴·가격',
    text: '가게 밖에서 메뉴와 가격을 볼 수 있나요?',
    options: [{ v: 'yes', label: '네, 볼 수 있어요' }, { v: 'no', label: '아니요' }],
    when: (c) => c.hallish(),
    allow: LATER,
  },
  {
    id: 'e_menu_board', area: 'env', type: 'multi', depth: 'core', label: '매장 메뉴판 상태',
    text: '매장 메뉴판에 해당하는 것을 골라주세요.',
    options: [
      { v: 'price_clear', label: '가격이 잘 보여요' }, { v: 'photo', label: '사진이 있어요' }, { v: 'recommend', label: '추천 표시가 있어요' },
      { v: 'small', label: '글씨가 작아요' }, { v: 'crowded', label: '메뉴가 너무 많아 보여요' }, { v: 'old', label: '가격을 덧붙이거나 고친 흔적이 있어요' },
    ],
    when: (c) => c.hallish(),
    allow: LATER,
  },
  {
    id: 'e_issues', area: 'env', type: 'multi', depth: 'core', label: '매장 불편 요소',
    text: '매장에서 신경 쓰이는 점을 모두 골라주세요.',
    options: [
      { v: 'dark', label: '조명이 어두워요' }, { v: 'noise', label: '시끄러워요' }, { v: 'smell', label: '냄새(주방·하수구)가 나요' },
      { v: 'seat', label: '좌석이 불편해요' }, { v: 'temp', label: '냉난방이 아쉬워요' }, { v: 'flow', label: '주문·픽업 동선이 헷갈려요' },
      { v: 'none', label: '특별히 없어요' },
    ],
    when: (c) => c.hallish(),
    allow: LATER,
  },
  {
    id: 'e_access', area: 'env', type: 'choice', depth: 'core', label: '접근성·주차',
    text: '찾아오기나 주차는 쉬운가요?',
    options: [{ v: 'easy', label: '쉬워요' }, { v: 'parking', label: '주차가 어려워요' }, { v: 'hidden', label: '골목·2층 등 찾기 어려워요' }, { v: 'both', label: '둘 다 어려워요' }],
    allow: LATER,
  },
  {
    id: 'e_control', area: 'env', type: 'multi', depth: 'core', label: '건물주·관리 영역',
    text: '건물주나 관리사무소와 협의해야 바꿀 수 있는 곳을 골라주세요.',
    options: [{ v: 'sign', label: '간판' }, { v: 'facade', label: '외관·입구' }, { v: 'restroom', label: '화장실' }, { v: 'corridor', label: '공용 복도' }, { v: 'none', label: '없어요' }],
    allow: LATER,
  },
  {
    id: 'e_photo_spot', area: 'env', type: 'choice', depth: 'deep', label: '사진 찍는 공간',
    text: '손님이 사진을 찍는 공간이나 소품이 있나요?',
    options: [{ v: 'yes', label: '있고 손님들이 자주 찍어요' }, { v: 'some', label: '있지만 잘 안 찍어요' }, { v: 'no', label: '없어요' }],
    when: (c) => c.hallish() && c.biz === 'cafe',
    allow: LATER,
  },
  {
    id: 'e_upload', area: 'env', type: 'upload', kind: 'store', depth: 'core', label: '입구·간판·내부 사진',
    text: '가게 입구, 간판, 매장 내부 사진이 있으면 올려주세요. (선택)',
    when: (c) => c.hallish(),
    allow: ['na', 'later'],
  },

  // ───────── 청결·화장실
  {
    id: 'cl_who', area: 'clean', type: 'choice', depth: 'core', label: '청소 담당·주기',
    text: '청소는 누가, 언제 하나요?',
    options: [{ v: 'fixed', label: '정해진 담당과 시간이 있어요' }, { v: 'adhoc', label: '상황 봐서 해요' }, { v: 'owner', label: '사장님이 틈틈이 혼자 해요' }],
    allow: LATER,
  },
  {
    id: 'cl_check', area: 'clean', type: 'choice', depth: 'core', label: '청소 점검표',
    text: '청소 점검표(체크리스트)가 있나요?',
    options: [{ v: 'daily', label: '있고 매일 확인해요' }, { v: 'unused', label: '있지만 잘 안 써요' }, { v: 'none', label: '없어요' }],
    why: '세제 종류보다 "누가 언제 확인하는지"가 실제 청결을 좌우해요.',
    allow: LATER,
  },
  {
    id: 'cl_deep', area: 'clean', type: 'choice', depth: 'core', label: '최근 대청소·방역',
    text: '최근 대청소나 전문 방역(소독)은 언제 했나요?',
    options: [{ v: '1m', label: '1개월 안' }, { v: '3m', label: '3개월 안' }, { v: '6m', label: '6개월 안' }, { v: 'older', label: '그보다 오래전' }, { v: 'unknown', label: '잘 모르겠어요' }],
    allow: LATER,
  },
  {
    id: 'cl_rest_where', area: 'clean', type: 'choice', depth: 'core', label: '화장실 위치',
    text: '손님이 쓰는 화장실은 어디에 있나요?',
    options: [{ v: 'inside', label: '매장 안' }, { v: 'floor', label: '건물 같은 층 공용' }, { v: 'outside', label: '건물 밖이나 다른 층' }, { v: 'none', label: '손님용 화장실이 없어요' }],
    when: (c) => c.hallish(),
    allow: LATER,
  },
  {
    id: 'cl_rest_sep', area: 'clean', type: 'choice', depth: 'core', label: '남녀 구분',
    text: '화장실은 남녀가 나뉘어 있나요?',
    options: [{ v: 'sep', label: '나뉘어 있어요' }, { v: 'shared', label: '남녀 공용이에요' }],
    when: (c) => c.hallish() && c.answered('cl_rest_where') && c.v('cl_rest_where') !== 'none',
    allow: LATER,
  },
  {
    id: 'cl_rest_items', area: 'clean', type: 'multi', depth: 'core', label: '화장실 비품',
    text: '화장실에 갖춰진 것을 모두 골라주세요.',
    options: [
      { v: 'lock', label: '잘 잠기는 문' }, { v: 'light', label: '밝은 조명' }, { v: 'mirror', label: '거울' },
      { v: 'soap', label: '비누·손 세정제' }, { v: 'paper', label: '휴지' }, { v: 'towel', label: '핸드타월·핸드드라이어' },
      { v: 'bin', label: '뚜껑 있는 휴지통' }, { v: 'fan', label: '환기팬' },
    ],
    when: (c) => c.hallish() && c.answered('cl_rest_where') && c.v('cl_rest_where') !== 'none',
    allow: LATER,
  },
  {
    id: 'cl_rest_issues', area: 'clean', type: 'multi', depth: 'core', label: '화장실 문제',
    text: '화장실에서 생기는 문제를 골라주세요.',
    options: [
      { v: 'smell', label: '냄새' }, { v: 'dirty', label: '물 고임·오염' }, { v: 'supplies', label: '소모품이 자주 떨어져요' },
      { v: 'lockbroken', label: '잠금이 불안해요' }, { v: 'complaint', label: '손님 불만을 들은 적 있어요' }, { v: 'none', label: '특별히 없어요' },
    ],
    when: (c) => c.hallish() && c.answered('cl_rest_where') && c.v('cl_rest_where') !== 'none',
    allow: LATER,
  },
  {
    id: 'cl_rest_manage', area: 'clean', type: 'choice', depth: 'core', label: '화장실 관리 주체',
    text: '화장실 청소와 관리는 누가 하나요?',
    options: [{ v: 'us', label: '우리 가게가 해요' }, { v: 'building', label: '건물 관리 쪽에서 해요' }, { v: 'mixed', label: '나눠서 해요' }],
    when: (c) => c.hallish() && c.answered('cl_rest_where') && ['floor', 'outside'].includes(c.v('cl_rest_where')),
    allow: LATER,
  },
  {
    id: 'cl_upload', area: 'clean', type: 'upload', kind: 'restroom', depth: 'deep', label: '화장실 사진',
    text: '사람이 나오지 않게 찍은 화장실 사진이 있으면 올려주세요. (선택)',
    help: '거울에 사람이 비치지 않게 찍어주세요.',
    when: (c) => c.hallish() && c.answered('cl_rest_where') && c.v('cl_rest_where') !== 'none',
    allow: ['na', 'later'],
  },
];

export const QMAP = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));

export const UPLOAD_KINDS = [
  { v: 'menu_board', label: '메뉴판·가격표' },
  { v: 'dish', label: '대표 메뉴·실제 제공 사진' },
  { v: 'store', label: '입구·간판·매장 내부' },
  { v: 'restroom', label: '화장실 (사람 없이)' },
  { v: 'receipt', label: '거래명세서·매입 영수증' },
  { v: 'sales_file', label: '매출 내역·POS 파일 (CSV)' },
  { v: 'ads', label: '광고 집행·성과 화면' },
  { v: 'review', label: '고객 리뷰·문의 화면' },
  { v: 'other', label: '기타' },
];
