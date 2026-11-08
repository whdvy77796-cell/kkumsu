// 매출올려드림 AI · 가게 인터뷰 질문 (운영 설계 문서 기준)
// 설계 원칙
//  1. 모든 사장님에게 같은 질문을 전부 묻지 않는다: 기본 질문 + 가장 큰 고민·운영 방식·AI가 찾은 신호에 맞는 추가 질문
//  2. 앞에서 입력한 대표 메뉴 이름을 이후 질문에 그대로 쓴다
//  3. 배달을 하지 않으면 배달 질문은 건너뛴다
//  4. 비용을 모르면 기록 방법을 안내하고, 알면 세부 비용으로 넘어간다
//  5. AI가 찾은 정보와 앞의 답은 미리 채워 다시 입력하지 않게 한다
//  6. 필요한 질문에는 '잘 모름·대략 입력·해당 없음'을 둔다

// ───────── 한국어 조사
function hasBatchim(word) {
  const ch = String(word || '').trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return /[0-9lmnLMN]$/.test(ch);
}
export const josa = (word, withB, withoutB) => `${word}${hasBatchim(word) ? withB : withoutB}`;

// ───────── 선택지
const opts = (...labels) => labels.map((l) => (Array.isArray(l) ? { v: l[0], label: l[1], desc: l[2] } : { v: l, label: l }));
const FREQ = opts('자주 있어요', '가끔 있어요', '거의 없어요');

export const CATEGORIES = ['한식', '국밥·탕·찌개', '고기·구이', '분식', '면 요리', '중식', '일식', '양식', '치킨·피자·버거', '주점·포차', '카페', '베이커리·디저트', '기타'];
export const PROBLEMS = [
  { v: 'acquisition', label: '새 손님이 부족해요', desc: '가게를 알고 찾아오는 손님이 적어요' },
  { v: 'profit', label: '팔아도 남는 게 적어요', desc: '매출에 비해 이익이 적어요' },
  { v: 'repeat', label: '다시 오는 손님이 적어요', desc: '재방문·단골이 늘지 않아요' },
  { v: 'labor', label: '일손이 부족하거나 인건비가 부담돼요', desc: '바쁜 시간이 버겁거나 인건비가 커요' },
];
export const STATUS_LABEL = { approx: '대략', unknown: '잘 모름', na: '해당 없음' };

// ───────── AI가 찾은 정보에서 읽어내는 값
const CAT_RULES = [
  ['카페', /카페|커피|티룸|찻집/], ['베이커리·디저트', /베이커리|빵집|제과|디저트|케이크/],
  ['국밥·탕·찌개', /국밥|곰탕|설렁탕|해장국|찌개|전골|탕/], ['고기·구이', /고기|구이|갈비|삼겹|불고기|숯불|곱창|막창|정육/],
  ['면 요리', /냉면|국수|칼국수|우동|라멘|쌀국수|소바|면/], ['분식', /분식|떡볶이|김밥|순대/],
  ['중식', /중식|중국|짜장|짬뽕|마라|딤섬/], ['일식', /일식|스시|초밥|돈가스|돈까스|이자카야|오마카세/],
  ['치킨·피자·버거', /치킨|피자|버거/], ['양식', /양식|파스타|스테이크|브런치|이탈리안|비스트로/],
  ['주점·포차', /주점|술집|포차|호프|펍|와인바/], ['한식', /한식|백반|한정식|비빔밥|보쌈|족발/],
];
export function guessCategory(text) {
  if (!text) return null;
  let best = null;
  for (const [cat, re] of CAT_RULES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.i)) best = { cat, i: m.index };
  }
  return best?.cat || null;
}
export function guessPeriod(openedYear, now = new Date()) {
  const m = String(openedYear || '').match(/(19|20)\d{2}/);
  if (!m) return null;
  const years = now.getFullYear() - Number(m[0]);
  if (years < 1) return '1년 미만';
  if (years < 3) return '1~3년';
  if (years < 5) return '3~5년';
  return '5년 이상';
}
export function guessServices(store) {
  if (!store) return null;
  const s = store.services || {};
  const text = [...(store.features || []), store.category || ''].join(' ');
  const pick = (v, yes, no) => (typeof v === 'boolean' ? v : no.test(text) ? false : yes.test(text) ? true : null);
  return {
    hall: pick(s.hall, /.^/, /배달 ?전문|포장 ?전문|테이크아웃 ?전문/) ?? true,
    takeout: pick(s.takeout, /포장|테이크아웃/, /포장 ?(불가|안 ?됨|안 ?함)/),
    delivery: pick(s.delivery, /배달/, /배달 ?(불가|안 ?됨|안 ?함|하지 않)/),
  };
}

const FLAG_RULES = {
  wait: /대기|웨이팅|줄이 길|줄을 서|오래 기다/,
  price: /비싸|가격 부담|가격이 높|가성비가 (아쉽|떨)/,
  portion: /양이 (적|줄|아쉽)/,
  service: /불친절|응대|서비스 (불만|아쉽)|직원 (태도|서비스)|무뚝뚝/,
  hygiene: /위생|청결|더럽|지저분|벌레|냄새/,
  restroom: /화장실/,
  parking: /주차/,
  seat: /좁|자리가 불편|좌석|의자|춥|덥|추웠|더웠|시끄|에어컨|난방/,
  entrance: /찾기 어렵|입구|간판|헤맸/,
  consistency: /맛이 (변|달라)|예전 같지|들쭉날쭉|일정하지/,
};
const THEME_FLAG = { 대기: 'wait', 가격: 'price', 양: 'portion', 친절: 'service', 위생: 'hygiene', 화장실: 'restroom', 주차: 'parking' };
export function storeFlags(store) {
  const flags = {};
  if (!store) return flags;
  // 불평 하나씩 본다. 화장실 이야기("화장실이 좁다")는 좌석 신호로 세지 않는다.
  for (const w of store.weaknesses || []) {
    if (FLAG_RULES.restroom.test(w)) {
      flags.restroom = true;
      if (FLAG_RULES.hygiene.test(w)) flags.hygiene = true;
      continue;
    }
    for (const [k, re] of Object.entries(FLAG_RULES)) if (re.test(w)) flags[k] = true;
  }
  for (const t of store.reviewThemes || []) {
    if ((t.tone === 'bad' || t.tone === 'mixed') && THEME_FLAG[t.theme]) flags[THEME_FLAG[t.theme]] = true;
  }
  return flags;
}
function flagNote(store, theme, re) {
  const t = (store?.reviewThemes || []).find((x) => x.theme === theme && x.tone !== 'good');
  if (t?.note) return t.note;
  return (store?.weaknesses || []).find((w) => re.test(w)) || null;
}
// "불고기(1인분 150g) 46,000원" → 46000 (원 앞의 숫자를 우선, 없으면 가장 큰 숫자)
const toWon = (s) => {
  const t = String(s || '');
  const won = t.match(/(\d[\d,]*)\s*원/);
  if (won) return Number(won[1].replace(/,/g, ''));
  const nums = (t.match(/\d[\d,]*/g) || []).map((x) => Number(x.replace(/,/g, '')));
  return nums.length ? Math.max(...nums) : '';
};

// ───────── 답·상태 읽기
export function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[,\s원만%]/g, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const SOUPY = /국|탕|찌개|국밥|짬뽕|라면|우동|칼국수|국수|냉면|전골|떡볶이|파스타|카레|마라|쌀국수|샤브|짜장/;
const SIDES_CATS = ['한식', '국밥·탕·찌개', '고기·구이', '중식', '면 요리'];
const NO_RESERVE = ['분식', '카페', '베이커리·디저트', '치킨·피자·버거'];

export function buildCtx(S, store) {
  const A = S.answers || {};
  const st = (id) => A[id]?.s;
  const val = (id) => (A[id] && (A[id].s === 'ok' || A[id].s === 'approx') ? A[id].v : undefined);
  const split = val('a_split') || {};
  const on = (k) => !!split?.[k]?.on;
  const menus = (val('c_menus') || []).filter((r) => r && String(r.name || '').trim());
  const worry = st('c_worry') === 'na' ? null : (val('c_worry') || [])[0];
  const menuName = menus[0]?.name?.trim() || store?.menu?.[0]?.name || '대표 메뉴';
  const staffV = val('a_staff');
  const staffRaw = parseNum(staffV && typeof staffV === 'object' ? staffV.staff : staffV);
  const basic = val('a_basic') || {};
  const category = basic.category || guessCategory(store?.category) || '';
  const customers = val('a_customers') || {};
  const rest = val('i_rest') || {};
  const spent = val('e_spend') && Object.values(val('e_spend')).some((x) => (parseNum(x) || 0) > 0);
  const c = {
    S, A, st, val, store, flags: storeFlags(store),
    hasHall: on('hall'), hasTakeout: on('takeout'), hasDelivery: on('delivery'),
    channelsOn: ['hall', 'takeout', 'delivery'].filter(on).length,
    menus, worry, menuName, staff: staffRaw ?? 0, hasStaff: (staffRaw ?? 0) > 0,
    problem: (() => { const p = val('a_problem'); return (p && typeof p === 'object' ? p.value : p) || null; })(),
    costKnow: val('b_know') || null,
    category, soupy: SOUPY.test(menuName) || ['국밥·탕·찌개', '면 요리'].includes(category),
    sidesCat: SIDES_CATS.includes(category),
    foodCat: !['카페', '베이커리·디저트'].includes(category),
    reserveCat: !NO_RESERVE.includes(category),
    dateCrowd: (customers.who || []).some((x) => /연인|친구/.test(x)) || ['카페', '베이커리·디저트'].includes(category),
    restroom: rest.type && rest.type !== 'none' ? rest.type : null,
    womenRoom: rest.sep === 'split' ? '여자화장실' : '화장실',
    spent: !!spent,
  };
  c.is = (p) => c.problem === p;
  c.unit = c.soupy ? '한 그릇' : category === '고기·구이' ? '1인분' : ['카페', '베이커리·디저트'].includes(category) ? '하나' : '1인분';
  return c;
}

