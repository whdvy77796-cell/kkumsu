// 인터뷰 질문 분기 점검 (설계 문서 원칙대로 질문이 바뀌는지)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUESTIONS, QMAP, PAGES, buildCtx, visibleQuestions, visiblePages, isAnswered, answerText, splitCheck, resolve, guessCategory, guessPeriod, guessServices, storeFlags, josa } from '../public/questions.js';

const STORE = {
  name: '얼큰집', address: '서울 마포구 망원로 1', category: '국밥 전문점', openedYear: '2019년 개업', floor: '2층',
  services: { hall: true, takeout: true, delivery: true, reservation: null },
  menu: [{ name: '얼큰 소고기국밥', price: '11,000원' }, { name: '수육', price: '대 32,000원' }, { name: '공깃밥', price: null }],
  strengths: ['국물이 진하다'], weaknesses: ['점심 웨이팅이 길다', '화장실이 좁고 지저분하다'],
  reviewThemes: [{ theme: '대기', tone: 'bad', note: '점심에 20분 넘게 기다림' }, { theme: '가격', tone: 'mixed', note: '조금 비싸다' }],
  features: ['포장 가능', '배달 가능'], channels: [{ type: '네이버 플레이스', url: 'https://naver.me/abc' }, { type: '인스타그램', url: 'https://instagram.com/x' }],
};

const ok = (v) => ({ s: 'ok', v });
const split = (hall, takeout, delivery) => ({ hall: { on: hall, pct: '' }, takeout: { on: takeout, pct: '' }, delivery: { on: delivery, pct: '' } });
const ids = (S, store) => visibleQuestions(S, store).map((q) => q.id);
function state(answers) { return { answers }; }

test('AI가 찾은 정보로 업종·운영 기간·판매 방식·메뉴·SNS를 미리 채운다 (채널 주소 질문은 없음)', () => {
  const c = buildCtx(state({}), STORE);
  assert.deepEqual(QMAP.a_basic.prefill(c), { category: '국밥·탕·찌개', period: guessPeriod('2019년 개업') });
  assert.deepEqual(QMAP.a_split.prefill(c), split(true, true, true));
  assert.equal(QMAP.a_channels, undefined, '네이버·카카오맵·인스타·배달앱 주소 질문은 뺐다');
  assert.deepEqual(QMAP.f_sns.prefill(c), { channels: ['인스타그램'] }, 'SNS는 AI가 찾은 채널로 미리 고른다');
  assert.deepEqual(QMAP.c_menus.prefill(c), [
    { name: '얼큰 소고기국밥', price: 11000, qty: '' }, { name: '수육', price: 32000, qty: '' }, { name: '공깃밥', price: '', qty: '' },
  ]);
  assert.match(resolve(QMAP.l_entrance.hint, c) || '', /2층/);
  assert.equal(QMAP.l_entrance.prefill(c).floor, '2층 이상');
});

test('앞에서 입력한 대표 메뉴 이름을 이후 질문에 그대로 쓴다 (조사도 맞게)', () => {
  const c1 = buildCtx(state({ c_menus: ok([{ name: '얼큰 소고기국밥' }]), a_basic: ok({ category: '국밥·탕·찌개' }) }), STORE);
  assert.equal(resolve(QMAP.c_cost.title, c1), '대표 메뉴가 얼큰 소고기국밥이네요. 이 메뉴 한 그릇을 만들 때 반찬·소스·포장까지 포함해 재료비가 얼마나 드는지 알고 계신가요?');
  assert.match(resolve(QMAP.s_service.fields.find((f) => f.key === 'apron').label, c1), /^얼큰 소고기국밥을 먹을 때/);
  const c2 = buildCtx(state({ c_menus: ok([{ name: '떡볶이' }]), a_basic: ok({ category: '분식' }) }), null);
  assert.match(resolve(QMAP.c_cost.title, c2), /대표 메뉴가 떡볶이네요\. 이 메뉴 한 그릇을/);
  assert.match(resolve(QMAP.c_cook.title, c2), /^떡볶이는 만드는 데/);
  assert.equal(josa('라떼', '을', '를'), '라떼를');
});

