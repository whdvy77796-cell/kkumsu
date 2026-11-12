// AI·검색 로봇 접근 집계 읽기. 공개 합계와 소유 가게 전용 조회를 분리한다.
// 기존 가게 저장소는 계정 확인에만 쓰고, 통계는 별도 Redis를 사용한다.
import { HttpError, RedisStore, createStore, send } from '../lib/guard.mjs';
import { requestScope, validId } from '../lib/stores.mjs';
import { ownerKeys, actOnOwnerStore } from '../lib/owner-stores.mjs';
import { readAiSummary } from '../lib/ai-access-core.mjs';

const authDefault = async (args) => (await import('../lib/owner-auth.mjs')).requireSession(args);
const quiet = () => ({ state: 'not_started', since: null, updatedAt: null, lifetime: null, last7Days: null, breakdown: [] });
const unavailable = () => ({ state: 'unavailable', since: null, updatedAt: null, lifetime: null, last7Days: null, breakdown: [] });
const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const pair = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const verified = count(v.verified), unverified = count(v.unverified);
  return verified === null || unverified === null ? null : { verified, unverified };
};
const date = (v) => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
const providers = new Set(['openai', 'anthropic', 'google']);
const purposes = new Set(['search', 'training', 'user', 'search_engine']);
// 저장소 결과를 신뢰하지 않고 필요한 집계값만 내보낸다. 원본 로그나 가게 식별값은 내보내지 않는다.
export function publicSummary(value) {
  if (!value || typeof value !== 'object' || !['active', 'limited'].includes(value.state)) {
    return value?.state === 'not_started' ? quiet() : unavailable();
  }
  const lifetime = pair(value.lifetime), since = date(value.since), updatedAt = date(value.updatedAt);
  const last7Days = value.last7Days === null ? null : pair(value.last7Days);
  if (!lifetime || !since || !updatedAt || (value.last7Days !== null && !last7Days) || !Array.isArray(value.breakdown) || value.breakdown.length > 20) return unavailable();
  const breakdown = [];
  for (const row of value.breakdown) {
    const counters = pair(row);
    if (!counters || !providers.has(row.provider) || !purposes.has(row.purpose)) return unavailable();
    breakdown.push({ provider: row.provider, purpose: row.purpose, ...counters });
  }
  return { state: value.state, since, updatedAt, lifetime, last7Days, breakdown };
}
function configured(env, now) {
  const startedAt = date(env.YB_AI_ACCESS_STARTED_AT);
  return env.YB_AI_ACCESS_ENABLED === 'true' && typeof env.YB_AI_ACCESS_DRAIN_SECRET === 'string' && Buffer.byteLength(env.YB_AI_ACCESS_DRAIN_SECRET) >= 32 &&
    typeof env.YB_AI_ACCESS_PROJECT_ID === 'string' && /^prj_[A-Za-z0-9]{8,100}$/.test(env.YB_AI_ACCESS_PROJECT_ID) && startedAt && Date.parse(startedAt) <= now ? startedAt : null;
}
function telemetryStore(env, fetcher) {
  const url = env.YB_AI_ACCESS_REDIS_URL, token = env.YB_AI_ACCESS_REDIS_TOKEN;
  if (typeof url !== 'string' || typeof token !== 'string' || !token || url.length > 2048) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  // 설정상 같은 주소를 재사용하는 경우를 차단한다. 별도 저장소인지는 배포 전 추가 확인한다.
  const canon = (s) => String(s || '').replace(/\/+$/, '');
  if ([env.KV_REST_API_URL, env.UPSTASH_REDIS_REST_URL].some((x) => x && canon(x) === canon(url))) return null;
  return new RedisStore(url, token, fetcher);
}
export function createHandler(deps = {}) {
  return async function handler(req, res) {
    try {
      const env = deps.env || process.env, now = typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now();
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new HttpError(405, 'METHOD', 'GET 요청만 지원해요.'); }
      const scope = requestScope(req, env);
      const url = new URL(req.url || '/api/ai-access', 'https://' + scope.host);
      if (url.pathname !== '/api/ai-access') throw new HttpError(400, 'QUERY', '요청 주소를 확인해 주세요.');
      const keys = [...url.searchParams.keys()];
      const query = (name) => {
        const values = url.searchParams.getAll(name), q = req.query?.[name];
        if (values.length > 1 || Array.isArray(q) || (q !== undefined && typeof q !== 'string')) throw new HttpError(400, 'QUERY', '요청 주소를 확인해 주세요.');
        if (q !== undefined && values.length && q !== values[0]) throw new HttpError(400, 'QUERY', '요청 주소를 확인해 주세요.');
        return q ?? values[0] ?? null;
      };
      const view = query('view');
      if (!['site', 'store'].includes(view) || keys.some((k) => !['view', 'id'].includes(k))) throw new HttpError(400, 'QUERY', '요청 주소를 확인해 주세요.');
      const id = query('id');
      let ownerCheck = null;
      if (view === 'site' && id !== null) throw new HttpError(400, 'QUERY', '요청 주소를 확인해 주세요.');
      if (view === 'store') {
        validId(id);
        const ownerStore = deps.ownerStore || createStore(env, deps.fetcher || fetch);
        if (!ownerStore || typeof ownerStore.ownerTransaction !== 'function' || typeof ownerStore.publicTransaction !== 'function') throw new HttpError(503, 'STORE_CONFIG', '로그인 상태를 확인하지 못했어요.');
        const session = await (deps.authenticate || authDefault)({ req, store: ownerStore, scope, env, now });
        const accountId = session?.accountId;
        ownerKeys(scope, accountId, id);
        // 같은 계정의 연결 여부와 현재 세션을 원자적으로 확인한다. 브라우저가 보낸 ID만으로 승인하지 않는다.
        ownerCheck = () => (deps.authorizeOwner || actOnOwnerStore)({ store: ownerStore, scope, req, env, accountId, session, input: { action: 'read', id }, now: typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now() });
        await ownerCheck();
        res.setHeader('Vary', 'Cookie');
      }
      const since = configured(env, now);
      if (!since) return send(res, 200, quiet());
      const statsStore = deps.statsStore || telemetryStore(env, deps.fetcher || fetch);
      if (!statsStore) return send(res, 200, unavailable());
      let value;
      try { value = await (deps.readSummary || readAiSummary)({ store: statsStore, scope, storeId: view === 'store' ? id : null, now, since }); }
      catch { value = unavailable(); }
      // 집계 저장소 조회 중 연결 해제·로그아웃이 일어난 경우 응답 직전 다시 차단한다.
      if (ownerCheck) await ownerCheck();
      // 설정 기준 시각과 첫 집계 기록은 다르다. 연결 지연이나 누락이 없었다는 보장은 하지 않는다.
      const result = { ...publicSummary(value), collectionStartedAt: since };
      // 공개 결과는 짧은 CDN 캐시로 무제한 호출에 따른 저장소 부하를 줄인다. 개별 가게는 절대 공유 캐시하지 않는다.
      if (view === 'site') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=10, s-maxage=60');
        return res.end(JSON.stringify(result));
      }
      return send(res, 200, result);
    } catch (err) {
      return send(res, err instanceof HttpError ? err.status : 503, { error: err instanceof HttpError ? err.message : '접근 현황을 확인하지 못했어요.', code: err instanceof HttpError ? err.code : 'AI_ACCESS' });
    }
  };
}
export default createHandler();
