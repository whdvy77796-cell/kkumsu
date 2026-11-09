/*
 * Optional standalone POST /api/place-copy, not wired into the survey or the
 * local development router. A consumer must explain that the entered text is
 * sent to an external AI provider and get a fresh affirmative consent before
 * each request. It must render all returned strings as text, not HTML.
 *
 * Request: { consent: true, facts: { name?, category?, address?, highlights?,
 *           keywords?, menus?, parking?, hours? } }
 * All facts are bounded strings; unknown keys, images, attachments, links and
 * empty input are rejected. No network call happens before these checks.
 * Success: { originalFactsLabel, originalFacts, suggestionsLabel,
 *            suggestions: [{ text }], reviewRequired: true, notice }.
 * Facts are unverified owner input (surrounding whitespace is trimmed).
 * Suggestions are exact whole-field combinations, not verified claims.
 * This does not search, guarantee ranking, publish, or mutate the survey.
 *
 * Metering uses the existing report category, including its configured quota
 * if any; no new limits are introduced. No input or output is cached: only an
 * existing hashed temporary lock and the existing usage ledger are stored.
 */
import { HttpError, send, sendError, readJson, checkOrigin, runMetered, hashKey, createStore, limits } from '../lib/guard.mjs';
import { chat, extractJson, REPAIR_MODEL } from '../lib/ai.mjs';
import { COPY_SYSTEM, COPY_SCHEMA, copyUserMessage, validatePlaceCopyInput, validatePlaceCopyOutput } from '../lib/place-copy.mjs';

export async function makePlaceCopy({ env, fetcher, facts, meter }) {
  let response;
  try {
    response = await chat({
      env,
      fetcher,
      model: REPAIR_MODEL,
      system: COPY_SYSTEM,
      user: copyUserMessage(facts),
      maxTokens: 650,
      reasoningEffort: null,
      responseFormat: { type: 'json_schema', json_schema: { name: 'place_copy_drafts', strict: true, schema: COPY_SCHEMA } },
      timeoutMs: 45000,
      // No tools, images, remote content, or automatic retries.
    });
  } catch (err) {
    if (err?.charged === 'unknown') meter.markUnknown();
    throw err;
  }
  // Even an invalid model answer may have incurred a provider charge.
  meter.add(response.costMicro);
  if (response.finish === 'length' || response.annotations.length || response.usage?.server_tool_use_details?.web_search_requests) {
    throw new HttpError(502, 'AI_FORMAT', '안전하게 확인할 수 있는 초안을 만들지 못했어요.');
  }
  return { drafts: validatePlaceCopyOutput(extractJson(response.text), facts) };
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
      const facts = validatePlaceCopyInput(await readJson(req, 12000));
      const store = deps.store || createStore(env, fetcher);
      if (!store) throw new HttpError(503, 'STORE_CONFIG', '이용량 관리 설정이 없어 AI 기능을 잠시 멈췄어요.');

      // runMetered's cache also stores returned values. Use only a short-lived
      // hashed lock, then run without a cache key to avoid retaining the text.
      const lockKey = hashKey('place-copy-lock-v1', JSON.stringify(facts));
      if (!(await store.lock(lockKey, limits(env).lockTtl))) {
        throw new HttpError(409, 'BUSY', '같은 내용으로 이미 만드는 중이에요. 잠시 뒤 다시 확인해 주세요.');
      }
      let result;
      try {
        result = await runMetered({
          env, fetcher, store, req, kind: 'report',
          run: (meter) => makePlaceCopy({ env, fetcher, facts, meter }),
        });
      } finally {
        await store.unlock(lockKey).catch(() => {});
      }
      return send(res, 200, {
        originalFactsLabel: '사장님이 입력한 내용 (사실 확인 전)',
        originalFacts: facts,
        suggestionsLabel: 'AI가 선택한 원문 조합 초안',
        suggestions: result.drafts.map((text) => ({ text })),
        reviewRequired: true,
        notice: 'AI 결과는 의미나 맥락이 잘못될 수 있으므로 사장님이 사실을 직접 확인하고 수정해 주세요. 이 기능은 검색이나 순위를 확인하지 않으며 자동 게시하지 않습니다.',
      });
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export default createHandler();