test('배달을 하지 않으면 배달 질문을 건너뛴다', () => {
  const base = { a_problem: ok('profit'), b_know: ok('exact'), a_staff: ok({ staff: 2, owner: 10 }), c_menus: ok([{ name: '국밥' }]) };
  const noDelivery = ids(state({ ...base, a_split: ok(split(true, true, false)) }), STORE);
  const withDelivery = ids(state({ ...base, a_split: ok(split(true, false, true)) }), STORE);
  for (const id of ['m_unit', 'm_ops']) {
    assert.ok(!noDelivery.includes(id), `${id}는 배달을 안 하면 없어야 함`);
    assert.ok(withDelivery.includes(id), `${id}는 배달을 하면 있어야 함`);
  }
  assert.equal(QMAP.b_channel_sales.fields.find((f) => f.key === 'delivery').when(buildCtx(state({ ...base, a_split: ok(split(true, true, false)) }), STORE)), false);
});

test('비용을 모르면 세부 비용 대신 기록 방법 안내로, 알면 세부 비용으로 넘어간다', () => {
  const unknown = ids(state({ a_problem: ok('acquisition'), b_know: ok('unknown'), a_split: ok(split(true, false, false)) }), STORE);
  assert.ok(!unknown.includes('b_sales') && !unknown.includes('b_costs'));
  assert.ok(unknown.includes('b_records'), '장부·POS 자료 질문');
  const exact = ids(state({ a_problem: ok('acquisition'), b_know: ok('exact'), a_split: ok(split(true, false, false)) }), STORE);
  assert.ok(exact.includes('b_sales') && exact.includes('b_costs'));
  const cExact = buildCtx(state({ b_know: ok('exact'), a_staff: ok({ staff: 1, owner: 9 }), a_split: ok(split(true, true, true)) }), STORE);
  const cApprox = buildCtx(state({ b_know: ok('approx'), a_staff: ok({ staff: 0, owner: 9 }), a_split: ok(split(true, false, false)) }), STORE);
  assert.equal(resolve(QMAP.b_costs.items, cExact).length, 9);
  assert.deepEqual(resolve(QMAP.b_costs.items, cApprox).map((i) => i.key), ['food', 'rent', 'etc']);
});

test('가장 큰 고민에 맞는 추가 질문만 나온다', () => {
  const common = { a_split: ok(split(true, false, false)), a_staff: ok({ staff: 2, owner: 10 }), b_know: ok('approx'), c_menus: ok([{ name: '국밥' }]) };
  const pagesOf = (problem) => visiblePages(state({ ...common, a_problem: ok(problem) }), null).map((p) => p.id);
  assert.ok(pagesOf('acquisition').includes('marketing'));
  assert.ok(!pagesOf('profit').includes('marketing'));
  assert.ok(pagesOf('profit').includes('purchase'));
  assert.ok(!pagesOf('acquisition').includes('purchase'));
  const labor = ids(state({ ...common, a_problem: ok('labor') }), null);
  assert.ok(labor.includes('j_training') && labor.includes('o_peak'));
  const repeat = ids(state({ ...common, a_problem: ok('repeat') }), null);
  assert.ok(repeat.includes('g_manage') && repeat.includes('n_ops'));
  assert.ok(!repeat.includes('j_more') && !repeat.includes('o_peak'));
  const solo = ids(state({ ...common, a_staff: ok({ staff: 0, owner: 12 }), a_problem: ok('labor') }), null);
  assert.ok(!solo.includes('j_training'), '직원이 없으면 직원 교육 질문은 없다');
});