// ───────── 화면(페이지)
export const PAGES = [
  { id: 'basic', title: '가게 기본 정보', desc: '정확한 매장과 손님, 판매 방식을 먼저 확인해요. AI가 찾은 정보는 미리 채워 두었으니 틀린 곳만 고쳐 주세요.' },
  { id: 'money', title: '목표와 매출·비용', desc: '무엇을 먼저 해결할지 정하고, 실제로 얼마나 남는지 확인해요.' },
  { id: 'menu', title: '대표 메뉴', desc: '많이 팔리는 메뉴 3개와 수익성이 걱정되는 메뉴 1개를 집중해서 볼게요.' },
  { id: 'menuDetail', title: (c) => `${c.menuName} 자세히`, desc: '가격·원가·조리 부담을 함께 확인해요.' },
  { id: 'sides', title: '반찬과 잔반', desc: '반찬이 나가는 방식과 손님이 남기는 음식을 함께 봐요. 남는 음식은 손님 만족과 재료비를 함께 알려주는 자료예요.' },
  { id: 'purchase', title: '식재료 구매와 재고', desc: '구매가격과 버리는 손실을 함께 봐요.' },
  { id: 'marketing', title: '마케팅과 SNS', desc: '쓴 돈과 실제로 늘어난 손님을 연결해서 봐요.' },
  { id: 'experience', title: '리뷰와 손님 경험', desc: '반복되는 불편과 지켜야 할 강점을 함께 찾아요.' },
  { id: 'basics', title: '기본 서비스와 손님 앞 기본', desc: '담요 같은 기본 서비스와, 사장님·직원의 식사와 청소가 손님 눈에 띄지 않는지 확인해요.' },
  { id: 'clean', title: '청소와 화장실', desc: '청결과 편의, 공간의 인상까지 확인해요.' },
  { id: 'ops', title: '운영·배달·직원', desc: '실제로 남는 돈과 일의 변화를 기준으로 판단해요.' },
  { id: 'finish', title: '실행 준비', desc: '이미 해본 것과 실제로 맡을 사람을 확인해요.' },
];

