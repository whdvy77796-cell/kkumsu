// POST /api/survey  { name, address, store | null }
// 사장님이 맞다고 확인한 가게 정보로 5점 척도 맞춤 설문 10문항을 만든다.
import { HttpError, send, sendError, readJson, checkOrigin, runMetered, hashKey } from '../lib/guard.mjs';
import { chat, extractJson, DEFAULT_MODEL } from '../lib/ai.mjs';
import { SURVEY_SYSTEM, surveyUser, SURVEY_SCHEMA } from '../lib/prompts.mjs';
import { validateSurveyInput, normalizeSurvey } from '../lib/validate.mjs';
import { mockEnabled, mockSurvey } from '../lib/mock.mjs';

export async function makeSurvey({ env, fetcher, input, meter }) {
  const model = env.MAECHUL_AI_MODEL || DEFAULT_MODEL;
  const base = {
    env,
    fetcher,
    model,
    system: SURVEY_SYSTEM,
    user: surveyUser(input),
    maxTokens: 3500,
    reasoningEffort: 'low',
    timeoutMs: 70000,
  };
  const call = async (opts) => {
    try {
      const r = await chat({ ...base, ...opts });
      meter.add(r.costMicro);
      return r;
    } catch (err) {
      if (err.charged === 'unknown') meter.markUnknown();
      throw err;
    }
  };
  let r;
  try {
    r = await call({ responseFormat: { type: 'json_schema', json_schema: { name: 'store_survey', strict: true, schema: SURVEY_SCHEMA } } });
  } catch (err) {
    // 구조화 출력 옵션을 받지 않는 경우에만 일반 JSON 요청으로 한 번 더 시도한다.
    if (err.code !== 'AI_PROVIDER' || err.detail === undefined || !/response_format|schema|structured/i.test(err.detail)) throw err;
    r = await call({});
  }
  const parsed = extractJson(r.text);
  if (!parsed) throw new HttpError(502, 'AI_FORMAT', '맞춤 질문을 정리하지 못했어요. 다시 시도해 주세요.');
  return { ...normalizeSurvey(parsed), model: r.model, createdAt: new Date().toISOString() };
}

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    const env = deps.env || process.env;
    const fetcher = deps.fetcher || fetch;
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'METHOD', '지원하지 않는 요청이에요.');
      }
      checkOrigin(req, env);
      const input = validateSurveyInput(await readJson(req, 24000));
      if (mockEnabled(env)) return send(res, 200, await mockSurvey(input, deps.mockDelay));
      const result = await runMetered({
        env,
        fetcher,
        store: deps.store,
        req,
        kind: 'survey',
        cacheKey: hashKey('survey', input.name, input.address, JSON.stringify(input.store)),
        refresh: false,
        run: (meter) => makeSurvey({ env, fetcher, input, meter }),
      });
      return send(res, 200, result);
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export default createHandler();
