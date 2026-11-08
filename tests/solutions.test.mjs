// 맞춤 솔루션 점검: 기본 서비스·손님 앞 식사·영업 중 청소·반찬과 잔반·비용 기록
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSolutions, LEVEL } from '../public/solutions.js';

const ok = (v) => ({ s: 'ok', v });
const hall = { a_split: ok({ hall: { on: true, pct: '100' }, takeout: { on: false }, delivery: { on: false } }), a_basic: ok({ category: '국밥·탕·찌개' }), c_menus: ok([{ name: '얼큰 소고기국밥' }]) };
const sol = (answers) => buildSolutions({ answers: { ...hall, ...answers } }, null);
const byId = (list, id) => list.find((s) => s.id === id);

test('손님이 보는 곳에서 식사하면 솔루션이 나오고, 잘 지키면 나오지 않는다', () => {
  const bad = sol({ s_manners: ok({ mealWhen: '영업 중 틈틈이', mealWhere: '손님 좌석·홀', seen: '가끔 있어요', cleanDuring: ['손님 있을 땐 안 해요'] }) });
  const meal = byId(bad, 'staff_meal');
  assert.ok(meal, '식사 솔루션');
  assert.equal(meal.stars, 3, '손님 좌석에서 먹으면 우선 개선');
  assert.equal(meal.title, '손님이 보는 곳에서 식사하지 마세요.');
  assert.ok(meal.evidence.includes('식사 장소: 손님 좌석·홀'));
  assert.ok(meal.actions.some((a) => /오픈 전·브레이크 타임·마감 후/.test(a)));
  assert.ok(!byId(bad, 'clean_timing'), '손님 있을 땐 청소 안 하면 청소 솔루션 없음');

  const seenOnly = byId(sol({ s_manners: ok({ mealWhen: '손님이 적은 시간에 교대로', mealWhere: '주방 안쪽', seen: '가끔 있어요', cleanDuring: [] }) }), 'staff_meal');
  assert.equal(seenOnly.stars, 2);

  const good = sol({ s_manners: ok({ mealWhen: '영업 전·후', mealWhere: '손님이 안 보이는 따로 된 공간', seen: '없어요', cleanDuring: ['테이블 닦기만 해요'] }) });
  assert.ok(!byId(good, 'staff_meal') && !byId(good, 'clean_timing'));
});

test('손님이 있을 때 청소하면 솔루션이 나오고, 냄새 나는 세제 청소는 우선 개선', () => {
  const mop = byId(sol({ s_manners: ok({ mealWhen: '영업 전·후', mealWhere: '주방 안쪽', seen: '없어요', cleanDuring: ['바닥 쓸기·걸레질', '의자 올리기 같은 마감 정리'] }) }), 'clean_timing');
  assert.equal(mop.stars, 2);
  assert.equal(mop.title, '손님이 있을 때는 청소하지 마세요.');
  assert.ok(mop.actions.some((a) => /의자 올리기/.test(a)), '마감 정리 안내');
  const chem = byId(sol({ s_manners: ok({ mealWhen: '영업 전·후', mealWhere: '주방 안쪽', seen: '없어요', cleanDuring: ['락스·세제 냄새 나는 청소'] }) }), 'clean_timing');
  assert.equal(chem.stars, 3);
  assert.ok(chem.actions.some((a) => /환기/.test(a)));
});

test('담요·자주 찾는 물품·앞치마·짐 둘 곳 솔루션', () => {
  const list = sol({ s_service: ok({ amenities: ['물티슈'], requests: ['물', '담요'], temp: '자주 있어요', apron: '직원에게 요청해야 해요', storage: '부족해요' }) });
  const blanket = byId(list, 'blanket');
  assert.ok(blanket && blanket.stars === 2);
  assert.ok(blanket.actions[0].startsWith('냉난방 온도와 바람 방향을 먼저'), '담요보다 냉난방 조정이 먼저');
  const req = byId(list, 'requests');
  assert.match(req.title, /자주 찾는 물품/);
  assert.match(req.problem, /^물·담요를 따로 달라는/);
  const apron = byId(list, 'apron');
  assert.match(apron.problem, /얼큰 소고기국밥은 국물이나 양념이 튈 수 있는데/);
  assert.ok(byId(list, 'storage'));
  const withBlanket = sol({ s_service: ok({ amenities: ['담요'], requests: ['거의 없어요'], temp: '자주 있어요', storage: '충분해요' }) });
  assert.ok(!byId(withBlanket, 'blanket') && byId(withBlanket, 'temp_check'), '담요가 있으면 자리별 바람 점검');
  assert.ok(!byId(withBlanket, 'requests'));
});