// ───────── 질문
// type: choice | multi | text | number | money | group | split | rows | costs | channels | reviews | menucost
// allow: 질문 단위로 고를 수 있는 상태 (unknown 잘 모름 · approx 대략 입력 · na 해당 없음)
// 관련 있는 질문은 한 카드에 묶었다. AI가 찾은 리뷰 신호는 신호마다 카드 하나만 더한다.
export const QUESTIONS = [
  // ── 2. 가게 기본 정보와 목표
  {
    id: 'a_basic', page: 'basic', type: 'group',
    title: '업종과 운영 기간을 확인해 주세요.',
    hint: (c) => (c.store?.category ? `AI가 찾은 업종: ${c.store.category}${c.store.openedYear ? ` · ${c.store.openedYear}` : ''}` : null),
    fields: [
      { key: 'category', label: '업종', type: 'choice', options: opts(...CATEGORIES) },
      { key: 'period', label: '운영 기간', type: 'choice', options: opts('1년 미만', '1~3년', '3~5년', '5년 이상', '잘 모르겠어요') },
    ],
    prefill: (c) => {
      const category = guessCategory(c.store?.category);
      const period = guessPeriod(c.store?.openedYear);
      return category || period ? { category: category || '', period: period || '' } : null;
    },
    why: '정확한 매장을 확인하고 주변 상권·경쟁점·접근성을 살펴보는 기준이 돼요.',
  },
  {
    id: 'a_channels', page: 'basic', type: 'channels',
    title: '네이버 플레이스·카카오맵·인스타그램·배달앱 주소가 있나요?',
    hint: (c) => (c.store?.channels?.length ? 'AI가 찾은 주소를 미리 넣었어요. 틀리거나 빠진 곳만 고쳐 주세요.' : null),
    items: [
      { key: 'naver', label: '네이버 플레이스', placeholder: 'https://naver.me/...' },
      { key: 'kakao', label: '카카오맵', placeholder: 'https://place.map.kakao.com/...' },
      { key: 'insta', label: '인스타그램', placeholder: '@계정 또는 주소' },
      { key: 'delivery', label: '배달앱', placeholder: '앱 이름과 가게 이름' },
      { key: 'other', label: '홈페이지·기타', placeholder: 'https://' },
    ],
    prefill: (c) => {
      const out = {};
      for (const ch of c.store?.channels || []) {
        const t = `${ch.type} ${ch.url}`;
        const key = /네이버|naver/i.test(t) ? 'naver' : /카카오|kakao/i.test(t) ? 'kakao' : /인스타|instagram/i.test(t) ? 'insta' : /배달|baemin|배민|쿠팡이츠|요기요|yogiyo|coupangeats/i.test(t) ? 'delivery' : 'other';
        if (!out[key]) out[key] = ch.url;
      }
      return Object.keys(out).length ? out : null;
    },
    allow: ['na'],
    naLabel: '운영하는 채널이 없어요',
    why: '메뉴·가격·영업시간·사진이 채널마다 같은지 확인하고, 고칠 곳을 알려드려요.',
  },
  {
    id: 'a_intro', page: 'basic', type: 'text',
    title: '우리 가게를 한 문장으로 소개한다면 무엇인가요?',
    placeholder: '예: 직접 끓인 사골 육수로 만드는 동네 국밥집',
    allow: ['unknown'],
    why: '사장님이 원하는 콘셉트와 실제 메뉴·가격·인테리어가 맞는지 확인해요.',
  },
  {
    id: 'a_customers', page: 'basic', type: 'group',
    title: '주로 어떤 손님이, 어떤 시간에, 어떤 목적으로 오나요?',
    fields: [
      { key: 'who', label: '손님', type: 'multi', options: opts('학생', '직장인', '가족', '연인·데이트', '친구·모임', '동네 주민', '관광객', '혼자 오는 손님') },
      { key: 'when', label: '시간', type: 'multi', options: opts('아침', '점심', '오후', '저녁', '밤·심야', '주말') },
      { key: 'why', label: '목적', type: 'multi', options: opts('식사', '간단한 한 끼', '회식·모임', '데이트', '술자리', '포장해 가기', '배달', '커피·디저트', '공부·업무') },
    ],
    allow: ['unknown'],
    why: '학생 식사·직장인 점심·가족 외식·데이트·회식 등 손님에 맞춰 전략을 나눠요.',
  },
  {
    id: 'a_split', page: 'basic', type: 'split',
    title: '홀·포장·배달 중 무엇을 운영하나요? 각각 매출 비중은요?',
    hint: (c) => {
      const s = guessServices(c.store);
      if (!s) return null;
      const found = [s.takeout ? '포장 가능' : null, s.delivery ? '배달 가능' : null].filter(Boolean);
      return found.length ? `AI가 찾은 정보: ${found.join(' · ')}` : null;
    },
    prefill: (c) => {
      const s = guessServices(c.store);
      if (!s) return null;
      return { hall: { on: s.hall !== false, pct: '' }, takeout: { on: !!s.takeout, pct: '' }, delivery: { on: !!s.delivery, pct: '' } };
    },
    allow: ['approx', 'unknown'],
    unknownLabel: '비중은 잘 몰라요',
    why: '판매 방식에 따라 손익 계산과 다음 질문이 달라져요. 배달을 하지 않으면 배달 질문은 건너뛰어요.',
  },
  {
    id: 'a_staff', page: 'basic', type: 'group',
    title: '함께 일하는 사람과, 사장님·가족이 일하는 시간을 알려 주세요.',
    fields: [
      { key: 'staff', label: '사장님 말고 함께 일하는 사람 (가족·아르바이트 포함, 없으면 0)', short: '함께 일하는 사람', type: 'number', unit: '명' },
      { key: 'owner', label: '사장님이 하루에 일하는 시간', short: '사장님 하루 근무', type: 'number', unit: '시간' },
      { key: 'family', label: '돕는 가족이 하루에 일하는 시간 (없으면 0)', short: '가족 하루 근무', type: 'number', unit: '시간', optional: true },
    ],
    allow: ['approx'],
    why: '인건비와 업무 나눔을 살펴보고, 사장님과 가족의 노동에 기대는 구조인지 확인해요. 이익은 사장님 노동 가치를 따로 반영해서도 계산해요.',
  },

  {
    id: 'a_problem', page: 'money', type: 'choice',
    title: '지금 가장 해결하고 싶은 문제는 무엇인가요?',
    options: PROBLEMS,
    detail: { key: 'detail', placeholder: '구체적으로 적어 주시면 더 정확해요 (선택)' },
    why: '손님 부족·이익 부족·재방문 부족·인력 부담 중 우선 목표를 정하고, 그에 맞는 질문을 이어서 드려요.',
  },
  {
    id: 'a_budget', page: 'money', type: 'group',
    title: '개선에 쓸 수 있는 예산과 시간은 어느 정도인가요?',
    fields: [
      { key: 'money', label: '앞으로 1~3개월 예산', type: 'choice', options: opts('거의 없어요', '30만 원 이하', '30~100만 원', '100만 원 이상', '잘 모르겠어요') },
      { key: 'time', label: '사장님이 일주일에 낼 수 있는 시간', type: 'choice', options: opts('1시간 미만', '1~3시간', '3시간 이상') },
    ],
    why: '사장님이 실제로 실행할 수 있는 계획만 드리려고 해요.',
  },

  // ── 3. 매출과 비용
  {
    id: 'b_know', page: 'money', type: 'choice',
    title: '지난달 얼마를 팔고, 얼마를 쓰고, 얼마가 남았는지 알고 계신가요?',
    options: opts(['exact', '정확히 알고 있어요'], ['approx', '대략 알고 있어요'], ['unknown', '잘 모르겠어요']),
    why: '알고 계시면 세부 비용을 확인하고, 모르시면 기록하는 방법부터 안내해요.',
  },
  {
    id: 'b_sales', page: 'money', type: 'rows',
    when: (c) => c.costKnow === 'exact' || c.costKnow === 'approx',
    title: '최근 3개월의 월별 매출과 영업일 수는요?',
    rowLabels: ['지난달', '2달 전', '3달 전'],
    columns: [
      { key: 'sales', label: '매출', type: 'money', unit: '만 원', placeholder: '예: 2400' },
      { key: 'days', label: '영업일', type: 'number', unit: '일', placeholder: '예: 26' },
    ],
    required: (rows) => parseNum(rows?.[0]?.sales) !== null,
    allow: ['approx', 'unknown'],
    autoApprox: (c) => c.costKnow === 'approx',
    why: '월매출과 영업일당 매출을 함께 비교해요.',
  },
  {
    id: 'b_channel_sales', page: 'money', type: 'group',
    when: (c) => c.channelsOn >= 2 && (c.costKnow === 'exact' || (c.costKnow === 'approx' && c.is('profit'))),
    title: '지난달 홀·포장·배달 매출은 각각 얼마인가요?',
    fields: [
      { key: 'hall', label: '홀', type: 'money', unit: '만 원', when: (c) => c.hasHall },
      { key: 'takeout', label: '포장', type: 'money', unit: '만 원', when: (c) => c.hasTakeout },
      { key: 'delivery', label: '배달', type: 'money', unit: '만 원', when: (c) => c.hasDelivery },
      { key: 'basis', label: '배달 매출 기준', type: 'choice', when: (c) => c.hasDelivery, options: opts('배달앱 주문금액 (수수료 빼기 전)', '정산 입금액 (수수료 뺀 뒤)', '잘 모르겠어요') },
    ],
    allow: ['approx', 'unknown'],
    autoApprox: (c) => c.costKnow === 'approx',
    why: '판매 방식별 수익성을 나눠 보고, 배달 수수료를 두 번 빼지 않도록 매출 기준을 확인해요.',
  },
  {
    id: 'b_costs', page: 'money', type: 'costs', unit: '만 원',
    when: (c) => c.costKnow === 'exact' || c.costKnow === 'approx',
    title: (c) => (c.costKnow === 'exact' ? '지난달 식재료·포장재·임차료·공과금·수수료·마케팅·소모품에 각각 얼마를 썼나요?' : '지난달 큰 비용만 대략 알려 주세요.'),
    help: '모르는 항목은 비워 두세요.',
    items: (c) => (c.costKnow === 'exact'
      ? [
          ['food', '식재료'], c.hasStaff ? ['labor', '직원 급여·인력 비용'] : null, c.hasTakeout || c.hasDelivery ? ['pack', '포장재'] : null,
          ['rent', '임차료 (월세·관리비)'], ['util', '공과금 (전기·가스·수도)'], ['fee', '수수료 (카드·배달앱)'], ['mkt', '마케팅'], ['supply', '소모품'], ['etc', '그 밖의 비용'],
        ]
      : [['food', '식재료'], c.hasStaff ? ['labor', '직원 급여·인력 비용'] : null, ['rent', '임차료 (월세·관리비)'], ['etc', '그 밖의 비용 합계']]
    ).filter(Boolean).map(([key, label]) => ({ key, label })),
    allow: ['approx'],
    autoApprox: (c) => c.costKnow === 'approx',
    why: '비용이 많이 드는 항목과 줄일 수 있는 항목을 찾아요.',
  },
  {
    id: 'b_records', page: 'money', type: 'group',
    when: (c) => c.costKnow === 'unknown' || c.is('profit'),
    title: '장부·POS 자료와 재고 기록이 있나요?',
    fields: [
      { key: 'data', label: '장부나 POS 자료', type: 'choice', options: opts('POS 매출 자료가 있어요', '장부(엑셀·노트)가 있어요', '매출·비용 관리 앱을 써요', '따로 없어요') },
      { key: 'stock', label: '월초·월말 재고와 식재료 폐기량 기록', type: 'choice', when: (c) => c.is('profit') && c.costKnow !== 'unknown', options: opts('둘 다 기록해요', '재고만 기록해요', '폐기량만 기록해요', '기록하지 않아요') },
    ],
    why: '자료가 있으면 입력을 줄이고, 없으면 꼭 필요한 것만 기록하는 방법을 드려요. 재고 기록이 없으면 이익을 추정치로 표시해요.',
  },

  // ── 4. 대표 메뉴
  {
    id: 'c_menus', page: 'menu', type: 'rows',
    title: '많이 팔리는 메뉴 3개의 이름·판매가격·지난달 판매 수량을 알려 주세요.',
    hint: (c) => (c.store?.menu?.length ? 'AI가 찾은 메뉴를 미리 넣었어요. 실제로 많이 팔리는 순서로 고쳐 주세요.' : null),
    rowLabels: ['1위', '2위', '3위'],
    columns: [
      { key: 'name', label: '메뉴', type: 'text', placeholder: '메뉴 이름' },
      { key: 'price', label: '가격', type: 'money', unit: '원' },
      { key: 'qty', label: '지난달 판매', type: 'number', unit: '개', placeholder: '모르면 비움' },
    ],
    prefill: (c) => {
      const m = (c.store?.menu || []).slice(0, 3);
      return m.length ? [0, 1, 2].map((i) => ({ name: m[i]?.name || '', price: toWon(m[i]?.price), qty: '' })) : null;
    },
    required: (rows) => !!String(rows?.[0]?.name || '').trim(),
    allow: ['approx'],
    why: '실제 매출과 이익을 만드는 메뉴를 찾아요. 이후 질문에 이 메뉴 이름을 그대로 써요.',
  },
  {
    id: 'c_worry', page: 'menu', type: 'rows',
    title: '수익성이 걱정되는 메뉴가 있다면 하나만 알려 주세요.',
    rowLabels: ['걱정 메뉴'],
    columns: [
      { key: 'name', label: '메뉴', type: 'text', placeholder: '메뉴 이름' },
      { key: 'price', label: '가격', type: 'money', unit: '원' },
      { key: 'qty', label: '지난달 판매', type: 'number', unit: '개', placeholder: '모르면 비움' },
    ],
    required: (rows) => !!String(rows?.[0]?.name || '').trim(),
    allow: ['na'],
    naLabel: '딱히 없어요',
    why: '많이 팔리지만 남는 게 적은 메뉴인지, 덜 팔리는데 손이 많이 가는 메뉴인지 살펴봐요.',
  },

  {
    id: 'c_cost', page: 'menuDetail', type: 'menucost',
    title: (c) => `대표 메뉴가 ${josa(c.menuName, '이네요', '네요')}. 이 메뉴 ${josa(c.unit, '을', '를')} 만들 때 반찬·소스·포장까지 포함해 재료비가 얼마나 드는지 알고 계신가요?`,
    why: '알면 바로 메뉴별 남는 돈을 계산하고, 모르면 재료별 구매가격·용량·사용량으로 나눠서 추정해요.',
  },
  {
    id: 'c_cost_more', page: 'menuDetail', type: 'costs', unit: '원',
    when: (c) => c.is('profit') && (c.menus.length > 1 || !!c.worry),
    title: '다른 메뉴의 1개(1인분)당 재료비도 아시면 적어 주세요.',
    help: '모르는 메뉴는 비워 두세요.',
    items: (c) => [...c.menus.slice(1).map((m, i) => ({ key: `m${i + 2}`, label: m.name })), c.worry ? { key: 'worry', label: `${c.worry.name} (걱정 메뉴)` } : null].filter(Boolean),
    allow: ['unknown'],
    why: '메뉴별 공헌이익(재료비 등을 빼고 남는 금액)을 비교해요. 임차료 같은 고정비를 빼기 전 금액이라 최종 순이익과는 구분해요.',
  },
  {
    id: 'c_cook', page: 'menuDetail', type: 'group',
    when: (c) => c.is('profit') || c.is('labor'),
    title: (c) => `${josa(c.menuName, '은', '는')} 만드는 데 얼마나 걸리나요? 바쁠 때 다른 메뉴 조리를 늦추나요?`,
    fields: [
      { key: 'minutes', label: '조리 시간', type: 'number', unit: '분' },
      { key: 'delay', label: '다른 메뉴 지연', type: 'choice', options: FREQ },
    ],
    allow: ['approx'],
    why: '판매량뿐 아니라 주방 부담까지 함께 봐요.',
  },
  {
    id: 'c_price', page: 'menuDetail', type: 'group',
    when: (c) => c.is('profit') || c.is('acquisition') || !!c.flags.price,
    hint: (c) => (c.flags.price ? `리뷰에서 가격 이야기가 보였어요: "${flagNote(c.store, '가격', FLAG_RULES.price) || '가격이 비싸다'}"` : null),
    title: '최근 1년 안에 메뉴 가격을 바꾼 적이 있나요? 손님이 비싸다고 한다면 이유는 무엇인가요?',
    fields: [
      { key: 'change', label: '가격 변경', type: 'choice', options: opts(['up', '올렸어요'], ['down', '내렸어요'], ['none', '바꾼 적 없어요']) },
      { key: 'after', label: '바꾼 뒤 판매량', type: 'choice', options: opts('늘었어요', '비슷해요', '줄었어요', '잘 모르겠어요'), when: (c, v) => v?.change === 'up' || v?.change === 'down' },
      { key: 'expensive', label: '비싸다는 말을 듣는 이유', type: 'choice', options: opts('가격 자체 때문이에요', '양이 적다고 느껴서예요', '맛에 비해 비싸다고 느껴서예요', '서비스·분위기에 비해서예요', '비싸다는 말을 거의 안 들어요', '잘 모르겠어요') },
    ],
    why: '가격 변경 전후의 판매량·객단가·남는 금액을 비교하고, 가격을 내려야 할지 양·맛·서비스의 가치를 높여야 할지 구분해요.',
  },
  {
    id: 'c_compare', page: 'menuDetail', type: 'group',
    when: (c) => c.is('acquisition'),
    title: '주변 비슷한 가게와 비교하면 우리 가게는 어떤가요?',
    fields: [
      { key: 'amount', label: '양', type: 'choice', options: opts('더 많아요', '비슷해요', '더 적어요', '잘 모르겠어요') },
      { key: 'set', label: '구성', type: 'choice', options: opts('더 좋아요', '비슷해요', '부족해요', '잘 모르겠어요') },
      { key: 'service', label: '서비스', type: 'choice', options: opts('더 좋아요', '비슷해요', '부족해요', '잘 모르겠어요') },
    ],
    why: '가격만 비교하지 않고 양·구성·서비스가 비슷한 가게끼리 비교해요.',
  },

  // ── 5. 식재료 구매와 재고
  {
    id: 'd_items', page: 'purchase', type: 'rows',
    when: (c) => c.is('profit'),
    title: '비용이 많이 드는 식재료 5개와 구매처를 알려 주세요.',
    rowLabels: ['1', '2', '3', '4', '5'],
    columns: [
      { key: 'name', label: '식재료', type: 'text', placeholder: '예: 소고기 양지' },
      { key: 'where', label: '구매처', type: 'text', placeholder: '예: 식자재 납품업체' },
    ],
    required: (rows) => !!String(rows?.[0]?.name || '').trim(),
    allow: ['unknown'],
    why: '비용에 영향이 큰 품목부터 비교해요. 비교 자료가 없으면 "다른 곳보다 비싸다"고 단정하지 않고 비교 견적이 필요한 품목으로 표시해요.',
  },
  {
    id: 'd_detail', page: 'purchase', type: 'rows',
    when: (c) => c.is('profit') && c.costKnow === 'exact',
    title: '그중 가장 비싼 2개의 구매가격·중량(규격)·등급·배송비·최소 주문량은요?',
    rowLabels: ['1', '2'],
    columns: [
      { key: 'name', label: '식재료', type: 'text' },
      { key: 'price', label: '구매가격', type: 'money', unit: '원' },
      { key: 'spec', label: '중량·규격·등급', type: 'text', placeholder: '예: 1kg, 1등급' },
      { key: 'ship', label: '배송비·최소 주문', type: 'text', placeholder: '예: 3천 원, 5kg 이상' },
    ],
    required: (rows) => !!String(rows?.[0]?.name || '').trim(),
    allow: ['unknown'],
    why: '같은 조건의 단위가격으로 비교해야 정확해요. 계란이라면 크기·등급·수량·배송 조건까지 맞춰요.',
  },
  {
    id: 'd_order', page: 'purchase', type: 'group',
    when: (c) => c.is('profit'),
    title: '식재료를 한 번에 얼마나 주문하고, 얼마나 버리나요?',
    fields: [
      { key: 'cycle', label: '주문 주기', type: 'choice', options: opts('거의 매일', '일주일에 2~3번', '일주일에 1번', '그보다 드물게') },
      { key: 'waste', label: '버리는 정도', type: 'choice', options: opts('거의 안 버려요', '가끔 버려요', '자주 버려요') },
      { key: 'depend', label: '거래처', type: 'choice', options: opts('한 곳에 거의 의존해요', '두세 곳에서 사요', '여러 곳에서 비교해 사요') },
    ],
    why: '대량 구매 할인보다 버리는 손실이 크면 주문량과 주기를 조정하고, 한 곳에 의존하면 대체 거래처와 품절 대응 기준을 마련해요.',
  },

  // ── 6~7. 마케팅·SNS·인플루언서·체험단 · 14. 입구
  {
    id: 'e_spend', page: 'marketing', type: 'costs', unit: '만 원/월',
    when: (c) => c.is('acquisition'),
    title: '최근 3개월 동안 마케팅에 쓴 돈을 채널별로 알려 주세요. (한 달 평균)',
    help: '안 쓴 곳은 비워 두세요.',
    items: (c) => [['insta', '인스타그램 광고'], ['blog', '블로그 체험단'], ['agency', '마케팅 대행사'], c.hasDelivery ? ['app', '배달앱 광고'] : null, ['etc', '기타 (전단·지역 광고 등)']].filter(Boolean).map(([key, label]) => ({ key, label })),
    allow: ['na', 'unknown'],
    naLabel: '마케팅에 돈을 쓰지 않았어요',
    why: '채널별 지출을 나누고, 예산 변화와 매출 변화를 함께 확인해요.',
  },
  {
    id: 'e_effect', page: 'marketing', type: 'group',
    when: (c) => c.is('acquisition') && c.spent,
    title: '광고 후 방문·예약·주문이 얼마나 늘었나요? 예산을 줄인 적이 있다면 이유는요?',
    fields: [
      { key: 'effect', label: '광고 후 변화', type: 'choice', options: opts('확실히 늘었어요', '조금 늘었어요', '변화가 없었어요', '확인하지 못했어요') },
      { key: 'cut', label: '예산을 줄인 이유', type: 'choice', options: opts('줄인 적 없어요', '매출이 줄어서', '효과가 없어서', '기타') },
      { key: 'total', label: '할인·음식 제공·대행비까지 합친 비용 (한 달)', type: 'money', unit: '만 원', optional: true },
    ],
    why: '조회수가 아니라 실제로 늘어난 손님과, 할인·음식 제공 비용까지 뺀 남는 돈으로 판단해요. 광고비와 매출이 함께 줄었어도 영업일·계절·가격·경쟁점 변화를 같이 확인해요.',
  },
  {
    id: 'e_track', page: 'marketing', type: 'group',
    when: (c) => c.is('acquisition'),
    title: '손님이 어디서 보고 왔는지 확인하나요? 손님이 늘면 감당할 수 있나요?',
    fields: [
      { key: 'track', label: '방문 경로 확인', type: 'choice', options: opts('물어보거나 기록해요', '가끔 물어봐요', '확인하지 않아요') },
      { key: 'capacity', label: '손님이 늘어날 때 주방·인력', type: 'choice', options: opts('충분해요', '바쁜 시간에는 어려워요', '지금도 버거워요') },
    ],
    why: '방문 경로 질문·예약 링크·채널별 쿠폰으로 기록하는 방법을 드리고, 감당하기 어려우면 운영부터 손보거나 한가한 시간대 중심으로 홍보해요.',
  },
  {
    id: 'f_sns', page: 'marketing', type: 'group',
    when: (c) => c.is('acquisition'),
    title: '운영 중인 SNS와 게시 빈도, 찍을 사람과 시간은요?',
    fields: [
      { key: 'channels', label: '운영 중인 SNS', type: 'multi', options: opts('인스타그램', '블로그', '스레드', '유튜브·쇼츠', '틱톡', '카카오톡 채널', '당근', '운영하지 않아요') },
      { key: 'freq', label: '게시 빈도', type: 'choice', options: opts('일주일에 2번 이상', '일주일에 1번', '한 달에 1~3번', '거의 안 올려요') },
      { key: 'who', label: '사진·영상을 찍을 사람', type: 'choice', options: opts('사장님', '직원', '가족', '맡길 사람이 없어요') },
      { key: 'hours', label: '일주일에 쓸 수 있는 시간', type: 'choice', options: opts('1시간 미만', '1~3시간', '3시간 이상') },
    ],
    prefill: (c) => {
      const ch = c.val('a_channels') || {};
      const list = [];
      if (ch.insta) list.push('인스타그램');
      if (/blog/i.test(Object.values(ch).join(' '))) list.push('블로그');
      return list.length ? { channels: list } : null;
    },
    why: '손님과 잘 맞는 채널 1~2개를 먼저 고르고, 한 번 촬영해서 여러 게시물로 쓰는 계획을 만들어요. 모든 가게에 매일 게시를 권하지 않아요.',
  },
  {
    id: 'f_collab', page: 'marketing', type: 'group',
    when: (c) => c.is('acquisition'),
    title: '지역 인플루언서나 체험단을 해본 적이 있나요?',
    fields: [
      { key: 'influencer', label: '지역 인플루언서 협업', type: 'choice', options: opts('해봤어요', '안 해봤어요') },
      { key: 'review', label: '체험단', type: 'choice', options: opts('비용과 이후 방문 성과를 확인했어요', '비용만 알아요', '성과를 확인하지 못했어요', '안 해봤어요') },
    ],
    why: '모집 인원보다 실제로 늘어난 방문과 콘텐츠 품질로 평가하고, 맞는 인플루언서 후보를 고르는 기준으로 써요.',
  },
  {
    id: 'l_entrance', page: 'marketing', type: 'group',
    when: (c) => c.hasHall && (c.is('acquisition') || !!c.flags.entrance || !!c.flags.parking),
    title: '처음 온 손님이 가게를 쉽게 찾고, 밖에서 메뉴를 알 수 있나요?',
    hint: (c) => (c.store?.floor ? `AI가 찾은 위치: ${c.store.floor}` : c.flags.parking ? '리뷰에서 주차 이야기가 보였어요.' : null),
    fields: [
      { key: 'floor', label: '층', type: 'choice', options: opts('1층', '2층 이상', '지하') },
      { key: 'find', label: '입구 찾기', type: 'choice', options: opts('쉽게 찾아요', '헤매는 손님이 있어요', '잘 모르겠어요') },
      { key: 'outside', label: '밖에서 보이는 안내', type: 'choice', options: opts('메뉴와 가격이 보여요', '메뉴만 보여요', '잘 안 보여요') },
      { key: 'clutter', label: '입구·통로', type: 'choice', options: opts('물건이 쌓여 있을 때가 있어요', '깔끔해요') },
    ],
    prefill: (c) => {
      const f = String(c.store?.floor || '');
      const floor = /지하|B\d/i.test(f) ? '지하' : /(^|\D)1층/.test(f) ? '1층' : /[2-9]층/.test(f) ? '2층 이상' : '';
      return floor ? { floor } : null;
    },
    why: '간판·층 안내·입구 사진·지도 안내와, 밖에서 보이는 대표 메뉴·가격·영업 여부 안내를 고칠지 정해요. 장식을 사기 전에 정리와 동선부터 봐요.',
  },

  // ── 8. 리뷰 · 9. 고객 편의 · 13. 잔반 · 16. 추가 질문
  {
    id: 'g_reviews', page: 'experience', type: 'reviews',
    title: '손님이 반복해서 칭찬하는 점과 불평하는 점은 무엇인가요?',
    hint: (c) => ((c.store?.strengths?.length || c.store?.weaknesses?.length) ? 'AI가 찾은 리뷰 내용이에요. 맞는 것을 고르고, 빠진 건 적어 주세요.' : null),
    allow: ['unknown'],
    why: '유지할 강점과 고칠 문제를 함께 정리해요. 분석 기간·리뷰 수·출처가 확인된 내용만 근거로 써요.',
  },
  {
    id: 'g_manage', page: 'experience', type: 'group',
    when: (c) => c.is('repeat') || !!c.flags.service,
    hint: (c) => (c.flags.service ? '리뷰에서 응대·서비스 이야기가 보였어요.' : null),
    title: '리뷰는 얼마나 자주 확인하고, 불만이 반복되는 상황이 있나요?',
    fields: [
      { key: 'freq', label: '확인 주기', type: 'choice', options: opts('매일', '일주일에 1~2번', '가끔', '거의 안 봐요') },
      { key: 'owner', label: '담당', type: 'choice', options: opts('사장님', '직원', '정해진 사람이 없어요') },
      { key: 'changed', label: '불만을 받은 뒤 실제로 바꾼 것', type: 'choice', options: opts('바꾼 게 있어요', '아직 없어요', '불만이 거의 없어요') },
      { key: 'pattern', label: '같은 불만이 반복되는 상황', type: 'multi', options: opts('특정 시간대에', '특정 메뉴에서', '특정 직원·근무조에서', '딱히 없어요', '잘 모르겠어요') },
    ],
    why: '확인 주기와 담당자를 정하고, 답글이 실제 개선으로 이어지게 해요. 문제가 생기는 상황을 좁혀 구체적으로 처방해요.',
  },
  {
    id: 'n_wait', page: 'experience', type: 'choice',
    when: (c) => c.is('repeat') || c.is('labor') || !!c.flags.wait,
    hint: (c) => (c.flags.wait ? `리뷰에서 대기 이야기가 보였어요: "${flagNote(c.store, '대기', FLAG_RULES.wait) || '대기가 길다'}"` : null),
    title: '손님이 가장 오래 기다리는 단계는 어디인가요?',
    options: opts('들어오기 전 대기', '주문할 때', '음식이 나오기까지', '계산할 때', '거의 기다리지 않아요'),
    why: '입장·주문·조리·계산 중 문제가 생기는 지점을 고쳐요.',
  },
  {
    id: 'n_ops', page: 'experience', type: 'group',
    when: (c) => c.is('repeat') || c.is('labor'),
    title: '재방문 손님 확인, 품절·주문 누락, 예약 관리는 어떤가요?',
    fields: [
      { key: 'revisit', label: '처음 온 손님과 다시 온 손님 구분', type: 'choice', when: (c) => c.is('repeat'), options: opts('예약·멤버십 기록으로 확인해요', '얼굴로 기억하는 정도예요', '구분하지 않아요') },
      { key: 'soldout', label: '품절이나 주문 누락', type: 'choice', options: FREQ },
      { key: 'noshow', label: '예약 취소·노쇼로 생기는 빈자리', type: 'choice', when: (c) => c.hasHall && c.reserveCat, options: opts('자주 있어요', '가끔 있어요', '거의 없어요', '예약을 받지 않아요') },
    ],
    why: '확인할 수 있는 기록으로 재방문을 살펴보고, 준비 수량·주문 전달·출고 확인과 예약 확인·대기 손님 운영을 조정해요.',
  },
  {
    id: 'l_mood', page: 'experience', type: 'group',
    when: (c) => c.hasHall && (c.is('acquisition') || c.is('repeat') || c.dateCrowd),
    title: '조명·가구·메뉴판·음악이 가게 콘셉트와 맞나요? 음악은 어떻게 틀고 있나요?',
    fields: [
      { key: 'concept', label: '조명·가구·메뉴판·음악과 콘셉트', short: '콘셉트', type: 'choice', options: opts('잘 맞아요', '일부 안 맞아요', '신경 쓰지 못했어요') },
      { key: 'music', label: '음악을 트는 방식 (시간대·음량)', short: '음악', type: 'choice', options: opts('시간대에 맞춰 곡과 음량을 바꿔요', '한 가지로 계속 틀어요', '음악을 틀지 않아요') },
      { key: 'source', label: '매장에서 틀기 허용된 음원 서비스인가요?', short: '음원', type: 'choice', when: (c, v) => v?.music && v.music !== '음악을 틀지 않아요', options: opts('매장용 음원 서비스를 써요', '개인 스트리밍·유튜브를 틀어요', '잘 모르겠어요') },
      { key: 'speaker', label: '가게 밖에 스피커를 쓸 수 있는 환경인가요?', short: '외부 스피커', type: 'choice', when: (c) => c.is('acquisition'), options: opts('건물 규정상 쓸 수 있어요', '쓸 수 없어요', '잘 모르겠어요') },
    ],
    why: '영향이 큰 부분부터 순서대로 조정하고, 대화·식사·체류 목적에 맞게 선곡과 음량을 제안해요. 유튜브 플레이리스트를 찾았다고 매장 재생이 허용되는 것은 아니라서, 이용이 허용된 서비스인지 확인해요. 외부 스피커는 건물 규정과 주변 환경을 확인한 경우에만 검토해요.',
  },
  // ── 13. 반찬과 잔반 (홀이 있는 음식점은 모두)
  {
    id: 'k_sides', page: 'sides', type: 'group',
    when: (c) => c.hasHall && c.foodCat,
    title: '반찬은 어떻게 나가나요?',
    fields: [
      { key: 'provide', label: '기본 반찬·곁들임', type: 'choice', options: opts(['yes', '제공해요'], ['no', '제공하지 않아요']) },
      { key: 'serve', label: '나가는 방식', short: '반찬 나가는 방식', type: 'choice', when: (c, v) => v?.provide === 'yes', options: opts('자리마다 기본으로 차려 드려요', '셀프바에서 덜어 가요', '요청하면 드려요', '메뉴와 한 접시에 같이 나가요') },
      { key: 'kinds', label: '기본 반찬 가짓수', type: 'number', unit: '가지', optional: true, when: (c, v) => v?.provide === 'yes' },
      { key: 'refill', label: '더 드시고 싶을 때', short: '리필', type: 'choice', when: (c, v) => v?.provide === 'yes', options: opts('직원이 더 드려요', '셀프로 더 가져가요', '추가 요금을 받아요', '더 드리지 않아요') },
    ],
    why: '반찬을 차리는 방식에 따라 남는 양과 비용, 손님이 느끼는 만족이 달라져요.',
  },
  {
    id: 'k_leftover', page: 'sides', type: 'group',
    when: (c) => c.hasHall && c.foodCat,
    title: '손님이 남기는 음식(메인 메뉴·반찬)을 살펴보고 있나요?',
    fields: [
      { key: 'recent', label: '최근에 손님이 무엇을 남겼는지 기억나세요?', short: '최근 잔반 기억', type: 'choice', options: opts('기억나요', '잘 기억 안 나요') },
      { key: 'look', label: '테이블을 치울 때 잔반을 일부러 살펴보나요?', short: '잔반 살펴보기', type: 'choice', options: opts('매번 살펴봐요', '가끔 봐요', '따로 보지 않아요') },
      { key: 'repeat', label: '같은 음식·반찬이 여러 테이블에서 계속 남나요?', short: '같은 잔반 반복', type: 'choice', options: opts('자주 그래요', '가끔 그래요', '거의 없어요', '잘 모르겠어요') },
      { key: 'which', label: '자주 남는 것', short: '자주 남는 것', type: 'text', placeholder: '예: 콩나물무침', optional: true, when: (c, v) => v?.recent === '기억나요' || v?.repeat === '자주 그래요' || v?.repeat === '가끔 그래요' },
      { key: 'why', label: '남는 이유로 짐작되는 것', short: '남는 이유', type: 'multi', options: opts('양이 많아서', '간·맛이 안 맞아서', '식었거나 온도가 안 맞아서', '메인 메뉴와 안 어울려서', '손님마다 달라요', '이유를 모르겠어요') },
      { key: 'asked', label: '남긴 이유를 손님에게 물어본 적이 있나요?', short: '손님에게 물어봄', type: 'choice', options: opts('있어요', '없어요') },
      { key: 'taste', label: '남는 음식을 손님 안 보이는 곳에서 직접 맛보며 확인해 보나요? (같은 조리분에서 따로 덜어 둔 것으로)', short: '직접 맛보기', type: 'choice', options: opts('정기적으로 맛봐요', '가끔 맛봐요', '해본 적 없어요') },
    ],
    why: '남는 음식은 손님 만족과 재료비를 함께 알려주는 자료예요. 같은 게 계속 남으면 양·맛·온도·메인 메뉴와의 조합 중 이유를 찾아 고쳐요. 손님이 남긴 음식은 눈으로 보고 기록만 하고, 맛은 같은 조리분에서 따로 덜어 둔 것이나 새로 만든 것으로 확인해요.',
  },

  // ── 9. 기본 서비스 · 손님 앞 기본 (홀이 있는 가게는 모두)
  {
    id: 's_service', page: 'basics', type: 'group',
    when: (c) => c.hasHall,
    hint: (c) => (c.flags.seat ? '리뷰에서 좌석·온도 이야기가 보였어요.' : null),
    title: '담요 같은 기본 서비스는 준비돼 있나요?',
    fields: [
      { key: 'amenities', label: '손님이 바로 쓸 수 있게 준비된 것', short: '준비된 것', type: 'multi', options: opts('담요', '앞치마', '머리끈', '물티슈', '휴대폰 충전', '가방 바구니·옷걸이', '우산꽂이', '아기 의자', '아직 없어요') },
      { key: 'requests', label: '따로 달라는 요청이 잦은 물품', short: '자주 요청하는 물품', type: 'multi', options: opts('물', '휴지', '수저', '앞치마', '머리끈', '담요', '물티슈', '거의 없어요') },
      { key: 'temp', label: '춥다·덥다는 의견', short: '춥다·덥다는 의견', type: 'choice', options: FREQ },
      { key: 'apron', short: '앞치마 위치', label: (c) => `${josa(c.menuName, '을', '를')} 먹을 때 옷에 튈 수 있나요? 앞치마는 어디에 있나요?`, type: 'choice', when: (c) => c.soupy, options: opts('튈 일이 거의 없어요', '손님이 직접 꺼낼 수 있는 곳에 있어요', '직원에게 요청해야 해요', '앞치마가 없어요') },
      { key: 'storage', label: '가방·외투·우산 둘 곳', short: '짐 둘 곳', type: 'choice', options: opts('부족해요', '조금 부족해요', '충분해요') },
    ],
    why: '반복해서 요청받는 물품부터 손님이 바로 쓸 수 있게 하고, 냉난방을 먼저 맞춘 뒤 필요하면 담요를 준비해요.',
  },
  {
    id: 's_manners', page: 'basics', type: 'group',
    when: (c) => c.hasHall,
    title: '사장님·직원의 식사와 청소, 손님 눈에 띄지 않게 하고 있나요?',
    fields: [
      { key: 'mealWhen', label: '식사하는 때', short: '식사 시간', type: 'choice', options: opts('영업 전·후', '손님이 적은 시간에 교대로', '영업 중 틈틈이', '정해진 때가 없어요') },
      { key: 'mealWhere', label: '식사하는 곳', short: '식사 장소', type: 'choice', options: opts('손님이 안 보이는 따로 된 공간', '주방 안쪽', '손님 좌석·홀', '카운터 근처', '정해진 곳이 없어요') },
      { key: 'seen', label: '식사하다가 손님과 마주치거나, 손님이 식사하는 모습을 본 적이 있나요?', short: '식사 중 손님과 마주침', type: 'choice', options: opts('자주 있어요', '가끔 있어요', '없어요', '잘 모르겠어요') },
      { key: 'cleanDuring', label: '손님이 있을 때 하는 청소', short: '손님 있을 때 청소', type: 'multi', options: opts('바닥 쓸기·걸레질', '락스·세제 냄새 나는 청소', '쓰레기 정리', '의자 올리기 같은 마감 정리', '테이블 닦기만 해요', '손님 있을 땐 안 해요') },
    ],
    why: '손님이 보는 곳에서 식사하거나 청소하면 작은 일 같아도 가게 인상이 크게 달라져요. 식사 시간·장소와 청소 시간을 정해 손님 눈에 띄지 않게 해요.',
  },

  // ── 10. 청소와 화장실
  {
    id: 'i_rest', page: 'clean', type: 'group',
    when: (c) => c.hasHall,
    title: '손님용 화장실은 어떤가요?',
    fields: [
      { key: 'type', label: '화장실', type: 'choice', options: opts(['own', '가게 전용'], ['shared', '건물 공용'], ['none', '손님용 화장실이 없어요']) },
      { key: 'sep', label: '남녀 구분', type: 'choice', options: opts(['split', '남녀가 나뉘어 있어요'], ['unisex', '남녀 공용이에요']), when: (c, v) => v?.type && v.type !== 'none' },
    ],
    why: '사장님이 직접 고칠 수 있는 것과 건물 관리 쪽에 요청할 일을 나눠요.',
  },
  {
    id: 'i_state', page: 'clean', type: 'group',
    when: (c) => !!c.restroom,
    hint: (c) => (c.flags.restroom || c.flags.hygiene ? '리뷰에서 화장실·위생 이야기가 보였어요.' : null),
    title: (c) => `${c.womenRoom} 상태와 핸드워시는 어떤가요?`,
    fields: [
      { key: 'problems', short: '문제', label: (c) => `${c.womenRoom}에 생기는 문제`, type: 'multi', options: opts('냄새', '물기', '오염', '잠금장치', '문제 없어요') },
      { key: 'handwash', label: '핸드워시 (용기·펌프·내용물)', type: 'choice', options: opts('있고 상태가 좋아요', '있지만 펌프·용기 관리가 아쉬워요', '고체 비누만 있어요', '없어요') },
    ],
    why: '냄새·물기·고장 같은 기본 불편과 위생부터 고치고, 세면대 가까이에서 쓰기 편하고 청결하게 관리할 수 있는 핸드워시와 위치를 제안해요.',
  },
  {
    id: 'i_mirror', page: 'clean', type: 'group',
    when: (c) => c.restroom === 'own' && (c.is('repeat') || c.dateCrowd || !!c.flags.restroom),
    title: '세면대·거울과 조명은 어떤가요?',
    fields: [
      { key: 'clean', label: '세면대·거울 닦는 때', type: 'choice', options: opts('영업 중에도 수시로', '하루 1번', '며칠에 1번', '정해진 때가 없어요') },
      { key: 'light', label: '거울 앞 조명', type: 'choice', options: opts('적당해요', '어두워요', '눈부셔요', '거울 앞 그림자가 심해요') },
      { key: 'tidy', label: '거울 주변', type: 'choice', options: opts('정돈돼 있고 가게 분위기와 어울려요', '정돈이 필요해요', '신경 쓰지 못했어요') },
    ],
    why: '물때·얼룩·손자국 점검 루틴을 만들고, 기본 밝기를 확보한 뒤 필요하면 거울 주변 간접조명과 정돈을 제안해요.',
  },
  {
    id: 'i_supplies', page: 'clean', type: 'group',
    when: (c) => !!c.restroom && (c.is('repeat') || c.dateCrowd),
    title: '비누·휴지·손 건조 용품이 떨어지는 일이 있나요? 여성용 폐기함과 편의용품은요?',
    fields: [
      { key: 'runout', label: '비누·휴지·손 건조 용품', type: 'choice', options: opts('자주 떨어져요', '가끔 떨어져요', '거의 없어요') },
      { key: 'bin', label: '여성용 폐기함', type: 'choice', options: opts('뚜껑 있는 폐기함이 있고 자주 비워요', '있지만 관리가 아쉬워요', '없어요') },
      { key: 'amenity', label: '생리용품·머리끈 같은 편의용품', type: 'choice', options: opts('두고 있어요', '두면 좋을 것 같아요', '필요 없어 보여요') },
    ],
    why: '보충 기준과 담당자를 정하고, 예산과 관리 여력에 맞춰 편의용품을 골라요.',
  },
  {
    id: 'i_photo', page: 'clean', type: 'choice',
    when: (c) => c.restroom === 'own' && c.dateCrowd,
    title: '거울 앞을 가게 분위기가 담기는, 사진 찍기 좋은 공간으로 만들고 싶나요?',
    options: opts('만들고 싶어요', '이미 그런 공간이 있어요', '관심 없어요'),
    why: '청결과 사용성을 먼저 확인한 뒤, 다른 사람이나 화장실 칸이 비치지 않는 거울 앞 구성을 검토해요.',
  },
  {
    id: 'i_routine', page: 'clean', type: 'group',
    when: (c) => c.hasHall && (c.is('repeat') || !!c.flags.hygiene),
    title: '청소는 어떻게 하고 있나요?',
    fields: [
      { key: 'routine', label: '청소 루틴', type: 'choice', options: opts('오픈 전·영업 중·마감 후로 정해져 있어요', '마감 청소만 해요', '그때그때 해요') },
      { key: 'missed', label: '자주 빠지는 곳', type: 'multi', options: opts('배수구', '환기구·후드', '쓰레기통', '테이블 밑·의자', '바닥 모서리', '잘 챙기고 있어요') },
    ],
    why: '시간대별 구역·담당자·확인 항목을 정하고, 빠지는 구역은 점검 주기를 정해요.',
  },

  // ── 12. 직원 교육과 레시피 · 15. 배달·키오스크·인력
  {
    id: 'o_peak', page: 'ops', type: 'group',
    when: (c) => c.is('labor'),
    title: '가장 바쁜 시간대에는 몇 명이 일하고, 손님이 기다리거나 주문을 포기하나요?',
    fields: [
      { key: 'slot', label: '가장 바쁜 시간대', type: 'choice', options: opts('아침', '점심', '오후', '저녁', '밤') },
      { key: 'people', label: '그때 일하는 사람 (사장님 포함)', type: 'number', unit: '명' },
      { key: 'orders', label: '그 시간 주문 수', type: 'number', unit: '건/시간', optional: true },
      { key: 'wait', label: '주문·결제 때문에 기다리거나 포기하는 손님', type: 'choice', when: (c) => c.hasHall, options: FREQ },
      { key: 'device', label: '키오스크·테이블오더', type: 'choice', when: (c) => c.hasHall, options: opts('쓰고 있어요', '검토 중이에요', '쓸 생각이 없어요') },
    ],
    allow: ['approx'],
    why: '시간대별 업무량에 맞게 근무를 배치하고, 키오스크나 테이블오더가 문제를 실제로 줄이는지 임대료·수수료·유지비와 줄어드는 일을 비교해요.',
  },
  {
    id: 'j_training', page: 'ops', type: 'group',
    when: (c) => c.hasStaff && c.is('labor'),
    title: '새 직원 교육은 어떻게 하나요?',
    fields: [
      { key: 'firstday', label: '첫날 배울 내용', type: 'choice', options: opts('문서로 정리돼 있어요', '말로만 알려줘요', '따로 없어요') },
      { key: 'hygiene', label: '복장·손톱·머리·손 씻기 기준', type: 'choice', options: opts('정해져 있어요', '일부만 있어요', '없어요') },
      { key: 'check', label: '교육 후 지키는지 확인', type: 'choice', options: opts('정기적으로 확인해요', '가끔 확인해요', '확인하지 않아요') },
    ],
    why: '인사·주문·설명·서빙·계산·불만 대응 매뉴얼과 위생 기준을 만들고, 설명·시연·실습·확인 순서로 교육해요. 외모가 아니라 위생·응대·업무 수행을 기준으로 봐요.',
  },
  {
    id: 'j_more', page: 'ops', type: 'group',
    when: (c) => c.hasStaff && (c.is('labor') || !!c.flags.consistency),
    hint: (c) => (c.flags.consistency ? '리뷰에서 맛이 달라졌다는 이야기가 보였어요.' : null),
    title: (c) => `불만 처리 기준과 ${c.menuName} 레시피는 정해져 있나요?`,
    fields: [
      { key: 'authority', label: '불만이 생기면 직원이 처리할 수 있는 범위', type: 'choice', options: opts('교환·다시 만들기까지 직접 해요', '사장님을 불러야 해요', '정해진 기준이 없어요') },
      { key: 'consistency', short: '조리하는 사람마다 맛·양 차이', label: (c) => `조리하는 사람마다 ${c.menuName}의 맛·양·모양이 달라지나요?`, type: 'choice', options: opts('자주 달라져요', '가끔 달라져요', '거의 같아요', '사장님 혼자 조리해요') },
      { key: 'absent', label: '사장님이 없으면 달라지는 일', type: 'multi', when: (c) => c.is('labor'), options: opts('맛', '응대', '청소', '발주·재고', '마감 정산', '달라지는 게 없어요') },
    ],
    why: '교환·재조리·책임자 호출 기준을 정하고, 계량 도구·재료 중량·조리 순서·완성 사진으로 레시피를 표준화해요. 사장님에게만 있는 판단은 매뉴얼과 인수인계로 옮겨요.',
  },
  {
    id: 'm_unit', page: 'ops', type: 'costs', unit: '원/건',
    when: (c) => c.hasDelivery && (c.is('profit') || c.costKnow === 'exact'),
    title: '배달 주문 한 건의 평균 결제금액과, 그중 드는 비용은요?',
    help: '모르는 항목은 비워 두세요.',
    items: () => [['order', '평균 결제금액'], ['food', '재료비'], ['pack', '포장비'], ['fee', '중개·결제 수수료'], ['rider', '가게가 내는 배달비'], ['coupon', '할인·쿠폰']].map(([key, label]) => ({ key, label })),
    allow: ['approx', 'unknown'],
    why: '주문 한 건에 실제로 남는 금액(공헌이익)과 배달 전체 수익성을 계산해요.',
  },
  {
    id: 'm_ops', page: 'ops', type: 'group',
    when: (c) => c.hasDelivery && (c.is('profit') || c.is('labor') || c.is('repeat')),
    title: '배달 때문에 생기는 문제가 있나요?',
    fields: [
      { key: 'load', label: '배달 때문에 홀 음식이 늦거나 일손이 더 필요함', type: 'choice', when: (c) => c.hasHall, options: FREQ },
      { key: 'quality', label: '배달 후 문제', type: 'multi', options: opts('음식이 식거나 불어요', '누락이 생겨요', '환불·재배달 요청이 있어요', '거의 없어요') },
    ],
    why: '배달 시간대·메뉴·주문량을 조정할지 보고, 배달용 메뉴 구성·포장·출고 체크리스트를 고쳐요.',
  },

  // ── 16. 실행 준비
  {
    id: 'n_tried', page: 'finish', type: 'text', long: true,
    title: '최근에 바꿔본 것과 그 결과를 알려 주세요.',
    placeholder: '예: 점심 세트를 만들었는데 직장인 손님이 늘었어요',
    allow: ['na'],
    naLabel: '최근에 바꾼 게 없어요',
    why: '효과가 없었던 방법을 다시 권하지 않으려고요.',
  },
  {
    id: 'n_owner', page: 'finish', type: 'choice',
    title: '개선을 실제로 맡을 사람은 누구인가요?',
    options: opts('사장님', '직원', '가족', '아직 정하지 못했어요'),
    why: '할 일마다 담당자와 완료일을 정해요.',
  },
];

