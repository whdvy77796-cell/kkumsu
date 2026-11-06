# 간편 첨삭 Preview 추가 안내

새 화면은 자소서 1편(40~6,000자)의 일부 미리보기 무료, 해당 전문 3,000원입니다. 문항과 분량은 선택, 기존 주문 및 구 V4 탭은 구 미리보기 호환 방식을 사용합니다. 기존 v4-revision-3000 금액·결제 준비 gate·보관 정책은 유지합니다. 사업자/환불/지원/정산 준비와 별도 승인 전 PAYMENT_MODE=disabled. 자세한 현재 계약은 SIMPLE_PREVIEW_CONTRACT.md 참조.

# V4 첨삭 전환 추가 안내

신규상품은 v4-revision-3000, 문항1개 첨삭 전문3,000원입니다. V4는 미결제1시간/결제확인대기24시간/미수신승인결과24시간이며 전문수신후 삭제를 확인합니다. 신규 복구코드는 없고, 아래 V3 보관·복구 항목은 기존상품에만 적용됩니다. 거래 최소기록과 승인검증·환불·가맹점·운영 준비 gate는 유지합니다. 주문 request 인덱스와 무료이용권을 상품별로 구분합니다. 실제 PG는 disabled이며 이 문서는 실결제 검증 완료를 뜻하지 않습니다.

---

# Payment security integration

## Parent integration and exports

Payment-owned files only: lib/payments.mjs, lib/payment-store.mjs, api/payment.js, api/payment-webhook.js, new api/payment-reconcile.js, tests/payment.test.mjs, this guide. No existing core/store/insosoe/pipeline/UI/vercel files edited.

PaymentService(c,existingStore,deps={fetcher,now,uuid}) uses existingStore.command and existing seal/unseal. Existing exports remain: saveGeneratedResult, getLatestResultId, getPublicResult, getResult, createOrder, confirm, recover, deleteResult, deleteOwnerResults, webhook; appendSetCookie/readAccessCookie; API factories createPaymentHandler/createWebhookHandler.

NEW: await getOperationalStatus()/refreshReadiness() loads worker heartbeat. getStatus() remains synchronous, but live readiness is FALSE until a healthy heartbeat is loaded. Parent GET /api/insosoe must await getOperationalStatus. createOrder and confirm enforce fresh worker readiness themselves. runReconciliation({limit:10}) returns an aggregate report; createReconcileHandler is exported from new api/payment-reconcile.js.

After runPipeline, BEFORE store.finish, saveGeneratedResult(sid,requestId,fullResult) returns PREVIEW ONLY. Cache/return that projection, never pipeline full content. Reject old full generation caches. Atomically saved latest/result and SAME insosoe:v2:used:<sid> flag remain if budget finalization fails; recover GET latest rather than rerun AI. No budget keys changed.

Pass original validated section id/heading/charLimit and validated used sources. Preview preserves metadata only for bounded id/heading and charLimit100..2000. Fixed three snippets expose <=25% Unicode code points. No section.text, sources, raw notes, plan or review in preview. Full-only sources support evidence review after redirect. Encrypted root fields are whitelisted; raw full answer lists/unexpected roots are excluded. Parent validates source objects before passing them.

DELETE parent integration must await deleteOwnerResults and not swallow pending-order errors. Cookie identity must append Set-Cookie and support SameSite=Lax redirects. recover returns {result,cookie}; append cookie without exposing its header string in JSON. Recovery bearer resultUUID.HMAC is returned only with authorized full results, never in URL/localStorage/logs. Cookie is HttpOnly, sid-bound, expiry-bound, Secure on HTTPS.

## Enforced live gates

Default PAYMENT_MODE=disabled. Regular window keys only: TOSS_CLIENT_KEY=test_ck_/live_ck_, TOSS_SECRET_KEY=test_sk_/live_sk_, TOSS_MERCHANT_ID, PAYMENT_READY=true, valid APP_ORIGIN, Redis settings. Deployed TEST mode is allowed only with explicit VERCEL_ENV=preview, including Preview's normal NODE_ENV=production build. VERCEL_ENV=production, unknown/unmarked Vercel deployments, and NODE_ENV=production without explicit Preview remain blocked for both checkout and provider access. Non-deployed local development/tests remain supported. Live readiness gates are unchanged. No widget gck/gsk keys.

Live also requires:
- TOSS_MERCHANT_VERIFIED=true and PAYMENT_LEGAL_VERIFIED=true.
- Dedicated env SESSION_SECRET >=32 chars, matching c.secret and not equal to configured AI/Toss keys. API-key fallback is not accepted for live readiness.
- PAYMENT_RECONCILIATION_READY=true and CRON_SECRET >=32 chars.
- PAYMENT_SUPPORT_READY=true, asserting an actual monitored support/escalation process.
- Worker success <=25minutes old, no outstanding per-order failures or unresolved support incidents. Readiness also reads persistent queue counts so a not-yet-updated heartbeat cannot hide a newly stored failure.

