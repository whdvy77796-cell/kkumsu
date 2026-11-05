# 인소서 v3 업그레이드 계약

## 목표 / 경계
쓸거리를 정리해 오지 않아도 쉬운 질문에 답하며 실제 경험을 발견하고 지원 목적·문항에 맞는 자기소개서를 완성한다. 대학 신입학 제외. 원래 질문은행 30개와 총10~30개 규칙 유지. 합격/채용 가능성·무오류·문장 유일성 보장 금지. 검수는 실제 근거와 제출 준비도 점검, 합격 확률이 아님.

무료는 익명 브라우저 첫 생성 1건의 부분 미리보기. 전문 열람·복사·저장은 그 결과 1건에 3,000원(KRW), 구독 없음. 인터뷰 시작 전부터 이 조건을 명확히 고지. 미결제 전문은 DOM, API 응답, 소스맵, 로그, 로컬스토리지에 전달하지 않는다. 블러는 가짜 자리표시자에만 적용. 공개 미리보기는 고정된 작은 구간만 사용해 재요청으로 전체 재구성 불가. 복사/저장 버튼 비활성화, 미리보기 영역 복사 방어는 보조수단이며 보이는 내용의 캡처/필사는 막을 수 없음.

## 기존 AI 계약
POST /api/insosoe: 기존 action interview/facts/generate, profile,answers,facts,focusAnswerIds,exclusions,verified,consent:true,product:'free',requestId 유지. 새 클라이언트는 offerVersion:'v3-preview-3000'도 전송. 생성에는 previewDisclosureAccepted:true. facts 생성·프런트 검토는 그대로. 비용예약/누적/일일 장부(insosoe:v2:budget...) 절대 초기화/이름변경 금지. AI 생성 최대3호출(초안/별도검수/필요시1회개정) 유지. 실제 API는 승인된 기존 잔액/상한만.

## 작성 품질 모듈 (quality 작업자 소유)
수정범위: lib/pipeline.mjs, 신규 lib/quality.mjs, 신규 tests/quality-v3.test.mjs. 다른 파일 수정 금지. 기존 결과 sections, quality, note, freeAvailable 계약 유지. 새 requirement/plan/review 객체는 반드시 검증. 채용공고와 문항 요구를 사용자 경험과 분리하고 요구별 근거 매핑, 문항별 핵심 주장·행동·판단·결과·직무연결을 설계. 출처 없는 회사 특징·성과·숫자/역할 금지. 사용자 정정 우선, 제외사항 엄수. 선택적 보강을 필수부족으로 오판해 쓸 수 있는 경험까지 거절하지 않음. 독립검수에 문항 응답성/구체행동/본인기여/판단이유/공고적합/상투어/중복/자연스러움 기준 추가. 중대한 미해결 품질 문제는 1회 자동수정 후 차단; 낮은 우선순위는 투명한 경고. 정량적인 합격확률 표시하지 않음. 기존 deterministic checks 유지/개선. 원래30개질문을 유지하되 쉬운 꼬리질문과 소재 발견 가치를 강화. 새테스트는 node --test로 실행가능하고 mocking 범위를 명확히. 부모가 core/API/store와 전체 테스트 통합을 담당.

## 신규 결과 API (부모 소유)
GET /api/insosoe -> 기존 ready/freeAvailable + paymentReady, paymentMode:'disabled'|'test'|'live', offer:{version:'v3-preview-3000',amount:3000,currency:'KRW',freePreviewLimit:1}, latestResultId? . 모델표시는 첫화면에서 제거하고 개인정보 안내로 이동.
POST generate 성공은 저장된 결과의 공개 projection:
{source:'ai', resultId:UUID, access:'preview'|'full', sections, quality, note, freeAvailable:false, purchase:{amount:3000,currency:'KRW',ready:boolean,mode:'disabled'|'test'|'live',expiresAt:ISO,orderName:string}}
preview sections:[{id,heading,charCount,segments:[{kind:'visible',text:string}|{kind:'locked',lines:number}]}]. preview에는 text/sourceFactIds/full analysis/raw review 없음. quality.checks는 서버가 고정된 안전한 라벨·상태만 공개. full sections는 기존 [{id,heading,text,charCount,sourceFactIds}]이고 quality의 실제 검수정보 제공.
GET /api/payment?resultId=UUID -> 같은 결과 projection. 소유권+결제상태를 서버 검증. 결과 ID만 localStorage 허용, 답변·전문·결제키는 금지.