export const QMAP = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
export const resolve = (x, c, ...args) => (typeof x === 'function' ? x(c, ...args) : x);

// ───────── 보이는 질문·답 확인
export function visibleQuestions(S, store) {
  const c = buildCtx(S, store);
  return QUESTIONS.filter((q) => !q.when || q.when(c));
}

export function visiblePages(S, store) {
  const qs = visibleQuestions(S, store);
  return PAGES.map((p) => ({ ...p, questions: qs.filter((q) => q.page === p.id) })).filter((p) => p.questions.length);
}

function fieldAnswered(f, v) {
  if (f.type === 'multi') return Array.isArray(v) && v.length > 0;
  if (f.type === 'number' || f.type === 'money') return parseNum(v) !== null;
  return v != null && String(v).trim() !== '';
}

export function splitCheck(v, status) {
  const keys = ['hall', 'takeout', 'delivery'].filter((k) => v?.[k]?.on);
  if (!keys.length) return { ok: false, msg: '운영하는 방식을 하나 이상 골라 주세요.' };
  if (keys.length === 1 || status === 'unknown') return { ok: true };
  const nums = keys.map((k) => parseNum(v[k].pct));
  if (nums.some((n) => n === null)) return { ok: false, msg: '각 비중을 적거나 "비중은 잘 몰라요"를 눌러 주세요.' };
  const sum = nums.reduce((a, b) => a + b, 0);
  if (status === 'approx' ? sum < 80 || sum > 120 : Math.abs(sum - 100) > 1) return { ok: false, msg: `합계가 ${sum}%예요. 100%가 되게 맞춰 주세요.` };
  return { ok: true, sum };
}