Stale/missing/unhealthy heartbeat blocks new live checkout/confirm, not GET reconciliation or existing paid access. Flags do not independently prove legal, merchant or support verification. Do not enable live without real acceptance. Public safe legal fields are supplied through BUSINESS_NAME, BUSINESS_REPRESENTATIVE, BUSINESS_REGISTRATION_NUMBER, BUSINESS_ECOMMERCE_REGISTRATION, BUSINESS_ADDRESS, BUSINESS_CONTACT_EMAIL, BUSINESS_CONTACT_PHONE, PAYMENT_REFUND_POLICY, PAYMENT_DELIVERY_TERMS, PAYMENT_FINANCIAL_RETENTION_POLICY, TERMS_URL, PRIVACY_URL. Terms/privacy resolve to same-origin HTTPS. No business/contact details fabricated.

## Fixed absolute retention

- Ordinary unpaid result/latest/request/owner pointers:24h. Abandoned checkout alone does not extend content.
- First confirmation requires provider-authenticated IN_PROGRESS. BEFORE charge, BEGIN_CONFIRM atomically persists ciphertext, payment identity, immutable idempotency binding, queue entry and latest/request/owner pointers. Processing retention is fixed FIRST BEGIN +7days. Retry/read does not extend it.
- Approved content expiry: actual provider approvedAt +7days, never sliding.
- Approved/revoked financial ledger expiry: actual approvedAt +5calendar years (UTC anniversary, leap day clamped). Unknown potentially charged pending ledger: createdAt +5calendar years until definitively resolved. Failed/expired/unpaid abandoned: createdAt +30days.
- Payment uniqueness mapping gets EXACT same absolute deadline as ledger. All begin/record/release/delete/retry SETs preserve absolute expiry. No indefinite ledger keys or sliding read TTLs.
- Content pointers expire with content, not financial retention. Legacy free-use flag intentionally unchanged.
- DELETE blocks unresolved in-flight orders only through processing deadline, or unblocks earlier after provider terminal status. It never blocks for five financial years. Deletion preserves minimal ledger, destroys content/recovery and does not refund.

Ledger excludes resume/answer content. It includes only hashed owner/result/order references, mode/MID, fixed amount/currency, consent/version/times, idempotency UUID, status/expiry, safe reconciliation counters/codes and AES-GCM-encrypted opaque gateway key. Queue indexes contain order IDs only. Support expiry scores are pruned each sweep; missing ledger entries are removed from pending batches. Stable secrets, durable Redis and planned key rotation remain required.

## Scheduled reconciliation

Parent schedules GET /api/payment-reconcile every10minutes with Authorization: Bearer CRON_SECRET. POST is rejected (GET-only HTTP endpoint). Constant-time authentication before any service/provider work. No user input can enlarge batch. Server-to-server endpoint does not depend on browser cookies/Origin. Cross-site browser fetch metadata rejected. maxDuration90.

Default batch10/max25, max5 concurrent provider GETs, timeout15s each. Atomic claim moves due score120s, preventing overlapping workers from claiming same due batch; crash claims become reclaimable. BEFORE confirmation every pending order is enqueued. Successfully delivered paid/revoked/definitively unpaid orders leave pending; unresolved support incidents remain in the bounded due queue even if provider-approved. Failures stay queued with attempt count, timestamp and allowlisted error code only. Aggregate heartbeat records success/failure/pending/support counts; HTTP503 indicates failed items and must be monitored.

Worker is deliberately GET-ONLY. It never charges, confirms, mints a new order/idempotency key, or refunds. IN_PROGRESS within10minutes of first confirmation attempt reports PAYMENT_AUTHORIZATION_RETRY_REQUIRED; browser may retry SAME order/key/idempotency. After10minutes PAYMENT_AUTHORIZATION_WINDOW_ENDED prevents another confirm POST. Provider's actual auth deadline can be earlier and remains authoritative.

After unresolved seven-day expiry, pending becomes visible support incident PENDING_CONTENT_EXPIRED. Unexpected missing paid ciphertext before expected expiry records PAID_CONTENT_UNAVAILABLE. Normal paid seven-day expiry is not a support incident. Public/cron responses contain aggregates only, no order IDs/payment keys/content. Support incidents block new live checkout through heartbeat. Investigate and resolve/refund explicitly when warranted; never clear incidents just to turn readiness green. No real automatic refunds.

## Existing payment gates preserved