test('AI가 찾은 리뷰 신호(대기·가격·화장실)로 관련 질문을 더한다', () => {
  const flags = storeFlags(STORE);
  assert.equal(flags.wait, true);
  assert.equal(flags.price, true);
  assert.equal(flags.restroom, true);
  const S = state({ a_problem: ok('acquisition'), a_split: ok(split(true, false, false)), a_staff: ok({ staff: 1, owner: 10 }), b_know: ok('unknown'), c_menus: ok([{ name: '얼큰 소고기국밥' }]), i_rest: ok({ type: 'own', sep: 'split' }) });
  const list = ids(S, STORE);
  for (const id of ['n_wait', 'c_price', 'i_mirror']) assert.ok(list.includes(id), id);
  assert.equal(resolve(QMAP.s_service.hint, buildCtx(S, STORE)), null, '화장실이 좁다는 불평은 좌석 신호로 세지 않는다');
  const c = buildCtx(S, STORE);
  assert.match(resolve(QMAP.n_wait.hint, c), /점심에 20분 넘게 기다림/);
  assert.equal(resolve(QMAP.i_state.title, c), '여자화장실 상태와 핸드워시는 어떤가요?');
  const none = ids(state({ ...S.answers, i_rest: ok({ type: 'none' }) }), STORE);
  assert.ok(!none.includes('i_state') && !none.includes('i_mirror'), '화장실이 없으면 화장실 세부 질문 없음');
});

test('질문 수는 상황에 따라 대략 20~36개 사이로 유지된다', () => {
  const scenarios = {
    '배달 국밥집·이익 고민·대략 앎': { a_problem: ok('profit'), a_split: ok(split(true, true, true)), a_staff: ok({ staff: 2, owner: 11 }), b_know: ok('approx'), c_menus: ok([{ name: '얼큰 소고기국밥' }, { name: '수육' }]), k_sides: ok({ provide: 'yes' }), i_rest: ok({ type: 'own', sep: 'split' }) },
    '매장 카페·손님 부족·혼자': { a_problem: ok('acquisition'), a_split: ok(split(true, true, false)), a_staff: ok({ staff: 0, owner: 10 }), b_know: ok('approx'), a_basic: ok({ category: '카페' }), c_menus: ok([{ name: '아메리카노' }]), i_rest: ok({ type: 'own', sep: 'unisex' }), e_spend: ok({ insta: 30 }) },
    '비용 모름·재방문 고민': { a_problem: ok('repeat'), a_split: ok(split(true, false, false)), a_staff: ok({ staff: 1, owner: 12 }), b_know: ok('unknown'), c_menus: ok([{ name: '김치찌개' }]), a_basic: ok({ category: '한식' }), k_sides: ok({ provide: 'yes' }), i_rest: ok({ type: 'shared', sep: 'split' }) },
    '배달 전문·일손 고민': { a_problem: ok('labor'), a_split: ok(split(false, false, true)), a_staff: ok({ staff: 3, owner: 10 }), b_know: ok('exact'), c_menus: ok([{ name: '치킨' }]), a_basic: ok({ category: '치킨·피자·버거' }) },
  };
  const counts = {};
  for (const [name, answers] of Object.entries(scenarios)) {
    counts[name] = visibleQuestions(state(answers), STORE).length;
    assert.ok(counts[name] >= 20 && counts[name] <= 36, `${name}: ${counts[name]}개`);
  }
  console.log('시나리오별 질문 수', counts, '/ 전체 질문 은행', QUESTIONS.length);
});

