/*
 * Standalone server-side place page renderer. No I/O, fetching, routes, payment
 * decisions, publication, analytics, or client-side JavaScript are performed.
 *
 * renderPlacePage(ownerData, policy = {}) returns an HTML string.
 * normalizePlacePage(ownerData, policy = {}) returns a fresh normalized record.
 * Invalid input throws TypeError. Inputs must be plain data objects/arrays.
 *
 * ownerData (all text is owner-provided; limits are UTF-16 code units):
 *   slug: required ASCII letters/digits separated by single hyphens, max 80;
 *   storeName: required text, max 80;
 *   address: max 200; category: max 60; description: max 1200;
 *   hours: max 300; parking: max 300;
 *   menu: up to 40 { name: text max 80, priceKrw: integer 0..100000000,
 *                    verified: true };
 *   reservationLinks: up to 8 { label: text max 80, url: HTTPS URL };
 *   faqs: up to 20 { question: text max 200, answer: text max 1000 };
 *   keywordTopics: up to 15 text values, each max 60;
 *   images: up to 10 { url: HTTPS URL, alt: text max 160,
 *                      ownerApproved: true }.
 * Optional missing, null, blank text, and empty arrays are omitted. Unknown
 * properties, malformed entries and over-limit values are rejected, not fixed.
 * The flags record the submitter's assertions, not independent verification.
 *
 * policy is trusted server configuration, NOT owner-provided content:
 *   { imageHosts: ['images.example.com'],
 *     reservationHosts: ['booking.example.com'] }
 * Both host lists default to empty and contain exact public DNS hostnames only,
 * no wildcards, URLs, ports, IP literals or private/local names. URLs must be
 * HTTPS, credential-free, on their respective exact allowlist, and no longer
 * than 2048 characters. The renderer never resolves DNS or fetches resources.
 * DNS/private-address checks and egress controls are essential if a later
 * integration ever fetches URLs; a trusted hostname can itself resolve locally.
 */

const ORIGIN = 'https://www.kkumsu.com';
const MAX_URL = 2048;
const MAX_HOSTS = 50;
const OWN_FIELDS = [
  'slug', 'storeName', 'address', 'category', 'description', 'hours', 'parking',
  'menu', 'reservationLinks', 'faqs', 'keywordTopics', 'images',
];
const RESERVED_SUFFIXES = [
  'localhost', 'local', 'localdomain', 'internal', 'lan', 'home', 'home.arpa',
  'test', 'invalid', 'example', 'onion', 'corp',
];

function invalid(field, reason) {
  throw new TypeError(`${field}: ${reason}`);
}

// Avoid invoking getters or accepting extra/inherited fields, including
// prototype-pollution keys. JSON-decoded objects and null-prototype records work.
function record(value, field, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(field, 'must be a plain object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(field, 'must be a plain object');
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) invalid(field, 'contains an unknown property');
  const out = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid(field, 'contains an unknown property');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      invalid(`${field}.${key}`, 'must be an enumerable data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function list(value, field, max, mapEntry) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(field, 'must be an array');
  }
  if (value.length > max) invalid(field, `allows at most ${max} items`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    invalid(field, 'must be a dense data array without extra properties');
  }
  const result = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (!entry || !Object.hasOwn(entry, 'value') || !entry.enumerable) {
      invalid(`${field}[${i}]`, 'must be a data item');
    }
    result.push(mapEntry(entry.value, `${field}[${i}]`));
  }
  return result;
}

function text(value, field, max, required = false) {
  if (value === undefined || value === null) {
    if (required) invalid(field, 'is required');
    return undefined;
  }
  if (typeof value !== 'string') invalid(field, 'must be text');
  // A raw bound avoids processing an arbitrarily large whitespace-only string.
  if (value.length > max * 4 + 256) invalid(field, `exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
      || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) {
    invalid(field, 'contains invalid control or Unicode characters');
  }
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    if (required) invalid(field, 'must not be blank');
    return undefined;
  }
  if (normalized.length > max) invalid(field, `exceeds ${max} characters`);
  return normalized;
}

function slug(value) {
  const s = text(value, 'slug', 80, true).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) {
    invalid('slug', 'must contain ASCII letters/digits separated by single hyphens');
  }
  return s;
}

function publicHost(value, field) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 253
      || value !== value.trim() || /[\s\\/@:#?%\[\]]/.test(value)) {
    invalid(field, 'must be an exact public DNS hostname');
  }
  let parsed;
  try { parsed = new URL(`https://${value}/`); } catch { invalid(field, 'must be an exact public DNS hostname'); }
  const host = parsed.hostname.toLowerCase();
  if (!host || host.endsWith('.') || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) {
    invalid(field, 'must be an exact public DNS hostname');
  }
  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(tld)
      || RESERVED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    invalid(field, 'must be an exact public DNS hostname');
  }
  return host;
}

