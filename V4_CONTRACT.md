# 인소서 V4: 문항 맞춤 첨삭 전환 계약

작업 경로: 현재 insosoe-v4. v3 원본과 운영 main은 변경하지 않는다. Preview 브랜치 insosoe-v3만 갱신한다. 추가 충전/한도 상향/실결제 활성화 금지.

## 상품 / UX
- 메인은 지원 문항과 이미 쓴 초안의 첨삭. 일반 대학 입학 지원은 제외. 취업/인턴 경험에 대학 활동을 쓰는 것은 허용.
- 1건 = 문항 1개, 무료는 부분 미리보기, 전문/변경 이유/복사/TXT는 기존 금액 3,000원. 실결제는 disabled 유지.
- 질문은 필수가 아니며 원문만으로 수정 불가한 사실 공백에 최대 3개, 추가 확인 라운드 최대 1회.
- 이미 좋은 글은 불필요하게 재작성하지 않는다. 없는 수치·역할·행동·동기·회사정보를 추가하지 않는다. 회사 공고는 지원자 개인 성과의 근거가 아니다.
- 문항 응답성, 논리/본인 역할, 원문 근거, 자연스러운 문장/맞춤법, 분량을 검수한다. 합격률/채용 점수 표현 금지.

## HTTP 인터페이스 (부모가 구현)
기존 URL `/api/insosoe`: GET 상태, POST 첨삭, DELETE 현재 소유 콘텐츠/재시도 캐시 삭제. `/api/payment` 기존 결제·잠금 흐름을 재사용한다.
POST JSON:
```
{action:'revise',requestId:UUID,product:'free',consent:true,factsConfirmed:true,previewDisclosureAccepted:true,offerVersion:'v4-revision-3000',prompt:string,originalText:string,organization:string,role:string,posting:string,lengthMode:'characters'|'no-spaces'|'utf8-bytes',limit:number,clarificationRound:0|1,clarifications:[{question:string,answer:string}]}
```
- prompt 10~800자; originalText 40~6000자. 회사/직무 각 200자, posting 최대3000자. 추가 답변 최대3개, 질문200자/답변500자.
- limit: 문자 기준100~2000, UTF8바이트100~6000. UTF8와 채용사이트 자체 byte 규칙은 다를 수 있음을 안내.
- 수정 목표는 상한 이하의 자연스러운 글. 빈약한 사실로 최소 길이를 억지로 채우지 않는다.
GET: `{product:'revision',ready,freeAvailable,paymentReady,paymentMode,message,offer:{version:'v4-revision-3000',amount:3000,currency:'KRW',freePreviewLimit:1},latestResultId,limits:{...},privacy:{...}}`.

POST 성공은 아래 내부 full을 PaymentService에 저장한 뒤 preview projection만 반환한다. 원문은 통째로 DB에 넣지 않는다. 변경 전 발췌는 수정본과 함께 암호화 임시 보관하므로 원문 일부까지 저장하지 않는다는 문구 금지.
needs_input 응답은 `{source:'ai',product:'revision',status:'needs_input',questions:[{id:'q1',question:...,reason:...}],message:...,freeAvailable:true}`. 수정 전문은 포함하지 않는다. 입력창 원문/설정은 브라우저 메모리에만 유지.

## 새 서버 모듈 (백엔드 담당 소유)
`lib/revision.mjs`, `tests/revision-v4.test.mjs`, `tests/revision-fixtures.mjs`만 작성.
export `validateRevision(raw)`, `measureText(text,mode)`, `revisionLimits(c,data)`, `reserveRevisionCost(c,data)`, `runRevision(c,data,deps={})`.
기존 core의 AppError/fail과 provider.callAI 재사용. deps.ai(system,payload,maxTokens,{stage}) 모의 주입 지원. stage draft/review 사용. deps.onUsage/onCallStarted 전달. 자체 외부 요청 실행 금지.
기본 수정 + 별도 검수 2호출, 보완이 필요하면 보완1 + 재검수1 추가, 총4 호출을 상한으로 예산 예약. 각 호출 실제 입력바이트 상한을 예약 수식과 동일하게 강제. 과도한 출력/불완전JSON/잘못된 구조는 실패. 검수 후 필수 문제가 남으면 공개하지 않는다.

