// 매출올려드림 AI · 답변에 따라 나오는 맞춤 솔루션 (운영 설계 문서 18장 형식)
// 발견한 문제 · 확인 근거 · 추천 행동 · 실행 방법 · 비용과 기간 · 확인 지표
// 우선순위: ★★★ 우선 개선 / ★★ 이번 주 실행 / ★ 조건부 실험 / 확인 필요
import { buildCtx, josa } from './questions.js';

export const LEVEL = { 3: '우선 개선', 2: '이번 주 실행', 1: '조건부 실험', 0: '확인 필요' };

const ans = (S, id) => {
  const a = S.answers?.[id];
  return a && (a.s === 'ok' || a.s === 'approx') ? a.v || {} : null;
};
const has = (list, x) => Array.isArray(list) && list.includes(x);
const often = (v) => v === '자주 있어요' || v === '가끔 있어요';
const ev = (label, value) => (value == null || value === '' || (Array.isArray(value) && !value.length) ? null : `${label}: ${Array.isArray(value) ? value.join(', ') : value}`);

export function buildSolutions(S, store) {
  const c = buildCtx(S, store);
  const menu = c.menuName;
  const out = [];
  const add = (sol) => out.push({ ...sol, evidence: (sol.evidence || []).filter(Boolean), actions: sol.actions.filter(Boolean) });

  // ── 비용을 모를 때 (문서 3장)
  if (c.costKnow === 'unknown') {
    add({
      id: 'cost_record', stars: 3, area: '매출·비용',
      title: '비용 기록부터 시작하세요.',
      problem: '지금 자료만으로는 이익이 줄어드는 원인을 정확히 확인하기 어려워요.',
      evidence: ['지난달 판매·지출·남은 돈: 잘 모르겠어요'],
      actions: [
        '매일 마감 후 그날 매출과 지출을 적어요.',
        '월말에는 남은 식재료(재고)를 확인해요.',
        '지금 쓰는 POS의 장부 기능이나 캐시노트처럼 매출·비용 조회와 장부 관리 기능이 있는 도구를 쓸 수 있어요.',
        '도구에 연결되지 않는 현금 지출과 재고는 따로 적어 둬요.',
      ],
      cost: '추가 비용 없음 · 오늘부터 한 달',
      metric: '한 달 뒤 매출·비용·남은 돈을 한 장으로 정리할 수 있는지 확인해요.',
    });
  }

  // ── 손님 앞 기본: 식사 (문서 9장 + 사장님 기준)
  const m = ans(S, 's_manners');
  if (m) {
    const seen = m.seen === '자주 있어요' || m.seen === '가끔 있어요';
    const badWhere = ['손님 좌석·홀', '카운터 근처', '정해진 곳이 없어요'].includes(m.mealWhere);
    const badWhen = ['영업 중 틈틈이', '정해진 때가 없어요'].includes(m.mealWhen);
    if (seen || badWhere || badWhen) {
      add({
        id: 'staff_meal', stars: m.seen === '자주 있어요' || m.mealWhere === '손님 좌석·홀' ? 3 : 2, area: '손님 앞 기본',
        title: '손님이 보는 곳에서 식사하지 마세요.',
        problem: seen
          ? '사장님이나 직원이 식사하다가 손님과 마주친 적이 있어요. 손님에게는 가게가 어수선해 보일 수 있어요.'
          : '식사 시간이나 장소가 정해져 있지 않아 손님 눈에 띌 수 있어요.',
        evidence: [ev('식사 시간', m.mealWhen), ev('식사 장소', m.mealWhere), ev('식사 중 손님과 마주침', m.seen)],
        actions: [
          '식사 시간을 손님이 거의 없는 때(오픈 전·브레이크 타임·마감 후)로 정하고, 바쁜 날은 한 명씩 교대로 먹어요.',
          '식사 장소는 주방 안쪽·창고·휴게 공간처럼 손님 시야 밖으로 정해요. 따로 된 공간이 없으면 가림막이나 커튼으로 가려요.',
          '영업 중에는 손님 좌석이나 카운터에서 식사하거나 음식을 두지 않는다는 규칙을 직원과 함께 정해요.',
          '가방·휴대폰·개인 컵 같은 개인 물품도 손님 눈에 띄지 않는 곳에 둬요.',
        ],
        cost: '추가 비용 거의 없음 (가림막을 쓰면 소액) · 이번 주',
        metric: '일주일 동안 식사 시간·장소가 지켜졌는지 체크하고, 손님과 마주친 일이 없었는지 확인해요.',
      });
    }

    // ── 손님 앞 기본: 영업 중 청소
    const during = (m.cleanDuring || []).filter((x) => !['테이블 닦기만 해요', '손님 있을 땐 안 해요'].includes(x));
    if (during.length) {
      const chemical = during.includes('락스·세제 냄새 나는 청소');
      add({
        id: 'clean_timing', stars: chemical ? 3 : 2, area: '손님 앞 기본',
        title: '손님이 있을 때는 청소하지 마세요.',
        problem: chemical
          ? '손님이 식사하는 중에 락스·세제 냄새가 나는 청소를 하고 있어요. 음식 맛과 위생 인상을 함께 해쳐요.'
          : '손님이 식사하는 중에 바닥 청소나 마감 정리를 하고 있어요. 손님은 빨리 나가 달라는 신호로 느낄 수 있어요.',
        evidence: [ev('손님 있을 때 하는 청소', during)],
        actions: [
          '영업 중에는 테이블 닦기와 흘린 것 바로 치우기만 해요.',
          '바닥 쓸기·걸레질·쓰레기 정리는 오픈 전·마감 후나 손님이 없는 시간으로 옮겨요.',
          chemical ? '락스·세제처럼 냄새가 나는 청소는 손님이 없을 때만 하고, 끝나면 환기해요.' : null,
          during.includes('의자 올리기 같은 마감 정리') ? '마감 전에 손님이 남아 있으면 의자 올리기·조명 줄이기 같은 마감 정리를 시작하지 않아요.' : null,
          '시간대별로 할 청소(오픈 전·영업 중·마감 후)를 표로 정해 붙여 두고 담당자를 정해요.',
        ],
        cost: '추가 비용 없음 · 이번 주',
        metric: '손님이 있는 시간에 청소한 횟수를 일주일 동안 적어 0회로 줄여요.',
      });
    }
  }

  // ── 기본 서비스 (문서 9장)
  const sv = ans(S, 's_service');
  if (sv) {
    const hasBlanket = has(sv.amenities, '담요');
    const tempIssue = often(sv.temp);
    if ((tempIssue || has(sv.requests, '담요')) && !hasBlanket) {
      add({
        id: 'blanket', stars: 2, area: '기본 서비스',
        title: '냉난방을 먼저 맞추고, 필요하면 담요를 준비하세요.',
        problem: '춥다(덥다)는 의견이나 담요 요청이 있는데 담요가 준비돼 있지 않아요.',
        evidence: [ev('춥다·덥다는 의견', sv.temp), has(sv.requests, '담요') ? '자주 요청하는 물품: 담요' : null, '준비된 것에 담요 없음'],
        actions: [
          '냉난방 온도와 바람 방향을 먼저 조정하고, 에어컨이나 출입문 바람이 바로 닿는 자리가 있는지 확인해요.',
          '그래도 춥다는 손님이 있으면 담요를 손님이 찾기 쉬운 곳에 두거나, 자리에 앉을 때 안내해요.',
          '담요는 세탁 주기를 정해 깨끗하게 관리하고, 쓴 담요는 따로 모아요.',
        ],
        cost: '담요 몇 장 정도의 소액 · 이번 주',
        metric: '춥다는 의견과 담요 요청 횟수를 2주 동안 적어 줄었는지 봐요.',
      });
    } else if (tempIssue && sv.temp === '자주 있어요') {
      add({
        id: 'temp_check', stars: 1, area: '기본 서비스',
        title: '자리마다 바람과 온도를 점검하세요.',
        problem: '담요는 있지만 춥다·덥다는 의견이 자주 나와요.',
        evidence: [ev('춥다·덥다는 의견', sv.temp)],
        actions: [
          '에어컨·난방기·출입문 가까운 자리를 직접 앉아 보며 바람이 바로 닿는지 확인해요.',
          '바람 방향을 바꾸거나 가림판을 두고, 그래도 불편한 자리는 손님을 안내할 때 피해요.',
        ],
        cost: '추가 비용 거의 없음',
        metric: '춥다·덥다는 의견 횟수',
      });
    }
    const req = (sv.requests || []).filter((x) => x !== '거의 없어요');
    if (req.length) {
      add({
        id: 'requests', stars: 2, area: '기본 서비스',
        title: '손님이 자주 찾는 물품은 바로 쓸 수 있게 두세요.',
        problem: `${josa(req.join('·'), '을', '를')} 따로 달라는 요청이 잦아요. 손님은 기다리고, 직원은 일이 늘어요.`,
        evidence: [ev('자주 요청하는 물품', req), ev('준비된 것', sv.amenities)],
        actions: [
          `${josa(req.join('·'), '을', '를')} 테이블이나 셀프 코너에 두거나, 자리에 앉을 때 함께 드려요.`,
          '셀프로 두는 물품은 위치를 알리는 작은 안내 문구를 붙여요.',
          '보충 담당과 시점(오픈 전·바쁜 시간 전)을 정해요.',
          '테이블 서비스 중심 매장이라면 셀프보다 직원이 먼저 챙겨 드리는 방식이 더 맞을 수 있어요.',
        ],
        cost: '소액 (수납함·안내 문구) · 이번 주',
        metric: '같은 물품 요청 횟수를 일주일 동안 적어 줄었는지 봐요.',
      });
    }
    if (c.soupy && (sv.apron === '직원에게 요청해야 해요' || sv.apron === '앞치마가 없어요')) {
      add({
        id: 'apron', stars: 2, area: '기본 서비스',
        title: '앞치마 제공 위치를 개선하세요.',
        problem: sv.apron === '앞치마가 없어요'
          ? `${josa(menu, '은', '는')} 국물이나 양념이 튈 수 있는데 앞치마가 준비돼 있지 않아요.`
          : `${josa(menu, '은', '는')} 국물이나 양념이 튈 수 있는데, 앞치마를 직원에게 따로 달라고 해야 해요.`,
        evidence: [ev('앞치마 위치', sv.apron)],
        actions: [
          '손님이 쉽게 찾을 수 있는 위치에 깨끗한 앞치마를 두고 안내 문구를 붙여요.',
          '공간에 맞는 걸이나 수납함을 쓰고, 사용한 앞치마는 따로 모아요.',
          '테이블 서비스 중심이라면 자리에 앉을 때 먼저 권해도 좋아요.',
        ],
        cost: '앞치마·걸이 소액 · 이번 주',
        metric: '앞치마 요청 횟수와 옷이 더러워졌다는 불만이 줄었는지 봐요.',
      });
    }
    if (sv.storage === '부족해요') {
      add({
        id: 'storage', stars: 1, area: '기본 서비스',
        title: '가방·외투·우산 둘 곳을 마련하세요.',
        problem: '손님이 가방·외투·우산을 둘 곳이 부족해요.',
        evidence: [ev('짐 둘 곳', sv.storage)],
        actions: [
          '좌석 옆이나 의자 밑에 바구니를, 벽에는 옷걸이를 둬요. 통로를 막지 않는 위치로 정해요.',
          '비 오는 날은 입구에 우산 보관함과 물받이를 두고 바닥 물기를 자주 닦아요.',
        ],
        cost: '바구니·걸이 소액',
        metric: '짐 때문에 불편하다는 이야기가 줄었는지 봐요.',
      });
    }
  }

  // ── 반찬과 잔반 (문서 13장 + 사장님 기준)
  const sd = ans(S, 'k_sides');
  const lo = ans(S, 'k_leftover');
  if (lo) {
    const repeat = lo.repeat === '자주 그래요' || lo.repeat === '가끔 그래요';
    const notLooking = lo.look === '따로 보지 않아요' || lo.recent === '잘 기억 안 나요' || lo.repeat === '잘 모르겠어요';
    const item = String(lo.which || '').trim();
    const reasons = (lo.why || []).filter((x) => !['손님마다 달라요', '이유를 모르겠어요'].includes(x));
    const FIX = {
      '양이 많아서': '양이 많아서라면 기본으로 내는 양을 줄이고, 더 드시는 손님께 더 드리는 방식으로 바꿔요.',
      '간·맛이 안 맞아서': '간·맛이 문제라면 양념 비율을 계량해서 다시 맞추고, 만드는 사람이 바뀌어도 같은 맛이 나게 레시피를 적어 둬요.',
      '식었거나 온도가 안 맞아서': '온도가 문제라면 내기 직전에 담고, 따뜻한 것은 따뜻하게·찬 것은 차게 나가도록 순서를 바꿔요.',
      '메인 메뉴와 안 어울려서': `${josa(menu, '과', '와')} 어울리지 않는다면 같이 먹기 좋은 반찬으로 바꿔요.`,
    };
    if (repeat) {
      add({
        id: 'leftover_fix', stars: lo.repeat === '자주 그래요' ? 3 : 2, area: '반찬과 잔반',
        title: `${item ? josa(item, '이', '가') : '같은 음식이나 반찬이'} 계속 남는다면 이유를 찾아 고치세요.`,
        problem: `${item ? josa(item, '이', '가') : '같은 음식·반찬이'} 여러 테이블에서 ${lo.repeat === '자주 그래요' ? '자주' : '가끔'} 남아요. 손님 만족이 떨어질 수 있고, 재료비도 버려져요.`,
        evidence: [ev('같은 잔반 반복', lo.repeat), ev('자주 남는 것', item), ev('남는 이유', lo.why), ev('손님에게 물어봄', lo.asked), ev('직접 맛보기', lo.taste), sd?.provide === 'yes' ? ev('반찬 나가는 방식', sd.serve) : null],
        actions: [
          `남는 이유를 하나씩 확인해요: 양이 많은지, 간·맛이 맞는지, 식거나 너무 차지 않은지, ${josa(menu, '과', '와')} 어울리는지, 담음새가 먹기 불편한지.`,
          '손님 안 보이는 곳에서 직접 맛보세요. 같은 날 같은 조리분에서 따로 덜어 둔 것이나 새로 만든 것으로 확인하고, 손님이 남긴 음식은 맛보지 않고 눈으로 보고 기록만 해요.',
          lo.asked === '없어요'
            ? '손님에게 부담 없이 물어봐요. 예: "반찬 입에 맞으셨어요? 간이 세지는 않았어요?"'
            : '손님에게 들은 이유를 적어 두고, 같은 이야기가 반복되는지 봐요.',
          ...(reasons.length ? reasons.map((r) => FIX[r]) : [FIX['양이 많아서'], FIX['간·맛이 안 맞아서']]),
          sd?.serve === '자리마다 기본으로 차려 드려요'
            ? '자리마다 기본으로 차리는 반찬이라면 가짓수나 양을 줄이고, 원하는 손님께 더 드리는 방식을 1~2주 시험해요.'
            : null,
          '바꾼 뒤 1~2주 다시 기록해서 남는 양이 줄었는지 확인해요.',
        ],
        cost: '추가 비용 거의 없음, 남는 양이 줄면 재료비가 줄어요 · 1~2주',
        metric: `${item ? josa(item, '이', '가') : '해당 음식·반찬이'} 남은 테이블 수, 더 달라는 요청 수, 그 반찬 재료비를 바꾸기 전과 비교해요.`,
      });
    }
    if (notLooking) {
      add({
        id: 'leftover_record', stars: 2, area: '반찬과 잔반',
        title: '치울 때 잔반을 살펴보고, 일주일만 기록해 보세요.',
        problem: '손님이 무엇을 얼마나 남기는지 아직 잘 모르고 있어요. 남는 음식은 손님 만족과 재료비를 알려주는 가장 쉬운 자료예요.',
        evidence: [ev('최근 잔반 기억', lo.recent), ev('잔반 살펴보기', lo.look), ev('같은 잔반 반복', lo.repeat)],
        actions: [
          '테이블을 치우는 사람이 메인 메뉴와 반찬별로 남은 정도를 표시해요: 다 먹음 · 조금 남음 · 절반 · 거의 그대로.',
          '시간대와 함께 주문한 메뉴도 같이 적어요. 어떤 조합에서 남는지 보여요.',
          '일주일 뒤 같은 것이 반복해서 남는지 확인하고, 반복되면 이유를 찾아 고쳐요.',
          '손님이 남긴 음식은 눈으로 보고 기록만 해요. 맛은 같은 조리분에서 따로 덜어 둔 것으로 확인해요.',
        ],
        cost: '추가 비용 없음 · 일주일',
        metric: '일주일 잔반 기록표(반찬별로 남은 테이블 수)를 완성해요.',
      });
    }
  }

  return out.map((s, i) => ({ ...s, order: i })).sort((a, b) => b.stars - a.stars || a.order - b.order);
}
