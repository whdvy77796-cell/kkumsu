// Claude에게 보내는 지시문과 응답 형식 (가게 찾기)

const S = (description) => ({ type: 'string', description });
const NS = (description) => ({ type: ['string', 'null'], description });
const NB = (description) => ({ type: ['boolean', 'null'], description });
const LIST = (description) => ({ type: 'array', items: { type: 'string' }, description });

export const REVIEW_THEMES = ['맛', '가격', '양', '대기', '친절', '위생', '화장실', '주차'];

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'address', 'category', 'openedYear', 'floor', 'phone', 'hours', 'priceRange', 'rating', 'reviewCount',
    'services', 'menu', 'strengths', 'weaknesses', 'reviewThemes', 'features', 'channels', 'matchLevel', 'matchReason',
  ],
  properties: {
    name: S('가게 이름'),
    address: S('도로명 또는 지번 주소'),
    category: NS('업종 (예: 한식, 분식, 카페)'),
    openedYear: NS('개업 연도나 운영 기간 (예: 2019년 개업)'),
    floor: NS('매장 위치 층 (예: 1층, 2층, 지하 1층)'),
    phone: NS('전화번호'),
    hours: NS('영업시간 요약'),
    priceRange: NS('1인 가격대'),
    rating: NS('평점과 출처 (예: 네이버 4.52)'),
    reviewCount: NS('리뷰 수와 출처'),
    services: {
      type: 'object',
      additionalProperties: false,
      required: ['hall', 'takeout', 'delivery', 'reservation'],
      description: '확인된 판매 방식. 모르면 null',
      properties: { hall: NB('매장 식사'), takeout: NB('포장'), delivery: NB('배달'), reservation: NB('예약') },
    },
    menu: {
      type: 'array',
      description: '대표 메뉴 최대 8개',
      items: { type: 'object', additionalProperties: false, required: ['name', 'price'], properties: { name: S('메뉴 이름'), price: NS('가격') } },
    },
    strengths: LIST('리뷰·소개에서 반복되는 장점 최대 4개'),
    weaknesses: LIST('리뷰에서 반복되는 아쉬운 점 최대 4개'),
    reviewThemes: {
      type: 'array',
      description: '리뷰에서 확인된 주제별 경향. 확인된 주제만',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['theme', 'tone', 'note'],
        properties: {
          theme: { type: 'string', enum: REVIEW_THEMES },
          tone: { type: 'string', enum: ['good', 'bad', 'mixed'] },
          note: S('리뷰에서 본 내용 한 줄'),
        },
      },
    },
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
  required: ['candidates', 'summary', 'notFoundReason', 'sources'],
  properties: {
    candidates: { type: 'array', items: CANDIDATE_SCHEMA, description: '입력과 가장 잘 맞는 순서로 최대 3곳' },
    summary: S('찾은 정보 전체 요약 한두 문장'),
    notFoundReason: NS('찾지 못했을 때 이유'),
    sources: {
      type: 'array',
      description: '실제로 참고한 페이지 최대 6개',
      items: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: S('페이지 제목'), url: S('주소') } },
    },
  },
};

export const SEARCH_SYSTEM = `당신은 한국 음식점·카페의 공개 정보를 조사하는 리서처입니다.
규칙:
1. 웹 검색 도구로 찾은 내용만 씁니다. 검색 결과에서 확인되지 않은 값은 지어내지 말고 null 또는 빈 배열로 둡니다.
2. 같은 이름의 다른 지점이나 다른 가게와 헷갈리지 않도록 주소(시·구·동·도로명)를 대조합니다.
3. 검색은 3번 이내로 합니다. 예: "상호 + 동·구 이름", "상호 + 메뉴 가격", "상호 + 리뷰 후기".
4. 네이버 지도·플레이스, 카카오맵, 다이닝코드, 망고플레이트, 배달앱, 인스타그램, 블로그 후기, 공식 홈페이지 등을 참고합니다.
5. 평점·리뷰 수·가격은 출처에 나온 그대로 짧게 적습니다. 예: "네이버 4.52", "방문자 리뷰 1,234개".
   각 값은 60자 안팎으로 짧게 씁니다. 출처마다 다르면 대표값을 쓰고 "(출처마다 다름)"만 덧붙입니다.
6. services는 매장 식사·포장·배달·예약 가능 여부가 출처에서 확인될 때만 true/false로 적고, 모르면 null로 둡니다.
7. reviewThemes는 리뷰에서 실제로 반복해서 보인 주제(맛·가격·양·대기·친절·위생·화장실·주차)만 적습니다. 특정 플랫폼 후기를 모두 사실로 단정하지 않습니다.
8. 폐업·이전·휴업 정보가 보이면 features에 적습니다.
9. sources에는 실제로 참고한 페이지를 최대 6개 적습니다. 검색 결과에 있던 주소만 씁니다.
10. 최종 답변은 JSON 객체 하나만 출력합니다. 앞뒤 설명, 마크다운, 코드블록 표시를 붙이지 않습니다.`;

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
      "openedYear": "개업 연도나 운영 기간 또는 null",
      "floor": "매장 층 또는 null",
      "phone": "전화번호 또는 null",
      "hours": "영업시간 요약 또는 null",
      "priceRange": "1인 가격대 또는 null",
      "rating": "평점과 출처 또는 null",
      "reviewCount": "리뷰 수와 출처 또는 null",
      "services": { "hall": true, "takeout": true, "delivery": null, "reservation": null },
      "menu": [{ "name": "메뉴", "price": "가격 또는 null" }],
      "strengths": ["리뷰·소개에서 반복되는 장점"],
      "weaknesses": ["리뷰에서 반복되는 아쉬운 점"],
      "reviewThemes": [{ "theme": "맛 | 가격 | 양 | 대기 | 친절 | 위생 | 화장실 | 주차", "tone": "good | bad | mixed", "note": "리뷰에서 본 내용 한 줄" }],
      "features": ["주차·좌석·포장·배달·예약 등 특징"],
      "channels": [{ "type": "네이버 플레이스", "url": "https://..." }],
      "matchLevel": "high | medium | low",
      "matchReason": "입력한 상호명·주소와 맞다고 본 근거 한 문장"
    }
  ],
  "summary": "찾은 정보 요약 한두 문장",
  "notFoundReason": null,
  "sources": [{ "title": "참고한 페이지 제목", "url": "https://..." }]
}
candidates는 입력과 가장 잘 맞는 순서로 최대 3곳입니다. 확실한 한 곳을 찾았다면 1곳만 넣습니다.
찾지 못했다면 candidates를 빈 배열로 두고 notFoundReason에 이유를 적습니다.`;
}

export const REPAIR_SYSTEM = `아래 글은 가게 정보를 조사한 결과입니다. 글에 있는 정보만 사용해 지정된 JSON 형식으로 옮겨 적으세요.
글에 없는 값은 null 또는 빈 배열로 둡니다. 새로운 정보를 추가하지 않습니다.`;
