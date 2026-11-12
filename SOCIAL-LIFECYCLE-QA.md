# Isolated lifecycle migration next step: BLOCKED, NOT RELEASEABLE

## Completed bounded implementation

Production base copied from `ai-access-production-port/kkumsu-yeogibwa-logo-953e1e4` into this NEW directory. Existing application files are unchanged. No deploy, provider configuration, production Redis access, customer data inspection, session invalidation, account deletion or store deletion occurred.

- Reused `withdrawal-per-account/lib/withdrawal-redis.mjs` verbatim, rather than repeating its earlier withdrawal experiments. Reviewed its WIP and the older `lifecycle-copy/kkumsu-yeogibwa-lifecycle-module-20261112/WITHDRAWAL-WIP.md`.
- Added `lib/legacy-lifecycle-adoption.mjs`: isolated, unintegrated Google-session migration building block. A single Redis EVAL checks existing persistent per-account authority, active state, incarnation/fence, tuple, session TTL, exact raw CAS, and a one-use independently reconciled session-specific grant. Missing authority or grant fails closed. It keeps the existing accountId, session key, binding, timestamps, unknown JSON fields, exact numeric lexemes and Redis TTL; only adds incarnation/fence. It does not write account/store/index records. Grant consumption is after the session write, so a failed consumption cannot authorize a second adoption because the session raw CAS and already-versioned checks reject it.
- Added `tests/legacy-lifecycle-adoption.test.mjs` (7 Node test cases; later rerun independently with Node 24.22.3, all passed).
- Added `lifecycle-validation.json`: actual validation scope/results.

The preparer rejects duplicate JSON names, escaped duplicate names, already-versioned sessions, incompatible tuples/providers, deleting/deleted authority, invalid epochs and oversized input. It intentionally does not export an enrollment/grant issuer, deletion endpoint, callback adapter or runtime switch. The copied primitive's experimental PROVISION is NOT wired into the service.

## Exact unresolved blocker

A missing per-account authority is indistinguishable from a genuinely new account versus loss/eviction/restore of a prior deletion tombstone. Existing Google accountIds are deterministic and current sessions/owner records have no incarnation. Creating active state on login or adopting every surviving session into a new epoch would resurrect a deleted identity or restore an older incarnation's ownership. Keeping accountIds is possible, but safely preserving sessions requires a durable, independently reconciled authority and session-specific migration evidence. That issuer/reconciliation is absent in the inspected work. This bridge therefore requires a grant; it never manufactures one from a successful login, a session snapshot or an empty owner index.

No safe online bootstrap without a reviewed migration/cutover source of truth has been established. Do NOT resolve this by allowing missing markers, silently turning the gate off or treating a missing index as proof of no accounts. A migration decision must define independent durable enrollment/tombstone history, retention policy, existing Google session eligibility, backup/restore reconciliation and writer cutover. The bridge alone does NOT make existing authentication deletion-safe.

## Inspected current writer coverage that still needs SAME-EVAL integration

- `lib/owner-auth.mjs`: AUTH_LUA `finish` issues a new session; start/claim does not capture account epoch, and `requireSession` currently performs a session GET without lifecycle authority. In-flight callbacks must not select a fresh epoch after identity resolution/deletion.
- `lib/guard.mjs`: OWNER_STORES_LUA `claim`, `update`, `unlink`; the same-account claim fast path; owner `list` stale-member pruning; claim capacity-pruning and index TTL changes. All need the same active authority/session epoch check in the transaction that mutates the record/index, not a previous successful GET.
- `lib/guard.mjs`: STORES_LUA password `update`, `delete`, public `report` (including hidden-record replacement), `create` and public `list` index pruning. Legacy raw CAS preserves ownerAccountId but supplies no lifecycle incarnation. Any owner-bearing create/replay must be rejected or verified with the same epoch; old password snapshots must not restore ownership.
- Restore/import/admin/replay writers outside this repository are not proven absent and remain a release dependency.
- Current auth/store/directory keys do not share the prior per-account `{hash-tag}`. The proposed multi-key gates require confirmed single-primary/shared atomic Redis semantics or a reviewed schema/sharding migration. Do not split cross-slot authorization from writes.

## Validation actually performed

- Exact exported preparer function source executed in the REPL sandbox: **24 assertions passed**, including field/raw retention, large numbers, duplicate keys, invalid input, missing/deleting/deleted authority, tuple mismatch and social legacy refusal. This is pure JavaScript contract validation, NOT Lua/Redis integration or HTTP verification.
- The first Node run was blocked by shell isolation. A later independent rerun in a mapped temporary copy using Node 24.22.3 passed all 7 focused tests; the checks cover JS behavior and Lua source contract only, not Redis execution.
- TCP checks of loopback 127.0.0.1:6379 and :16379 both returned ECONNREFUSED. No real Redis Lua execution occurred, and no production Redis fallback was attempted.
- An attempted shell test command created two output files in the account root after Set-Location failed. Both were immediately removed; no such files remain. All intended deliverables are in this QA directory.

## Remaining work / prohibited conclusions

[blocked] Production-compatible independent authority/grant bootstrap and loss/rollback recovery.
[blocked] Full OAuth start/callback, session auth and every owner-bearing writer transaction integration and concurrent race testing on disposable real Redis.
[blocked] Legacy owner-epoch migration and independently verified coverage of retained records, without losing user data.
Separate work: provider unlink, Kakao/Naver webhooks, store retention/cleanup choices, final deletion, reenrollment policy, real provider round trips and deployment approval. No full deletion or safe real social-login readiness is claimed. No Kakao/Naver enablement is included.