full shape:
```
{source:'ai',product:'revision',sections:[{id:'p1',heading:prompt,text:revisedText,charLimit:limit}],quality:{checks:[{key,label,status:'pass'|'attention'}],repairAttempted:boolean},revision:{lengthMode,limit,originalLength,revisedLength,changes:[{category:'fit'|'logic'|'evidence'|'wording'|'spelling'|'length',before,after,reason}],diagnosis:[{category,problem,suggestion}],confirmedFacts:[],warnings:[]},review:{...},sources:[...]}
```
최대8 changes, before/after 각각220자 이하이며 각각 실제 원문/수정문의 연속 부분문자열이어야 한다. reasons160자 이하. 변경은0개여도 된다. before는 originalText 또는 사용자 추가답변에 존재해야 한다. 원문/추가답변 밖 수치 유입은 차단하며 회사공고 수치는 개인 성과로 허용하지 않는다. 원문대조는 진실성 인증이 아니다. 독립 요청 검수는 답변의 구체적 근거와 역할·기여·인과·숫자 변화·문항이탈을 살피고, 수정본을 입력에 근거해 검사한다.

## 공개 결과 (부모가 결제 계층 확장)
preview: `{product:'revision',resultId,access:'preview',sections:[{id,heading,charCount,charLimit,segments:[{kind:'visible',text}|{kind:'locked',lines}]}],quality:{checks:[...]},revisionSummary:{lengthMode,limit,originalLength,revisedLength,changeCount,diagnosisCategories:[]},purchase:{amount,ready,disabledReason,expiresAt,...},privacy:{autoDeleteOnDelivery:true,...}}`.
미결제 원문/수정전후 전체/검수 원문/근거는 반환 금지. visible 합계 수정본문의25% 이하.
full: 기존 full projection + product/revision/review/sources + privacy.autoDeleteOnDelivery=true. 신규 revision에는 복구코드 UI 없음.
결과 화면에 full을 수신/렌더한 후 `/api/payment` DELETE `{resultId}`로 콘텐츠 삭제하고, `/api/insosoe` DELETE로 재시도 캐시 정리. 삭제 실패 시 삭제됐다고 쓰지 말고 재시도/상태 표시. 화면 메모리에는 결과를 남겨 복사·다운로드 가능. 새로고침/닫으면 복구할 수 없다고 명시.

## 보관 정책 목표
신규 revision 미결제 결과 최대1시간. 결제 확인 대기 및 미수신 승인 결과는 최대24시간(결제 장애 대응 예외). 전문 전달 후 삭제 요청/서버 성공 확인 즉시 서비스 DB 콘텐츠와 캐시 삭제. 거래기록은 분리 보관. 기존 v3 결과의 약속한 보관 기간은 유지. 로그·백업·외부 AI 업체 정책은 별도 범위이므로 어디에도 남지 않는다는 보장 금지. provider 요청에 ZDR를 명시하지만 계정별 Safety Retention과 법적 예외 검증 전 절대 보장 금지.

## UI 담당 소유
`public/index.html`, `public/app.js`, `public/style.css`, `public/policy.js`, `scripts/build-ui-v4-qa.mjs`만 수정/작성. 다른 파일은 부모가 관리.
랜딩은 첨삭 가치 중심. 모바일/키보드/레이블/오류 포커스/로딩 상태/실제 글자수/동의창 접근성. innerHTML로 사용자/AI 문자열 주입 금지. 입력 원문이나 수정문을 localStorage/sessionStorage에 저장하지 않음. 샘플은 명확히 가상 예시, 실서버 AI 호출 없이 체험 가능한 미리보기. production API를 우회하는 모의결제/전문열기 버튼 금지. 로컬 QA 파일만 고정 stub을 주입할 수 있고 서버 배포 코드에는 QA 우회 금지.
입력 화면에서 비용 한도 부족해도 작성·가상 예시 체험 가능하되 실제 전송만 비활성화하고 이유 설명. UI가 긴 인터뷰 시작을 유도하지 않아야 함.

## 검증
mock와 실제 AI 품질 검증을 구분. 실제 모델 호출은 부모만 기존 잔여 한도 내 승인된 가상 입력으로 수행. 무료잠금/주문승인/삭제 race/네트워크 재시도/바이트·수치·인용 무결성/원문 프롬프트 주입/문항이탈/모바일을 테스트한다. 보안 전체감사·합격 보장이라고 하지 않는다.

## 통합 보완
- 일반 지우기는 DELETE scope revision: 진행 중 요청 취소와 미수신 V4 결과까지 삭제하고 기존 V3는 보존한다. 전문 수신 후에는 특정 결과 payment DELETE 뒤 scope cache로만 정리한다.
- 보강질문의 공개 문구는 서버 소유 고정 템플릿으로 정규화하여 모델이 질문 필드로 전문을 유출하지 못하게 한다.
- 로컬 file URL 접근은 브라우저 권한상 차단되었다. 실제 화면은 허가된 Preview에서 확인한다. 모의 full 화면 검증은 실제 승인과 구분하며 배포 코드에 우회 기능을 추가하지 않는다.
