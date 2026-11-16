import { HttpError } from './guard.mjs';
import { normalizeSourceData, sourceHash } from './store-translations.mjs';
const bad=()=>new HttpError(400,'FIELDS','입력 항목과 글자 수를 확인해 주세요.');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const LINKS=/(?:\b[a-z][a-z\d+.-]*:\/\/|(?:https?|javascript|data|mailto|tel|file|vbscript|blob):|www\.|\/\/[\p{L}\p{N}]|(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,63}|한국)(?=$|[^\p{L}\p{N}-])|\]\s*\()/iu;
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
function text(value,max) {
 if(typeof value!=='string'||value.length>max||/[<>\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2212\ufe62\ufe63\uff0b\uff0d\ufeff]/u.test(value))throw bad();
 const v=value.normalize('NFC').trim();
 if(!v.length||v.length>max||LINKS.test(v)||/[\p{N}]/u.test(v.replace(/[0-9]/g,'')))throw bad();
 return v;
}
/** Basic script/numeric checks are not semantic translation or Simplified Chinese verification. */
export function normalizeHighlightLines(lines,sourceData) {
 const base=normalizeSourceData(sourceData);
 if(!Array.isArray(lines)||lines.length<3||lines.length>4)throw bad();
 const sources=[base.headline,base.intro,...base.sections.flatMap(s=>[s.heading,s.body])],seen=new Set();
 return lines.map(row=>{
  if(!exact(row,['ko','en','zh','ja']))throw bad();
  const value={ko:text(row.ko,200),en:text(row.en,400),zh:text(row.zh,400),ja:text(row.ja,400)};
  if(!/[\p{Script=Hangul}]/u.test(value.ko)||!sources.some(s=>s.includes(value.ko))||seen.has(value.ko))throw bad();
  seen.add(value.ko);
  if(!/[A-Za-z]/.test(value.en)||/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value.en))throw bad();
  if(!/[\p{Script=Han}]/u.test(value.zh)||/[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value.zh))throw bad();
  if(!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value.ja)||/[\p{Script=Hangul}]/u.test(value.ja))throw bad();
  const originalNumbers=highlightNumbers(value.ko);
  if(originalNumbers===null)throw bad();
  for(const lang of ['en','zh','ja']) {
   const translatedNumbers=highlightNumbers(value[lang]);
   if(translatedNumbers===null||JSON.stringify(translatedNumbers)!==JSON.stringify(originalNumbers))throw bad();
  }
  return value;
 });
}
export function normalizeHighlights(highlights,sourceData) {
 const base=normalizeSourceData(sourceData);
 if(!exact(highlights,['sourceHash','lines'])||highlights.sourceHash!==sourceHash(base))throw bad();
 return {sourceHash:highlights.sourceHash,lines:normalizeHighlightLines(highlights.lines,base)};
}
/** Preserve stored bytes but hide stale/malformed derived copy on reads. */
export function getCurrentHighlights(data) {
 if(!object(data)||!Object.hasOwn(data,'highlights'))return null;
 try {
  const base={...data};
  for(const key of ['sections','faqs','situations'])if(Object.hasOwn(base,key)&&exact(base[key],[]))base[key]=[];
  return normalizeHighlights(data.highlights,base);
 }catch{return null;}
}
