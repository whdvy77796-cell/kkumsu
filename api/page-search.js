// POST /api/page-search  { name, address, consent: true }
// 동의를 받은 뒤 상호명·주소로 후보 가게(최대 3곳)를 찾는다. 자동 재시도·형식 복구 호출 없음(모델 호출은 최대 1회).
import { HttpError, send, sendError, readJson, checkOrigin, runMetered, hashKey } from '../lib/guard.mjs';
import { chat, extractJson, DEFAULT_MODEL } from '../lib/ai.mjs';
import { SEARCH_SYSTEM, searchUser } from '../lib/prompts.mjs';
import { validateSearchInput, normalizeStoreResult, safeUrl, clean } from '../lib/validate.mjs';
import { mockEnabled, mockSearch } from '../lib/mock.mjs';
import { searchTool } from './store-search.js';

export const CACHE_NAMESPACE = 'page-search-v4';
const ALLOWED = new Set(['name', 'address', 'consent']);
const NOTE = '검색 도구가 돌려준 인용(provider_annotation)과 모델이 직접 적은 링크(model_generated)는 구분해서 보여줘요. 어느 쪽도 개별 항목이 사실을 입증한다는 뜻은 아니에요.';

// 기존 진단 프롬프트는 건드리지 않고 소개 페이지 검색에만 지도 관련 공개 검색을 더한다.
// 검색 횟수, 토큰 한도, 기존 예산·호출 제한은 변경하지 않는다.
export const PAGE_SEARCH_SYSTEM = `${SEARCH_SYSTEM}
추가 조사 지침:
- 허용된 최대 3회 검색 안에서 상호와 주소를 함께 넣어 1회는 가게 기본정보·공식 안내, 1회는 Google Maps/구글 지도 관련 공개 웹자료, 1회는 카카오맵에서 가게를 직접 열 수 있는 링크를 찾아보세요. 자료가 부족하면 확인하지 못한 채로 둡니다.
- 이 요청은 지도 공식 API 응답이 아닙니다. 접근하거나 검색 결과에서 실제로 확인할 수 없는 지도 내용·후기·평점·리뷰 수를 읽었다고 가장하지 마세요. 한 플랫폼의 내용을 다른 플랫폼에서 봤다고 쓰지 마세요.
- 카카오맵의 후기·평점·상세정보나 그 가공 요약은 수집·출력하지 마세요. 사용자가 카카오맵 서비스에서 직접 확인할 수 있도록 링크만 제시하며, mapSignals에도 카카오맵 내용을 넣지 않습니다. 다른 웹페이지의 자체 정보는 실제 출처를 밝혀 일반 가게 특징에만 정리합니다.
- 각 후보에 mapSignals 배열을 추가하세요. Google 지도를 명시적으로 언급한 외부 공개 자료에서, 상호와 주소가 이 지점에 맞는다는 근거까지 살핀 뒤 확인 가능한 가게 특징만 짧게 요약합니다. Google 지도 원문을 직접 읽었다고 가장하거나 개인 후기 원문·개인정보를 복사하지 마세요.
- Google 관련 단서마다 platform은 google_maps, text는 특징 하나만 70자 이내로 쓰고, sourceTitle은 실제 검색 결과 제목, sourceUrl은 그 특징을 직접 뒷받침하는 실제 외부 검색 결과의 전체 URL을 적습니다. 서로 다른 내용이나 출처를 한 문장에 섞지 마세요. 하나라도 확인하지 못하면 그 항목을 넣지 말고 최대 3개만 적습니다. URL을 추측하거나 만들어내지 마세요.
- 지도 페이지에서 연결된 블로그·외부 글의 내용은 해당 블로그·외부 글의 실제 원문 URL로만 표시하고, 지도 페이지 URL을 대신 붙이지 마세요. 그 글에서 직접 확인한 범위만 씁니다. 광고·블로그 자체 평가를 지도 후기나 평점으로 바꾸지 마세요.
- 각 지도에서 확인 가능한 단서가 없거나 해당 지점이 불명확하면 mapSignals를 빈 배열로 둡니다. 이는 실제 정보가 없다는 뜻이 아닙니다.`;

