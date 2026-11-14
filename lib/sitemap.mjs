import { HttpError } from './guard.mjs';

// These are deliberately separate from the already-submitted static sitemap.
// Bounded rank-based chunks limit each Redis read; ranks can shift while stores change.
export const SITEMAP_PAGE_SIZE = 50;
export const MAX_SITEMAP_PAGES = 50000;
const BASE = 'https://www.lookhereai.com';
// Preview uses only its own isolated namespace and never advertises production URLs.
function sitemapBase(scope) {
  if (scope.production) return BASE;
  if (scope.local) return 'http://' + scope.host;
  if (/^(?:[a-z0-9-]+\.)+vercel\.app$/.test(scope.host)) return 'https://' + scope.host;
  throw new HttpError(404, 'NOT_FOUND', '사이트맵을 찾을 수 없어요.');
}
const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const fail = () => new HttpError(503, 'STORE', '사이트맵을 준비하지 못했어요. 잠시 후 다시 시도해 주세요.');

export async function renderStoreSitemapIndex(store, scope, now = Date.now()) {
  const meta = await store.publicTransaction('sitemap-meta', [scope.namespace + ':directory'], { now });
  if (meta?.status !== 'ok' || !Number.isSafeInteger(meta.total) || meta.total < 0) throw fail();
  const pages = Math.max(1, Math.ceil(meta.total / SITEMAP_PAGE_SIZE));
  if (pages > MAX_SITEMAP_PAGES) throw fail(); // Never claim a truncated index is complete.
  const base = sitemapBase(scope);
  const entries = Array.from({ length: pages }, (_, i) => `  <sitemap><loc>${base}/sitemaps/stores/${i + 1}</loc></sitemap>`);
  return HEADER + `<sitemapindex xmlns="${NS}">\n` + entries.join('\n') + '\n</sitemapindex>\n';
}

export async function renderStoreSitemapPage(store, scope, page, now = Date.now()) {
  const value = String(page ?? '');
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > MAX_SITEMAP_PAGES) {
    throw new HttpError(400, 'PAGE', '사이트맵 페이지 번호를 확인해 주세요.');
  }
  const offset = (Number(value) - 1) * SITEMAP_PAGE_SIZE;
  const result = await store.publicTransaction('sitemap-page', [scope.namespace + ':directory'], {
    prefix: scope.namespace + ':record:', offset, limit: SITEMAP_PAGE_SIZE, now,
  });
  // Redis Lua cjson encodes an empty table as {}, so accept only that empty object.
  let ids = result?.ids;
  if (ids && !Array.isArray(ids) && typeof ids === 'object' && Object.keys(ids).length === 0) ids = [];
  if (result?.status !== 'ok' || !Array.isArray(ids) || ids.length > SITEMAP_PAGE_SIZE ||
      ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) || new Set(ids).size !== ids.length) throw fail();
  const base = sitemapBase(scope);
  const entries = ids.map(id => `  <url><loc>${base}/stores/${id}</loc></url>`);
  return HEADER + `<urlset xmlns="${NS}">\n` + entries.join('\n') + '\n</urlset>\n';
}
