// Conservative report assembly: search values remain unverified leads.
import { isIP } from 'node:net';
import { HttpError, createStore, hashKey } from './guard.mjs';
import { getGeoSearch, validateGeoInput, GEO_NOTICE } from './geo-search.mjs';
import { getDiagnosisResearch } from './geo-diagnosis-research.mjs';
import { clean } from './validate.mjs';

export const SCAN_ROWS = Object.freeze([
  ['accessibility', '홈페이지 접근'], ['mainFacts', '주요 사업 정보'],
  ['noindex', '검색 색인 제한'], ['robots', '로봇 접근 규칙'],
  ['structuredData', '구조화 데이터'], ['sitemap', '사이트맵'],
  ['metadata', '페이지 메타 정보'], ['contentStructure', '본문 구조'], ['llmsTxt', 'llms.txt'],
].map(([key, label]) => Object.freeze({ key, label })));

// Syntax guard only. The scanner must separately enforce DNS/IP, redirects,
// response-size and timeout rules on EVERY actual network connection.
export function validateWebsite(value, sourceOnly = false) {
  if (typeof value !== 'string' || value.length > 2048 || !value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value))
    throw new HttpError(400, 'WEBSITE', '공식 홈페이지의 공개 HTTP(S) 주소를 입력해 주세요.');
  let u;
  try { u = new URL(value); } catch { throw new HttpError(400, 'WEBSITE', '올바른 홈페이지 주소를 입력해 주세요.'); }
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if ((!sourceOnly && (u.search || u.hash)) || !['https:', 'http:'].includes(u.protocol) || u.username || u.password ||
      (u.port && !['80', '443'].includes(u.port)) || isIP(h) || h.includes(':') ||
      !h.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|test|invalid|onion|arpa)$/.test(h) ||
      !/^[a-z0-9.-]+$/.test(h) || h.split('.').some(p => !p || p.startsWith('-') || p.endsWith('-')) ||
      [...u.searchParams.keys()].some(k => /^(token|access_token|api[_-]?key|password|secret|authorization|code)$/i.test(k)))
    throw new HttpError(400, 'WEBSITE', '인증 정보가 없는 공개 홈페이지 도메인만 검사할 수 있어요.');
  u.hash = '';
  return u.href;
}

export function validateDiagnosisInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'BAD_INPUT', '상호명, 주소와 명시적 동의를 보내주세요.');
  if (Object.keys(body).some(k => !['consent', 'name', 'address', 'website'].includes(k)))
    throw new HttpError(400, 'UNEXPECTED_FIELD', '동의, 상호명, 주소, 선택적 홈페이지 주소만 보낼 수 있어요.');
  const input = validateGeoInput({ consent: body.consent, name: body.name, address: body.address });
  return { ...input, website: body.website === undefined ? null : validateWebsite(body.website) };
}

export function unknownTechnicalScan(targetUrl, reason) {
  return {
    targetUrl: targetUrl || null,
    items: SCAN_ROWS.map(({ key, label }) => ({ key, label, status: 'unknown', evidence: reason,
      improvement: '미확인 상태에서는 문제로 판단하지 않습니다.', sourceUrl: null })),
    warnings: [reason],
  };
}
function validScan(scan) {
  return scan && typeof scan === 'object' && (scan.targetUrl === null || typeof scan.targetUrl === 'string') &&
    Array.isArray(scan.items) && scan.items.length === 9 && Array.isArray(scan.warnings) &&
    scan.warnings.every(x => typeof x === 'string') && SCAN_ROWS.every(({ key }) =>
      scan.items.filter(x => x?.key === key).length === 1) && scan.items.every(x =>
      ['present', 'absent', 'blocked', 'unknown'].includes(x.status) &&
      ['label', 'evidence', 'improvement'].every(k => typeof x[k] === 'string') &&
      (x.sourceUrl === null || typeof x.sourceUrl === 'string'));
}
const norm = x => typeof x === 'string' ? x.normalize('NFC').replace(/\s+/g, '').toLowerCase() : '';
const addressText = value => String(value || '').normalize('NFC').trim()
  .replace(/^(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시)(?=\s)/, v => v.slice(0, 2))
  .replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

