// POST /api/store-search  { name, address, refresh? }
// 상호명·주소로 Claude가 인터넷 공개 정보를 찾아 후보 가게(최대 3곳)를 돌려준다.
import { HttpError, send, sendError, readJson, checkOrigin, runMetered, hashKey, createStore, onVercel } from '../lib/guard.mjs';
import { chat, extractJson, DEFAULT_MODEL, REPAIR_MODEL } from '../lib/ai.mjs';
import { SEARCH_SYSTEM, searchUser, REPAIR_SYSTEM, STORE_SCHEMA } from '../lib/prompts.mjs';
import { validateSearchInput, normalizeStoreResult } from '../lib/validate.mjs';
import { mockEnabled, mockSearch } from '../lib/mock.mjs';

export function searchTool(env) {
  const engine = env.MAECHUL_SEARCH_ENGINE || 'auto';
  const parameters = {
    engine,
    max_uses: 3,
    max_results: 5,
    max_total_results: 15,
    user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' },
  };
  if (engine === 'exa' || engine === 'parallel' || engine === 'perplexity') parameters.max_characters = 2000;
  return { type: 'openrouter:web_search', parameters };
}

export async function searchStore({ env, fetcher, input, meter }) {
  const model = env.MAECHUL_AI_MODEL || DEFAULT_MODEL;
  let r;
  try {
    r = await chat({
      env,
      fetcher,
      model,
      system: SEARCH_SYSTEM,
      user: searchUser(input),
      tools: [searchTool(env)],
      maxToolCalls: 4,
      maxTokens: 5000,
      reasoningEffort: 'low',
      timeoutMs: 110000,
    });
  } catch (err) {
    if (err.charged === 'unknown') meter.markUnknown();
    throw err;
  }
  meter.add(r.costMicro);
  let parsed = extractJson(r.text);
  if (!parsed || !Array.isArray(parsed.candidates)) {
    // 형식이 어긋나면 검색 없이 저렴한 모델로 JSON 형식만 다시 맞춘다.
    if (!r.text.trim()) throw new HttpError(502, 'AI_EMPTY', 'AI가 찾은 내용을 받지 못했어요. 다시 시도해 주세요.');
    let fix;
    try {
      fix = await chat({
        env,
        fetcher,
        model: env.MAECHUL_REPAIR_MODEL || REPAIR_MODEL,
        system: REPAIR_SYSTEM,
        user: r.text.slice(0, 24000),
        maxTokens: 4000,
        reasoningEffort: null,
        responseFormat: { type: 'json_schema', json_schema: { name: 'store_search', strict: true, schema: STORE_SCHEMA } },
        timeoutMs: 40000,
      });
    } catch (err) {
      if (err.charged === 'unknown') meter.markUnknown();
      throw err;
    }
    meter.add(fix.costMicro);
    parsed = extractJson(fix.text);
  }
  if (!parsed || !Array.isArray(parsed.candidates)) {
    throw new HttpError(502, 'AI_FORMAT', 'AI가 찾은 내용을 정리하지 못했어요. 다시 시도해 주세요.');
  }
  return {
    ...normalizeStoreResult(parsed, r.annotations),
    input: { name: input.name, address: input.address },
    model: r.model,
    searches: r.usage?.server_tool_use_details?.web_search_requests ?? null,
    searchedAt: new Date().toISOString(),
  };
}

export function status(env) {
  const mock = mockEnabled(env);
  return {
    ok: true,
    mock,
    ai: mock || !!env.OPENROUTER_API_KEY,
    store: mock || !onVercel(env) || !!createStore(env),
    model: mock ? 'mock' : env.MAECHUL_AI_MODEL || DEFAULT_MODEL,
  };
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
      const input = validateSearchInput(await readJson(req, 4000));
      if (mockEnabled(env)) return send(res, 200, await mockSearch(input, deps.mockDelay));
      const result = await runMetered({
        env,
        fetcher,
        store: deps.store,
        req,
        kind: 'search',
        cacheKey: hashKey('search', input.name, input.address),
        refresh: input.refresh,
        run: (meter) => searchStore({ env, fetcher, input, meter }),
      });
      return send(res, 200, result);
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export default createHandler();
