import {randomUUID,timingSafeEqual} from 'node:crypto';
import {AppError,fail,hmac,seal,unseal} from './core.mjs';
import {PaymentStore,SAVE_RESULT,CREATE_ORDER,REPLACE_ORDER,CHECK_CONFIRM,BEGIN_CONFIRM,RECORD_PAYMENT,RELEASE_CONFIRM,DELETE_RESULT,RECONCILE_CLAIM,RECONCILE_RETRY,RECONCILE_HEARTBEAT} from './payment-store.mjs';
export const OFFER=Object.freeze({version:'v3-preview-3000',amount:3000,currency:'KRW',freePreviewLimit:1});
export const REVISION_OFFER=Object.freeze({version:'v4-revision-3000',amount:3000,currency:'KRW',freePreviewLimit:1});
const REVISION_LABELS={fit:'문항 적합성',logic:'논리와 본인 역할',evidence:'원문 근거·수치',wording:'문장 표현',spelling:'맞춤법·띄어쓰기',length:'분량'};
export const REVISION_PRIVACY=Object.freeze({autoDeleteOnDelivery:true,unpaidMaxMinutes:60,paymentPendingMaxHours:24,undeliveredPaidMaxHours:24,externalAI:'외부 AI 업체의 보관·보안·법적 예외 정책은 별도 적용됩니다.',deliveryNotice:'전문 수신 후 서비스 DB 임시 콘텐츠 삭제를 요청하고 성공 여부를 표시합니다. 현재 화면을 닫거나 새로고침하면 복구할 수 없습니다.'});
const DAY=86400000, HEARTBEAT_MAX_AGE=25*60000, ORDER_NAME='인소서 자기소개서 전문 1건', ACCESS_COOKIE='insosoe_result_access';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function appendSetCookie(res,cookie){const prior=res.getHeader?.('Set-Cookie');res.setHeader('Set-Cookie',[...(Array.isArray(prior)?prior:prior?[prior]:[]),cookie]);}
export function readAccessCookie(req){return String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(ACCESS_COOKIE+'='))?.slice(ACCESS_COOKIE.length+1);}
function validId(id){if(typeof id!=='string'||!UUID.test(id))fail('RESULT_ID','결과 ID를 확인해주세요.');return id.toLowerCase();}
function keyInput(key){if(typeof key!=='string'||key.length<1||key.length>200||/[\x00-\x20\x7f]/.test(key))fail('PAYMENT_INPUT','결제 확인 정보가 올바르지 않습니다.');return key;}
export function addCalendarYears(timestamp,years=5){const d=new Date(timestamp),month=d.getUTCMonth();d.setUTCFullYear(d.getUTCFullYear()+years);if(d.getUTCMonth()!==month)d.setUTCDate(0);return d.getTime();}
function originOf(value){try{const u=new URL(value);if(u.username||u.password||u.search||u.hash||u.pathname!=='/')return null;if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))return null;return u.origin;}catch{return null;}}
export function paymentSettings(c){const e=c.env||{},mode=['test','live'].includes(e.PAYMENT_MODE)?e.PAYMENT_MODE:'disabled';const origin=originOf(c.origin||e.APP_ORIGIN);
 // Vercel Preview runs a production Node build, but is the only explicitly allowed deployed sandbox.
 const preview=e.VERCEL_ENV==='preview';
 const deployed=!!(c.vercel||e.VERCEL||e.VERCEL_ENV||e.VERCEL_URL||e.VERCEL_DEPLOYMENT_ID);
 const production=e.VERCEL_ENV==='production'||(!preview&&e.NODE_ENV==='production');
 const testEnvironmentAllowed=preview||(!deployed&&e.NODE_ENV!=='production');
 const publicMap={businessName:'BUSINESS_NAME',representative:'BUSINESS_REPRESENTATIVE',registrationNumber:'BUSINESS_REGISTRATION_NUMBER',ecommerceRegistration:'BUSINESS_ECOMMERCE_REGISTRATION',address:'BUSINESS_ADDRESS',email:'BUSINESS_CONTACT_EMAIL',phone:'BUSINESS_CONTACT_PHONE',refundPolicy:'PAYMENT_REFUND_POLICY',deliveryTerms:'PAYMENT_DELIVERY_TERMS',financialRetention:'PAYMENT_FINANCIAL_RETENTION_POLICY',termsUrl:'TERMS_URL',privacyUrl:'PRIVACY_URL'};
 const legal={};for(const [k,v] of Object.entries(publicMap)){if(typeof e[v]==='string'&&e[v].trim()&&e[v].length<=4000)legal[k]=e[v].trim();}
 const legalReady=Object.keys(publicMap).every(k=>!!legal[k])&&['termsUrl','privacyUrl'].every(k=>{try{const u=new URL(legal[k],origin);return u.origin===origin&&u.protocol==='https:';}catch{return false;}})&&e.PAYMENT_LEGAL_VERIFIED==='true';
 const clientKey=e.TOSS_CLIENT_KEY||'',secretKey=e.TOSS_SECRET_KEY||'',mid=e.TOSS_MERCHANT_ID||'';
 const prefix=mode==='live'?'live':'test',keysConfigured=new RegExp('^'+prefix+'_ck_[A-Za-z0-9]+$').test(clientKey)&&new RegExp('^'+prefix+'_sk_[A-Za-z0-9]+$').test(secretKey);
 const dedicatedSecret=typeof e.SESSION_SECRET==='string'&&e.SESSION_SECRET.length>=32&&c.secret===e.SESSION_SECRET&&![e.OPENROUTER_API_KEY,e.ANTHROPIC_API_KEY,e.AI_GATEWAY_API_KEY,secretKey].filter(Boolean).includes(e.SESSION_SECRET);const reconciliationConfigured=e.PAYMENT_RECONCILIATION_READY==='true'&&typeof e.CRON_SECRET==='string'&&e.CRON_SECRET.length>=32;const supportReady=e.PAYMENT_SUPPORT_READY==='true';const merchantVerified=e.TOSS_MERCHANT_VERIFIED==='true';const configured=!!(origin&&mid&&keysConfigured&&c.secret?.length>=24&&c.redisURL&&c.redisToken);
 const ready=mode!=='disabled'&&e.PAYMENT_READY==='true'&&configured&&(mode!=='test'||testEnvironmentAllowed)&&(mode!=='live'||merchantVerified&&legalReady&&dedicatedSecret&&reconciliationConfigured&&supportReady&&origin.startsWith('https://'));
 return {mode,origin,production,testEnvironmentAllowed,clientKey,secretKey,mid,ready,legal,config:{keysConfigured,originConfigured:!!origin,merchantVerified,legalReady,production,preview,testEnvironmentAllowed,dedicatedSecret,reconciliationConfigured,supportReady}};
}
function previewSections(sections,revision=false,opening=false){return sections.map((s,i)=>{const chars=Array.from(s.text),budget=Math.floor(chars.length*.25),piece=Math.floor(budget/3),segments=[];let previous=0;if(opening){let end=budget;if(end>0&&end<chars.length&&!/\s/u.test(chars[end])&&!/\s/u.test(chars[end-1])){let boundary=end;while(boundary>0&&!/\s/u.test(chars[boundary-1]))boundary--;if(boundary>=Math.max(1,Math.floor(budget/2)))end=boundary;}const visible=chars.slice(0,end).join('').trimEnd();if(visible)segments.push({kind:'visible',text:visible});if(end<chars.length)segments.push({kind:'locked',lines:Math.max(1,Math.min(8,Math.ceil((chars.length-end)/45)))});}else{const starts=[0,Math.floor(chars.length*.43),Math.floor(chars.length*.78)];for(const start of starts){if(start>previous)segments.push({kind:'locked',lines:Math.max(1,Math.min(8,Math.ceil((start-previous)/45)))});if(piece)segments.push({kind:'visible',text:chars.slice(start,start+piece).join('')});previous=start+piece;}if(previous<chars.length)segments.push({kind:'locked',lines:Math.max(1,Math.min(8,Math.ceil((chars.length-previous)/45)))});}const metadataValid=typeof s.id==='string'&&s.id.length<=100&&typeof s.heading==='string'&&(revision?Array.from(s.heading).length<=800:s.heading.length<=500)&&Number.isInteger(s.charLimit)&&s.charLimit>=100&&s.charLimit<=(revision?6000:2000);return {id:metadataValid?s.id:'section-'+(i+1),heading:metadataValid?s.heading:'문항 '+(i+1),...(metadataValid?{charLimit:s.charLimit}:{}),charCount:chars.length,segments};});}
// Mark changed characters against the full verified before/after pair BEFORE
// cropping. Comparing two independently cropped windows can falsely mark a
// shared word as edited. Ranges contain offsets only, never additional text.
function clippedChangeMarks(a,b,fromA,toA,fromB,toB){
 if(a.length*b.length>50000)return null;
 const width=b.length+1,dp=new Uint16Array((a.length+1)*width),sameA=new Uint8Array(a.length),sameB=new Uint8Array(b.length);
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i*width+j]=a[i]===b[j]?dp[(i+1)*width+j+1]+1:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
 let i=0,j=0;while(i<a.length&&j<b.length){if(a[i]===b[j]){sameA[i++]=1;sameB[j++]=1;}else if(dp[(i+1)*width+j]>dp[i*width+j+1])i++;else j++;}
 const ranges=(same,start,end)=>{const out=[];let open=-1;for(let k=start;k<end;k++){if(!same[k]&&open<0)open=k-start;if(same[k]&&open>=0){out.push([open,k-start]);open=-1;}}if(open>=0)out.push([open,end-start]);return out;};
 return {before:ranges(sameA,fromA,toA),after:ranges(sameB,fromB,toB)};
}
// Free deep-analysis teaser: at most one improvement, priority+bounded problem only (no quote/suggestion), never overlapping revised text or any source quote.
function analysisPreview(data){
 const a=data?.revision?.deepAnalysis,t=data?.revision?.publicTeaser,body=data?.sections?.[0]?.text;
 if(!a||!Array.isArray(a.improvements)||!t||!['high','medium','low'].includes(t.priority)||typeof t.problem!=='string'||!t.problem.trim()||Array.from(t.problem).length>101||/[0-9０-９]|\bO{3,}\b|[○□]{2,}/u.test(t.problem)||typeof body!=='string')return undefined;
 // The teaser must be the stored prefix of a real issue, not an injected field.
 if(!a.improvements.some(x=>x?.priority===t.priority&&typeof x.problem==='string'&&(x.problem.trim()===t.problem||Array.from(x.problem.trim()).slice(0,100).join('').trimEnd()+'…'===t.problem)))return undefined;
 const grams=new Set(),add=x=>{const c=Array.from(typeof x==='string'?x.normalize('NFKC').replace(/\s+/gu,''):'');for(let i=0;i+8<=c.length;i++)grams.add(c.slice(i,i+8).join(''));};
 add(body);for(const k of ['strengths','improvements','questions'])for(const x of Array.isArray(a[k])?a[k]:[])add(x?.quote);for(const x of data?.revision?.changes||[]){add(x?.before);add(x?.after);}for(const x of data?.sources||[])add(x?.quote);
 const c=Array.from(t.problem.normalize('NFKC').replace(/\s+/gu,''));for(let i=0;i+8<=c.length;i++)if(grams.has(c.slice(i,i+8).join('')))return undefined;
 return {priority:t.priority,problem:t.problem};
}

