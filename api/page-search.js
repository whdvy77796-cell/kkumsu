// POST /api/page-search  { name, address, consent: true }
// 동의를 받은 뒤 상호명·주소로 후보 가게(최대 3곳)를 찾는다. 자동 재시도·형식 복구 호출 없음(모델 호출은 최대 1회).
import { HttpError, send, sendError, readJson, checkOrigin, runMetered, hashKey } from '../lib/guard.mjs';
import { chat, extractJson, DEFAULT_MODEL } from '../lib/ai.mjs';
import { SEARCH_SYSTEM, searchUser } from '../lib/prompts.mjs';
import { validateSearchInput, normalizeStoreResult, safeUrl, clean } from '../lib/validate.mjs';
import { mockEnabled, mockSearch } from '../lib/mock.mjs';
import { searchTool } from './store-search.js';

export const CACHE_NAMESPACE = 'page-search-v1';
const ALLOWED = new Set(['name', 'address', 'consent']);
const NOTE = '검색 도구가 돌려준 인용(provider_annotation)과 모델이 직접 적은 링크(model_generated)는 구분해서 보여줘요. 어느 쪽도 개별 항목이 사실을 입증한다는 뜻은 아니에요.';

export function validatePageInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'BAD_JSON', '요청 형식이 올바르지 않아요.');
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (extra.length) throw new HttpError(400, 'FIELDS', '허용되지 않은 항목이 포함되어 있어요.');
  if (body.consent !== true) throw new HttpError(400, 'CONSENT', 'AI 검색을 이용하려면 동의가 필요해요.');
  const { name, address } = validateSearchInput({ name: body.name, address: body.address });
  return { name, address };
}

// 제공자가 보고한 검색 횟수와 제공자 생성 url_citation 주석만으로 근거 상태를 정한다.
export function buildWebEvidence(usage, annotations) {
  const raw = usage?.server_tool_use_details?.web_search_requests;
  const count = Number.isInteger(raw) && raw >= 0 ? raw : null;
  const invalidCount = raw !== undefined && raw !== null && count === null;
  const providerCitations = [];
  const seen = new Set();
  for (const a of Array.isArray(annotations) ? annotations : []) {
    if (!a || a.type !== 'url_citation') continue;
    const u = safeUrl(a?.url_citation?.url || a?.url);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    providerCitations.push({ title: clean(a?.url_citation?.title || a?.title, 100) || new URL(u).hostname, url: u });
    if (providerCitations.length >= 8) break;
  }
  let status = 'unverified';
  if (count !== null) status = count > 0 ? 'confirmed' : 'unverified';
  else if (!invalidCount && providerCitations.length) status = 'citation_only';
  return { status, searchCount: count, providerCitations, conflict: (count === 0 || invalidCount) && providerCitations.length > 0, note: NOTE };
}

function buildSources(providerCitations, modelSources) {
  const out = [];
  const seen = new Set();
  for (const [origin, list] of [['provider_annotation', providerCitations], ['model_generated', modelSources]]) {
    for (const s of list) {
      if (!s?.url || seen.has(s.url)) continue;
      seen.add(s.url);
      out.push({ title: s.title, url: s.url, origin });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

export async function pageSearch({ env, fetcher, input, meter }) {
  const model = env.MAECHUL_AI_MODEL || DEFAULT_MODEL;
  let r;
  try {
    r = await chat({
      env, fetcher, model,
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
  if (!r.text.trim()) throw new HttpError(502, 'AI_EMPTY', 'AI가 찾은 내용을 받지 못했어요. 다시 시도해 주세요.');
  const parsed = extractJson(r.text);
  if (!parsed || !Array.isArray(parsed.candidates)) {
    throw new HttpError(502, 'AI_FORMAT', 'AI가 찾은 내용을 정리하지 못했어요. 다시 시도해 주세요.');
  }
  const norm = normalizeStoreResult(parsed, []); // 모델이 적은 링크만 정리 (제공자 주석은 따로 처리)
  const webEvidence = buildWebEvidence(r.usage, r.annotations);
  if (webEvidence.status === 'unverified') {
    throw new HttpError(502, 'SEARCH_UNVERIFIED', 'AI의 웹 검색 실행 여부를 확인하지 못했어요. 자동으로 다시 보내지 않았어요.');
  }
  return {
    candidates: norm.candidates,
    summary: norm.summary,
    notFoundReason: norm.notFoundReason,
    absenceConfirmed: false, // 후보 없음은 "없다"는 확인이 아니다
    sources: buildSources(webEvidence.providerCitations, norm.sources),
    webEvidence,
    input: { name: input.name, address: input.address },
    model: r.model,
    mock: false,
    searchedAt: new Date().toISOString(),
  };
}

export async function mockPageSearch(input, delay) {
  const m = await mockSearch(input, delay);
  return {
    candidates: m.candidates,
    summary: m.summary,
    notFoundReason: m.notFoundReason,
    absenceConfirmed: false,
    sources: (m.sources || []).map((s) => ({ title: s.title, url: s.url, origin: 'mock' })),
    webEvidence: { status: 'mock', searchCount: null, providerCitations: [], conflict: false, note: '모의 응답이에요. 실제 검색이 아니에요.' },
    input: m.input,
    model: 'mock',
    mock: true,
    searchedAt: m.searchedAt,
    cached: false,
  };
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
      const input = validatePageInput(await readJson(req, 2000));
      if (mockEnabled(env)) return send(res, 200, await mockPageSearch(input, deps.mockDelay));
      const result = await runMetered({
        env, fetcher, store: deps.store, req,
        kind: 'search',
        cacheKey: hashKey(CACHE_NAMESPACE, input.name, input.address),
        refresh: false,
        lock: true,
        run: (meter) => pageSearch({ env, fetcher, input, meter }),
      });
      return send(res, 200, result);
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export default createHandler();