Toss v2 standard payment WINDOW CARD, SDK https://js.tosspayments.com/v2/standard, SDK ANONYMOUS constant. Server-only immutable3000KRW/order/owner/result; same-origin success/fail URLs. CARD DEFAULT may return 카드 or 간편결제, both immediate types accepted; unsupported methods rejected before charge. No virtual-account flow.

Pinned provider API https://api.tosspayments.com/v1/payments/confirm and /orders/{orderId}; Basic base64(secretKey+':'); immutable per-order UUID Idempotency-Key. Confirm requires matching amount/order/currency/MID/key/type/status. Full access always provider-requeried and refund/partial-refund revoked. Client paid flags or webhook payload never grant access. PAYMENT_STATUS_CHANGED uses lookup hints, not invented payment-event signatures.

Official references inspected: https://docs.tosspayments.com/reference ; https://docs.tosspayments.com/reference/using-api/authorization ; https://docs.tosspayments.com/reference/using-api/webhook-events .

## Test scope / remaining real-operation gates

Tests mock provider and model Lua in JS. They do NOT prove real Redis EVAL/PEXPIREAT/cjson semantics. Parent must verify scripts on Redis, durable storage/crash behavior, merchant test-account round trips, SDK redirects, scheduling and monitoring. Normal command: node --test tests/payment.test.mjs. Guard launcher:

node --preserve-symlinks --preserve-symlinks-main --input-type=module -e "await import('file:///C:/Users/whdvy/.aside/u/0/sessions/2026-11-05_mtkEyil5Vtb9063M/tmp/insosoe-v3/tests/payment.test.mjs')"

No real payment, live key enablement, AI call, refund, deployment or cron activation performed. Seven-day retention plus worker fixes the former one-hour operational gap, but catastrophic data loss or outages beyond retention still need actual support/backups. Parent owns WAF/rate limits, legal/merchant verification and live operational acceptance. Downloaded full content cannot be remotely revoked; revocation affects subsequent server access.

## Concrete security corrections: persistent health and unpaid-order replacement

Persistent queue:failures stores each unresolved failed order with its fixed financial expiry. RECONCILE_RETRY adds failures; only a successful verified provider lookup or ledger expiry clears them. Empty/overlapping sweeps cannot reset failed health or advance lastSuccessAt while failure/support sets remain nonempty. Heartbeat includes outstandingFailures and lastSweepFailures; failed aggregates unresolved failures/support plus current-sweep failures. Handler returns HTTP503 even for an empty batch when unresolved incidents remain. Checkout readiness reads live queue counts, not just stale heartbeat counters.

PAID_CONTENT_UNAVAILABLE and PENDING_CONTENT_EXPIRED remain in both support and due monitoring indexes. They do not count as terminal success. Provider-confirmed full cancellation, valid restored content with a currently DONE payment, or definitive unpaid terminal resolution clears applicable incidents. Partial refund alone does not resolve a missing paid-content incident. Normal seven-day expiry and previously user-authorized deletion do not create new incidents. No refund is initiated.

One exception to the original immutable-one-order rule: a still-valid unpaid result may atomically replace a provider-verified ABORTED/EXPIRED order. A fresh server lookup (<=30s), no approval/cancellation history, no active confirmation lock, no ambiguous status, same owner/result/MID/mode, and immutable3000KRW are required. Old ledger and payment identity remain at their original finite expiry; old order gains supersededBy and can never be rebound or reconfirmed. Concurrent replacement returns the same already-created new order. Late old webhooks can update only their old ledger, never current result binding. CHECK_CONFIRM verifies current binding, payment identity and live lock immediately before every confirm POST. The provider's terminal status is also authoritative; the worker remains GET-only.

Public purchase adds state (available/checkout/pending/retryable/paid/revoked/closed) and canRetry. Revoked/closed/paid are never checkout-ready. createOrder is the existing facade for replacement; no new browser action is required.

Lua export changes: new REPLACE_ORDER (6KEYS), CHECK_CONFIRM (2KEYS); RECORD_PAYMENT now9KEYS (last failure index), RECONCILE_RETRY now4KEYS plus ARGV5 outcome failure/pending/support, RECONCILE_HEARTBEAT now4KEYS. BEGIN7KEYS and DELETE5KEYS unchanged. Regenerated smoke command contains all11 exact exports and16test groups, including replacement and persistent-failure/support resolution. Do not run the earlier smoke command.


## Parent verification update

148 total regression tests passed, including 51 payment mocks, API privacy/UTF-8/budget tests, and GET-only/disabled-worker operation tests. Actual Upstash Redis ran the latest 11 exports: 16 groups, 619 checks, 65 isolated keys cleaned, zero remaining (QA_REDIS_LIVE.json). This does not establish real gateway acceptance, multi-client load, catastrophic recovery, or commercial readiness. Live remains disabled.