test('답 확인: 잘 모름·해당 없음, 비중 합계, 메뉴 원가 분기', () => {
  const c = buildCtx(state({}), null);
  assert.equal(isAnswered(QMAP.a_intro, { s: 'unknown' }, c), true);
  assert.equal(isAnswered(QMAP.a_intro, { s: 'ok', v: '  ' }, c), false);
  assert.equal(isAnswered(QMAP.a_problem, { s: 'ok', v: { value: null, detail: '설명만' } }, c), false);
  assert.equal(isAnswered(QMAP.a_problem, { s: 'ok', v: { value: 'profit', detail: '' } }, c), true);
  const two = { hall: { on: true, pct: '70' }, takeout: { on: false }, delivery: { on: true, pct: '20' } };
  assert.equal(splitCheck(two, 'ok').ok, false);
  assert.equal(splitCheck(two, 'approx').ok, true, '대략이면 합계 80~120% 허용');
  assert.equal(splitCheck({ ...two, delivery: { on: true, pct: '30' } }, 'ok').ok, true);
  assert.equal(splitCheck({ hall: { on: true, pct: '' }, delivery: { on: true, pct: '' } }, 'unknown').ok, true);
  assert.equal(isAnswered(QMAP.c_cost, { s: 'ok', v: { know: 'known', amount: '' } }, c), false);
  assert.equal(isAnswered(QMAP.c_cost, { s: 'ok', v: { know: 'known', amount: '3,500' } }, c), true);
  assert.equal(isAnswered(QMAP.c_cost, { s: 'ok', v: { know: 'unknown' } }, c), true);
  assert.equal(isAnswered(QMAP.c_price, { s: 'ok', v: { change: 'up', expensive: '가격 자체 때문이에요' } }, c), false, '가격을 바꿨으면 이후 판매량도 답해야 함');
  assert.equal(isAnswered(QMAP.c_price, { s: 'ok', v: { change: 'none', expensive: '잘 모르겠어요' } }, c), true);
  assert.equal(isAnswered(QMAP.e_spend, { s: 'na' }, c), true);
});

test('AI 검색 질문은 모든 가게에 보이고 처음 듣거나 중요도를 몰라도 답할 수 있으며 목표는 선택이다', () => {
  const q = QMAP.a_ai_search;
  assert.equal(q.page, 'basic');
  assert.equal(q.type, 'group');
  assert.match(q.help, /처음 들어도 괜찮아요/);
  const [awareness, importance, goal] = q.fields;
  assert.equal(goal.optional, true);
  assert.equal(goal.type, 'text');
  assert.ok(awareness.options.some((o) => o.v === 'new' && /처음/.test(o.label)));
  assert.ok(importance.options.some((o) => o.v === 'unsure' && /모르/.test(o.label)));
  for (const problem of ['acquisition', 'profit', 'repeat', 'labor']) {
    assert.ok(ids(state({ a_problem: ok(problem) }), null).includes(q.id));
  }
  const c = buildCtx(state({}), null);
  const noGoal = ok({ awareness: 'new', importance: 'unsure' });
  assert.equal(isAnswered(q, noGoal, c), true);
  assert.equal(isAnswered(q, ok({ awareness: 'new' }), c), false, '중요도도 모름을 포함해 선택');
  assert.match(answerText(q, noGoal, c), /처음 들어요/);
  assert.match(answerText(q, noGoal, c), /잘 모르겠어요/);
  const withGoal = ok({ ...noGoal.v, goal: '혼자 점심 먹기 좋은 곳' });
  assert.match(answerText(q, withGoal, c), /혼자 점심 먹기 좋은 곳/);
});

test('모든 질문이 화면·형식·이유를 갖고 있다', () => {
  const pageIds = PAGES.map((p) => p.id);
  for (const q of QUESTIONS) {
    assert.ok(pageIds.includes(q.page), `${q.id} 화면`);
    assert.ok(q.why && q.why.length > 5, `${q.id} 이유`);
    assert.ok(q.title, `${q.id} 제목`);
  }
  assert.equal(new Set(QUESTIONS.map((q) => q.id)).size, QUESTIONS.length, '질문 id 중복 없음');
  assert.equal(guessCategory('평양냉면 전문점 (냉면·불고기·갈비)'), '면 요리');
  assert.equal(guessCategory('카페, 베이커리 카페'), '카페');
  assert.deepEqual(guessServices({ features: ['배달 전문'] }), { hall: false, takeout: null, delivery: true });
});