export function pageSearchUser(input) {
  return `${searchUser(input)}\n\n각 candidates 항목에는 다음 mapSignals도 포함하세요. Google 관련 외부 공개 검색 결과와 해당 지점이 확인된 경우만 적으며, 확인하지 못하면 []입니다. 카카오맵의 후기·상세 정보는 넣지 마세요.\n"mapSignals": [{ "platform": "google_maps", "text": "외부 검색 결과에서 확인한 가게 특징", "sourceTitle": "실제로 표시된 출처 제목", "sourceUrl": "실제 외부 검색 결과 URL" }]`;
}

// 링크는 브라우저에서만 열고 서버는 가져오지 않는다. AI가 제시한 출처라는 점은 화면에 남긴다.
function publicSourceUrl(value) {
  const raw = safeUrl(value);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (u.username || u.password || !host.includes('.') || /(^|\.)(localhost|local|internal|home\.arpa)$/i.test(host) || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return u.href;
  } catch { return null; }
}

function mapUrlPlatform(value) {
  const u = new URL(value);
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/^(?:www\.)?google\.(?:com|co\.kr)$/.test(host) && /^\/maps(?:\/|$)/.test(u.pathname)) return 'google_maps';
  if (/^maps\.google\.(?:com|co\.kr)$/.test(host) || host === 'maps.app.goo.gl' || host === 'g.page' || (host === 'goo.gl' && /^\/maps(?:\/|$)/.test(u.pathname))) return 'google_maps';
  if (host === 'place.map.kakao.com' || host === 'map.kakao.com' || host === 'map.daum.net' || host === 'kko.to') return 'kakao_map';
  return null;
}

export function normalizeMapSignals(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  const counts = { google_maps: 0, kakao_map: 0 };
  for (const item of raw) {
    const platform = item?.platform;
    // 카카오맵 상세 내용은 서비스 밖에서 수집·표시하지 않는다. 링크만 별도 제공한다.
    if (platform !== 'google_maps' || counts[platform] >= 3) continue;
    const text = clean(item?.text, 1000);
    const sourceUrl = publicSourceUrl(item?.sourceUrl);
    if (!text || text.length > 120 || !sourceUrl) continue;
    const detected = mapUrlPlatform(sourceUrl);
    // Google 지도 원문 콘텐츠 자체는 가져오지 않고 외부 게시물의 공개 검색 단서만 표시한다.
    if (detected) continue;
    const dedup = `${platform}\n${text.toLowerCase()}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    counts[platform]++;
    out.push({ platform, text, sourceTitle: clean(item?.sourceTitle, 100) || new URL(sourceUrl).hostname, sourceUrl, sourceKind: 'third_party' });
  }
  return out;
}

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
      system: PAGE_SEARCH_SYSTEM,
      user: pageSearchUser(input),
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
  const rawCandidates = parsed.candidates.filter((c) => c && typeof c === 'object' && clean(c.name, 80)).slice(0, 3);
  const notKakao = (s) => !/카카오\s*맵|kakao\s*map/i.test(String(s || ''));
  const candidates = norm.candidates.map((c, i) => ({
    ...c,
    hours: notKakao(c.hours) ? c.hours : null,
    phone: notKakao(c.phone) ? c.phone : null,
    rating: notKakao(c.rating) ? c.rating : null,
    reviewCount: notKakao(c.reviewCount) ? c.reviewCount : null,
    priceRange: notKakao(c.priceRange) ? c.priceRange : null,
    menu: c.menu.filter((m) => notKakao(m.name) && notKakao(m.price)),
    features: c.features.filter(notKakao),
    strengths: c.strengths.filter(notKakao),
    weaknesses: c.weaknesses.filter(notKakao),
    reviewThemes: c.reviewThemes.filter((t) => notKakao(t.note)),
    mapSignals: normalizeMapSignals(rawCandidates[i]?.mapSignals),
  }));
  return {
    candidates,
    summary: notKakao(norm.summary) ? norm.summary : '',
    notFoundReason: notKakao(norm.notFoundReason) ? norm.notFoundReason : null,
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
    candidates: (m.candidates || []).map((c) => ({ ...c, mapSignals: [] })),
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
