import { createHash } from 'node:crypto';
import { HttpError } from './guard.mjs';
const bad = () => new HttpError(400, 'FIELDS', '입력 항목과 글자 수를 확인해 주세요.');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact = (v,keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
function text(value,min,max) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw bad();
  const v = value.normalize('NFC').trim();
  if (v.length < min || v.length > max || /<\s*[!/?a-z][^>]*>|(?:https?:|javascript:|data:|www\.)|\]\s*\(/i.test(v)) throw bad();
  return v;
}

export function normalizeSourceData(data) {
  if (!object(data)) throw bad();
  // Derived translations and highlights do not participate in the source digest.
  // Other unknown keys are rejected as before.
  if (Object.hasOwn(data,'translations') || Object.hasOwn(data,'highlights')) {
    const {translations,highlights,...base}=data; data=base;
  }
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

/** SHA-256 of normalized Korean fields in the original public-contract order. */
export function sourceHash(data) {
  return createHash('sha256').update(JSON.stringify(normalizeSourceData(data))).digest('hex');
}
const LINKS=/(?:\b[a-z][a-z\d+.-]*:\/\/|(?:mailto|tel|file|vbscript|blob):|\/\/[\p{L}\p{N}]|(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,63}|한국)(?=$|[^\p{L}\p{N}-]))/iu;
// Numeric facts must stay in the original field and order. Only commas are ignored.
const numbers=v=>v.replace(/,/g,'').match(/[+-]?\d+(?:\.\d+)?/g) || [];
function translatedText(value,original,min,max) {
  const result=text(value,min,max);
  if (/[<>]/.test(result) || LINKS.test(result) || /[\p{N}]/u.test(result.replace(/[0-9]/g,'')) || JSON.stringify(numbers(result))!==JSON.stringify(numbers(original))) throw bad();
  return result;
}
export function normalizeTranslations(translations, sourceData) {
  const base=normalizeSourceData(sourceData);
  if (!exact(translations,['sourceHash','en','ja','zh']) || translations.sourceHash!==sourceHash(base)) throw bad();
  const fields=['name','address','headline','intro','sections','faqs',...(Object.hasOwn(base,'situations')?['situations']:[])];
  const normalized={sourceHash:translations.sourceHash};
  for (const language of ['en','ja','zh']) {
    const input=translations[language];
    if (!exact(input,fields)) throw bad();
    const pairs=(rows,original,a,b,am,bm)=>{
      if (!Array.isArray(rows) || rows.length!==original.length) throw bad();
      return rows.map((row,i)=>{
        if (!exact(row,[a,b])) throw bad();
        return {[a]:translatedText(row[a],original[i][a],1,am),[b]:translatedText(row[b],original[i][b],1,bm)};
      });
    };
    const value={
      name:translatedText(input.name,base.name,1,60),
      address:translatedText(input.address,base.address,1,120),
      headline:translatedText(input.headline,base.headline,1,200),
      intro:translatedText(input.intro,base.intro,1,2000),
      sections:pairs(input.sections,base.sections,'heading','body',200,4000),
      faqs:pairs(input.faqs,base.faqs,'question','answer',300,2000)
    };
    if (Object.hasOwn(base,'situations')) value.situations=pairs(input.situations,base.situations,'question','answer',300,2000);
    normalized[language]=value;
  }
  return normalized;
}
/** Stale or malformed translations never hide the Korean original. */
export function getCurrentTranslations(data) {
  if (!object(data) || !Object.hasOwn(data,'translations')) return null;
  try {
    // Redis cjson serializes [] as {}. Repair exact empty objects only on
    // known array fields at read time; strict incoming writes still reject {}.
    const restore=value=>{
      if (!object(value)) return value;
      const result={...value};
      for (const key of ['sections','faqs','situations']) {
        if (Object.hasOwn(result,key) && exact(result[key],[])) result[key]=[];
      }
      return result;
    };
    const base=restore(data), input=data.translations;
    if (!object(input)) return null;
    const translations={...input};
    for (const language of ['en','ja','zh']) if (Object.hasOwn(input,language)) translations[language]=restore(input[language]);
    return normalizeTranslations(translations,base);
  } catch { return null; }
}
