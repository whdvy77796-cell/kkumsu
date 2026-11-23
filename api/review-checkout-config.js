// 심사용 테스트 결제창 설정 조회(읽기 전용). 전용 환경변수 YB_TOSS_REVIEW_CLIENT_KEY 만 읽으며
// 다른 환경변수로 대체하지 않습니다. test_ck_ 형식의 테스트 클라이언트 키만 반환하고 그 외는 모두 미설정 처리합니다.
export const REVIEW_KEY_ENV = 'YB_TOSS_REVIEW_CLIENT_KEY';
const TEST_CK = /^test_ck_[A-Za-z0-9_-]{10,100}(?![\s\S])/;

export function isSafeTestClientKey(key) {
  return typeof key === 'string' && TEST_CK.test(key);
}

// 순수 함수: env 객체를 받아 { configured, clientKey? } 만 반환.
export function reviewCheckoutConfig(env) {
  // 무료 운영에서는 환경과 키 설정에 관계없이 심사용 테스트창도 비활성화한다.
  return { configured: false };
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!req || req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(reviewCheckoutConfig(process.env)));
}
