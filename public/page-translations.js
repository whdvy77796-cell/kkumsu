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
  if (Object.hasOwn(data,'translations') || Object.hasOwn(data,'highlights')) { const {translations,highlights,...base}=data; data=base; }
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

// Automatic summaries are optional: a failed check never discards Korean content.
export const HIGHLIGHT_LANGUAGES = [['en', '영어'], ['zh', '중국어 간체'], ['ja', '일본어']];
export const HIGHLIGHT_STALE = '한국어 내용 또는 이용 정보가 바뀌어 이전 다국어 핵심문구는 제외했어요. 한국어 내용은 그대로 공개할 수 있어요. 자동으로 다시 생성하지 않아요.';
// Deliberately finite native-Korean quantities. Never rewrite saved/displayed copy.
const KOREAN_QUANTITIES=Object.freeze({한:1,하나:1,두:2,둘:2,세:3,셋:3,네:4,넷:4,다섯:5,여섯:6,일곱:7,여덟:8,아홉:9,열:10,스무:20,스물:20});
const QUANTITY_WORDS=Object.keys(KOREAN_QUANTITIES).sort((a,b)=>b.length-a.length).join('|');
const QUANTITY_UNITS='시간|명|인|개|시|분|잔';
const quantityCandidate=new RegExp('(?:'+QUANTITY_WORDS+')\\s*(?:'+QUANTITY_UNITS+')','u');
const vagueQuantity=new RegExp('(?:한두|두세|서너|너덧|네댓|대여섯|예닐곱|몇|여러)\\s*(?:'+QUANTITY_UNITS+')','u');
const quantityEnd='(?=$|[^\\p{L}\\p{N}]|(?:입니다|이에요|예요|이고|이며|이라서|이라|부터|까지|마다|으로|에서|에게|당|만|씩|도|이|가|은|는|을|를|의|에|로|과|와)(?=$|[^\\p{L}\\p{N}]))';
const explicitQuantity=new RegExp('(?<![\\p{L}\\p{N}])([+-]?)('+QUANTITY_WORDS+')\\s*('+QUANTITY_UNITS+')'+quantityEnd,'gu');
/** null means unsupported/ambiguous quantity; callers must omit/reject the entire bundle. */
export function highlightNumbers(value) {
 let v=value.normalize('NFC');
 if(vagueQuantity.test(v))return null;
 if(quantityCandidate.test(v)) {
  // These modifiers need semantic reasoning, which this finite checker does not promise.
  if(/없|않|아니|아닙|아닌|아닐|(?:^|\s)안(?:\s|됨|돼|되)|못|불가|금지|제외|이상|이하|미만|초과|최대|최소|정도|가량|내외|쯤|마이너스|플러스|음수|양수|(?:^|\s)약(?=\s|[한두세네다여일아열스])/u.test(v))return null;
  v=v.replace(explicitQuantity,(_all,sign,word,unit)=>sign+KOREAN_QUANTITIES[word]+unit);
  if(quantityCandidate.test(v))return null; // Unsupported compounds such as 열두 명.
 }
 // A separated sign cannot silently become an unsigned numeric fact.
 if(/[+-]\s+(?=\d)/u.test(v))return null;
 return v.replace(/,/g,'').match(/[+-]?\d+(?:\.\d+)?/g)||[];
}
const highlightLinks = /(?:\b[a-z][a-z\d+.-]*:\/\/|(?:mailto|tel|file|vbscript|blob):|\/\/[\p{L}\p{N}]|(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,63}|한국)(?=$|[^\p{L}\p{N}-]))/iu;
export function validHighlightLines(lines, source) {
  try {
    const base = normalizeTranslationSource(source);
    if (!Array.isArray(lines) || lines.length < 3 || lines.length > 4) return false;
    const excerpts = [base.headline, base.intro, ...base.sections.flatMap(x => [x.heading, x.body])];
    const seen = new Set();
    for (const row of lines) {
      if (!exact(row, ['ko', 'en', 'zh', 'ja'])) return false;
      for (const lang of ['ko', 'en', 'zh', 'ja']) {
        const value = row[lang];
        if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > (lang === 'ko' ? 200 : 400) || /[<>\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2212\ufe62\ufe63\uff0b\uff0d\ufeff]/u.test(value) || highlightLinks.test(value)) return false;
        text(value, 1, lang === 'ko' ? 200 : 400);
      }
      if (/[\p{N}]/u.test(row.ko.replace(/[0-9]/g, '')) || !/[가-힣]/.test(row.ko) || !excerpts.some(x => x.includes(row.ko)) || seen.has(row.ko)) return false;
      seen.add(row.ko);
      if (!/[a-z]/i.test(row.en) || /[가-힣\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(row.en)) return false;
      if (!/\p{Script=Han}/u.test(row.zh) || /[가-힣\p{Script=Hiragana}\p{Script=Katakana}]/u.test(row.zh)) return false;
      if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(row.ja) || /[가-힣]/.test(row.ja)) return false;
      const originalNumbers = highlightNumbers(row.ko);
      if (originalNumbers === null) return false;
      for (const lang of ['en', 'zh', 'ja']) {
        const translatedNumbers = highlightNumbers(row[lang]);
        if (/[\p{N}]/u.test(row[lang].replace(/[0-9]/g, '')) || translatedNumbers === null || JSON.stringify(translatedNumbers) !== JSON.stringify(originalNumbers)) return false;
        // Reject obvious new local facts; these heuristics are not a semantic guarantee.
        for (const [ko, foreign] of [[/주차/, /parking|駐車|停车|停車/i], [/예약/, /reservations?|booking|予約|预订|預訂/i], [/무료|공짜/, /free|無料|免费|免費/i], [/배달|배송/, /delivery|配送|外送/i], [/와이파이|무선|wifi/i, /wi-?fi|无线|無線/i]]) {
          if (foreign.test(row[lang]) && !ko.test(row.ko)) return false;
        }
      }
    }
    return true;
  } catch { return false; }
}
export function syncHighlights(d, source) {
  const fingerprint = translationFingerprint(source);
  if (d.autoHighlights && d.autoHighlights.fingerprint !== fingerprint) d.autoHighlights = { status: 'stale', fingerprint, error: HIGHLIGHT_STALE };
  return fingerprint;
}
export function matchingHighlights(d, source) {
  const t = d.autoHighlights;
  return t?.status === 'ready' && t.fingerprint === translationFingerprint(source) && /^[a-f0-9]{64}$/.test(t.highlights?.sourceHash || '') && validHighlightLines(t.highlights?.lines, source) ? t.highlights : null;
}
export function highlightPreviews(h, highlights) {
  if (!highlights) return null;
  return h('section', { class: 'page-highlights' }, h('h2', null, '다국어 핵심문구 미리보기'),
    h('p', { class: 'card warn' }, 'AI 핵심문구에는 오류나 누락이 있을 수 있어요. 한국어 원문이 우선이에요. 가격·시간·조건을 확인하고 사용해 주세요.'),
    HIGHLIGHT_LANGUAGES.map(([lang, label]) => h('article', { class: 'card', lang: lang === 'zh' ? 'zh-Hans' : lang, 'data-highlight-language': lang }, h('h3', null, label), h('ul', null, highlights.lines.map(row => h('li', null, row[lang]))))));
}
