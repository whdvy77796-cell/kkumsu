// Claude에게 보내는 지시문과 응답 형식

const S = (description) => ({ type: 'string', description });
const NS = (description) => ({ type: ['string', 'null'], description });
const LIST = (description) => ({ type: 'array', items: { type: 'string' }, description });

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'address', 'category', 'phone', 'hours', 'priceRange', 'rating', 'reviewCount', 'menu', 'strengths', 'weaknesses', 'features', 'channels', 'matchLevel', 'matchReason'],
  properties: {
    name: S('가게 이름'),
    address: S('도로명 또는 지번 주소'),
    category: NS('업종 (예: 한식, 분식, 카페)'),
    phone: NS('전화번호'),
    hours: NS('영업시간 요약'),
    priceRange: NS('1인 가격대'),
    rating: NS('평점과 출처 (예: 네이버 4.52)'),
    reviewCount: NS('리뷰 수와 출처'),
    menu: {
      type: 'array',
      description: '대표 메뉴 최대 8개',
      items: { type: 'object', additionalProperties: false, required: ['name', 'price'], properties: { name: S('메뉴 이름'), price: NS('가격') } },
    },
    strengths: LIST('리뷰·소개에서 반복되는 장점 최대 4개'),
    weaknesses: LIST('리뷰에서 반복되는 아쉬운 점 최대 4개'),
    features: LIST('주차, 좌석, 포장·배달, 예약 등 특징 최대 5개'),
    channels: {
      type: 'array',
      description: '찾은 온라인 채널 주소',
      items: { type: 'object', additionalProperties: false, required: ['type', 'url'], properties: { type: S('네이버 플레이스·카카오맵·인스타그램·블로그·배달앱·홈페이지·기타'), url: S('주소') } },
    },
    matchLevel: { type: 'string', enum: ['high', 'medium', 'low'], description: '입력한 상호명·주소와 맞는 정도' },
    matchReason: S('입력과 맞다고 본 근거 한 문장'),
  },
};

export const STORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates', 'summary', 'notFoundReason'],
  properties: {
    candidates: { type: 'array', items: CANDIDATE_SCHEMA, description: '입력과 가장 잘 맞는 순서로 최대 3곳' },
    summary: S('찾은 정보 전체 요약 한두 문장'),
    notFoundReason: NS('찾지 못했을 때 이유'),
  },
};

export const SEARCH_SYSTEM = `당신은 한국 음식점·카페의 공개 정보를 조사하는 리서처입니다.
규칙:
1. 웹 검색 도구로 찾은 내용만 씁니다. 검색 결과에서 확인되지 않은 값은 지어내지 말고 null 또는 빈 배열로 둡니다.
2. 같은 이름의 다른 지점이나 다른 가게와 헷갈리지 않도록 주소(시·구·동·도로명)를 대조합니다.
3. 검색은 3번 이내로 합니다. 예: "상호 + 동·구 이름", "상호 + 메뉴 가격", "상호 + 리뷰 후기".
4. 네이버 지도·플레이스, 카카오맵, 다이닝코드, 망고플레이트, 배달앱, 인스타그램, 블로그 후기, 공식 홈페이지 등을 참고합니다.
5. 평점·리뷰 수·가격은 출처에 나온 그대로 짧게 적습니다. 예: "네이버 4.52", "방문자 리뷰 1,234개".
6. 폐업·이전·휴업 정보가 보이면 features에 적습니다.
7. 최종 답변은 JSON 객체 하나만 출력합니다. 앞뒤 설명, 마크다운, 코드블록 표시를 붙이지 않습니다.`;

export function searchUser({ name, address }) {
  return `상호명: ${name}
주소: ${address}

이 가게를 찾아 아래 형식의 JSON으로 정리해 주세요.
{
  "candidates": [
    {
      "name": "가게 이름",
      "address": "주소",
      "category": "업종 또는 null",
      "phone": "전화번호 또는 null",
      "hours": "영업시간 요약 또는 null",
      "priceRange": "1인 가격대 또는 null",
      "rating": "평점과 출처 또는 null",
      "reviewCount": "리뷰 수와 출처 또는 null",
      "menu": [{ "name": "메뉴", "price": "가격 또는 null" }],
      "strengths": ["리뷰·소개에서 반복되는 장점"],
      "weaknesses": ["리뷰에서 반복되는 아쉬운 점"],
      "features": ["주차·좌석·포장·배달·예약 등 특징"],
      "channels": [{ "type": "네이버 플레이스", "url": "https://..." }],
      "matchLevel": "high | medium | low",
      "matchReason": "입력한 상호명·주소와 맞다고 본 근거 한 문장"
    }
  ],
  "summary": "찾은 정보 요약 한두 문장",
  "notFoundReason": null
}
candidates는 입력과 가장 잘 맞는 순서로 최대 3곳입니다. 확실한 한 곳을 찾았다면 1곳만 넣습니다.
찾지 못했다면 candidates를 빈 배열로 두고 notFoundReason에 이유를 적습니다.`;
}

