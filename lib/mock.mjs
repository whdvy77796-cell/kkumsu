// 로컬 개발·화면 점검용 모의 응답 (MOCK_AI=1). 운영 배포(VERCEL_ENV=production)에서는 쓰지 않는다.
import { normalizeStoreResult, normalizeSurvey } from './validate.mjs';

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
    phone: '02-000-0000',
    hours: '매일 11:00~21:00 (모의 데이터)',
    priceRange: '1인 8,000~12,000원',
    rating: '네이버 4.4 (모의)',
    reviewCount: '방문자 리뷰 320개 (모의)',
    menu: [{ name: '떡볶이', price: '5,000원' }, { name: '순대', price: '5,000원' }, { name: '김밥', price: '3,500원' }],
    strengths: ['떡볶이 양념이 맛있다는 후기가 많음', '포장 주문이 빠름'],
    weaknesses: ['점심시간 대기가 길다는 후기', '좌석이 좁다는 의견'],
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

const MOCK_Q = [
  ['점심시간에는 기다리다 그냥 돌아가는 손님이 자주 있다', '손님·매출 흐름'],
  ['떡볶이가 우리 가게를 대표하는 메뉴라고 생각한다', '메뉴·가격'],
  ['최근 1년 안에 메뉴 가격을 올린 적이 있다', '메뉴·가격'],
  ['온라인 리뷰를 자주 확인하고 답글을 단다', '리뷰·평판'],
  ['네이버 플레이스의 메뉴와 사진이 지금과 같다', '온라인 홍보'],
  ['인스타그램 등 SNS에 꾸준히 사진을 올린다', '온라인 홍보'],
  ['좌석이 좁아 매장에서 먹기 불편하다는 말을 듣는다', '매장·서비스'],
  ['바쁜 시간에는 일손이 부족하다고 느낀다', '운영·일손'],
  ['배달 주문이 매장 주문보다 남는 돈이 적다고 느낀다', '배달·포장'],
  ['다시 찾아오는 단골손님이 많은 편이다', '손님·매출 흐름'],
];

export async function mockSurvey({ name, store }, delayMs = 900) {
  await wait(delayMs);
  const out = normalizeSurvey({
    insights: store
      ? [
          { title: '맛에 대한 칭찬', detail: '모의 응답: 대표 메뉴 맛을 칭찬하는 후기가 많다고 가정했어요.' },
          { title: '점심 대기', detail: '모의 응답: 점심시간 대기가 길다는 후기를 가정했어요.' },
          { title: '좁은 좌석', detail: '모의 응답: 좌석이 좁다는 의견을 가정했어요.' },
        ]
      : [{ title: '공개 정보 부족', detail: `모의 응답: ${name}의 공개 정보를 찾지 못했다고 가정했어요.` }],
    questions: MOCK_Q.map(([text, area]) => ({ text, area, why: '모의 응답: 화면 점검용 문항이에요.' })),
  });
  return { ...out, model: 'mock', mock: true, cached: false };
}
