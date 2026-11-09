// 결제 설정 (공개 값만). 배포할 때 scripts/build-site.mjs 가 서버와 같은 규칙(lib/pay.mjs)으로 다시 써 넣는다.
// 이 파일 그대로면(로컬 개발) 결제를 받지 않는 모드예요.
export const PAY = { mode: 'off', amount: 9900, list: 19900, orderName: '매출올려드림 맞춤 실행 패키지' };