export function isAnswered(q, a, c) {
  if (!a) return false;
  if (a.s === 'unknown' || a.s === 'na') return true;
  const v = a.v;
  switch (q.type) {
    case 'choice': { const x = v && typeof v === 'object' ? v.value : v; return x != null && x !== ''; }
    case 'multi': return Array.isArray(v) && v.length > 0;
    case 'text': return String(v ?? '').trim().length > 0;
    case 'number':
    case 'money': return parseNum(v) !== null;
    case 'group': return q.fields.filter((f) => !f.optional && (!f.when || f.when(c, v))).every((f) => fieldAnswered(f, v?.[f.key]));
    case 'split': return splitCheck(v, a.s).ok;
    case 'rows': return q.required ? q.required(v) : Array.isArray(v) && v.length > 0;
    case 'costs': return !!v && Object.values(v).some((x) => parseNum(x) !== null);
    case 'channels': return !!v && Object.values(v).some((x) => String(x || '').trim());
    case 'reviews': return !!v && ((v.praise || []).length || (v.complaints || []).length || String(v.praiseText || '').trim() || String(v.complaintsText || '').trim());
    case 'menucost': return v?.know === 'unknown' || ((v?.know === 'known' || v?.know === 'approx') && parseNum(v.amount) !== null);
    default: return v != null;
  }
}