test('홀이 있으면 기본 서비스·손님 앞 기본을 묻고, 음식점이면 반찬·잔반을 묻는다', () => {
  const base = { a_problem: ok('acquisition'), b_know: ok('unknown'), a_staff: ok({ staff: 1, owner: 10 }), c_menus: ok([{ name: '김치찌개' }]) };
  const hallFood = ids(state({ ...base, a_split: ok(split(true, false, false)), a_basic: ok({ category: '한식' }) }), null);
  for (const id of ['s_service', 's_manners', 'k_sides', 'k_leftover']) assert.ok(hallFood.includes(id), id);
  const cafe = ids(state({ ...base, a_split: ok(split(true, true, false)), a_basic: ok({ category: '카페' }) }), null);
  assert.ok(cafe.includes('s_service') && cafe.includes('s_manners'));
  assert.ok(!cafe.includes('k_sides') && !cafe.includes('k_leftover'), '카페는 반찬·잔반 질문 없음');
  const deliveryOnly = ids(state({ ...base, a_split: ok(split(false, false, true)), a_basic: ok({ category: '한식' }) }), null);
  for (const id of ['s_service', 's_manners', 'k_sides', 'k_leftover']) assert.ok(!deliveryOnly.includes(id), `배달 전용이면 ${id} 없음`);
  const c = buildCtx(state({ k_sides: ok({ provide: 'no' }) }), null);
  assert.equal(isAnswered(QMAP.k_sides, ok({ provide: 'no' }), c), true, '반찬을 안 주면 나머지 칸은 묻지 않음');
  assert.equal(isAnswered(QMAP.k_sides, ok({ provide: 'yes' }), c), false);
  assert.equal(isAnswered(QMAP.k_sides, ok({ provide: 'yes', serve: '셀프바에서 덜어 가요', refill: '셀프로 더 가져가요' }), c), true, '가짓수는 선택');
});

test('단계 순서: 1단계 → 반찬·식재료·마케팅·리뷰·기본 서비스·청소·운영·실행 준비 → 예산과 매출·비용 → 대표 메뉴 → 자세히', () => {
  assert.deepEqual(PAGES.map((p) => p.id), ['basic', 'sides', 'purchase', 'marketing', 'experience', 'basics', 'clean', 'ops', 'finish', 'money', 'menu', 'menuDetail']);
  assert.equal(QMAP.a_problem.page, 'basic', '가장 큰 고민은 1단계');
  assert.equal(QMAP.b_know.page, 'basic', '비용 파악 여부는 1단계');
});

test('1단계만 답하면 앞 단계 질문이 정해지고, 뒤의 매출·메뉴 단계를 답해도 앞 단계에 질문이 새로 생기지 않는다', () => {
  const late = new Set(['money', 'menu', 'menuDetail']);
  const earlyIds = (answers) => visiblePages({ answers }, STORE).filter((p) => !late.has(p.id)).flatMap((p) => p.questions.map((q) => q.id)).join(',');
  for (const problem of ['acquisition', 'profit', 'repeat', 'labor']) {
    for (const know of ['exact', 'approx', 'unknown']) {
      const step1 = {
        a_basic: ok({ category: '국밥·탕·찌개' }), a_split: ok(split(true, true, true)), a_staff: ok({ staff: '2', owner: '10' }),
        a_problem: ok(problem), b_know: ok(know),
      };
      const before = earlyIds(step1);
      const after = earlyIds({
        ...step1,
        a_budget: ok({ money: '30만 원 이하', time: '1~3시간' }),
        b_sales: ok([{ sales: '2400', days: '26' }]), b_costs: ok({ food: '1000', labor: '400', rent: '250', etc: '100' }),
        c_menus: ok([{ name: '얼큰 소고기국밥', price: '11000', qty: '1200' }, { name: '수육', price: '25000', qty: '200' }]),
        c_worry: ok([{ name: '수육', price: '25000' }]), c_cost: ok({ know: 'known', amount: '4800', includes: [] }),
      });
      assert.equal(after, before, `${problem}/${know}: 앞 단계 질문이 바뀜`);
    }
  }
});