test('같은 잔반이 계속 남으면 이유를 찾아 고치는 솔루션 (맛 확인은 따로 덜어 둔 것으로)', () => {
  const list = sol({
    k_sides: ok({ provide: 'yes', serve: '자리마다 기본으로 차려 드려요', refill: '직원이 더 드려요' }),
    k_leftover: ok({ recent: '기억나요', look: '가끔 봐요', repeat: '자주 그래요', which: '콩나물무침', why: ['양이 많아서', '간·맛이 안 맞아서'], asked: '없어요', taste: '해본 적 없어요' }),
  });
  const fix = byId(list, 'leftover_fix');
  assert.ok(fix);
  assert.equal(fix.stars, 3);
  assert.equal(fix.title, '콩나물무침이 계속 남는다면 이유를 찾아 고치세요.');
  assert.match(fix.problem, /^콩나물무침이 여러 테이블에서 자주 남아요/);
  const all = fix.actions.join('\n');
  assert.match(all, /손님 안 보이는 곳에서 직접 맛보세요/);
  assert.match(all, /따로 덜어 둔 것/);
  assert.match(all, /손님이 남긴 음식은 맛보지 않고/);
  assert.match(all, /입에 맞으셨어요/, '물어본 적 없으면 묻는 문구');
  assert.match(all, /기본으로 내는 양을 줄이고/, '양이 많다는 이유에 맞춘 수정');
  assert.match(all, /양념 비율을 계량/, '간·맛 이유에 맞춘 수정');
  assert.match(all, /자리마다 기본으로 차리는 반찬이라면/);
  assert.ok(fix.evidence.includes('반찬 나가는 방식: 자리마다 기본으로 차려 드려요'));
  assert.ok(!byId(list, 'leftover_record'), '이미 살펴보고 있으면 기록 안내는 생략');
});

test('잔반을 살펴보지 않거나 기억이 안 나면 일주일 기록부터', () => {
  const list = sol({ k_leftover: ok({ recent: '잘 기억 안 나요', look: '따로 보지 않아요', repeat: '잘 모르겠어요', why: ['이유를 모르겠어요'], asked: '없어요', taste: '해본 적 없어요' }) });
  const rec = byId(list, 'leftover_record');
  assert.ok(rec && rec.stars === 2);
  assert.match(rec.actions[0], /다 먹음 · 조금 남음 · 절반 · 거의 그대로/);
  assert.ok(!byId(list, 'leftover_fix'));
  const fine = sol({ k_leftover: ok({ recent: '기억나요', look: '매번 살펴봐요', repeat: '거의 없어요', why: ['손님마다 달라요'], asked: '있어요', taste: '정기적으로 맛봐요' }) });
  assert.ok(!byId(fine, 'leftover_record') && !byId(fine, 'leftover_fix'));
});

test('비용을 모르면 비용 기록이 맨 위(우선 개선)에 오고, 우선순위 순으로 정렬된다', () => {
  const list = sol({
    b_know: ok('unknown'),
    s_service: ok({ amenities: [], requests: ['물'], temp: '거의 없어요', storage: '부족해요' }),
    s_manners: ok({ mealWhen: '영업 전·후', mealWhere: '주방 안쪽', seen: '자주 있어요', cleanDuring: [] }),
  });
  assert.equal(list[0].stars, 3);
  assert.deepEqual(list.map((s) => s.stars), [...list.map((s) => s.stars)].sort((a, b) => b - a));
  assert.ok(byId(list, 'cost_record'));
  assert.equal(LEVEL[3], '우선 개선');
  for (const s of list) {
    assert.ok(s.title && s.problem && s.actions.length && s.metric, `${s.id} 형식`);
    assert.ok(s.actions.every((a) => typeof a === 'string' && a.length > 5), `${s.id} 실행 항목`);
  }
});

test('답하지 않았거나 잘 모름이면 솔루션을 지어내지 않는다', () => {
  assert.deepEqual(buildSolutions({ answers: {} }, null), []);
  assert.deepEqual(buildSolutions({ answers: { s_manners: { s: 'unknown' }, k_leftover: { s: 'na' } } }, null), []);
});
