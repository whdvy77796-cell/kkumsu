// 심사용 테스트 결제창 설정 조회(읽기 전용). 전용 환경변수 YB_TOSS_REVIEW_CLIENT_KEY 만 읽으며
// 다른 환경변수로 대체하지 않습니다. test_ck_ 형식의 테스트 클라이언트 키만 반환하고 그 외는 모두 미설정 처리합니다.
export const REVIEW_KEY_ENV = 'YB_TOSS_REVIEW_CLIENT_KEY';
const TEST_CK = /^test_ck_[A-Za-z0-9_-]{10,100}(?![\s\S])/;

export function isSafeTestClientKey(key) {
  return typeof key === 'string' && TEST_CK.test(key);
}

// 순수 함수: env 객체를 받아 { configured, clientKey? } 만 반환.
export function reviewCheckoutConfig(env) {
  // 운영 배포에서는 테스트용 환경변수가 실수로 들어와도 검토 기능을 절대 켜지 않는다.
  if (env && env.VERCEL_ENV === 'production') return { configured: false };
  const raw = env && typeof env === 'object' ? env[REVIEW_KEY_ENV] : undefined;
  return isSafeTestClientKey(raw) ? { configured: true, clientKey: raw } : { configured: false };
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
