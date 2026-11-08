// POST /api/research  { name, address, store, refresh? }
// 보고서를 만들기 전에 Claude가 상호명·주소로 인터넷을 직접 조사한다 (웹 검색 + 블로그·리뷰 글 읽기).
// 상호명·주소와 앞서 찾은 공개 정보만 쓰고, 인터뷰 답변은 보내지 않는다. 같은 가게는 3일 동안 저장한 결과를 쓴다.
import { HttpError, send, sendError, readJson, checkOrigin, runMetered, hashKey, isProduction } from '../lib/guard.mjs';
import { chat, extractJson, DEFAULT_MODEL, REPAIR_MODEL } from '../lib/ai.mjs';
import {
  RESEARCH_SYSTEM, RESEARCH_SCHEMA, RESEARCH_REPAIR_SYSTEM, researchUser, researchTools, normalizeResearch, looksLikeResearch,
} from '../lib/research.mjs';
import { clean, normalizeCandidate } from '../lib/validate.mjs';
import { mockEnabled, mockResearch } from '../lib/mock.mjs';
import { status } from './store-search.js';

export const researchKey = (name, address) => hashKey('research', name, address);
const ENGINES = ['auto', 'native', 'exa', 'parallel', 'perplexity'];

export function validateResearchInput(body, env = {}) {
  const name = clean(body?.name, 60);
  const address = clean(body?.address, 120);
  if (!name) throw new HttpError(400, 'NAME', '상호명을 입력해 주세요.');
  if (address.length < 4) throw new HttpError(400, 'ADDRESS', '주소를 입력해 주세요.');
  // 검색 엔진 비교는 미리보기에서만 (운영에서는 무시)
  const engine = !isProduction(env) && ENGINES.includes(body?.engine) ? body.engine : null;
  return { name, address, store: body?.store == null ? null : normalizeCandidate(body.store), refresh: body?.refresh === true, engine };
}

export async function runResearch({ env, fetcher, input, meter }) {
  const model = env.MAECHUL_RESEARCH_MODEL || env.MAECHUL_AI_MODEL || DEFAULT_MODEL;
  let r;
  try {
    r = await chat({
      env,
      fetcher,
      model,
      system: RESEARCH_SYSTEM,
      user: researchUser(input),
      tools: researchTools(env, input.engine),
      maxToolCalls: 12,
      maxTokens: 7000,
      reasoningEffort: 'low',
      timeoutMs: 200000,
    });
  } catch (err) {
    if (err.charged === 'unknown') meter.markUnknown();
    throw err;
  }
  meter.add(r.costMicro);
  let parsed = extractJson(r.text);
  if (!looksLikeResearch(parsed)) {
    if (!r.text.trim()) throw new HttpError(502, 'AI_EMPTY', 'AI가 조사한 내용을 받지 못했어요. 다시 시도해 주세요.');
    let fix;
    try {
      fix = await chat({
        env,
        fetcher,
        model: env.MAECHUL_REPAIR_MODEL || REPAIR_MODEL,
        system: RESEARCH_REPAIR_SYSTEM,
        user: r.text.slice(0, 40000),
        maxTokens: 6000,
        reasoningEffort: null,
        responseFormat: { type: 'json_schema', json_schema: { name: 'store_research', strict: true, schema: RESEARCH_SCHEMA } },
        timeoutMs: 50000,
      });
    } catch (err) {
      if (err.charged === 'unknown') meter.markUnknown();
      throw err;
    }
    meter.add(fix.costMicro);
    parsed = extractJson(fix.text);
  }
  if (!looksLikeResearch(parsed)) throw new HttpError(502, 'AI_FORMAT', 'AI가 조사한 내용을 정리하지 못했어요. 다시 시도해 주세요.');
  const used = r.usage?.server_tool_use_details || {};
  return {
    ...normalizeResearch(parsed, r.annotations),
    input: { name: input.name, address: input.address },
    model: r.model,
    engine: input.engine || env.MAECHUL_RESEARCH_ENGINE || 'auto',
    searches: used.web_search_requests ?? null,
    toolCalls: used.tool_calls_executed ?? null,
    searchedAt: new Date().toISOString(),
  };
}

// 저장된 조사 결과가 있으면 그대로, 없으면 새로 조사한다 (하루 예산·방문자별 횟수 안에서).
export function getResearch({ env, fetcher, store, req, input }) {
  return runMetered({
    env,
    fetcher,
    store,
    req,
    kind: 'research',
    cacheKey: researchKey(input.name, input.address),
    refresh: input.refresh,
    lock: true,
    run: (meter) => runResearch({ env, fetcher, input, meter }),
  });
}

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    const env = deps.env || process.env;
    const fetcher = deps.fetcher || fetch;
    try {
      if (req.method === 'GET') return send(res, 200, status(env));
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        throw new HttpError(405, 'METHOD', '지원하지 않는 요청이에요.');
      }
      checkOrigin(req, env);
      const input = validateResearchInput(await readJson(req, 20000), env);
      if (mockEnabled(env)) return send(res, 200, await mockResearch(input, deps.mockDelay));
      return send(res, 200, await getResearch({ env, fetcher, store: deps.store, req, input }));
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export default createHandler();