// 비용을 모를 때 바로 드리는 안내 (설계 문서 3장)
export const COST_RECORD_TIP = {
  stars: '★★★',
  title: '비용 기록부터 시작하세요.',
  body: '지금 자료만으로는 이익이 줄어드는 원인을 정확히 확인하기 어려워요. 매일 마감 후 매출과 지출을 기록하고, 월말에는 남은 식재료를 확인하세요. 지금 쓰는 POS의 장부 기능이나 캐시노트처럼 매출·비용 조회와 장부 관리 기능이 있는 도구를 쓸 수 있어요. 도구에 연결되지 않는 비용과 재고는 따로 적어 두세요.',
};

// ───────── 답을 읽기 쉬운 글로 (화면 요약과 AI 보고서에 함께 씀)
const fmtNum = (n) => Number(n).toLocaleString('ko-KR');
export function optionLabel(options, value) {
  return (options || []).find((o) => o.v === value)?.label ?? value;
}
export function answerText(q, a, c) {
  if (!a) return '-';
  if (a.s === 'unknown') return q.unknownLabel || STATUS_LABEL.unknown;
  if (a.s === 'na') return q.naLabel || STATUS_LABEL.na;
  const v = a.v;
  const approx = a.s === 'approx' ? ' (대략)' : '';
  const money = (x, unit) => (parseNum(x) === null ? null : `${fmtNum(parseNum(x))}${unit ? ` ${unit}` : ''}`);
  switch (q.type) {
    case 'choice': {
      const val = v?.value ?? v;
      const label = optionLabel(resolve(q.options, c), val);
      return v?.detail ? `${label} (${v.detail})` : label;
    }
    case 'multi': return (v || []).join(', ');
    case 'text': return v;
    case 'number': return `${v} ${q.unit || ''}${approx}`;
    case 'money': return `${money(v, q.unit) || '-'}${approx}`;
    case 'group':
      return q.fields.filter((f) => !f.when || f.when(c, v)).map((f) => {
        const x = v?.[f.key];
        if (x == null || x === '' || (Array.isArray(x) && !x.length)) return null;
        const t = f.type === 'choice' ? optionLabel(f.options, x) : f.type === 'multi' ? x.join(', ') : f.type === 'money' ? money(x, f.unit) : f.type === 'number' ? `${x} ${f.unit || ''}` : x;
        return `${f.short || resolve(f.label, c)}: ${t}`;
      }).filter(Boolean).join(' · ') + approx;
    case 'split': {
      const names = { hall: '홀', takeout: '포장', delivery: '배달' };
      return Object.keys(names).filter((k) => v?.[k]?.on).map((k) => (parseNum(v[k].pct) !== null ? `${names[k]} ${v[k].pct}%` : names[k])).join(' · ') + approx;
    }
    case 'rows':
      return (v || []).map((r, i) => {
        const parts = q.columns.map((col) => {
          const x = r?.[col.key];
          if (x == null || String(x).trim() === '') return null;
          return col.type === 'text' ? x : `${col.type === 'money' ? fmtNum(parseNum(x) ?? x) : x}${col.unit ? ` ${col.unit}` : ''}`;
        }).filter(Boolean);
        return parts.length ? `${q.rowLabels[i]} ${parts.join(' ')}` : null;
      }).filter(Boolean).join(' / ') + approx;
    case 'costs': {
      const items = resolve(q.items, c);
      return items.map((it) => (parseNum(v?.[it.key]) !== null ? `${it.label} ${money(v[it.key], q.unit)}` : null)).filter(Boolean).join(' · ') + approx;
    }
    case 'channels':
      return q.items.map((it) => (String(v?.[it.key] || '').trim() ? `${it.label}: ${v[it.key]}` : null)).filter(Boolean).join(' · ');
    case 'reviews': {
      const praise = [...(v?.praise || []), v?.praiseText].filter((x) => String(x || '').trim());
      const bad = [...(v?.complaints || []), v?.complaintsText].filter((x) => String(x || '').trim());
      return [praise.length ? `칭찬: ${praise.join(', ')}` : null, bad.length ? `불평: ${bad.join(', ')}` : null].filter(Boolean).join(' / ');
    }
    case 'menucost': {
      if (v?.know === 'unknown') {
        const items = (v.items || []).filter((x) => x?.name).map((x) => [x.name, money(x.price, '원'), x.size, x.use ? `1회 ${x.use}` : null].filter(Boolean).join(' '));
        return `잘 몰라요${items.length ? ` → ${items.join(' / ')}` : ''}`;
      }
      const inc = (v?.includes || []).length ? ` (${v.includes.join('·')} 포함)` : '';
      return `${v?.know === 'approx' ? '대략 ' : ''}${money(v?.amount, '원') || '-'}${inc}`;
    }
    default: return String(v ?? '');
  }
}
