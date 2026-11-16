// Private, explicitly requested translations. Never infer review from AI success.
export const TRANSLATION_LANGUAGES = [['en', '영어'], ['ja', '일본어'], ['zh', '중국어']];
// Keep canonical source rules in parity with lib/store-translations.mjs.
const bad = () => new Error('번역 원문을 표준화하지 못했어요.');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact = (v,keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
function text(value,min,max) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw bad();
  const v = value.normalize('NFC').trim();
  if (v.length < min || v.length > max || /<\s*[!/?a-z][^>]*>|(?:https?:|javascript:|data:|www\.)|\]\s*\(/i.test(v)) throw bad();
  return v;
}

export function normalizeTranslationSource(data) {
  if (!object(data)) throw bad();
  // Translations never participate in the source digest; other unknown keys are rejected.
  if (Object.hasOwn(data,'translations')) { const {translations,...base}=data; data=base; }
  const fields=['name','address','headline','intro','sections','faqs'];
  if (!exact(data,fields) && !exact(data,[...fields,'situations'])) throw bad();
  const pairs = (rows,a,b,am,bm,max=8) => {
    if (!Array.isArray(rows) || rows.length > max) throw bad();
    return rows.map(row => {
      if (!exact(row,[a,b])) throw bad();
      const x=text(row[a],0,am),y=text(row[b],0,bm);
      if (!!x !== !!y) throw bad();
      return x ? {[a]:x,[b]:y} : null;
    }).filter(Boolean);
  };
  const normalized={name:text(data.name,1,60),address:text(data.address,4,120),headline:text(data.headline,1,200),intro:text(data.intro,1,2000),sections:pairs(data.sections,'heading','body',200,4000),faqs:pairs(data.faqs,'question','answer',300,2000,12)};
  // Absence is part of the original public contract and create-retry identity.
  if (Object.hasOwn(data,'situations')) {
    normalized.situations=pairs(data.situations,'question','answer',300,2000);
    // Keep legacy field validation unchanged; the new public pairs are plain
    // text, not a place for schemes, protocol-relative links or bare domains.
    const url=/(?:\b[a-z][a-z\d+.-]*:\/\/|(?:mailto|tel|file|vbscript|blob):|\/\/[\p{L}\p{N}]|(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,63}|한국)(?=$|[^\p{L}\p{N}-]))/iu;
    if (normalized.situations.some(s=>url.test(s.question) || url.test(s.answer))) throw bad();
  }
  return normalized;
}

export async function translationSourceHash(source, cryptoProvider = globalThis.crypto) {
  if (typeof cryptoProvider?.subtle?.digest !== 'function' || typeof TextEncoder !== 'function') {
    throw Object.assign(new Error('이 브라우저에서는 안전한 번역 원문 검증을 지원하지 않아요. 번역은 사용할 수 없으며 한국어 초안은 보존했어요.'), { code: 'TRANSLATION_CRYPTO_UNAVAILABLE' });
  }
  const bytes = new TextEncoder().encode(JSON.stringify(normalizeTranslationSource(source)));
  try {
    const digest = await cryptoProvider.subtle.digest('SHA-256', bytes);
    if (digest.byteLength !== 32) throw new Error('Invalid digest');
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw Object.assign(new Error('브라우저의 안전한 번역 원문 검증에 실패했어요. 번역은 사용할 수 없으며 한국어 초안은 보존했어요.'), { code: 'TRANSLATION_CRYPTO_UNAVAILABLE' });
  }
}

export function translationFingerprint(source) { return JSON.stringify(source); }
export function syncTranslations(d, source) {
  const fingerprint = translationFingerprint(source);
  if (d.translation && d.translation.fingerprint !== fingerprint) {
    d.translation = { status: 'stale', fingerprint, error: '한국어 내용 또는 이용 정보가 변경되어 이전 번역을 무효 처리했어요. 새 내용으로 다시 생성하거나 한국어로만 공개해 주세요.' };
  }
  return fingerprint;
}
export function matchingTranslations(d, source) {
  const t = d.translation;
  return t?.status === 'ready' && t.fingerprint === translationFingerprint(source) && t.requestFingerprint === t.fingerprint ? t.translations : null;
}
export function validTranslations(value, source) {
  if (!value || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)) return false;
  try { source = normalizeTranslationSource(source); } catch { return false; }
  const pairs = (list, keys, max) => Array.isArray(list) && list.length <= max && list.every(x => x && keys.every(k => typeof x[k] === 'string' && x[k].trim()));
  return TRANSLATION_LANGUAGES.every(([lang]) => {
    const x = value[lang];
    return x && ['name', 'address', 'headline', 'intro'].every(k => typeof x[k] === 'string' && x[k].trim()) &&
      pairs(x.sections, ['heading', 'body'], 8) && x.sections.length === source.sections.length &&
      pairs(x.faqs, ['question', 'answer'], 12) && x.faqs.length === source.faqs.length &&
      (x.situations === undefined || (pairs(x.situations, ['question', 'answer'], 8) && x.situations.length === (source.situations || []).length));
  });
}
export function translationPreviews(h, translations) {
  if (!translations) return null;
  return h('section', { class: 'page-translations' },
    h('h2', null, '다국어 비공개 미리보기'),
    h('p', { class: 'card warn' }, 'AI 번역에는 오류나 누락이 있을 수 있어요. 한국어 원문이 우선이며 가게명·주소·가격·시간·조건과 모든 번역을 직접 검토해 주세요.'),
    TRANSLATION_LANGUAGES.map(([lang, label]) => {
      const x = translations[lang];
      return h('article', { class: 'card page-translation', lang, 'data-translation-language': lang },
        h('h3', null, label), h('p', null, x.name, ' · ', x.address), h('h4', null, x.headline), h('p', null, x.intro),
        x.sections.map(s => h('section', null, h('h4', null, s.heading), h('p', { style: 'white-space: pre-line' }, s.body))),
        [...x.faqs, ...(x.situations || [])].map(s => h('section', null, h('h4', null, s.question), h('p', null, s.answer))));
    }));
}