## 결제 API (부모 소유)
POST /api/payment JSON action:'create', resultId, termsAccepted:true, immediateDeliveryAccepted:true
-> {orderId,amount:3000,currency:'KRW',orderName,clientKey,customerKey:'ANONYMOUS',successUrl,failUrl,mode:'test'|'live'}.
Toss v2 표준 SDK https://js.tosspayments.com/v2/standard 의 결제창 CARD 사용 예정. 공식 문서 검증 후 부모가 SDK 계약 보완. 새결제/재시도에 기존 주문을 복구, 주문은 서버 고정 금액/결과/소유자에 묶음. 결제키·비밀키는 로그 금지.
POST /api/payment action:'confirm', orderId,paymentKey,amount (URL에서 왔어도 서버고정금액과 비교, 브라우저 전달액은 신뢰하지 않음) -> 서버 승인 확인한 full projection. 결제 성공 URL은 /payment/success, 실패는 /payment/fail. 첫 렌더 전에 URL 민감 파라미터를 제거하고 서버 확인. 확인 실패시 절대 전문/버튼 해제 금지. 승인 후 Redis 장애/중복탭/재요청에도 재검증·복구 가능. 테스트·운영 키/결과 엄격 분리, Production에서 테스트 결제 차단. amount/orderId/status/currency/MID 검증 및 중복 승인 방지. webhook으로 취소 통지 수신 후 제공자 조회로 재검증. 전문 요청 때도 취소/부분취소 상태 재검증.
POST /api/payment action:'recover', recoveryCode -> 결제 재검증 후 복구 및 현재 브라우저에 안전한 접근권한 발급. recoveryCode는 비밀번호급 비밀. 전문 반환시 복구코드 저장 도구는 나중에 부모가 계약 추가 예정. 다른 사람 결과 ID 추측/위조로 접근 불가.
DELETE /api/payment JSON {resultId} -> 결과+복구권한 삭제. 결제거래기록 및 무료한도는 별도이며 자동환불 아님. 기존 DELETE /api/insosoe도 결과 삭제 연결 예정.

보관 기본: 미결제 결과 최대24시간, 결제 결과는 승인일부터7일간 암호화 보관 후 만료. 원문 답변의 AI 요청 재시도 캐시는 기존15분. 결제 거래기록은 콘텐츠와 분리하며 실제 보존정책·사업자 조건 확정 전 실결제 활성화 금지. AI 외부전송/제공자 보유조건을 따로 안내. 결과가 만료/삭제됐다면 새로 결제받지 않음. 결제 진행 주문에는 결과를 안전하게 유지하는 lease 적용, 이미 결제된 실패건은 재조회로 제공 복구하며 제공 불가면 이중결제 막고 지원 안내.

## UI 작업자 (public 전용)
수정범위 public/app.js, public/style.css, public/index.html (question-bank.js 수정 금지). 원래 인터뷰/편집/사실선택/삭제/에러 재시도 기능 보존. 첫화면은 쉬운답→소재발견→지원용글완성, 명확한 실제 서비스명, 가상 예시 표시한 작은 전후사례. 가격상품은 무료부분미리보기+전문1건3000원으로 단순화. 첫화면/시작동의/생성직전/결과에 가격·제한 일관 표시. 준비안된 결제는 과장하지 않고 준비상태로 차단. 테스트 결제명확표시. 모바일/접근성/키보드 포커스/스크린리더 배려. 결제동의 확인 후 SDK실행, 오류나결제취소에도 결과ID보존 및 재시도. 결제콜백 server confirm 후만 unlock. 미리보기 복사/내려받기 불가, full일때만 편집/복사/저장. 준비도 검수와 합격보장 구분. 기존수정시결과무효화/사실재검토 동작 유지. 홈페이지 예시는 실제 고객 후기나 합격사례로 꾸미지 않는다.

## 배포
V3 작업본은 별도 폴더. 기존 운영·백업 보존. PG 계약/키/실제승인 검증과 사업자/환불안내 미준비 상태에서 실결제 받지 않는다. 무료 미리보기로 장시간 입력받고 결제불가로 막히게 하지 않도록 준비상태를 시작 전 안내하고, 정식 유료 공개는 완료조건 충족 후. 부모가 실제브라우저/회귀/보안·모바일/예산QA 및 GitHub배포 담당. 결과의 기술적 검수와 실제 채용평가/합격실적 구분.