export const REPAIR_SYSTEM = `아래 글은 가게 정보를 조사한 결과입니다. 글에 있는 정보만 사용해 지정된 JSON 형식으로 옮겨 적으세요.
글에 없는 값은 null 또는 빈 배열로 둡니다. 새로운 정보를 추가하지 않습니다.`;

export const SURVEY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['insights', 'questions'],
  properties: {
    insights: {
      type: 'array',
      description: '공개 정보에서 눈에 띈 점 3~4개',
      items: { type: 'object', additionalProperties: false, required: ['title', 'detail'], properties: { title: S('짧은 제목'), detail: S('공개 정보에서 본 내용 한 문장') } },
    },
    questions: {
      type: 'array',
      description: '정확히 10개',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'area', 'why'],
        properties: { text: S('5점 척도로 답할 수 있는 진술문'), area: S('영역'), why: S('이 문항을 묻는 이유 한 문장') },
      },
    },
  },
};

export const SURVEY_SYSTEM = `당신은 음식점·카페의 매출을 올리도록 돕는 컨설턴트입니다.
사장님이 "우리 가게가 맞다"고 확인한 공개 정보를 바탕으로, 사장님에게 물어볼 맞춤 설문 문항을 만듭니다.
규칙:
1. 문항은 정확히 10개입니다.
2. 각 문항은 사장님이 "전혀 그렇지 않다 · 그렇지 않다 · 보통이다 · 그렇다 · 매우 그렇다" 중 하나로 답할 수 있는 한 문장 진술문입니다. 물음표로 끝나는 질문이 아니라 "~다"로 끝나는 문장으로 씁니다.
3. 한 문항에는 한 가지 내용만 담습니다. 숫자나 금액을 직접 묻지 않습니다. 40자 안팎으로 짧게 씁니다.
4. 공개 정보에서 보인 강점·아쉬운 점·특징을 사장님 입장에서 확인하는 문항을 우선합니다. 예: 리뷰에 대기 이야기가 많으면 "바쁜 시간에 기다리다 그냥 돌아가는 손님이 자주 있다".
5. 영역을 고르게 섞습니다: 손님·매출 흐름, 메뉴·가격, 리뷰·평판, 온라인 홍보, 매장·서비스, 운영·일손, 배달·포장(해당할 때만).
6. 공개 정보로 확인되지 않은 내용을 사실처럼 단정하지 않습니다. 사장님을 탓하거나 깎아내리는 표현을 쓰지 않습니다.
7. insights는 공개 정보에서 눈에 띈 점 3~4개입니다. 정보에 없는 내용은 쓰지 않습니다.
8. 최종 답변은 JSON 객체 하나만 출력합니다.`;

export function surveyUser({ name, address, store }) {
  const info = store
    ? `사장님이 맞다고 확인한 가게 정보(JSON):\n${JSON.stringify(store, null, 1)}`
    : '인터넷에서 이 가게의 공개 정보를 찾지 못했습니다. 상호명과 주소만으로, 음식점·카페에서 흔히 확인할 만한 내용을 묻는 문항을 만드세요. insights에는 "공개 정보가 부족하다"는 점 1개만 넣습니다.';
  return `사장님이 입력한 상호명: ${name}
사장님이 입력한 주소: ${address}

${info}

위 내용을 바탕으로 아래 형식의 JSON을 만들어 주세요.
{
  "insights": [{ "title": "짧은 제목", "detail": "공개 정보에서 본 내용 한 문장" }],
  "questions": [{ "text": "~다로 끝나는 진술문", "area": "영역 이름", "why": "이 문항을 묻는 이유 한 문장" }]
}`;
}