function hostSet(value, field) {
  return new Set(list(value, field, MAX_HOSTS, (host, item) => publicHost(host, item)));
}

function externalUrl(value, field, allowedHosts) {
  if (typeof value !== 'string' || value.length > MAX_URL || value !== value.trim()
      || !/^https:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(value)) {
    invalid(field, 'must be a valid HTTPS URL');
  }
  let url;
  try { url = new URL(value); } catch { invalid(field, 'must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.href.length > MAX_URL) {
    invalid(field, 'must be a credential-free HTTPS URL on the default port');
  }
  const host = publicHost(url.hostname, field);
  if (!allowedHosts.has(host)) invalid(field, 'hostname is not on the trusted allowlist');
  return url.href;
}

function optionalField(out, key, value) {
  if (value !== undefined) out[key] = value;
}

/** Validate and normalize owner data without changing it, performing I/O, or publishing. */
export function normalizePlacePage(ownerData, policy = {}) {
  const source = record(ownerData, 'ownerData', OWN_FIELDS);
  const config = record(policy, 'policy', ['imageHosts', 'reservationHosts']);
  const imageHosts = hostSet(config.imageHosts, 'policy.imageHosts');
  const reservationHosts = hostSet(config.reservationHosts, 'policy.reservationHosts');
  const out = {
    slug: slug(source.slug),
    storeName: text(source.storeName, 'storeName', 80, true),
  };
  for (const [key, max] of [
    ['address', 200], ['category', 60], ['description', 1200],
    ['hours', 300], ['parking', 300],
  ]) optionalField(out, key, text(source[key], key, max));

  const menu = list(source.menu, 'menu', 40, (value, field) => {
    const item = record(value, field, ['name', 'priceKrw', 'verified']);
    if (item.verified !== true) invalid(`${field}.verified`, 'must be explicitly true');
    if (!Number.isSafeInteger(item.priceKrw) || item.priceKrw < 0 || item.priceKrw > 100000000) {
      invalid(`${field}.priceKrw`, 'must be a whole KRW amount between 0 and 100000000');
    }
    return { name: text(item.name, `${field}.name`, 80, true), priceKrw: item.priceKrw, verified: true };
  });
  if (menu.length) out.menu = menu;
  const links = list(source.reservationLinks, 'reservationLinks', 8, (value, field) => {
    const item = record(value, field, ['label', 'url']);
    return {
      label: text(item.label, `${field}.label`, 80, true),
      url: externalUrl(item.url, `${field}.url`, reservationHosts),
    };
  });
  if (links.length) out.reservationLinks = links;
  const faqs = list(source.faqs, 'faqs', 20, (value, field) => {
    const item = record(value, field, ['question', 'answer']);
    return {
      question: text(item.question, `${field}.question`, 200, true),
      answer: text(item.answer, `${field}.answer`, 1000, true),
    };
  });
  if (faqs.length) out.faqs = faqs;
  const topics = list(source.keywordTopics, 'keywordTopics', 15,
    (value, field) => text(value, field, 60, true));
  if (topics.length) out.keywordTopics = topics;
  const images = list(source.images, 'images', 10, (value, field) => {
    const item = record(value, field, ['url', 'alt', 'ownerApproved']);
    if (item.ownerApproved !== true) invalid(`${field}.ownerApproved`, 'must be explicitly true');
    return {
      url: externalUrl(item.url, `${field}.url`, imageHosts),
      alt: text(item.alt, `${field}.alt`, 160, true),
      ownerApproved: true,
    };
  });
  if (images.length) out.images = images;
  return out;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

// HTML parsers treat </script as an end tag even in a JSON string. Escaping
// these code points produces valid JSON without creating a script end tag.
function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026',
    '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[character]);
}

function priceKrw(amount) {
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

/** Return a complete crawlable Korean HTML document; caller controls delivery. */
export function renderPlacePage(ownerData, policy = {}) {
  const data = normalizePlacePage(ownerData, policy);
  const canonical = `${ORIGIN}/places/${data.slug}`;
  const metaTitle = [data.storeName, data.category].filter(Boolean).join(' | ');
  const metaDescription = Array.from(
    [data.storeName, data.category, data.address, data.description].filter(Boolean).join(' · '),
  ).slice(0, 160).join('');
  // Only facts also present as visible body text are placed in structured data.
  const schema = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: data.storeName };
  if (data.address) schema.address = data.address;
  if (data.description) schema.description = data.description;
  const info = [
    ['업종', data.category], ['주소', data.address], ['영업시간', data.hours], ['주차', data.parking],
  ].filter(([, value]) => value).map(([label, value]) =>
    `<div class="info-row"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('\n');
  const description = data.description
    ? `<section aria-labelledby="about"><h2 id="about">소개</h2><p>${escapeHtml(data.description)}</p></section>` : '';
  const infoSection = info ? `<section aria-labelledby="info"><h2 id="info">매장 정보</h2><dl>${info}</dl></section>` : '';
  const menu = data.menu ? `<section aria-labelledby="menu"><h2 id="menu">메뉴</h2><ul class="menu-list">${data.menu.map((item) =>
    `<li><span>${escapeHtml(item.name)}</span><span>${priceKrw(item.priceKrw)}</span></li>`).join('')}</ul></section>` : '';
  const reservations = data.reservationLinks ? `<section aria-labelledby="reservation"><h2 id="reservation">예약</h2><ul>${data.reservationLinks.map((item) =>
    `<li><a href="${escapeHtml(item.url)}" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">${escapeHtml(item.label)}</a></li>`).join('')}</ul></section>` : '';
  const faq = data.faqs ? `<section aria-labelledby="faq"><h2 id="faq">자주 묻는 질문</h2><dl class="faq-list">${data.faqs.map((item) =>
    `<div><dt>${escapeHtml(item.question)}</dt><dd>${escapeHtml(item.answer)}</dd></div>`).join('')}</dl></section>` : '';
  const topics = data.keywordTopics ? `<section aria-labelledby="topics"><h2 id="topics">관련 주제</h2><ul class="topics">${data.keywordTopics.map((item) =>
    `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : '';
  const images = data.images ? `<section aria-labelledby="photos"><h2 id="photos">사진</h2><div class="gallery">${data.images.map((item) =>
    `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`).join('')}</div></section>` : '';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index,follow">
<title>${escapeHtml(metaTitle)}</title>
<meta name="description" content="${escapeHtml(metaDescription)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<script type="application/ld+json">${safeJson(schema)}</script>
<style>
:root{color-scheme:light;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif;color:#17212b;background:#f5f7f8;line-height:1.65}*{box-sizing:border-box}body{margin:0}a{color:#075ea8;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #a04400;outline-offset:3px}.skip{position:absolute;left:1rem;top:-5rem;background:#fff;padding:.5rem;z-index:1}.skip:focus{top:1rem}main{width:min(100% - 2rem,54rem);margin:auto;padding:2rem 0 4rem}header,section{background:#fff;border:1px solid #dce2e7;border-radius:12px;padding:1.25rem;margin-bottom:1rem}h1,h2{line-height:1.3;overflow-wrap:anywhere}h1{font-size:clamp(1.6rem,5vw,2.4rem);margin:.1rem 0}h2{font-size:1.2rem;margin:0 0 .8rem}p,dd,dt,li{overflow-wrap:anywhere}p{margin:.4rem 0}dl{margin:0}.info-row{display:grid;grid-template-columns:6rem minmax(0,1fr);gap:.5rem;padding:.3rem 0}dt{font-weight:700}dd{margin:0}.menu-list,.topics{list-style:none;padding:0;margin:0}.menu-list li{display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;border-bottom:1px solid #e4e8eb}.menu-list li span:last-child{white-space:nowrap}.faq-list>div{margin:.8rem 0}.faq-list dd{margin-top:.25rem}.topics{display:flex;flex-wrap:wrap;gap:.5rem}.topics li{background:#eef3f7;border-radius:.4rem;padding:.2rem .55rem}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:.75rem}.gallery img{display:block;width:100%;height:auto;max-height:32rem;object-fit:contain}@media(max-width:360px){main{width:calc(100% - 1rem);padding-top:.5rem}header,section{padding:1rem}.info-row{grid-template-columns:1fr;gap:0}}
</style>
</head>
<body>
<a class="skip" href="#main">본문 바로가기</a>
<main id="main">
<header><h1>${escapeHtml(data.storeName)}</h1></header>
${description}
${infoSection}
${menu}
${reservations}
${faq}
${topics}
${images}
</main>
</body>
</html>`;
}