// Remove only a complete parenthesized parcel-address supplement, never an
// arbitrary parenthesis containing a floor, suite, branch or building number.
function roadAddress(value) {
  const parcels = [];
  const address = addressText(value).replace(/\(([^()]*)\)/g, (whole, inner) => {
    const parcel = inner.trim();
    if (!/^[가-힣0-9]+(?:동|리|가)\s+(?:산\s*)?\d+(?:-\d+)?(?:번지)?$/.test(parcel)) return whole;
    parcels.push(norm(parcel));
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  const road = /^(.+?\s)([가-힣A-Za-z0-9·.]+(?:대로|로|길))\s+(\d+(?:-\d+)?)(?=\s|$)(.*)$/.exec(address);
  if (!road) return null;
  let suffix = road[4].replace(/[()]/g, ' '), invalid = false;
  const details = {};
  const take = (key, pattern, normalize = norm) => {
    const found = [];
    suffix = suffix.replace(pattern, (_whole, value) => { found.push(normalize(value)); return ' '; });
    if (new Set(found).size > 1) invalid = true;
    details[key] = found[0] || null;
  };
  take('floor', /((?:지하\s*|B\s*)?\d+)\s*층/gi, v => norm(v).replace(/^지하/, 'b'));
  take('unit', /(\d+(?:-\d+)?)\s*호/g);
  take('building', /(\d+)\s*동/g);
  return { key: JSON.stringify([norm(road[1]), norm(road[2]), road[3]]),
    details, residual: norm(suffix), parcels: [...new Set(parcels)].sort(), invalid };
}
export function addressesMatch(left, right) {
  const a = roadAddress(left), b = roadAddress(right);
  // Preserve exact matching for identical non-road addresses; never infer a road
  // match from just the street and number while ignoring the city/district.
  if (!a || !b) return norm(addressText(left)) === norm(addressText(right));
  if (a.invalid || b.invalid || a.key !== b.key || a.residual !== b.residual) return false;
  if (a.parcels.length && b.parcels.length && JSON.stringify(a.parcels) !== JSON.stringify(b.parcels)) return false;
  return ['floor', 'unit', 'building'].every(key => !a.details[key] || !b.details[key] || a.details[key] === b.details[key]);
}
export function confidentCandidate(search, input) {
  if (!Array.isArray(search?.candidates) || search.candidates.length !== 1 || !search.sources?.length) return null;
  const c = search.candidates[0];
  return c?.matchLevel === 'high' && norm(c.name) === norm(input.name) && addressesMatch(c.address, input.address) ? c : null;
}
const text = (x, n = 200) => typeof x === 'string' ? clean(x, n) || null : null;
function sourceLinks(search) {
  const seen = new Set();
  return (Array.isArray(search?.sources) ? search.sources : []).flatMap(s => {
    try {
      const url = validateWebsite(s?.url, true);
      if (seen.has(url)) return [];
      seen.add(url);
      return [{ title: text(s.title, 100) || new URL(url).hostname, url }];
    } catch { return []; }
  }).slice(0, 8);
}
function businessSummary(candidate, input) {
  const category = text(candidate.category, 40);
  const menuNames = [...new Set((Array.isArray(candidate.menu) ? candidate.menu : [])
    .map(item => text(item?.name, 40)).filter(Boolean))].slice(0, 4);
  const first = `입력하신 ${input.address}의 ${input.name}에 대응하는 검색 후보${category ? `에는 업종이 ‘${category}’로 표시되어 있습니다` : '의 업종은 미확인입니다'}.`;
  const second = menuNames.length
    ? `검색된 상품·서비스 항목은 ${menuNames.join(', ')}이며, 이 소개는 사업자 확인이 필요한 미검증 검색 단서입니다.`
    : '검색된 상품·서비스 항목은 미확인이며, 이 소개는 사업자 확인이 필요한 미검증 검색 단서입니다.';
  return first + ' ' + second;
}
export function buildBusiness(search, input) {
  const c = confidentCandidate(search, input);
  if (!c) return { name: input.name, category: null, address: input.address, serviceArea: null,
    offerings: [], priceHoursBooking: { price: null, hours: null, booking: null },
    description: '사용자 입력 상호·주소입니다. 단일 업체의 일치를 충분히 확인하지 못해 검색 상세를 표시하지 않습니다.', sources: [] };
  return {
    name: input.name, category: text(c.category, 40), address: input.address,
    // An address does not establish delivery range or service area.
    serviceArea: null,
    offerings: (Array.isArray(c.menu) ? c.menu : []).map(m => { const name = text(m?.name, 40), price = text(m?.price, 30); return name ? name + (price ? ': ' + price + ' (미검증 검색 단서)' : '') : null; }).filter(Boolean).slice(0, 8),
    priceHoursBooking: { price: text(c.priceRange, 60), hours: text(c.hours),
      booking: c.services?.reservation === true ? '예약 가능이라는 미검증 검색 단서' :
        c.services?.reservation === false ? '예약 불가라는 미검증 검색 단서' : null },
    description: businessSummary(c, input),
    sources: sourceLinks(search),
  };
}
// Only directly observed constraints; never use AI weaknesses or unknown rows.
export function confirmedPriorities(scan) {
  if (!validScan(scan)) return [];
  const rules = {
    noindex: { status: 'present', problem: '검사 페이지에서 noindex 지시가 관찰됐습니다.',
      inconvenience: '이를 준수하는 검색 로봇은 해당 페이지를 색인하지 않을 수 있습니다.',
      action: '비공개 의도인지 확인하고, 공개 검색을 원할 때만 해당 페이지의 noindex 설정을 수정하세요.' },
    robots: { status: 'blocked', problem: '검사 대상의 로봇 접근 제한이 관찰됐습니다.',
      inconvenience: '이번 검사기의 robots 정책 파일 또는 대상 경로 접근이 제한됐습니다. 원문 근거의 HTTP 상태·규칙 범위에 한정되며 모든 검색 로봇의 차단을 뜻하지 않습니다.',
      action: '검사 근거의 대상 로봇·경로와 운영 의도를 확인하고, 필요한 공개 경로만 허용하세요.' },
    accessibility: { status: 'blocked', problem: '검사 환경에서 홈페이지 접근이 차단됐습니다.',
      inconvenience: '이번 검사기는 본문을 읽지 못했습니다. 모든 사용자나 로봇에 대한 장애를 뜻하지는 않습니다.',
      action: '검사 근거의 응답과 방화벽·인증 설정을 확인하세요. 의도된 보호 설정은 유지하세요.' },
  };
  Object.assign(rules, {
    metadata: { status: 'absent', problem: '읽은 페이지에서 title과 description이 모두 확인되지 않았습니다.', inconvenience: '페이지 제목과 요약을 기계가 읽을 때 참고할 정보가 부족합니다. 검색 순위 저하를 입증한 것은 아닙니다.', action: '검사 페이지에 실제 사업 내용과 일치하는 title과 description을 작성하세요.' },
    mainFacts: { status: 'absent', problem: '읽은 페이지의 명시적 body에서 정적 정보 텍스트를 찾지 못했습니다.', inconvenience: '자바스크립트를 실행하지 않는 수집기는 사업 정보를 읽기 어려울 수 있습니다.', action: '동적 화면과 별도로 상호·서비스·위치·연락처를 정확한 정적 본문으로 제공하는지 확인하세요.' },
    structuredData: { status: 'absent', problem: '검사 페이지의 지원 JSON-LD에서 LocalBusiness/Organization 타입이 확인되지 않았습니다.', inconvenience: '지원하는 기계 판독 형식으로 업체 정보를 전달하는 선택적 수단이 없습니다. 필수 요건이나 노출 실패를 뜻하지 않습니다.', action: '사업 유형에 적합할 때만 실제 공개 정보와 일치하는 구조화 데이터를 검토하세요.' },
    sitemap: { status: 'absent', problem: '검사한 관례 사이트맵 경로가 부재로 확인됐습니다.', inconvenience: '해당 경로에서는 사이트맵을 얻지 못했습니다. 다른 사이트맵의 부재나 미색인을 뜻하지 않습니다.', action: '이미 사용하는 사이트맵의 위치를 확인하고 필요할 때만 공개 경로 또는 robots 선언을 정리하세요.' },
  });
  return ['noindex', 'robots', 'accessibility', 'metadata', 'mainFacts', 'structuredData', 'sitemap'].flatMap(key => {
    const item = scan.items.find(x => x.key === key), r = rules[key];
    if (!item.evidence.trim() || !item.sourceUrl) return [];
    if (key === 'robots' && item.status === 'present' && /(?:Googlebot|Bingbot|OAI-SearchBot|GPTBot|ClaudeBot):disallow/.test(item.evidence)) return [{
      problem: 'robots.txt에서 검사한 URL에 대한 일부 봇의 접근 제한이 관찰됐습니다. 검사 근거: ' + item.evidence,
      inconvenience: '근거에 명시된 봇은 해당 경로를 수집하지 않을 수 있습니다. 다른 봇이나 경로로 일반화할 수 없습니다.',
      action: '제한 대상 봇과 경로가 의도된 설정인지 확인하고 공개가 필요한 경우에만 규칙을 조정하세요.',
    }];
    if (key === 'accessibility' && item.status === 'absent' && /페이지 HTTP (404|410)/.test(item.evidence)) return [{
      problem: '요청한 페이지 주소에서 HTTP 부재 응답이 관찰됐습니다. 검사 근거: ' + item.evidence,
      inconvenience: '이번 검사기는 해당 주소의 본문을 읽을 수 없었습니다. 사이트 전체가 없다는 뜻은 아닙니다.',
      action: '정확한 공식 홈페이지 주소와 공개 서버 설정을 확인하세요.',
    }];
    if (item.status !== r.status) return [];
    const confirmations = { metadata: /title: 없음; description: 없음/, mainFacts: /명시적 body에서 정적 텍스트를 찾지 못함/, structuredData: /지원 JSON-LD에서 schema\.org LocalBusiness\/Organization 타입을 찾지 못함/, sitemap: /관례 경로\s+HTTP (404|410)/ };
    if (confirmations[key] && !confirmations[key].test(item.evidence)) return [];
    return [{ problem: r.problem + ' 검사 근거: ' + item.evidence, inconvenience: r.inconvenience, action: r.action }];
  }).slice(0, 3);
}

// A five-minute domain cache and distributed lock prevent path/query variants
// from repeatedly crawling one origin. Cache errors fail closed, without a scan.
// No changes to the AI guard's budgets, reservations or visitor limits.
export async function guardedTechnicalScan({ input, env, fetcher, store, now, scanTechnical, scanOptions }) {
  const unavailable = reason => ({ scan: unknownTechnicalScan(input.website, reason), observedAt: new Date(now()).toISOString() });
  const st = store || createStore(env, fetcher);
  if (!st) return unavailable('검사 이용량 보호 저장소를 확인하지 못해 홈페이지를 검사하지 않았습니다.');
  const host = new URL(input.website).hostname.toLowerCase().replace(/\.$/, '');
  const key = hashKey('geo-technical-domain', host), lockKey = key + ':lock';
  const fromCache = async () => {
    const cached = await st.getJson(key);
    const age = now() - Date.parse(cached?.observedAt);
    if (!cached || !Number.isFinite(age) || age < 0 || age >= 300000 || !validScan(cached.scan)) return null;
    if (cached.targetUrl !== input.website)
      return unavailable('같은 도메인을 최근 5분 이내에 검사했습니다. 다른 경로의 추가 검사는 잠시 보류했으며 이 URL은 미검사입니다.');
    return { scan: cached.scan, observedAt: cached.observedAt };
  };
  let locked = false;
  try {
    const hit = await fromCache();
    if (hit) return hit;
    locked = await st.lock(lockKey, 320);
    if (!locked) return unavailable('같은 도메인의 검사가 진행 중이어서 중복 검사하지 않았습니다.');
    const second = await fromCache();
    if (second) { await st.unlock(lockKey); locked = false; return second; }
    let scan;
    try {
      const scanner = scanTechnical || (await import('./technical-scan.mjs')).scanTechnical;
      scan = await scanner(input.website, scanOptions);
      if (!validScan(scan)) throw new Error('INVALID_SCAN');
    } catch {
      scan = unknownTechnicalScan(input.website, '홈페이지 검사 결과를 확인하지 못했습니다. 재시도하지 않았으며 접근 차단이나 정보 부재로 단정하지 않습니다.');
    }
    const result = { scan, observedAt: new Date(now()).toISOString() };
    // If persistence fails retain the lock until TTL, preventing immediate recrawl.
    await st.setJson(key, { ...result, targetUrl: input.website }, 300);
    await st.unlock(lockKey);
    locked = false;
    return result;
  } catch {
    return unavailable('검사 이용량 보호 저장소를 확인하지 못해 검사 결과를 제공하지 않습니다. 자동 재시도하지 않았습니다.');
  }
  // Do not unlock failures: cooldown must fail closed even with an unhealthy cache.
}

export async function getGeoDiagnosis({ env, fetcher, store, req, input, now = Date.now, scanTechnical, scanOptions = {}, researcher = getDiagnosisResearch }) {
  let search = null, searchFailed = false;
  try {
    search = await getGeoSearch({ env, fetcher, store, req, input: { name: input.name, address: input.address }, now });
  } catch (err) {
    // Keep storage, budget, quota and config guards hard failures.
    if (!/^AI_/.test(err?.code || '') || err.code === 'AI_CONFIG') throw err;
    searchFailed = true;
  }
  let technicalScan, scannedAt = new Date(now()).toISOString();
  if (!input.website) {
    technicalScan = unknownTechnicalScan(null, '공식 홈페이지 주소를 제공하지 않아 검사하지 않았습니다. AI가 제안한 링크는 자동 방문하지 않습니다.');
  } else {
    const result = await guardedTechnicalScan({ input, env, fetcher, store, now, scanTechnical, scanOptions });
    technicalScan = result.scan; // Preserve scanner status/evidence verbatim, never AI-rewritten.
    scannedAt = result.observedAt;
  }
  const business = buildBusiness(search, input);
  let enrichment = { suggestedQuestions: [], competitors: [], researchNotice: 'AI 예상 질문과 비교 업체를 생성하지 못했습니다. 자동 재시도하지 않았습니다.' };
  if (search) {
    try {
      // The provider only sees detached copies. The authoritative measurements
      // remain unchanged even if enrichment code mutates its input.
      const candidate = await researcher({ env, fetcher, store, req, business: structuredClone(business), technicalScan: structuredClone(technicalScan), now });
      if (candidate && Array.isArray(candidate.suggestedQuestions) && Array.isArray(candidate.competitors) && typeof candidate.researchNotice === 'string') enrichment = candidate;
    } catch {
      // An additional AI call may have been processed; retain the measured report
      // and never auto-retry a failed or interrupted enrichment.
      enrichment.researchNotice = 'AI 추가 분석을 완료하지 못해 예상 질문과 비교 업체를 제공하지 않습니다. 자동 재시도하지 않았으며 요청이 처리되었을 수 있습니다.';
    }
  }
  return {
    business, technicalScan, suggestedQuestions: enrichment.suggestedQuestions,
    competitors: enrichment.competitors, priorities: confirmedPriorities(technicalScan),
    notice: GEO_NOTICE + ' 업종·가격·시간 등은 미검증 검색 단서이며 링크는 개별 사실의 증명이 아닙니다. ' +
      enrichment.researchNotice + ' ' +
      '기술 검사는 입력한 홈페이지에만 한정되며 소유권·업체 동일성을 인증하지 않습니다. 결과는 최대 5분 캐시되며 scannedAt은 해당 검사 관찰 시각입니다. 미검사일 때는 응답 시각입니다. ' +
      (searchFailed ? 'AI 공개 웹 검색에 실패하여 상세 정보는 미확인입니다. 자동 재시도하지 않았습니다.' :
        '검색 관찰 시각: ' + (search?.searchedAt || '미확인') + '. 캐시된 검색 단서는 최신 상태를 보장하지 않습니다.'),
    scannedAt,
  };
}
