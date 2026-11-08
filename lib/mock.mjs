// 로컬 개발·화면 점검용 모의 응답 (MOCK_AI=1). 운영 배포(VERCEL_ENV=production)에서는 쓰지 않는다.
import { normalizeStoreResult } from './validate.mjs';

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
    openedYear: '2019년 개업 (모의)',
    floor: '1층',
    phone: '02-000-0000',
    hours: '매일 11:00~21:00 (모의 데이터)',
    priceRange: '1인 8,000~12,000원',
    rating: '네이버 4.4 (모의)',
    reviewCount: '방문자 리뷰 320개 (모의)',
    services: { hall: true, takeout: true, delivery: true, reservation: false },
    menu: [{ name: '떡볶이', price: '5,000원' }, { name: '순대', price: '5,000원' }, { name: '김밥', price: '3,500원' }],
    strengths: ['떡볶이 양념이 맛있다는 후기가 많음', '포장 주문이 빠름'],
    weaknesses: ['점심시간 대기가 길다는 후기', '좌석이 좁다는 의견', '가격이 조금 비싸다는 의견'],
    reviewThemes: [{ theme: '맛', tone: 'good', note: '양념이 맛있다 (모의)' }, { theme: '대기', tone: 'bad', note: '점심 대기가 길다 (모의)' }, { theme: '가격', tone: 'mixed', note: '조금 비싸다는 의견 (모의)' }],
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
