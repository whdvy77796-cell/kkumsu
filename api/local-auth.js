import { HttpError, send } from '../lib/guard.mjs';
import { requestScope } from '../lib/stores.mjs';
import { trustedRequest } from '../lib/owner-auth.mjs';
import { localAuthAvailable, localRequestContext } from '../lib/local-auth.mjs';
export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const env = deps.env || process.env, scope = requestScope(req, env), raw = req.url;
      if (typeof raw !== 'string' || !/^\/api\/local-auth\?op=(signup|login|reset)$/.test(raw) || Object.keys(req.query || {}).some(k => k !== 'op')) throw new HttpError(400, 'LOCAL_QUERY', '요청 주소를 확인해 주세요.');
      const op = raw.split('=')[1];
      if (req.query?.op !== undefined && req.query.op !== op) throw new HttpError(400, 'LOCAL_QUERY', '요청 주소를 확인해 주세요.');
      if (req.method !== 'POST') res.setHeader('Allow', 'POST');
      localRequestContext(req, env); trustedRequest(req, scope, env);
      if (!localAuthAvailable(env)) throw new HttpError(503, 'LOCAL_AUTH_DISABLED', '이메일 로그인은 아직 제공되지 않아요. 기존 소셜 로그인을 이용해 주세요.');
      throw new HttpError(503, 'LOCAL_SESSION_RELEASE_BLOCKED', '이메일 로그인을 사용할 수 없어요.');
    } catch (err) {
      // Never log request/provider bodies, exceptions or credentials.
      return send(res, err instanceof HttpError ? err.status : 503, { code: err instanceof HttpError ? err.code : 'LOCAL_UNAVAILABLE', error: err instanceof HttpError ? err.message : '이메일 로그인을 사용할 수 없어요.' });
    }
  };
}
export default createHandler();
