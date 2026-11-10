import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, clientId, kstDay } from './guard.mjs';
const derive = promisify(scrypt);
export const BODY_LIMIT = 65536;
export const PREVIEW_TTL = 7200;
export const DISCLOSURE = '가게가 직접 입력한 정보이며 여기봐AI가 사업자 여부·내용을 검증하거나 품질을 보증하지 않습니다.';
const bad = () => new HttpError(400, 'FIELDS', '입력 항목과 글자 수를 확인해 주세요.');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact = (v,keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
export function validId(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) throw bad(); return id; }
function text(value,min,max) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw bad();
  const v = value.normalize('NFC').trim();
  if (v.length < min || v.length > max || /<\s*[!/?a-z][^>]*>|(?:https?:|javascript:|data:|www\.)|\]\s*\(/i.test(v)) throw bad();
  return v;
}
export function normalizeData(data) {
  if (!exact(data,['name','address','headline','intro','sections','faqs'])) throw bad();
  const pairs = (rows,a,b,am,bm) => {
    if (!Array.isArray(rows) || rows.length > 8) throw bad();
    return rows.map(row => {
      if (!exact(row,[a,b])) throw bad();
      const x=text(row[a],0,am),y=text(row[b],0,bm);
      if (!!x !== !!y) throw bad();
      return x ? {[a]:x,[b]:y} : null;
    }).filter(Boolean);
  };
  return {name:text(data.name,1,60),address:text(data.address,4,120),headline:text(data.headline,1,200),intro:text(data.intro,1,2000),sections:pairs(data.sections,'heading','body',200,4000),faqs:pairs(data.faqs,'question','answer',300,2000)};
}
export function validateRequest(body) {
  if (!object(body)) throw bad();
  const schemas = {create:['action','id','password','consent','data'],auth:['action','id','password'],update:['action','id','password','consent','data'],delete:['action','id','password'],report:['action','id','reason']};
  if (typeof body.action !== 'string' || !Object.hasOwn(schemas,body.action) || !exact(body,schemas[body.action])) throw bad();
  validId(body.id);
  if (body.action === 'report') return {action:body.action,id:body.id,reason:text(body.reason,1,500)};
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 64) throw new HttpError(400,'PASSWORD','비밀번호는 8~64자로 정해 주세요.');
  if (['create','update'].includes(body.action) && body.consent !== true) throw new HttpError(400,'CONSENT','공개할 정보를 직접 확인하고 공개에 동의해 주세요.');
  return {...body,...(['create','update'].includes(body.action) ? {data:normalizeData(body.data)} : {})};
}
export function requestScope(req,env={}) {
  const raw=req.headers.host;
  if (typeof raw !== 'string' || raw.length > 255 || /[\s,/@\\?#]/.test(raw) || raw !== raw.toLowerCase()) throw new HttpError(400,'HOST','요청 주소를 확인해 주세요.');
  let host;
  try { host=new URL('https://'+raw).host; } catch { throw new HttpError(400,'HOST','요청 주소를 확인해 주세요.'); }
  if (host !== raw || !host || host.endsWith('.')) throw new HttpError(400,'HOST','요청 주소를 확인해 주세요.');
  const forwarded=req.headers['x-forwarded-host'];
  if (forwarded !== undefined && forwarded !== host) throw new HttpError(403,'HOST','요청 주소를 확인해 주세요.');
  const local=/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  const production=host === 'www.kkumsu.com' && env.VERCEL_ENV === 'production';
  const namespace=production ? 'stores:v1:prod' : 'stores:v1:preview:'+createHash('sha256').update((local?'local:':'preview:')+host).digest('hex');
  return {host,local,production,namespace,ttl:production?0:PREVIEW_TTL};
}
export function checkStoreOrigin(req,scope) {
  const expected=(scope.local && !req.socket?.encrypted?'http':'https')+'://'+scope.host;
  if (typeof req.headers.origin !== 'string' || req.headers.origin !== expected || (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== (scope.local?'http':'https'))) throw new HttpError(403,'ORIGIN','이 사이트 화면에서만 이용할 수 있어요.');
}
export const storeKeys=(scope,id)=>[scope.namespace+':record:'+id,scope.namespace+':directory',scope.namespace+':reports:'+id];
export async function hashPassword(password) { const salt=randomBytes(16).toString('hex'); return {salt,hash:(await derive(password,salt,64,{N:16384,r:8,p:1})).toString('hex')}; }
export async function verifyPassword(password,stored) {
  const valid=stored && /^[a-f0-9]{32}$/.test(stored.salt) && /^[a-f0-9]{128}$/.test(stored.hash);
  const actual=await derive(password,valid?stored.salt:'0'.repeat(32),64,{N:16384,r:8,p:1});
  return !!valid && timingSafeEqual(actual,Buffer.from(stored.hash,'hex'));
}
const revision=()=>randomBytes(16).toString('hex');
const authError=()=>new HttpError(403,'AUTH','가게 주소 또는 비밀번호를 확인해 주세요.');
const unavailable=()=>new HttpError(404,'NOT_FOUND','공개된 가게 소개를 찾지 못했어요.');
const rateError=()=>new HttpError(429,'RATE_LIMIT','이용 횟수를 초과했어요. 잠시 후 다시 시도해 주세요.');
const output=r=>({id:r.id,data:r.data,url:'/stores/'+r.id,hidden:!!r.hidden});
const remaining=(r,scope,now)=>scope.ttl?Math.max(1,Math.ceil((r.expiresAt-now)/1000)):0;
export async function actOnStore({store,scope,req,env,input,now=Date.now()}) {
  const secret=env.SESSION_SECRET || env.OPENROUTER_API_KEY || (scope.local?'local-development-only-store-secret':null);
  if (!secret) throw new HttpError(503,'STORE_CONFIG','가게 공개 보안 설정이 아직 안 됐어요.');
  // On Vercel use its overwritten IP header, not client-controlled forwarded-for.
  const ipReq={headers:env.VERCEL?{'x-vercel-forwarded-for':req.headers['x-vercel-forwarded-for']}: {},socket:req.socket};
  const ip=clientId(ipReq,secret), ns=scope.namespace, keys=storeKeys(scope,input.id);
  const counter=(suffix,limit,ttl)=>({key:ns+':limit:'+suffix,limit,ttl});
  const hour=Math.floor(now/3600000),day=kstDay(now);
  const tx=async(op,p,k=keys)=>{const out=await store.publicTransaction(op,k,{now,...p});if (!out || !out.status) throw new HttpError(503,'STORE','저장 상태를 확인하지 못했어요.');return out;};
  if (input.action === 'report') {
    const old=await store.getJson(keys[0]); if (!old || old.deleted || (old.expiresAt && old.expiresAt<=now)) throw unavailable();
    const r=await tx('report',{reporter:ip,reason:input.reason,revision:revision(),ttl:remaining(old,scope,now),counters:[counter('report:h:'+hour+':'+ip,5,7200),counter('report:d:'+day+':'+ip,20,172800)]});
    if (r.status==='limited') throw rateError();
    if (r.status!=='reported') throw unavailable();
    return {status:200,body:{id:input.id,reported:true}};
  }
  const rate=await tx('rate',{counters:[counter('auth:ip:'+ip,8,900),counter('auth:id:'+input.id,8,900)]});
  if (rate.status!=='ok') throw rateError();
  if (input.action==='create') {
    const old=await store.getJson(keys[0]);
    const match=async r=>{
      if (!r || r.deleted || !(await verifyPassword(input.password,r.password)) || JSON.stringify(normalizeData(r.data))!==JSON.stringify(input.data)) throw new HttpError(409,'ID_CONFLICT','이미 사용 중인 가게 주소예요. 기존 정보와 비밀번호를 확인해 주세요.');
      return {status:200,body:output(r)};
    };
    if (old) return match(old);
    const record={id:input.id,data:input.data,password:await hashPassword(input.password),revision:revision(),createdAt:now,updatedAt:now,hidden:false,expiresAt:scope.ttl?now+scope.ttl*1000:null};
    const result=await tx('create',{record,ttl:scope.ttl,counters:[counter('create:h:'+hour+':'+ip,3,7200),counter('create:d:'+day+':'+ip,10,172800),counter('create:global:'+day,50,172800)]});
    if (result.status==='limited') throw new HttpError(429,'CREATE_LIMIT','오늘 또는 이번 시간의 무료 공개 한도에 도달했어요. 기존 가게는 유지됩니다.');
    if (result.status==='exists') return match(result.record);
    if (result.status!=='created') throw new HttpError(503,'STORE','저장 상태를 확인하지 못했어요.');
    return {status:201,body:output(result.record)};
  }
  for (let attempt=0;attempt<4;attempt++) {
    const old=await store.getJson(keys[0]);
    if (!(await verifyPassword(input.password,old?.password)) || old.deleted || (old.expiresAt && old.expiresAt<=now)) throw authError();
    if (input.action==='auth') return {status:200,body:output(old)};
    const record={...old,data:input.data,revision:revision(),updatedAt:now};
    const r=await tx(input.action,{expected:old.revision,record,revision:revision(),ttl:remaining(old,scope,now),tombstoneTtl:scope.ttl?remaining(old,scope,now):0});
    if (r.status==='conflict') continue;
    if (r.status==='missing') throw authError();
    if (r.status!=='ok') throw new HttpError(503,'STORE','저장 상태를 확인하지 못했어요.');
    return {status:200,body:input.action==='delete'?{id:input.id,deleted:true}:output(r.record)};
  }
  throw new HttpError(409,'BUSY','다른 변경이 진행 중이에요. 내용을 다시 확인해 주세요.');
}
export async function publicStore(store,scope,id) {
  const record=await store.getJson(storeKeys(scope,validId(id))[0]);
  if (!record || record.deleted || record.hidden || (record.expiresAt && record.expiresAt<=Date.now())) throw unavailable();
  return {id:record.id,data:record.data};
}
export function escapeHtml(value) { return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const paragraphs=t=>String(t).split(/\n\s*\n/).map(p=>'<p>'+escapeHtml(p).replace(/\n/g,'<br>')+'</p>').join('');
function shell(scope,title,route,content,description = '가게가 직접 입력하고 공개한 가게 소개를 둘러보세요.') {
  const fullTitle = escapeHtml(title+' | 여기봐 AI');
  const desc = escapeHtml(String(description).replace(/\s+/g,' ').trim().slice(0,160));
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+fullTitle+'</title><meta name="description" content="'+desc+'"><meta property="og:title" content="'+fullTitle+'"><meta property="og:description" content="'+desc+'"><meta name="robots" content="'+(scope.production?'index,follow':'noindex,nofollow')+'">'+(scope.production?'<link rel="canonical" href="https://www.kkumsu.com'+escapeHtml(route)+'">':'')+'<link rel="icon" href="/icon.png?v=yeogibwa-20261110a" type="image/png"><link rel="stylesheet" href="/fonts/pretendard.css"><link rel="stylesheet" href="/styles.css"></head><body><div class="demo-bar"><div class="wrap"><b>베타</b><span>가게가 직접 공개한 정보예요 · 내용은 확인이 필요해요</span></div></div><header class="top"><div class="wrap"><a class="logo" href="/" aria-label="여기봐 AI 처음으로"><img src="/logo.png?v=yeogibwa-20261110a" alt="여기봐 AI" width="1200" height="361"></a><nav aria-label="주 메뉴"><a class="directory-nav" href="/stores">믿을만한 가게 정보 모음</a></nav></div></header><main id="main-content"><div class="wrap">'+content+'</div></main><footer class="site-foot"><div class="wrap"><p>'+DISCLOSURE+'</p><p>베타 무료 공개 기능입니다. 검색 색인·노출이나 AI 추천을 보장하지 않습니다.</p><a href="/#/privacy">개인정보 안내</a></div></footer></body></html>';
}
export function renderStore(scope,{id,data}) {
  return shell(scope,data.name+' · '+data.headline,'/stores/'+id,'<p class="public-kicker">가게가 직접 공개한 소개</p><article class="card public-store"><header><h1>'+escapeHtml(data.name)+'</h1><p class="muted">'+escapeHtml(data.address)+'</p><h2>'+escapeHtml(data.headline)+'</h2></header>'+paragraphs(data.intro)+data.sections.map(s=>'<section><h2>'+escapeHtml(s.heading)+'</h2>'+paragraphs(s.body)+'</section>').join('')+(data.faqs.length?'<section><h2>자주 묻는 질문</h2><dl>'+data.faqs.map(f=>'<dt>'+escapeHtml(f.question)+'</dt><dd>'+paragraphs(f.answer)+'</dd>').join('')+'</dl></section>':'')+'</article><p class="card note small">'+DISCLOSURE+'</p><nav class="public-manage" aria-label="가게 관리"><a class="btn small" href="/#/manage/'+id+'">가게 정보 수정·삭제</a> <a class="btn small" href="/#/report-store/'+id+'">이 가게 신고</a></nav>',data.intro);
}
export async function renderDirectory(store,scope,page) {
  if (!/^[1-9]\d{0,5}$/.test(String(page))) throw new HttpError(400,'PAGE','페이지 번호를 확인해 주세요.');
  const n=Number(page),result=await store.publicTransaction('list',[scope.namespace+':directory'],{prefix:scope.namespace+':record:',offset:(n-1)*20,limit:20,ttl:scope.ttl,now:Date.now()});
  if (result?.status!=='ok' || (!Array.isArray(result.items) && typeof result.items!=='object')) throw new HttpError(503,'STORE','목록을 확인하지 못했어요.');
  const rows=Array.isArray(result.items)?result.items:[];
  return shell(scope,'믿을만한 가게 정보 모음'+(n>1?' · '+n+'페이지':''),'/stores'+(n>1?'?page='+n:''),'<p class="public-kicker">여기봐 AI 가게 모음</p><h1>믿을만한 가게 정보 모음</h1><p class="card note small">가게가 직접 등록한 소개예요. '+DISCLOSURE+'</p>'+(rows.length?'<ul class="public-grid">'+rows.slice(0,20).map(r=>'<li><article class="card public-listing"><h2><a href="/stores/'+escapeHtml(r.id)+'">'+escapeHtml(r.data.name)+'</a></h2><p>'+escapeHtml(r.data.headline)+'</p><p class="small muted">'+escapeHtml(r.data.address)+'</p><a class="public-more" href="/stores/'+escapeHtml(r.id)+'">가게 소개 보기 →</a></article></li>').join('')+'</ul>':'<div class="card public-empty"><h2>아직 공개된 가게가 없어요</h2><p>첫 번째 가게 소개를 만들어 보세요.</p><a class="btn primary" href="/">무료로 가게 소개 만들기</a></div>')+'<nav class="public-pagination" aria-label="목록 페이지">'+(n>1?'<a class="btn small" rel="prev" href="/stores'+(n>2?'?page='+(n-1):'')+'">이전 페이지</a> ':'')+(rows.length>20?'<a class="btn small" rel="next" href="/stores?page='+(n+1)+'">다음 페이지</a>':'')+'</nav>');
}
