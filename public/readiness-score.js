// 사용자가 직접 입력/확인한 내용만으로 "준비도"를 계산하는 순수 함수 모듈.
// AI 노출 확률이나 AI가 내용을 읽었다는 주장과는 무관하다.

export const READINESS_WEIGHTS = Object.freeze({
  basic: 20,
  offer: 20,
  difference: 20,
  audience: 15,
  visit: 10,
  faq: 15,
});

export const READINESS_LABELS = Object.freeze({
  basic: '이름과 주소',
  offer: '대표 상품/서비스',
  difference: '다른 곳과 다른 점',
  audience: '찾아오는 손님/상황',
  visit: '이용 정보',
  faq: '예상 질문 FAQ 확인',
});

export const READINESS_ORDER = Object.freeze(['basic', 'offer', 'difference', 'audience', 'visit', 'faq']);
export const NOT_APPLICABLE_KEYS = Object.freeze(['difference', 'audience', 'visit']);
export const MIN_NAME_LENGTH = 1;
export const MIN_ADDRESS_LENGTH = 4;
export const MIN_OFFER_LENGTH = 2;

const TIPS = Object.freeze({
  basic: '가게 이름(1자 이상)과 지도에 나오는 주소(4자 이상)를 실제 정보 그대로 입력해 주세요.',
  offer: '가장 자신 있게 내놓는 상품이나 서비스를 실제 이름 그대로 2자 이상으로 적어 주세요. 예: 대표 메뉴명, 주력 시술명.',
  difference: '실제로 해당하는 차이만 적어 주세요. 예: 직접 하는 작업 방식, 사용하는 재료, 운영 연차. 해당 사항이 없다면 "해당 없음"을 직접 선택할 수 있어요.',
  audience: '실제로 자주 오시는 손님이나 상황을 적어 주세요. 예: 점심 직장인, 아이 동반 가족. 해당 사항이 없다면 "해당 없음"을 직접 선택할 수 있어요.',
  visit: '영업시간, 주차, 예약 방법, 휴무일 등 실제 이용 정보 중 확실한 것을 적어 주세요. 해당 사항이 없다면 "해당 없음"을 직접 선택할 수 있어요.',
  faq: '손님이 물어볼 만한 질문과 답변을 직접 읽고 사실과 맞는지 확인한 뒤, 사장님이 확인 완료 표시를 해 주세요. 내용을 고치면 다시 확인이 필요해요.',
});

const NOT_APPLICABLE_TIP = '사장님이 직접 해당 없음으로 선택해 점수 계산에서 제외했어요.';

const PLACEHOLDER_WORDS = new Set([
  '모름', '몰라', '몰라요', '모르겠음', '모르겠어요', '모르겠습니다', '잘모름', '잘모르겠음', '잘모르겠어요', '잘모르겠습니다',
  '미입력', '미선택', '선택안함', '선택안했음', '없음', '해당없음', '해당사항없음', '해당무', '추후입력', '나중에', '나중에입력',
  '입력', '입력하세요', '입력해주세요', '입력필요', '작성', '작성예정', '작성하세요', '내용', '내용없음', '미정', '보류',
  'na', 'n/a', 'none', 'null', 'undefined', 'tbd', 'todo', 'test', 'temp', 'unknown', 'idk', 'dontknow', 'unsure', 'empty',
  'asdf', 'qwer', 'aaa', 'xxx', 'lorem', 'loremipsum', 'sample', 'example', '테스트', '예시', '샘플', 'ㅇㅇ', 'ㅁㄹ', 'ㅇㅁㅇ',
].map(s => s.normalize('NFKC').toLowerCase()));

function toText(value) {
  if (typeof value === 'string') return value;
  return '';
}

function compact(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[\s.,!?~\-_:;'"`()/\\|*#·…]+/g, (m) => (m.includes('/') ? '/' : ''));
}

// 빈 값, 기본 선택값, 모름/해당없음, 빈 칸 템플릿([..]), 의미 없는 반복은 모두 미입력으로 본다.
export function isPlaceholderText(value) {
  const text = toText(value).normalize('NFKC').trim();
  if (!text) return true;
  if (/\[\s*(?:\.{0,3}|…|가게 이름|가게명|주소|메뉴 이름|맛이나 재료|상품·서비스 이름|제공 방식|재료·공간·서비스의 특징|만드는 방식 또는 운영 방식|어떤 손님|방문 목적|방문 상황|주차 가능 여부와 방법|포장 가능 여부|예약·주차 등 확인할 점|업종|대표 메뉴|[^\]]{0,40}입력)\s*\]/.test(text)) return true; // 비어 있는 작성 예시
  if (/(\{\{.*?\}\}|<[^>]*>)/.test(text) && text.replace(/(\{\{.*?\}\}|<[^>]*>)/g, '').trim().length < 2) return true;
  const key = compact(text);
  if (!key || PLACEHOLDER_WORDS.has(key)) return true;
  if (/^[^\p{L}\p{N}]+$/u.test(text)) return true; // 기호만
  if (/^([a-z0-9])\1{2,}$/i.test(key)) return true; // 뜻 없는 영문·숫자 반복
  if (/^(모르|몰라|잘모르|해당없|해당사항없|미입력|미정)/.test(key) && key.length <= 12) return true;
  return false;
}

function validText(value, minLength) {
  const text = toText(value).trim();
  return !isPlaceholderText(text) && [...text].length >= minLength;
}

function validFaqString(value) {
  return typeof value === 'string' && value.trim().length > 0 && !isPlaceholderText(value);
}

function faqsValid(faqs) {
  if (!Array.isArray(faqs) || faqs.length === 0) return false;
  return faqs.every((f) => f && typeof f === 'object' && validFaqString(f.question) && validFaqString(f.answer));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function calculateReadiness(input = {}) {
  const { name = '', address = '', answers = {}, notApplicable = {}, faqReviewed = false, faqs = [] } = asObject(input);
  const safeAnswers = asObject(answers);
  const safeNa = asObject(notApplicable);

  const completed = {
    basic: validText(name, MIN_NAME_LENGTH) && validText(address, MIN_ADDRESS_LENGTH),
    offer: validText(safeAnswers.offer, MIN_OFFER_LENGTH),
    difference: validText(safeAnswers.difference, 1),
    audience: validText(safeAnswers.audience, 1),
    visit: validText(safeAnswers.visit, 1),
    faq: faqReviewed === true && faqsValid(faqs),
  };

  let earned = 0;
  let possible = 0;
  const items = READINESS_ORDER.map((key) => {
    const points = READINESS_WEIGHTS[key];
    let status;
    if (completed[key]) {
      status = 'completed';
    } else if (NOT_APPLICABLE_KEYS.includes(key) && safeNa[key] === true) {
      status = 'not-applicable';
    } else {
      status = 'missing';
    }
    if (status !== 'not-applicable') possible += points;
    if (status === 'completed') earned += points;
    return {
      key,
      label: READINESS_LABELS[key],
      points,
      status,
      tip: status === 'completed' ? '' : status === 'not-applicable' ? NOT_APPLICABLE_TIP : TIPS[key],
    };
  });

  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  return { score, earned, possible, items };
}
