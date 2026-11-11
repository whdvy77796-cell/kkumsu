# 로그인 운영 전 저장소 경계 확인, 미완료

2026-11-12 확인. 이 문서는 운영 준비 완료를 의미하지 않습니다.

- Vercel 프로젝트 `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`은 같은 Upstash 연동에서 Production과 Preview에 제공됩니다. 프로젝트 Storage에도 해당 리소스가 `Preview, Production`으로 연결돼 있습니다. 서비스 코드의 Preview/Production namespace 분리는 물리적인 저장소 분리나 접근권한 분리와 같지 않습니다. Preview에서 공통 전체 권한 토큰을 갖는 한 토큰 유출·오작동 시 운영 데이터가 경계 안에 들어갈 수 있습니다.
- Upstash 콘솔에서 해당 리소스의 primary는 AWS Tokyo, Japan (`ap-northeast-1`)으로 표시됐습니다. 다른 read region·로그·백업의 국가 및 전체 개인정보 국외 이전 내역은 아직 확인하지 않았습니다. 이 사실만으로 완전한 개인정보 처리방침을 작성하지 마세요.
- Upstash 무료 리소스 보안 화면의 `Encryption at Rest`에는 업그레이드가 표시됐고, 제공사 문서는 디스크 저장 암호화를 Prod Pack 기능으로 명시합니다. TLS는 별도로 지원됩니다. 키·원문·백업을 포함한 실제 보호 수준과 법적 의무는 별도로 확인해야 하며, 승인 없이 유료 업그레이드하지 않습니다.
- 같은 Vercel 연동에서 두 번째 Redis를 추가하는 화면은 현재 Pay As You Go와 유료 고정 플랜만 제시했습니다. 새 DB나 유료 플랜은 생성하지 않았습니다. 별도 제공사의 무료 Preview 데이터베이스, 로컬 전용 시험, 적절한 접근제어 등은 적용 전 제약·약관·지역·보안·비용 및 명시적 동의를 검토해야 합니다. 3일 뒤 자동 삭제되는 임시 시험 DB는 장기 Preview 분리 대책이 아닙니다.
- Production의 `YB_AUTH_ORIGIN`, `YB_AUTH_SECRET`, `YB_IDENTITY_KEY`는 확인 시점에 없었습니다. 운영 계정 ID를 결정하는 identity key는 안전한 보관·백업·복구를 먼저 설계해야 하며, Preview 값 재사용은 금지합니다.

운영 데이터 이동, 연결 토큰 교체, 유료 플랜, 공개 정책 변경 또는 배포는 이 문서 작성에 포함되지 않았습니다.

참고: [Upstash 보안 기능](https://upstash.com/docs/redis/features/security), [Upstash 요금과 무료 플랜](https://upstash.com/pricing/redis).
