// POST consent + name + address + optional owner-supplied official website.
import { HttpError, send, sendError, readJson, checkOrigin } from '../lib/guard.mjs';
import { validateDiagnosisInput, getGeoDiagnosis } from '../lib/geo-diagnosis.mjs';

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    const env = deps.env || process.env;
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'METHOD', 'POST 요청만 지원해요.');
      }
      checkOrigin(req, env);
      const body = await readJson(req, 8000);
      if (Buffer.byteLength(JSON.stringify(body) || '') > 8000)
        throw new HttpError(413, 'TOO_LARGE', '보낸 내용이 너무 길어요.');
      const input = validateDiagnosisInput(body);
      const result = await getGeoDiagnosis({ env, fetcher: deps.fetcher || fetch, store: deps.store,
        req, input, now: deps.now || Date.now, scanTechnical: deps.scanTechnical, scanOptions: deps.scanOptions, researcher: deps.researcher });
      return send(res, 200, result);
    } catch (err) { return sendError(res, err); }
  };
}
export default createHandler();
