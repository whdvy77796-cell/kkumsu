# 제공자 연결 해제와 회원 탈퇴: 설계안, 미구현

운영 기능이 아니며 출시나 개인정보 고지의 근거가 아닙니다. 계정별 탈퇴 실험과 별도로 제공자 연결 해제, 웹훅, 작업자 권한 발급을 모두 구현·검증해야 합니다.

## 현재 제약

- 현재 로그인 완료 시 발급받은 제공자 access/refresh token과 원본 subject를 세션에 저장하지 않습니다. 로그인 사용자임을 아는 것만으로 나중의 제공자 토큰 폐기나 원본 subject가 필요한 호출을 보장할 수 없습니다.
- 로그아웃, 가게별 소유권 분리, 이 서비스의 회원 탈퇴, 제공자의 앱 연결 해제는 서로 다른 결과입니다. 어느 하나만 성공하고 전부 완료됐다고 표시하지 않습니다.
- 네이버 `/revoke` HTTP 200은 해당 API의 토큰 폐기 요청 접수·응답으로 기록합니다. 개별 계정의 동의 철회까지 확인한 증거로 과장하지 않습니다. Google revoke 결과와 카카오 unlink 결과 역시 각각의 공식 의미와 확인 가능한 대상·상태를 따릅니다.

## 제안: 탈퇴 전용 재인증과 분리된 처리 상태

1. 유효한 기존 서비스 세션에서 탈퇴 의사를 확인하고 하나의 operation을 준비합니다. 단순 요청이나 클라이언트가 보낸 operation ID는 권한이 아닙니다.
2. 필요한 경우 해당 제공자로 **탈퇴 전용 재인증**을 수행합니다. 별도 OAuth state/nonce/PKCE는 서버에서 발급하고, operation·provider·issuer·clientId·origin·namespace·incarnation에 묶어 짧은 수명의 일회용으로 검증합니다. 실제 검증된 subject로 기존 accountId를 다시 도출해 정확히 비교합니다. 다른 제공자 계정은 대상 교체 없이 거부합니다.
3. 이 callback은 일반 로그인 callback과 분리해 새 세션 발급, 가입, active 상태 복귀를 하지 않습니다. 재인증이 새 동의를 만들 수 있으므로 확인 없이 로그인시키지 않고, 발급받은 자격을 같은 탈퇴 operation의 폐기 대상으로 처리합니다.
4. 검증된 탈퇴 시작은 계정별 fence를 원자적으로 올려 기존 세션과 writer를 차단합니다. 독립적인 신뢰된 서버 작업자만 그 operation의 로컬 정리를 이어갑니다. worker grant는 제공자 토큰이나 제공자 계정 소유 증명이 아닙니다.
5. 가능하면 제공자 자격은 콜백 처리 중에만 사용하고 저장하지 않습니다. 재시도 목적 보관이 꼭 필요하다면 별도 암호화·접근통제·최소 TTL·키 백업과 삭제 정책을 설계한 다음에만 검토합니다. 토큰과 원본 subject를 URL, 로그, receipt, 클라이언트 또는 worker grant에 넣지 않습니다.
6. 이미 탈퇴가 시작된 뒤 토큰이 없거나 실패하면 로컬 정리는 계속하고 제공자 상태를 `needs-reauth`, `ready`, `dispatched`, `unknown`, `blocked-manual` 등으로 구분합니다. 서버 발급 제한된 재개 수단이나 재인증으로 같은 operation만 재개하며 과거 사용자 세션 부활은 금지합니다.
7. 외부 요청 timeout은 성공 여부 불명입니다. 안전한 공식 상태 조회 또는 동일한 멱등 요청이 가능한지 확인하고, 불가능하면 사용자에게 직접 연결 해제가 필요한 상태로 안내합니다. 재인증 취소/만료는 challenge만 끝내고 탈퇴 상태를 active로 되돌리지 않습니다.

## 외부 사건과 재가입

- 카카오 연결 해제 webhook은 대표 어드민 키 및 app_id 검증, 필수 대상과 요청 형식 확인 후 내구성 있게 접수합니다. 어드민 키는 서버 secret으로만 취급합니다. 자체 unlink API 호출은 별도의 연결 해제 webhook을 기다려서는 안 됩니다.
- 세대 식별이 없는 지연 webhook이나 이전 세대의 미확정 unlink가 새 계정을 끊지 않도록 재가입과 이벤트 순서 문제를 해결하기 전 재가입을 허용하지 않습니다. 무조건 과거 요청을 재전송하지 않습니다.
- 네이버·Google 이벤트는 각 공식 명세의 지원 범위와 서명·대상·재전송 조건을 확인해 별도로 설계합니다. 수동 연결 해제 안내만으로 제공자가 검증한 연결 해제 성공으로 기록하지 않습니다.
- `localCleanup`과 `providerDisconnect`를 별도로 표시하고, 전체 삭제/연결 해제 완료라 부를 조건과 신고·공개 가게·법령상 보존 정보를 정책 및 법적 사실 확인 후 확정합니다.

## 출시 차단 항목

안전한 worker grant·원자적 전체 writer fence·완전한 가게 범위 scan 및 신뢰 가능한 receipt·불확정 결과 재조정·키 유실 복구·재가입 및 webhook 세대 식별·제공자별 실제 왕복 테스트는 모두 미완성입니다. 무응답 작업은 구체적 재개/수동 처리 경로를 제공하고 무한 pending으로 숨기지 않습니다. 비밀키나 토큰을 이 문서·저장소·로그에 넣지 않습니다.

참고: [네이버 토큰 폐기](https://developers.naver.com/docs/login/api/), [카카오 연결 해제 웹훅](https://developers.kakao.com/docs/ko/kakaologin/callback), [Google OAuth 토큰 철회](https://developers.google.com/identity/protocols/oauth2/web-server), [Google Cross-Account Protection](https://developers.google.com/identity/protocols/risc).
