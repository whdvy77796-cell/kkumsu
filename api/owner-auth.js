import { localAuthAvailable } from '../lib/local-auth.mjs';
import { HttpError, send, createStore } from '../lib/guard.mjs';
import { requestScope, checkStoreOrigin } from '../lib/stores.mjs';
import { authConfig, trustedRequest, requireSession, startLogin, finishLogin, logout, cookieHeader, STATE_COOKIE } from '../lib/owner-auth.mjs';

// Launch only Google by default. Other providers can be enabled later without
// deleting account links. Invalid explicit configuration fails closed.
function enabledLoginProviders(env) {
  const setting = env.YB_ENABLED_LOGIN_PROVIDERS;
  if (setting === undefined) return new Set(['google']);
  if (typeof setting !== 'string' || !/^(?:google|naver|kakao)(?:,(?:google|naver|kakao))*$/.test(setting)) return new Set();
  return new Set(setting.split(','));
}

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    let op, googleCallbackIntent = false;
    try {
      const env = deps.env || process.env, scope = requestScope(req, env);
      const clock = () => typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now();
      const now = clock();
      if (!Number.isSafeInteger(now)) throw new HttpError(503, 'AUTH_CLOCK', '로그인을 사용할 수 없어요.');
      const raw = req.url || '/api/owner-auth';
      if (typeof raw !== 'string' || raw.length > 10000 || !raw.startsWith('/api/owner-auth?') || raw.includes('#') || /[\x00-\x20\x7f\\]/.test(raw)) throw new HttpError(400, 'AUTH_URL', '요청 주소를 확인해 주세요.');
      const url = new URL(raw, 'https://' + scope.host);
      if (url.pathname !== '/api/owner-auth') throw new HttpError(400, 'AUTH_URL', '요청 주소를 확인해 주세요.');
      // Cleanup intent only, never authentication/provider selection. Record it
      // before query() can reject req.query disagreement or polluted values.
      // An explicit operation, including malformed start/status/logout, is not
      // an op-less Google callback and must not clear an unrelated OAuth cookie.
      googleCallbackIntent = !url.searchParams.has('op') && ['state','code','error'].some(name => url.searchParams.has(name));
      const query = name => {
        const values = url.searchParams.getAll(name);
        if (values.length > 1 || Array.isArray(req.query?.[name]) || (req.query?.[name] !== undefined && req.query[name] !== values[0])) throw new HttpError(400, 'AUTH_QUERY', '요청 주소를 확인해 주세요.');
        return values[0] ?? null;
      };
      // Query-free registered Google redirect URI: only op-less responses reach
      // Google. Extra response fields are ignored, never used as identity.
      const googleCallback = query('op') === null;
      op = googleCallback ? 'callback' : query('op');
      const fields = { status: ['op'], start: ['op','provider','return'], callback: googleCallback ? ['state','code','error','error_description','scope','authuser','prompt','iss'] : ['op','provider','state','code','error','error_description'], logout: ['op'] };
      if (!Object.hasOwn(fields, op)) throw new HttpError(400, 'AUTH_OP', '지원하지 않는 로그인 요청이에요.');
      for (const name of url.searchParams.keys()) { if (!fields[op].includes(name)) throw new HttpError(400, 'AUTH_QUERY', '요청 주소를 확인해 주세요.'); query(name); }
      if ((googleCallback && query('iss') !== null && query('iss') !== 'https://accounts.google.com') || (!googleCallback && op === 'callback' && query('provider') === 'google')) throw new HttpError(400, 'AUTH_QUERY', '요청 주소를 확인해 주세요.');
      const method = op === 'logout' ? 'POST' : 'GET';
      if (req.method !== method) { res.setHeader('Allow', method); throw new HttpError(405, 'METHOD', '요청 방식을 확인해 주세요.'); }
      const config = authConfig(env), enabledProviders = enabledLoginProviders(env);
      // Even status cannot enable login on an untrusted alias/preview host.
      if (config) trustedRequest(req, scope, env);
      let store = deps.store;
      if (store === undefined) { store = createStore(env, deps.fetcher || fetch); if (typeof store?.cmd !== 'function') store = null; }
      const usable = !!store && typeof store.getJson === 'function' && typeof store.setJson === 'function' && (typeof store.cmd === 'function' || deps.store?.kv instanceof Map);
      if (op === 'status') {
        // An unavailable datastore is an outage, not evidence of logout or
        // disabled providers. Only missing/invalid auth config is disabled.
        if (config && !usable) throw new HttpError(503, 'AUTH_STORE', '로그인 저장소가 준비되지 않았어요.');
        let session = null;
        if (config && usable) { try { session = await requireSession({ req, store, scope, env, now }); } catch (err) { if (!(err instanceof HttpError && err.status === 401)) throw err; } }
        return send(res, 200, { authenticated: !!session, provider: session?.provider || null, local: !!(usable && localAuthAvailable(env)), providers: { kakao: !!(enabledProviders.has('kakao') && config?.providers.kakao && usable), naver: !!(enabledProviders.has('naver') && config?.providers.naver && usable), google: !!(enabledProviders.has('google') && config?.providers.google && usable) } });
      }
      if (!config) throw new HttpError(503, 'AUTH_CONFIG', '소셜 로그인 설정이 아직 준비되지 않았어요.');
      if (!usable) throw new HttpError(503, 'AUTH_STORE', '로그인 저장소가 준비되지 않았어요.');
      if (op === 'logout') {
        checkStoreOrigin(req, scope);
        if (req.headers.origin !== config.origin || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'ORIGIN', '이 사이트에서 로그아웃해 주세요.');
        res.setHeader('Set-Cookie', await logout({ req, store, scope, env, now }));
        return send(res, 200, { authenticated: false, provider: null });
      }
      if (op === 'start' && !enabledProviders.has(query('provider'))) throw new HttpError(503, 'AUTH_DISABLED', '로그인 제공자가 아직 준비되지 않았어요.');
      const common = { req, store, scope, env, now, provider: googleCallback ? 'google' : query('provider') };
      const result = op === 'start'
        ? await startLogin({ ...common, destination: query('return') ?? 'dashboard' })
        : await finishLogin({ ...common, state: query('state'), code: query('code'), error: query('error'), clock, fetcher: deps.fetcher || fetch });
      res.setHeader('Set-Cookie', result.cookies);
      res.setHeader('Location', result.location);
      res.statusCode = 303;
      return res.end('');
    } catch (err) {
      // Never log exceptions/provider bodies: they can contain OAuth credentials.
      const rateFailure = err instanceof HttpError && ['AUTH_RATE_LIMIT', 'AUTH_RATE_STORE', 'AUTH_RATE_IP'].includes(err.code);
      if ((op === 'callback' || googleCallbackIntent) && !rateFailure) res.setHeader('Set-Cookie', [cookieHeader(STATE_COOKIE, '', 0)]);
      if (err instanceof HttpError && err.code === 'AUTH_RATE_LIMIT') res.setHeader('Retry-After', String(err.extra.retryAfter));
      return send(res, err instanceof HttpError ? err.status : 503, { error: err instanceof HttpError && err.code === 'AUTH_RATE_LIMIT' ? err.message : '로그인을 완료하지 못했어요. 다시 시도해 주세요.', code: err instanceof HttpError ? err.code : 'AUTH_UNAVAILABLE' });
    }
  };
}
export default createHandler();
