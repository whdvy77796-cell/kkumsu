// 입력 검사와 AI 응답 정리 (길이 제한, 빈 값 정리, 링크 확인)
import { HttpError } from './guard.mjs';
import { REVIEW_THEMES } from './prompts.mjs';

const EMPTY = /^(null|none|n\/a|unknown|없음|정보 ?없음|확인 ?불가|미확인|-)$/i;

export function clean(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function nclean(v, max) {
  const s = clean(v, max);
  return s && !EMPTY.test(s) ? s : null;
}
function list(v, max, len) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = nclean(x, len);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
export function safeUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.href.slice(0, 500);
  } catch {
    return null;
  }
}

export function validateSearchInput(body) {
  const name = clean(body?.name, 60);
  const address = clean(body?.address, 120);
  if (!name) throw new HttpError(400, 'NAME', '상호명을 입력해 주세요.');
  if (address.length < 4) throw new HttpError(400, 'ADDRESS', '주소를 조금 더 자세히 입력해 주세요.');
  return { name, address, refresh: body?.refresh === true };
}

const bool = (x) => (typeof x === 'boolean' ? x : null);
function normalizeServices(s) {
  if (!s || typeof s !== 'object') return null;
  const out = { hall: bool(s.hall), takeout: bool(s.takeout), delivery: bool(s.delivery), reservation: bool(s.reservation) };
  return Object.values(out).some((x) => x !== null) ? out : null;
}
function normalizeThemes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (!REVIEW_THEMES.includes(t?.theme) || !['good', 'bad', 'mixed'].includes(t?.tone)) continue;
    if (out.some((x) => x.theme === t.theme)) continue;
    out.push({ theme: t.theme, tone: t.tone, note: clean(t.note, 120) });
  }
  return out;
}

export function normalizeCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  const name = clean(c.name, 80);
  if (!name) return null;
  return {
    name,
    address: clean(c.address, 160),
    category: nclean(c.category, 40),
    openedYear: nclean(c.openedYear, 40),
    floor: nclean(c.floor, 30),
    phone: nclean(c.phone, 30),
    hours: nclean(c.hours, 200),
    priceRange: nclean(c.priceRange, 60),
    rating: nclean(c.rating, 80),
    reviewCount: nclean(c.reviewCount, 80),
    services: normalizeServices(c.services),
    menu: (Array.isArray(c.menu) ? c.menu : [])
      .map((m) => ({ name: clean(m?.name, 40), price: nclean(m?.price, 30) }))
      .filter((m) => m.name)
      .slice(0, 8),
    strengths: list(c.strengths, 4, 140),
    weaknesses: list(c.weaknesses, 4, 140),
    reviewThemes: normalizeThemes(c.reviewThemes),
    features: list(c.features, 5, 140),
    channels: (Array.isArray(c.channels) ? c.channels : [])
      .map((ch) => ({ type: clean(ch?.type, 20) || '링크', url: safeUrl(ch?.url) }))
      .filter((ch) => ch.url)
      .slice(0, 6),
    matchLevel: ['high', 'medium', 'low'].includes(c.matchLevel) ? c.matchLevel : 'low',
    matchReason: clean(c.matchReason, 220),
  };
}

export function normalizeStoreResult(raw, annotations = []) {
  const candidates = (Array.isArray(raw?.candidates) ? raw.candidates : []).map(normalizeCandidate).filter(Boolean).slice(0, 3);
  // 검색 도구가 돌려준 인용 링크를 먼저, 그다음 모델이 적은 참고 페이지를 붙인다.
  const sources = [];
  const seen = new Set();
  const listed = [
    ...annotations.map((a) => ({ url: a?.url_citation?.url || a?.url, title: a?.url_citation?.title || a?.title })),
    ...(Array.isArray(raw?.sources) ? raw.sources : []),
  ];
  for (const s of listed) {
    const u = safeUrl(s?.url);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const title = clean(s?.title, 100) || new URL(u).hostname;
    sources.push({ title, url: u });
    if (sources.length >= 8) break;
  }
  return {
    candidates,
    summary: clean(raw?.summary, 320),
    notFoundReason: candidates.length ? null : nclean(raw?.notFoundReason, 320) || '인터넷에서 이 가게의 공개 정보를 찾지 못했어요.',
    sources,
  };
}
