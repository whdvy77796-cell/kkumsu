// POST /api/geo-search: consent + name + address only. No uploads or questionnaire.
import { HttpError, send, sendError, readJson, checkOrigin } from '../lib/guard.mjs';
import { validateGeoInput, getGeoSearch } from '../lib/geo-search.mjs';

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    const env = deps.env || process.env;
    const fetcher = deps.fetcher || fetch;
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'METHOD', 'POST 요청만 지원해요.');
      }
      checkOrigin(req, env);
      const body = await readJson(req, 4000);
      // Some platforms provide an already parsed object, bypassing stream size checks.
      if (Buffer.byteLength(JSON.stringify(body) || '') > 4000)
        throw new HttpError(413, 'TOO_LARGE', '보낸 내용이 너무 길어요.');
      const input = validateGeoInput(body);
      const result = await getGeoSearch({ env, fetcher, store: deps.store, req, input, now: deps.now || Date.now });
      return send(res, 200, result);
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export default createHandler();
