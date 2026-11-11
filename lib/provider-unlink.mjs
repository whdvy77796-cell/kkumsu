/** Experimental server-only adapter. No routes, storage, retries or default transport. */
const ENDPOINTS = Object.freeze({
  kakao: 'https://kapi.kakao.com/v1/user/unlink',
  naver: 'https://nid.naver.com/oauth2.0/revoke',
  google: 'https://oauth2.googleapis.com/revoke',
});
const MAX_BODY = 4096;
const MAX_REQUEST = 8192;
const MAX_AGE = 5 * 60 * 1000;
const outcome = (status, reason) => Object.freeze({ status, reason, automaticRetry: false });
const validString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x20\x7f]/.test(v);

/**
 * fetchImpl is a trusted, non-logging transport supplied explicitly for experiments.
 * No global fetch fallback. Caller assertions are NOT cryptographic verification.
 */
export function createProviderUnlinkAdapter({ fetchImpl, now = Date.now, timeoutMs = 3000, experimental = false } = {}) {
  if (!experimental || typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 3000) {
    throw new TypeError('Invalid experimental adapter configuration');
  }
  return async function unlink(input) {
    let controller, timer, reader;
    try {
      // Capture primitives before any await: callers cannot mutate the checked identity.
      const { expected, reauthenticated, accessToken, clientSecret } = input ?? {};
      const provider = expected?.provider;
      const clientId = expected?.clientId;
      const subject = expected?.subject;
      const authenticatedAt = reauthenticated?.authenticatedAt;
      const current = now();
      if (!Object.hasOwn(ENDPOINTS, provider ?? '') ||
          !validString(clientId, 256) || !validString(subject, 256) ||
          reauthenticated?.provider !== provider || reauthenticated?.clientId !== clientId ||
          reauthenticated?.subject !== subject || reauthenticated?.tokenBound !== true ||
          reauthenticated?.freshAuthentication !== true ||
          !Number.isSafeInteger(current) || !Number.isSafeInteger(authenticatedAt) ||
          authenticatedAt > current || current - authenticatedAt > MAX_AGE ||
          !validString(accessToken, 2048) ||
          (provider === 'naver' && !validString(clientSecret, 1024)) ||
          (provider === 'kakao' && !/^[1-9][0-9]{0,18}$/.test(subject))) {
        return outcome('blocked', 'reauthentication_contract');
      }
      const endpoint = ENDPOINTS[provider];
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', Accept: 'application/json' };
      const form = new URLSearchParams();
      if (provider === 'kakao') headers.Authorization = 'Bearer ' + accessToken;
      else form.set('token', accessToken);
      if (provider === 'naver') {
        form.set('client_id', clientId);
        form.set('client_secret', clientSecret);
        form.set('token_type_hint', 'access_token');
      }
      const body = form.toString();
      if (new TextEncoder().encode(body).byteLength > MAX_REQUEST) return outcome('blocked', 'request_limit');
      controller = new AbortController();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeoutMs);
      });
      const operation = (async () => {
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers, body, redirect: 'error', credentials: 'omit',
          cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return outcome('pending', 'unconfirmed'); }
        if (response.redirected || response.url !== endpoint || response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          return outcome('pending', 'unconfirmed');
        }
        const length = response.headers.get('content-length');
        if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY)) {
          void response.body?.cancel().catch(() => {});
          return outcome('pending', 'response_limit');
        }
        let total = 0;
        const chunks = [];
        if (response.body) {
          reader = response.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_BODY) return outcome('pending', 'response_limit');
            chunks.push(value);
          }
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
        if (provider === 'naver') return outcome('pending', 'ambiguous_revocation_ack');
        if (provider === 'google') {
          // HTTP 200 is Google's documented acknowledgement; reject unexpected/error bodies.
          return !text || text === '{}' ? outcome('success', 'provider_confirmed') : outcome('pending', 'unconfirmed');
        }
        // Preserve 64-bit Kakao IDs exactly; never round them through JSON Number.
        const match = /^\{\s*"id"\s*:\s*([1-9][0-9]{0,18})\s*\}$/.exec(text);
        return match?.[1] === subject ? outcome('success', 'provider_confirmed') : outcome('pending', 'unconfirmed');
      })();
      return await Promise.race([operation, deadline]);
    } catch {
      // Never expose transport exceptions, response bodies, credentials or identity.
      return outcome(controller ? 'pending' : 'blocked', 'unconfirmed');
    } finally {
      clearTimeout(timer);
      controller?.abort();
      if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
    }
  };
}