// Simple-essay previews expose a fixed, bounded set of verified excerpts, never hidden text or model-authored rationale.
// Older preview schemes must remain unchanged for existing unpaid or pending results.
function simpleRevisionPreview(data){
 const s=data.sections?.[0]||{},v=data.revision||{},value=typeof s.text==='string'?s.text:'',chars=Array.from(value),budget=Math.floor(chars.length*.25);
 const metadata={id:typeof s.id==='string'&&s.id.length<=100?s.id:'p1',heading:typeof s.heading==='string'&&Array.from(s.heading).length<=800&&s.heading.trim()?s.heading:'다듬은 자기소개서',charCount:chars.length,...(Number.isInteger(s.charLimit)&&s.charLimit>=100&&s.charLimit<=6000?{charLimit:s.charLimit}:{})};
 const changes=Array.isArray(v.changes)?v.changes:[];
 const candidate=changes.find(c=>typeof c?.before==='string'&&c.before.trim()&&typeof c?.after==='string'&&c.after.trim()&&c.before!==c.after&&value.includes(c.after));
 let example,exampleMarks,exampleClipped,hadOriginalExample=false,originalExampleCost=0;
 if(candidate&&budget>=2){
  const a=Array.from(candidate.before),b=Array.from(candidate.after);let difference=0;while(difference<a.length&&difference<b.length&&a[difference]===b[difference])difference++;
  const beforeBudget=Math.min(100,Math.floor(budget/2)),afterBudget=Math.min(100,budget-beforeBudget);
  const snippet=(chars,cap,trim=false)=>{let start=Math.max(0,Math.min(Math.max(0,difference-Math.floor(cap/2)),Math.max(0,chars.length-cap))),end=Math.min(chars.length,start+cap);if(trim&&v.deepAnalysis){const boundary=c=>!c||/[\s.,!?;:(){}\[\]“”"'…]/u.test(c);if(start>0&&!boundary(chars[start-1])&&!boundary(chars[start])){while(start<end&&!boundary(chars[start]))start++;while(start<end&&/\s/u.test(chars[start]))start++;}if(end<chars.length&&!boundary(chars[end-1])&&!boundary(chars[end])){while(end>start&&!boundary(chars[end-1]))end--;while(end>start&&/\s/u.test(chars[end-1]))end--;}}return {text:chars.slice(start,end).join(''),start,end,clipped:start>0||end<chars.length};};
  const originalBefore=snippet(a,beforeBudget),originalAfter=snippet(b,afterBudget);hadOriginalExample=!!(originalBefore.text&&originalAfter.text);if(hadOriginalExample)originalExampleCost=Array.from(originalBefore.text).length+Array.from(originalAfter.text).length;
  const before=v.deepAnalysis?snippet(a,beforeBudget,true):originalBefore,after=v.deepAnalysis?snippet(b,afterBudget,true):originalAfter;
  if(before.text&&after.text&&(!v.deepAnalysis||before.text!==after.text)){example={before:before.text,after:after.text};exampleMarks=clippedChangeMarks(a,b,before.start,before.end,after.start,after.end);exampleClipped={before:before.clipped,after:after.clipped};}
 }
 // Preserve the original first pair for previously delivered previews. Additional
 // pairs share the same 25% budget, counting both original and edited excerpts.
 // Selection is deterministic, so repeated retrieval cannot reveal new slices.
 const validCategory=category=>Object.hasOwn(REVISION_LABELS,category)&&(category!=='fit'||v.promptProvided===true)&&(category!=='length'||v.limitProvided===true);
 const exampleCategory=validCategory(candidate?.category)?candidate.category:undefined;
 let remaining=budget-(example?(v.deepAnalysis&&hadOriginalExample?originalExampleCost:Array.from(example.before).length+Array.from(example.after).length):0);
 const additionalExamples=[];
 if(example&&remaining>=16){
  const pairs=changes.filter(c=>c!==candidate&&validCategory(c?.category)&&typeof c.before==='string'&&c.before.trim()&&typeof c.after==='string'&&c.after.trim()&&c.before!==c.after&&value.includes(c.after));
  const seen=new Set([JSON.stringify([candidate.before,candidate.after])]);
  const boundary=c=>!c||/[\s.,!?;:(){}\[\]“”"'…]/u.test(c);
  const crop=(arr,limit,start)=>{
   let at=Math.max(0,Math.min(Math.max(0,start-Math.floor(limit/3)),Math.max(0,arr.length-limit))),end=Math.min(arr.length,at+limit);
   // Trim only inward from the old window: no new content is exposed on redeploy.
   // Keep the first changed character and at least eight code points where possible.
   if(at>0&&!boundary(arr[at-1])&&!boundary(arr[at])){let next=at;while(next<end&&!boundary(arr[next]))next++;while(next<end&&/\s/u.test(arr[next]))next++;if(next<=start&&end-next>=8)at=next;}
   if(end<arr.length&&!boundary(arr[end-1])&&!boundary(arr[end])){let previous=end;while(previous>at&&!boundary(arr[previous-1]))previous--;while(previous>at&&/\s/u.test(arr[previous-1]))previous--;if(previous>start&&previous-at>=8)end=previous;}
   return {text:arr.slice(at,end).join(''),start:at,end,truncated:at>0||end<arr.length};
  };
  for(let i=0;i<pairs.length&&additionalExamples.length<2&&remaining>=16;i++){
   const c=pairs[i],signature=JSON.stringify([c.before,c.after]);if(seen.has(signature))continue;seen.add(signature);
   const a=Array.from(c.before),b=Array.from(c.after);let difference=0;while(difference<a.length&&difference<b.length&&a[difference]===b[difference])difference++;
   const slots=Math.min(2-additionalExamples.length,pairs.length-i),pairBudget=Math.min(120,slots>1?Math.floor(remaining/slots):remaining),beforeBudget=Math.floor(pairBudget/2),afterBudget=pairBudget-beforeBudget;
   if(beforeBudget<8||afterBudget<8)continue;
   const before=crop(a,beforeBudget,difference),after=crop(b,afterBudget,difference),used=Array.from(before.text).length+Array.from(after.text).length;
   if(!before.text.trim()||!after.text.trim()||before.text===after.text||used>remaining)continue;
   const marks=clippedChangeMarks(a,b,before.start,before.end,after.start,after.end);
   additionalExamples.push({category:c.category,before:before.text,after:after.text,beforeTruncated:before.truncated,afterTruncated:after.truncated,...(marks?{marks}:{})});remaining-=used;
  }
 }
 const lockOnly=!example&&!!v.deepAnalysis&&hadOriginalExample;
 const sections=example||lockOnly?[{...metadata,segments:[{kind:'locked',lines:Math.max(1,Math.min(8,Math.ceil((chars.length-(example?Array.from(example.after).length:0))/45)))}]}]:previewSections([s],true,true).map(section=>({...section,...metadata}));
 const descriptions={fit:'지원 문항과 연결되는 표현을 살펴봤어요.',logic:'경험과 본인의 행동이 자연스럽게 이어지도록 살펴봤어요.',evidence:'원문에 있는 근거와 표현을 중심으로 살펴봤어요.',wording:'문장의 뜻이 더 분명하게 전달되도록 살펴봤어요.',spelling:'맞춤법과 띄어쓰기를 살펴봤어요.',length:'입력한 분량 기준에 맞는지 살펴봤어요.'};
 const categories=[...new Set([...changes,...(Array.isArray(v.diagnosis)?v.diagnosis:[])].map(x=>x?.category).filter(k=>Object.hasOwn(descriptions,k)&&(k!=='fit'||v.promptProvided===true)&&(k!=='length'||v.limitProvided===true)))].slice(0,3);
 const highlights=categories.map(category=>({category,label:REVISION_LABELS[category],text:descriptions[category]}));
 const analysis=analysisPreview(data);return {sections,previewDetails:{highlights,...(analysis?{analysisPreview:analysis}:{}),...(example?{example,...(exampleCategory?{exampleCategory}:{}),...(exampleMarks?{exampleMarks}:{}),...(exampleClipped?{exampleClipped}:{}),...(additionalExamples.length?{additionalExamples}:{})}:{}),note:example?'원문과 수정본에서 발췌한 일부예요.':lockOnly?'공개 한도 안에서 온전한 수정 전후 발췌를 만들지 못했어요.':'보여줄 수 있는 수정 전후 발췌가 없어 수정본의 일부를 표시합니다.'}};
}
export class PaymentService {
 constructor(c,store,deps={}){this.c=c;this.p=paymentSettings(c);this.db=new PaymentStore(store,this.p.mode);this.fetcher=deps.fetcher||fetch;this.now=deps.now||Date.now;this.uuid=deps.uuid||randomUUID;}
 getStatus(){const {mode,legal,config}=this.p,h=this.workerHeartbeat;const workerRecent=!!h&&Number.isFinite(h.lastSuccessAt)&&this.now()-h.lastSuccessAt>=0&&this.now()-h.lastSuccessAt<=HEARTBEAT_MAX_AGE&&h.failed===0&&h.supportRequired===0;const ready=this.p.ready&&(mode!=='live'||workerRecent);const paymentLegal={...legal,businessNumber:legal.registrationNumber,commerceNumber:legal.ecommerceRegistration,supportEmail:legal.email};const reconciliation={configured:config.reconciliationConfigured,recent:workerRecent,lastSuccessAt:h?.lastSuccessAt??null,pending:h?.pending??null,failed:h?.failed??null,supportRequired:h?.supportRequired??null};return {ready,paymentReady:ready,mode,paymentMode:mode,offer:{...OFFER},legal:{...legal},paymentLegal,paymentDisabledReason:ready?'':'결제 설정·사업자·지원 체계·정산 확인 작업이 준비되지 않았습니다.',config:{...config},reconciliation};}
 async refreshReadiness(){this.requireStorage();const [heartbeat,failures,support]=await Promise.all([this.db.get('worker','heartbeat'),this.db.store.command(['ZCARD',this.db.key('queue','failures')]),this.db.store.command(['ZCARD',this.db.key('queue','support')])]);this.workerHeartbeat=heartbeat?{...heartbeat,outstandingFailures:Number(failures),supportRequired:Number(support),failed:Math.max(heartbeat.lastSweepFailures||0,Number(failures)+Number(support))}:null;return this.getStatus();}
 async getOperationalStatus(){return this.refreshReadiness();}
 requireStorage(){if(!this.c.secret||this.c.secret.length<24||!this.c.redisURL||!this.c.redisToken)fail('PAYMENT_STORAGE','안전한 결과 보관 설정이 필요합니다.',503,true);}
 requireProvider(){this.requireStorage();if(this.p.mode==='disabled'||!this.p.config.keysConfigured||!this.p.mid||(this.p.mode==='test'&&!this.p.testEnvironmentAllowed))fail('PAYMENT_UNAVAILABLE','결제 확인 서비스가 준비되지 않았습니다.',503,true);}
 async requireCheckout(){this.requireProvider();if(this.p.mode==='live')await this.refreshReadiness();if(!this.getStatus().ready)fail('PAYMENT_NOT_READY','결제 준비 중입니다. 현재 결제를 진행할 수 없습니다.',503);}
 async resultRecord(id){id=validId(id);const r=await this.db.get('result',id);if(!r||r.expiresAt<=this.now())fail('RESULT_EXPIRED','결과가 삭제되었거나 보관 기간이 지났습니다.',410);return r;}
 tokenAllows(token,sid,id){if(typeof token!=='string'||token.length>400)return false;const [rid,until,mac,...extra]=token.split('.');if(extra.length||rid!==id||!/^\d{13}$/.test(until||'')||Number(until)<=this.now())return false;return same(mac,hmac(this.c.secret,'result-access:'+this.p.mode+':'+sid+':'+rid+':'+until));}
 authorize(r,sid,token){if(r.owner!==sid&&!this.tokenAllows(token,sid,r.id))fail('RESULT_NOT_FOUND','결과를 찾을 수 없습니다.',404);}
 recoveryCode(r){return r.id+'.'+hmac(this.c.secret,'result-recovery:'+this.p.mode+':'+r.owner+':'+r.id);}
 projection(r,full=false){const data=unseal(this.c,r.owner,r.cipher);const purchase={amount:3000,currency:'KRW',ready:this.getStatus().ready&&!r.confirmationPending&&!['paid','revoked','closed'].includes(r.purchaseState)&&r.expiresAt>this.now()+60000,mode:this.p.mode,disabledReason:['paid','revoked','closed'].includes(r.purchaseState)?'이 주문은 결제를 진행할 수 없습니다.':this.getStatus().paymentDisabledReason,state:r.purchaseState||'available',canRetry:r.purchaseState==='retryable',confirmationPending:!!r.confirmationPending,pendingUntil:r.confirmationPending?new Date(r.expiresAt).toISOString():null,confirmationRetry:'same-order-only',expiresAt:new Date(r.expiresAt).toISOString(),orderName:r.product==='revision'?(r.previewScheme==='simple-v1'?'인소서 자소서 첨삭 전문 1편':'인소서 문항 맞춤 첨삭 전문 1건'):ORDER_NAME};
 if(r.product==='revision')return this.revisionProjection(r,data,purchase,full);
 if(!full)return {source:'ai',resultId:r.id,access:'preview',sections:previewSections(data.sections),quality:{checks:[{label:'서버 작성·검수 절차',status:'completed'},{label:'제출 전 본인 사실 확인',status:'required'}]},note:'고정된 일부 문장만 공개됩니다. 전문 1건 열람은 3,000원이며 합격을 보장하지 않습니다.',freeAvailable:false,purchase};
 const out={source:'ai',resultId:r.id,access:'full',sections:data.sections,quality:data.quality,note:data.note||'',freeAvailable:false,purchase:{...purchase,ready:false},recoveryCode:this.recoveryCode(r)};for(const k of ['requirement','plan','review','sources'])if(data[k]!==undefined)out[k]=data[k];return out;
 }
 revisionProjection(r,data,purchase,full){
 const v=data.revision||{},mode=['characters','no-spaces','utf8-bytes'].includes(v.lengthMode)?v.lengthMode:'characters';
 const numeric=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:0;
 const base={source:'ai',product:'revision',resultId:r.id,access:full?'full':'preview',freeAvailable:false,offer:{...REVISION_OFFER},purchase,privacy:{...REVISION_PRIVACY,expiresAt:new Date(r.expiresAt).toISOString()}};
 if(!full){const simple=r.previewScheme==='simple-v1',categories=[...new Set((Array.isArray(v.diagnosis)?v.diagnosis:[]).map(d=>d?.category).filter(k=>Object.hasOwn(REVISION_LABELS,k)))];const publicPreview=simple?simpleRevisionPreview(data):{sections:previewSections(data.sections,true,r.previewScheme==='opening-v1')};return {...base,...publicPreview,quality:{checks:Object.entries(REVISION_LABELS).map(([key,label])=>({key,label,status:simple&&((key==='fit'&&v.promptProvided!==true)||(key==='length'&&v.limitProvided!==true))?'not_checked':data.quality?.checks?.find(x=>x.key===key)?.status==='pass'?'pass':'attention'}))},revisionSummary:{lengthMode:mode,limit:simple&&v.limitProvided!==true?null:numeric(v.limit,6000),originalLength:numeric(v.originalLength,30000),revisedLength:numeric(v.revisedLength,6500),changeCount:Array.isArray(v.changes)?Math.min(v.changes.length,8):0,diagnosisCategories:categories,...(simple?{promptProvided:v.promptProvided===true,limitProvided:v.limitProvided===true}:{})},note:simple?'자소서 1편의 일부를 무료로 미리 볼 수 있어요. 전문·전체 변경 이유·복사·저장은 3,000원입니다. 검수는 채용 평가나 사실의 진실성 인증이 아닙니다.':'수정본의 고정된 일부만 공개됩니다. 전문·변경 이유·복사·저장은 문항 1개당 3,000원입니다. 검수는 채용 평가나 사실의 진실성 인증이 아닙니다.'};}
 const out={...base,sections:data.sections,quality:data.quality,revision:v,note:data.note||'제출 전 사실과 지원처의 글자 수 기준을 직접 확인해주세요.',purchase:{...purchase,ready:false}};for(const key of ['review','sources'])if(data[key]!==undefined)out[key]=data[key];return out;
 }
 requestKey(owner,requestId,product){return this.db.key('request',(product==='revision'?'revision:':'')+owner+':'+requestId);}
 async saveGeneratedResult(sid,requestId,full){this.requireStorage();if(this.p.mode==='live')await this.refreshReadiness();validId(requestId);if(typeof sid!=='string'||!sid||!object(full)||!Array.isArray(full.sections)||full.sections.length<1||full.sections.length>5||full.sections.some(s=>!object(s)||typeof s.text!=='string'||s.text.length>20000)||Buffer.byteLength(JSON.stringify(full))>300000)fail('RESULT_INVALID','결과 저장 형식을 확인해주세요.',500);
 const revision=full.product==='revision';if(revision&&full.sections.length!==1)fail('RESULT_INVALID','첨삭은 한 번에 자소서 1편입니다.',500);const simple=revision&&full.revision?.previewVersion==='simple-v1';const now=this.now(),id=this.uuid(),ttl=revision?3600000:DAY,r={id,owner:sid,requestId,...(revision?{product:'revision',previewScheme:simple?'simple-v1':'opening-v1'}:{}),createdAt:now,unpaidExpiresAt:now+ttl,expiresAt:now+ttl,cipher:seal(this.c,sid,Object.fromEntries(['sections','quality','note','requirement','plan','review','sources',...(revision?['product','revision']:[])].filter(key=>full[key]!==undefined).map(key=>[key,full[key]])))};
 const out=await this.db.eval(SAVE_RESULT,[this.requestKey(sid,requestId,revision?'revision':undefined),this.db.key('result',id),this.db.key('latest',sid),(revision?'insosoe:v4:used:':'insosoe:v2:used:')+sid,this.db.key('owner',sid),revision?'insosoe:v4:cancel:'+sid+':'+requestId:this.db.key('noop',requestId)],[id,JSON.stringify(r),r.expiresAt,now]);
 if(out[0]==='canceled')fail('REQUEST_CANCELLED','내용 삭제 요청으로 첨삭 결과를 보관하지 않았습니다.',409);if(out[0]==='used')fail('FREE_ALREADY_USED','이 브라우저의 무료 작성이 이미 완료되었습니다.',403);if(!['ok','existing'].includes(out[0]))fail('PAYMENT_STORAGE','결과를 저장하지 못했습니다.',503,true);
 const saved=await this.resultRecord(out[1]);this.authorize(saved,sid);return this.projection(saved,false);
 }
 async getLatestResultId(sid,token){this.requireStorage();const own=await this.db.value('latest',sid);const recovered=typeof token==='string'?token.split('.')[0]:null;for(const id of [own,recovered]){if(!UUID.test(id||''))continue;const r=await this.db.get('result',id);if(r&&r.expiresAt>this.now()&&(r.owner===sid||this.tokenAllows(token,sid,id)))return id;}return null;}
 async getPublicResult(sid,id){const r=await this.resultRecord(id);this.authorize(r,sid);return this.projection(r,false);}
 async getResult(sid,id,token){this.requireStorage();if(this.p.mode==='live')await this.refreshReadiness();let r=await this.resultRecord(id);this.authorize(r,sid,token);if(!r.orderId)return this.projection(r,false);const o=await this.db.get('order',r.orderId);if(!o||o.deleted||o.revoked)return this.projection({...r,purchaseState:o?.revoked?'revoked':'closed'},false);if(o.terminalFailure)return this.projection({...r,purchaseState:o.terminalUnpaidVerifiedAt&&!o.approvedAt&&r.unpaidExpiresAt>this.now()+60000?'retryable':'closed'},false);
 const checked=await this.reconcile(o,{allowMissing:!o.startedAt&&!o.approvedAt});r=await this.resultRecord(id);this.authorize(r,sid,token);return this.projection(r,!!checked?.approvedAt&&checked.providerStatus==='DONE'&&!checked.revoked&&!checked.terminalFailure&&!checked.deleted&&checked.paidExpiresAt>this.now());}
 async createOrder(sid,id,consents={}){
  await this.requireCheckout();if(consents.termsAccepted!==true||consents.immediateDeliveryAccepted!==true)fail('PAYMENT_CONSENT','상품·환불 안내와 즉시 제공 동의가 필요합니다.');
  const r=await this.resultRecord(id);this.authorize(r,sid);if(r.unpaidExpiresAt<=this.now()+60000)fail('RESULT_EXPIRED','결과 보관 기간이 끝나 새 결제를 진행할 수 없습니다.',410);
  const now=this.now(),oid='ins_'+this.p.mode+'_'+this.uuid(),fresh={id:oid,resultId:r.id,owner:sid,mode:this.p.mode,mid:this.p.mid,amount:3000,currency:'KRW',createdAt:now,state:'created',requestId:r.requestId,abandonedExpiresAt:now+30*DAY,pendingRetentionExpiresAt:addCalendarYears(now),retentionExpiresAt:now+30*DAY,idempotencyKey:this.uuid(),termsVersion:r.product==='revision'?REVISION_OFFER.version:OFFER.version,...(r.product==='revision'?{product:'revision'}:{}),consentedAt:now};
  let out;
  if(r.orderId){let prior=await this.db.get('order',r.orderId);if(!prior||prior.owner!==sid)fail('PAYMENT_ORDER','주문을 확인할 수 없습니다.',409);
   if(prior.deleted||prior.revoked||prior.approvedAt)fail('PAYMENT_CLOSED','이미 결제되었거나 닫힌 주문입니다.',409);
   const checked=await this.reconcile(prior,{allowMissing:!prior.startedAt&&!prior.paymentHash});prior=checked||prior;
   if(prior.terminalFailure&&prior.terminalUnpaidVerifiedAt&&!prior.approvedAt&&!prior.revoked){
    out=await this.db.eval(REPLACE_ORDER,[this.db.key('result',r.id),this.db.key('order',prior.id),this.db.key('order',oid),this.db.key('queue','pending'),this.db.key('queue','support'),this.db.key('queue','failures')],[sid,this.now(),prior.id,oid,JSON.stringify(fresh)]);
   }else if(prior.startedAt||prior.approvedAt||prior.revoked||prior.terminalFailure)fail('PAYMENT_ALREADY_STARTED','기존 결제를 확인 중이거나 닫힌 주문입니다. 새 결제를 진행하지 마세요.',409,true);
   else out=['existing',prior.id];
  }else out=await this.db.eval(CREATE_ORDER,[this.db.key('result',r.id),this.db.key('order',oid)],[sid,now,oid,JSON.stringify(fresh)]);
  this.transition(out,['ok','existing']);const saved=await this.db.get('order',out[1]);if(!saved||saved.owner!==sid||saved.mode!==this.p.mode||saved.mid!==this.p.mid)fail('PAYMENT_ORDER','주문을 확인할 수 없습니다.',409);
  if(saved.startedAt||saved.approvedAt||saved.revoked||saved.deleted||saved.terminalFailure||saved.supersededBy)fail('PAYMENT_CLOSED','기존 결제 상태를 먼저 확인해주세요.',409,true);
  return {orderId:saved.id,amount:3000,currency:'KRW',orderName:r.product==='revision'?(r.previewScheme==='simple-v1'?'인소서 자소서 첨삭 전문 1편':'인소서 문항 맞춤 첨삭 전문 1건'):ORDER_NAME,clientKey:this.p.clientKey,customerKey:'ANONYMOUS',successUrl:this.p.origin+'/payment/success',failUrl:this.p.origin+'/payment/fail',mode:this.p.mode};
 }
 transition(out,allowed=['ok']){if(allowed.includes(out[0]))return;const map={missing:['RESULT_NOT_FOUND','결과 또는 주문을 찾을 수 없습니다.',404,false],expired:['PAYMENT_EXPIRED','결제 확인 유효 시간이 지났습니다. 새 결제는 진행하지 않습니다.',410,false],conflict:['PAYMENT_CONFLICT','다른 결제 정보로 재요청할 수 없습니다.',409,false],revoked:['PAYMENT_REVOKED','취소되거나 삭제된 주문입니다.',409,false],busy:['PAYMENT_PROCESSING','기존 결제를 확인 중입니다. 같은 정보로 다시 확인해주세요.',409,true]};throw new AppError(...(map[out[0]]||['PAYMENT_STORAGE','결제 기록을 확인하지 못했습니다.',503,true]));}
 async provider(pathname,body,idempotencyKey){this.requireProvider();let response;try{response=await this.fetcher('https://api.tosspayments.com/v1/payments'+pathname,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(this.p.secretKey+':').toString('base64'),'Content-Type':'application/json',...(body?{'Idempotency-Key':idempotencyKey}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000),redirect:'error'});}catch{fail('PAYMENT_PROVIDER','결제 상태 확인이 지연되고 있습니다. 새 결제 대신 기존 결제를 다시 확인해주세요.',503,true);}let data;try{data=await response.json();}catch{fail('PAYMENT_PROVIDER','결제 상태를 확인할 수 없습니다.',503,true);}if(!response.ok){if(response.status===404&&['NOT_FOUND_PAYMENT','NOT_FOUND'].includes(data?.code))return null;fail('PAYMENT_PROVIDER','결제 상태를 확인할 수 없습니다. 기존 주문으로 다시 확인해주세요.',503,true);}if(!object(data))fail('PAYMENT_PROVIDER','결제 응답을 확인할 수 없습니다.',502,true);return data;}
 validatePayment(o,p,expectedKey){if(!p||o.mode!==this.p.mode||o.mid!==this.p.mid||p.mId!==o.mid||p.orderId!==o.id||p.totalAmount!==3000||p.currency!=='KRW'||p.type!=='NORMAL'||typeof p.paymentKey!=='string'||p.paymentKey.length>200||(expectedKey&&p.paymentKey!==expectedKey)||!['READY','IN_PROGRESS','WAITING_FOR_DEPOSIT','DONE','CANCELED','PARTIAL_CANCELED','ABORTED','EXPIRED'].includes(p.status))fail('PAYMENT_MISMATCH','결제 금액·상점·주문 정보가 일치하지 않습니다.',409);
 const digest=hmac(this.c.secret,'payment-key:'+this.p.mode+':'+p.paymentKey);if(o.paymentHash&&o.paymentHash!==digest)fail('PAYMENT_MISMATCH','결제 정보가 기존 주문과 일치하지 않습니다.',409);
 const revoked=['CANCELED','PARTIAL_CANCELED'].includes(p.status)||(Array.isArray(p.cancels)&&p.cancels.length>0)||(p.status==='DONE'&&p.balanceAmount!==3000);
 if(['IN_PROGRESS','DONE'].includes(p.status)&&!['카드','간편결제','CARD','EASY_PAY'].includes(p.method))fail('PAYMENT_METHOD','카드 결제창의 즉시 결제만 지원합니다.',409);
 let approvedAt=null;if(p.approvedAt&&(p.status==='DONE'||revoked)){approvedAt=Date.parse(p.approvedAt);if(!Number.isFinite(approvedAt)||approvedAt<o.createdAt-60000||approvedAt>this.now()+60000)fail('PAYMENT_MISMATCH','결제 승인 시각을 확인할 수 없습니다.',409);}if(p.status==='DONE'&&!approvedAt)fail('PAYMENT_MISMATCH','결제 승인 시각을 확인할 수 없습니다.',409);
 return {paymentHash:digest,paymentCipher:seal(this.c,'payment:'+o.id,p.paymentKey),status:p.status,revoked,unpaidTerminal:['ABORTED','EXPIRED'].includes(p.status)&&!p.approvedAt&&!revoked,...(approvedAt?{approvedAt,paidExpiresAt:approvedAt+(o.product==='revision'?DAY:7*DAY),retentionExpiresAt:addCalendarYears(approvedAt)}:{})};
 }
 async record(o,p,expectedKey){const v=this.validatePayment(o,p,expectedKey);const out=await this.db.eval(RECORD_PAYMENT,[this.db.key('result',o.resultId),this.db.key('order',o.id),this.db.key('payment',v.paymentHash),this.db.key('queue','pending'),this.db.key('latest',o.owner),this.requestKey(o.owner,o.requestId,o.product),this.db.key('owner',o.owner),this.db.key('queue','support'),this.db.key('queue','failures')],[JSON.stringify(v),this.now()]);this.transition(out,['ok','recorded']);return JSON.parse(out[1]);}
 async reconcile(o,{allowMissing=false}={}){const p=await this.provider('/orders/'+encodeURIComponent(o.id));if(!p){if(allowMissing)return null;fail('PAYMENT_UNCONFIRMED','결제 상태가 아직 확인되지 않았습니다. 새 결제를 진행하지 마세요.',503,true);}return this.record(o,p);}
 async confirm(sid,input){this.requireProvider();if(!object(input)||input.amount!==3000||typeof input.orderId!=='string'||!/^ins_(test|live)_[a-f0-9-]{36}$/.test(input.orderId))fail('PAYMENT_INPUT','결제 확인 정보 또는 금액이 올바르지 않습니다.');const key=keyInput(input.paymentKey),o=await this.db.get('order',input.orderId);if(!o||o.owner!==sid)fail('RESULT_NOT_FOUND','주문을 찾을 수 없습니다.',404);const r=await this.resultRecord(o.resultId);this.authorize(r,sid);if(r.orderId!==o.id||o.supersededBy)fail('PAYMENT_REPLACED','종료된 이전 주문입니다. 현재 주문을 확인해주세요.',409);
 if(o.deleted||o.revoked||o.terminalFailure)fail('PAYMENT_REVOKED','삭제되거나 취소된 주문입니다.',409);if(o.approvedAt){const current=await this.record(o,await this.provider('/orders/'+encodeURIComponent(o.id)),key);if(current.revoked)fail('PAYMENT_REVOKED','결제 취소로 전문 접근이 해제되었습니다.',403);return this.getResult(sid,o.resultId);}
 await this.requireCheckout();
 if(!o.startedAt){const authenticated=await this.provider('/orders/'+encodeURIComponent(o.id));this.validatePayment(o,authenticated,key);if(authenticated.status==='DONE'){await this.record(o,authenticated,key);return this.getResult(sid,o.resultId);}if(authenticated.status!=='IN_PROGRESS')fail('PAYMENT_AUTHORIZATION_REQUIRED','인증된 카드 결제를 확인할 수 없습니다.',409,true);}
 const token=this.uuid(),digest=hmac(this.c.secret,'payment-key:'+this.p.mode+':'+key);const begun=await this.db.eval(BEGIN_CONFIRM,[this.db.key('result',o.resultId),this.db.key('order',o.id),this.db.key('payment',digest),this.db.key('latest',o.owner),this.requestKey(o.owner,o.requestId,o.product),this.db.key('owner',o.owner),this.db.key('queue','pending')],[sid,digest,seal(this.c,'payment:'+o.id,key),this.now(),token]);if(begun[0]==='paid')return this.getResult(sid,o.resultId);this.transition(begun);const active=JSON.parse(begun[1]);
 try{let p=await this.provider('/orders/'+encodeURIComponent(o.id));this.validatePayment(active,p,key);if(p.status==='IN_PROGRESS'){
 if(this.now()-active.startedAt>=10*60000)fail('PAYMENT_AUTHORIZATION_WINDOW_ENDED','결제 인증 시간이 지났습니다. 새 결제 대신 기존 주문 상태를 확인해주세요.',409,true);
 // Recheck active binding/lease immediately before POST; replaced/terminal old orders cannot charge.
 this.transition(await this.db.eval(CHECK_CONFIRM,[this.db.key('result',o.resultId),this.db.key('order',o.id)],[sid,digest,token,this.now()]));
 p=await this.provider('/confirm',{paymentKey:key,orderId:o.id,amount:3000},active.idempotencyKey);
 }const recorded=await this.record(active,p,key);if(recorded.revoked)fail('PAYMENT_REVOKED','결제가 취소되었습니다.',403);if(!recorded.approvedAt||recorded.providerStatus!=='DONE')fail('PAYMENT_UNCONFIRMED','결제가 승인되지 않았습니다.',409,true);
 return await this.getResult(sid,o.resultId);
 }finally{try{await this.db.eval(RELEASE_CONFIRM,[this.db.key('order',o.id)],[token]);}catch{}}
 }
 async recover(sid,code){this.requireProvider();if(typeof code!=='string'||code.length!==101)fail('RECOVERY_INVALID','복구코드를 확인해주세요.',404);const [id,mac]=code.split('.');let r;try{r=await this.resultRecord(id);}catch{fail('RECOVERY_INVALID','복구코드를 확인해주세요.',404);}if(r.product==='revision')fail('RECOVERY_DISABLED','첨삭 전문은 전달 후 삭제되므로 복구코드를 제공하지 않습니다.',409);if(!same(mac,this.recoveryCode(r).split('.')[1])||!r.orderId)fail('RECOVERY_INVALID','복구코드를 확인해주세요.',404);const o=await this.db.get('order',r.orderId);if(!o||o.deleted||o.revoked||o.terminalFailure)fail('RECOVERY_INVALID','복구할 수 없는 결과입니다.',404);const checked=await this.reconcile(o);if(!checked.approvedAt||checked.providerStatus!=='DONE'||checked.revoked||checked.terminalFailure||checked.deleted||checked.paidExpiresAt<=this.now())fail('RECOVERY_INVALID','승인된 유효 결제를 확인할 수 없습니다.',403);r=await this.resultRecord(r.id);const until=String(checked.paidExpiresAt),token=r.id+'.'+until+'.'+hmac(this.c.secret,'result-access:'+this.p.mode+':'+sid+':'+r.id+':'+until);return {result:this.projection(r,true),cookie:ACCESS_COOKIE+'='+token+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+Math.max(0,Math.floor((checked.paidExpiresAt-this.now())/1000))+(this.p.origin?.startsWith('https:')?'; Secure':'')};}
 async deleteResult(sid,id,token){this.requireStorage();id=validId(id);const r=await this.db.get('result',id);if(!r||r.expiresAt<=this.now()){if(typeof this.db.store.clear==='function')await this.db.store.clear(sid);return {deleted:true,alreadyAbsent:true,cacheCleared:typeof this.db.store.clear==='function',freeAvailable:false,message:'해당 결과는 삭제되었거나 만료되었습니다. 현재 브라우저 재시도 캐시도 정리했습니다.'};}this.authorize(r,sid,token);if(typeof this.db.store.clear==='function')await this.db.store.clear(r.owner);const out=await this.db.eval(DELETE_RESULT,[this.db.key('result',r.id),this.db.key('latest',r.owner),this.db.key('owner',r.owner),this.db.key('order',r.orderId||'none'),this.requestKey(r.owner,r.requestId,r.product)],[sid,this.now(),r.owner===sid?'owner':'authorized']);this.transition(out);return {deleted:true,cacheCleared:typeof this.db.store.clear==='function',freeAvailable:false,message:'서비스 DB의 임시 콘텐츠와 재시도 캐시 삭제를 확인했습니다. 거래·무료 이용 기록은 유지되며 자동 환불되지 않습니다.'};}
 async deleteOwnerResults(sid,{product}={}){this.requireStorage();const ids=await this.db.store.command(['SMEMBERS',this.db.key('owner',sid)]);for(const id of ids||[]){try{if(product){const record=await this.db.get('result',id);if(!record||record.product!==product)continue;}await this.deleteResult(sid,id);}catch(e){if(e.code!=='RESULT_EXPIRED')throw e;}}return {deleted:true};}

 async runReconciliation({limit=10}={}){
  this.requireProvider();if(!Number.isInteger(limit)||limit<1||limit>25)fail('RECONCILIATION_LIMIT','작업 한도가 올바르지 않습니다.',400);
  const queue=this.db.key('queue','pending'),support=this.db.key('queue','support'),failures=this.db.key('queue','failures');
  const ids=await this.db.eval(RECONCILE_CLAIM,[queue],[this.now(),limit]);let sweepFailures=0,processed=0,terminal=0,retryRequired=0;
  // GET-only. Support incidents remain monitored in this same bounded due queue.
  for(let start=0;start<ids.length;start+=5)await Promise.all(ids.slice(start,start+5).map(async id=>{
   processed++;let code='PAYMENT_PENDING',outcome='pending';
   try{const order=await this.db.get('order',id);if(!order){await this.db.eval(RECONCILE_RETRY,[this.db.key('order',id),queue,support,failures],[id,this.now(),'LEDGER_EXPIRED',600000,'pending']);return;}
    const checked=await this.reconcile(order);
    if(checked.supportRequired){sweepFailures++;code=checked.lastReconcileCode==='PENDING_CONTENT_EXPIRED'?'PENDING_CONTENT_EXPIRED':'PAID_CONTENT_UNAVAILABLE';outcome='support';}
    else if(checked.approvedAt||checked.revoked||checked.terminalFailure){terminal++;return;}
    else if(checked.providerStatus==='IN_PROGRESS'){retryRequired++;code=this.now()-checked.startedAt<600000?'PAYMENT_AUTHORIZATION_RETRY_REQUIRED':'PAYMENT_AUTHORIZATION_WINDOW_ENDED';}
   }catch(error){sweepFailures++;outcome='failure';code=['PAYMENT_PROVIDER','PAYMENT_MISMATCH','PAYMENT_METHOD','PAYMENT_UNCONFIRMED','REDIS_UNAVAILABLE','PAYMENT_STORAGE','PAYMENT_CONFLICT'].includes(error?.code)?error.code:'RECONCILIATION_FAILED';}
   const retry=await this.db.eval(RECONCILE_RETRY,[this.db.key('order',id),queue,support,failures],[id,this.now(),code,600000,outcome]);
   if(outcome!=='support'&&retry[0]==='ok'&&JSON.parse(retry[1]).supportRequired)sweepFailures++;
  }));
  const result=await this.db.eval(RECONCILE_HEARTBEAT,[this.db.key('worker','heartbeat'),queue,support,failures],[this.now(),processed,sweepFailures]);this.transition(result);this.workerHeartbeat=JSON.parse(result[1]);
  return {mode:this.p.mode,processed,terminal,retryRequired,failed:this.workerHeartbeat.failed,sweepFailures,heartbeat:{...this.workerHeartbeat},reconciliation:this.getStatus().reconciliation};
 }
 async webhook(body){this.requireProvider();if(!object(body)||body.eventType!=='PAYMENT_STATUS_CHANGED')return {received:true};const id=body.data?.orderId;if(typeof id!=='string'||id.length>64)return {received:true};const o=await this.db.get('order',id);if(!o)return {received:true};await this.reconcile(o);return {received:true};}
}
