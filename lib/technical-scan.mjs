import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

export const SCANNER_AGENT='MaechulTechnicalScanner';
export class ScanError extends Error { constructor(code){super(code);this.code=code;} }
const fail=code=>{throw new ScanError(code);};
const brief=v=>String(v??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,260);
const code=e=>e instanceof ScanError?e.code:'network-failure';
const bound=(v,d,m)=>Number.isInteger(v)&&v>0?Math.min(v,m):d;
export function isPublicIPv4(ip){
 if(isIP(ip)!==4)return false;
 const p=ip.split('.').map(Number),n=(p[0]*0x1000000+(p[1]<<16)+(p[2]<<8)+p[3])>>>0;
 return ![[0,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],[0xac100000,12],[0xc0000000,24],[0xc0000200,24],[0xc0586300,24],[0xc0a80000,16],[0xc6120000,15],[0xc6336400,24],[0xcb007100,24],[0xe0000000,4],[0xf0000000,4]].some(([a,b])=>(n>>>(32-b))===(a>>>(32-b)));
}
export function validateTarget(input){
 if(typeof input!=='string'||input.length>4096||/[\x00-\x20\x7f\\]/.test(input))fail('invalid-url');
 let u;try{u=new URL(input);}catch{fail('invalid-url');}
 if(!['http:','https:'].includes(u.protocol))fail('unsafe-scheme');
 if(u.username||u.password||/^https?:\/\/[^/?#]*@/i.test(input))fail('credentials-not-allowed');
 if(u.port)fail('nonstandard-port');
 const h=u.hostname;
 if(h.startsWith('['))fail('ipv6-not-supported');
 if(isIP(h)===4){if(!isPublicIPv4(h))fail('unsafe-ip');}
 else if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(h)||/\.(localhost|local|internal|home|lan|test|invalid|example|onion)$/.test(h))fail('unsafe-hostname');
 u.hash='';return u;
}
async function timed(p,ms){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ScanError('timeout')),ms);})]);}finally{clearTimeout(timer);}}
export async function resolvePublicTarget(input,resolve=lookup,timeoutMs=2000){
 const url=validateTarget(input);
 const answers=isIP(url.hostname)===4?[{address:url.hostname,family:4}]:await timed(Promise.resolve().then(()=>resolve(url.hostname,{family:4,all:true,verbatim:true})),timeoutMs);
 if(!Array.isArray(answers)||!answers.length||answers.length>32||answers.some(a=>!a||a.family!==4||!isPublicIPv4(a.address)))fail('unsafe-dns');
 return {url,address:answers[0].address};
}
let activeRequests=0;
// Dependency overrides are trusted test-only capabilities, never user input.
export function createSecureTransport({resolve=lookup,request=null}={}){
 return async function transport(input,{timeoutMs=5000,maxBytes=524288,signal}={}){
  if(activeRequests>=4)fail('concurrency-limit');activeRequests++;
  const started=Date.now();
  try{
   if(signal?.aborted)fail('aborted');
   const {url,address}=await resolvePublicTarget(input,resolve,Math.min(timeoutMs,2000));
   if(signal?.aborted)fail('aborted');
   return await new Promise((accept,reject)=>{
    let req,res,timer,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){res?.destroy();req?.destroy();reject(error);}else accept(value);};
    const abort=()=>finish(new ScanError('aborted'));
    const pinned=(_host,opts,cb)=>{if(typeof opts==='function'){cb=opts;opts={};}if(opts?.all)cb(null,[{address,family:4}]);else cb(null,address,4);};
    try{
     req=(request??(url.protocol==='https:'?https.request:http.request))(url,{method:'GET',agent:false,family:4,lookup:pinned,maxHeaderSize:16384,rejectUnauthorized:true,headers:{'User-Agent':SCANNER_AGENT+'/1.0','Accept-Encoding':'identity','Accept':'text/html,application/xml,text/plain'}},incoming=>{
      res=incoming;
      if(!/^identity$/i.test(String(res.headers['content-encoding']??'identity'))){finish(new ScanError('unsupported-content-encoding'));return;}
      const len=res.headers['content-length'];if(len&&(!/^\d+$/.test(String(len))||Number(len)>maxBytes)){finish(new ScanError('body-limit'));return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{const b=Buffer.from(chunk);size+=b.length;if(size>maxBytes)finish(new ScanError('body-limit'));else chunks.push(b);});
      res.on('aborted',()=>finish(new ScanError('response-aborted')));res.on('error',e=>finish(e));
      res.on('end',()=>{if(!res.complete)finish(new ScanError('response-incomplete'));else finish(null,{status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)});});
     });
     req.on('socket',socket=>{const verify=()=>{if(String(socket.remoteAddress??'').replace(/^::ffff:/,'')!==address)finish(new ScanError('remote-address-mismatch'));};if(socket.connecting)socket.once('connect',verify);else verify();});
     req.on('error',e=>finish(e));signal?.addEventListener('abort',abort,{once:true});
     timer=setTimeout(()=>finish(new ScanError('timeout')),Math.max(1,timeoutMs-(Date.now()-started)));req.end();
    }catch(e){finish(e);}
   });
  }finally{activeRequests--;}
 };
}
const defaultTransport=createSecureTransport();
function normalizeHeaders(input){const h=Object.create(null);for(const [k,v]of Object.entries(input??{}))h[k.toLowerCase()]=Array.isArray(v)?v.join(', '):String(v);if(Object.entries(h).reduce((n,[k,v])=>n+k.length+v.length,0)>16384)fail('header-limit');return h;}
function decode(r){const charset=/charset\s*=\s*["']?([^\s;"']+)/i.exec(r.headers['content-type']??'')?.[1];if(charset&&!/^(utf-8|utf8|us-ascii)$/i.test(charset))fail('unsupported-charset');try{return new TextDecoder('utf-8',{fatal:true}).decode(r.body);}catch{fail('invalid-text-encoding');}}
const mime=(r,type)=>new RegExp('^'+type+'(?:\\s*;|$)','i').test(r.headers['content-type']??'');
const ok=r=>r.status>=200&&r.status<300&&r.status!==206;
const missing=r=>[404,410].includes(r.status);
const denied=r=>[401,403,429,451].includes(r.status);
function robotPath(v){if(/%(?![a-f\d]{2})/i.test(v))fail('robots-path-unsupported');return v.replace(/[^\x00-\x7f]/gu,c=>encodeURIComponent(c)).replace(/%([a-f\d]{2})/gi,(_,hex)=>{const c=String.fromCharCode(parseInt(hex,16));return /[a-z0-9._~-]/i.test(c)?c:'%'+hex.toUpperCase();});}
export function parseRobots(text,sourceUrl='',agent=SCANNER_AGENT){
 const sitemaps=[];
 try{
  if(typeof text!=='string'||Buffer.byteLength(text)>524288||/\x00|^\s*</.test(text))fail('robots-unparseable');
  const groups=[];let group,hasRule=false;
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
   const line=raw.replace(/#.*/,'').trim();if(!line)continue;
   const m=/^([a-z][a-z-]*)\s*:\s*(.*)$/i.exec(line);if(!m)fail('robots-malformed');
   const key=m[1].toLowerCase(),v=m[2].trim();
   if(key==='sitemap'){if(v)sitemaps.push(v);continue;}
   if(key==='user-agent'){
    if(!/^(\*|[a-z_-]+)$/i.test(v))fail('robots-agent-unsupported');
    if(!group||hasRule){group={agents:[],rules:[]};groups.push(group);hasRule=false;}group.agents.push(v.toLowerCase());continue;
   }
   if(!['allow','disallow'].includes(key))fail('robots-unsupported-directive');
   if(!group)fail('robots-rule-without-group');hasRule=true;if(!v)continue;
   if(!v.startsWith('/')||/[\x00-\x20]/.test(v)||/\$(?!$)/.test(v))fail('robots-rule-unsupported');
   const pattern=robotPath(v),end=pattern.endsWith('$'),p=end?pattern.slice(0,-1):pattern;
   const regex=new RegExp('^'+p.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+(end?'$':''));
   group.rules.push({allow:key==='allow',pattern,regex,length:Buffer.byteLength(p.replace(/\*/g,''))});
  }
  let best=-1,selected=[];
  for(const g of groups){const score=Math.max(-1,...g.agents.map(a=>a==='*'?0:agent.toLowerCase().includes(a)?a.length:-1));if(score>best){best=score;selected=[g];}else if(score===best&&best>=0)selected.push(g);}
  return {known:true,rules:best<0?[]:selected.flatMap(g=>g.rules),sitemaps:sitemaps.slice(0,32),sourceUrl};
 }catch(e){return {known:false,reason:code(e),sitemaps,sourceUrl};}
}
export function robotsDecision(policy,input){
 if(!policy?.known)return {known:false,allowed:false,evidence:policy?.reason??'robots-unknown'};
 try{const u=new URL(input),p=robotPath(u.pathname+u.search),rules=(policy.rules??[]).filter(r=>r.regex.test(p)).sort((a,b)=>b.length-a.length||Number(b.allow)-Number(a.allow)),r=rules[0];return {known:true,allowed:!r||r.allow,evidence:r?(r.allow?'Allow: ':'Disallow: ')+r.pattern:'No matching disallow rule'};}catch{return {known:false,allowed:false,evidence:'robots-path-unknown'};}
}
function entities(s){return s.replace(/&([^\s<&;]*);/g,(_,name)=>{const map={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(Object.hasOwn(map,name))return map[name];if(/^#(?:\d+|x[a-f\d]+)$/i.test(name)){const n=name[1].toLowerCase()==='x'?parseInt(name.slice(2),16):Number(name.slice(1));if(n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff))return String.fromCodePoint(n);}fail('html-entity-unsupported');});}
function attributes(s){const out=Object.create(null);while(s.trim()){const m=/^\s+([^\s/=>"'<]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(s);if(!m)fail('html-attributes-unsupported');const n=m[1].toLowerCase();if(n in out)fail('html-duplicate-attribute');out[n]=entities(m[2]??m[3]??m[4]??'');s=s.slice(m[0].length);}return out;}
// Restricted static HTML subset. This is NOT a browser HTML5 tree builder.
// Unsupported or ambiguous markup produces unknown, never an absence guess.
export function inspectHtml(text){
 const data={title:[],description:[],h1:[],h2:[],bodyText:'',robotsMeta:[],jsonLd:[],conditionalContent:false,conditionalNoindex:false,conditionalDescription:false};
 let completedHead=null;
 try{
  if(text.length>1048576||/\x00/.test(text))fail('html-limit');
  const stack=[],seen={html:0,head:0,body:0},voids=new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));let i=0,nodes=0;
  const excluded=()=>stack.some(n=>['template','noscript'].includes(n.tag)||n.hidden);
  const add=raw=>{const t=entities(raw);if(t.trim()&&!stack.some(n=>n.tag==='body'))fail('html-text-position');if(excluded())return;for(const n of stack)if(['h1','h2'].includes(n.tag))n.text+=t;if(stack.some(n=>n.tag==='body'))data.bodyText+=t+' ';};
  while(i<text.length){
   if(++nodes>30000||stack.length>128)fail('html-limit');
   if(text.startsWith('<!--',i)){const end=text.indexOf('-->',i+4);if(end<0)fail('html-comment-unclosed');i=end+3;continue;}
   const doc=/^<!doctype\s+html\s*>/i.exec(text.slice(i));if(doc){i+=doc[0].length;continue;}
   if(text[i]!=='<'){const end=text.indexOf('<',i);add(text.slice(i,end<0?text.length:end));i=end<0?text.length:end;continue;}
   const close=/^<\/([a-z][a-z0-9:-]*)\s*>/i.exec(text.slice(i));
   if(close){const n=stack.pop();if(!n||n.tag!==close[1].toLowerCase())fail('html-unbalanced');if(['h1','h2'].includes(n.tag)&&!n.ignore)data[n.tag].push(brief(n.text));if(n.tag==='head'&&seen.head===1&&!seen.body&&stack.length===1&&stack[0].tag==='html')completedHead={title:[...data.title],description:[...data.description],robotsMeta:data.robotsMeta.map(m=>({...m})),jsonLd:[...data.jsonLd],conditionalContent:data.conditionalContent};i+=close[0].length;continue;}
   const open=/^<([a-z][a-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(text.slice(i));if(!open)fail('html-token-unsupported');
   const tag=open[1].toLowerCase();let attr=open[2];if(/\/\s*$/.test(attr)){if(!voids.has(tag))fail('html-self-closing-unsupported');attr=attr.replace(/\/\s*$/,'');}const a=attributes(attr);i+=open[0].length;
   if(!new Set('html head body title meta link base script style textarea noscript div span p h1 h2 h3 h4 h5 h6 section article main header footer nav aside address blockquote figure figcaption ul ol li dl dt dd a strong em b i u s small br hr img input label form button pre code time abbr cite q mark wbr details summary picture source track video audio canvas'.split(' ')).has(tag))fail('html-element-unsupported');
   if(tag in seen){if(++seen[tag]!==1)fail('html-duplicate-root');if(tag==='html'&&stack.length)fail('html-root-position');if(['head','body'].includes(tag)&&stack.at(-1)?.tag!=='html')fail('html-root-position');}
   if(tag==='head'&&seen.body)fail('html-head-position');if(tag==='body'&&seen.head!==1)fail('html-body-position');
   const head=stack.some(n=>n.tag==='head'),body=stack.some(n=>n.tag==='body');
   if(!['html','head','body'].includes(tag)&&!head&&!body)fail('html-outside-root');
   if(head&&!['title','meta','link','base','script','style','template','noscript'].includes(tag))fail('html-head-element-unsupported');
   // Browser implicit closure/reparenting cases must not yield confident findings.
   if(stack.some(n=>n.tag==='p')&&['p','div','section','article','h1','h2','h3','h4','h5','h6','ul','ol','form','address','aside','blockquote','details','dl','dt','dd','figure','figcaption','footer','header','hr','li','main','nav','pre','summary'].includes(tag))fail('html-implied-close');
   if(['a','button','form','li','dt','dd','h1','h2'].includes(tag)&&stack.some(n=>n.tag===tag))fail('html-implied-close');
   if(/^h[1-6]$/.test(tag)&&stack.some(n=>/^h[1-6]$/.test(n.tag)))fail('html-implied-close');
   if(['dt','dd'].includes(tag)&&stack.some(n=>['dt','dd'].includes(n.tag)))fail('html-implied-close');
   const hidden=('hidden' in a)||a['aria-hidden']==='true',ignore=excluded()||hidden;
   if(tag==='meta'){
    if(a.charset&&!/^(utf-8|utf8|us-ascii)$/i.test(a.charset))fail('unsupported-charset');
    if(a['http-equiv']?.toLowerCase()==='content-type')fail('html-legacy-charset-unsupported');
    if(a.name?.toLowerCase()==='description'){if(!head)fail('html-metadata-position');data.description.push(a.content??'');}
    if(/^(robots|googlebot|bingbot|maechultechnicalscanner)$/i.test(a.name??''))data.robotsMeta.push({name:a.name,content:a.content??''});
   }
   if(tag==='title'&&!head)fail('html-title-position');
   if(tag==='noscript'){
    // Treat fallback as conditional, never as active metadata or body evidence.
    // Validate it in both scripting interpretations before skipping the raw block.
    const endRe=/<\/noscript\s*>/ig;endRe.lastIndex=i;const end=endRe.exec(text);if(!end)fail('html-noscript-unclosed');const raw=text.slice(i,end.index);
    if(/<\/?noscript\b/i.test(raw))fail('html-noscript-nested');
    if(head){const rest=raw.replace(/<!--[\s\S]*?-->/g,'').replace(/<(?:meta|link)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,'');if(rest.trim())fail('html-noscript-head-unsupported');}
    else if(/<\/?(?:html|head|body|script|style|textarea|title)\b/i.test(raw)||(/<[a-z]/i.test(raw)&&stack.some(n=>['p','a','button','form','h1','h2','h3','h4','h5','h6'].includes(n.tag))))fail('html-noscript-body-unsupported');
    const fallback=inspectHtml(head?'<html><head>'+raw+'</head><body></body></html>':'<html><head></head><body>'+raw+'</body></html>');
    if(!fallback.known)fail('html-noscript-fallback-unsupported');
    if(raw.trim())data.conditionalContent=true;
    if(fallback.robotsMeta.length)data.conditionalNoindex=true;
    if(fallback.description.length)data.conditionalDescription=true;
    // Scripts/JSON-LD and title are outside the supported fallback grammar.
    // Fully validated plain-text fallback cannot hide such elements.
    i=endRe.lastIndex;continue;
   }
   if(['script','style','textarea','title'].includes(tag)){
    const re=new RegExp('<\\/'+tag+'\\s*>','ig');re.lastIndex=i;const end=re.exec(text);if(!end)fail('html-raw-unclosed');const raw=text.slice(i,end.index);
    if(tag==='script'&&/<!--|<script/i.test(raw))fail('html-script-escaping-unsupported');
    if(tag==='script'&&a.type?.toLowerCase()==='application/ld+json')data.jsonLd.push(raw);
    if(tag==='title')data.title.push(brief(entities(raw)));
    if(tag==='textarea'&&!ignore&&body)data.bodyText+=entities(raw)+' ';
    i=re.lastIndex;continue;
   }
   if(!voids.has(tag))stack.push({tag,text:'',hidden,ignore});
  }
  if(stack.length||Object.values(seen).some(n=>n!==1))fail('html-structure-incomplete');
  data.bodyText=data.bodyText.replace(/\s+/g,' ').trim();return {known:true,...data};
 }catch(e){return {known:false,reason:code(e),...(completedHead&&!['unsupported-charset','html-legacy-charset-unsupported'].includes(code(e))?{completedHead}:{})};}
}
function structured(blocks){let invalid=false,found=false,count=0;for(const text of blocks){let value;try{value=JSON.parse(text);}catch{invalid=true;continue;}const queue=[{x:value,context:null}];while(queue.length){const {x,context}=queue.pop();if(++count>10000)return {known:false,found};if(!x||typeof x!=='object')continue;const ctx=x['@context']??context,types=Array.isArray(x['@type'])?x['@type']:[x['@type']];if(types.some(t=>typeof t==='string'&&((typeof ctx==='string'&&/^https?:\/\/schema\.org\/?$/.test(ctx)&&['LocalBusiness','Organization'].includes(t))||/^https?:\/\/schema\.org\/(LocalBusiness|Organization)$/.test(t))))found=true;for(const child of Object.values(x))if(child&&typeof child==='object')queue.push({x:child,context:ctx});}}return {known:!invalid,found};}
const noindex=v=>/(?:^|[\s,:;])(?:noindex|none)(?:$|[\s,;])/i.test(v??'');
const definitions=[['accessibility','공개 페이지 접근'],['mainFacts','정적 본문 정보 텍스트'],['noindex','noindex 지시'],['robots','robots.txt 접근 정책'],['structuredData','업체 정보를 설명하는 JSON-LD'],['sitemap','사이트맵'],['metadata','title / description'],['contentStructure','h1 / h2 / body'],['llmsTxt','llms.txt 참고 파일']];
function defaultImprovement(key,status,evidence){
 if(status==='unknown'||status==='blocked')return '확인할 수 없는 설정이나 접근 제한의 원인을 먼저 확인하세요.';
 if(key==='noindex')return status==='present'?'비공개 의도인지 확인하고 공개 검색을 원하는 경우에만 해당 noindex 설정을 검토하세요.':'읽은 헤더와 지원하는 메타 태그에 noindex가 발견되지 않았습니다. 색인 여부는 별도 확인하세요.';
 if(key==='robots')return /(?:Googlebot|Bingbot|OAI-SearchBot|GPTBot|ClaudeBot):disallow/.test(evidence)?'제한된 봇과 경로를 확인하고 운영 목적에 맞을 때만 robots.txt 정책을 조정하세요.':'검사한 봇과 경로별 접근 정책을 운영 목적에 맞게 확인하세요.';
 if(key==='structuredData')return status==='absent'?'사업 유형에 적합할 때 공개 정보와 일치하는 구조화 데이터 추가를 검토하세요.':'업체 정보가 실제 공개 내용과 일치하는지 별도 확인하세요.';
 if(key==='sitemap')return status==='absent'?'다른 사이트맵이 이미 있는지 확인한 뒤 필요한 경우만 경로와 안내를 정리하세요.':'검색 도구 제출 여부와 실제 색인 상태는 별도로 확인하세요.';
 if(key==='llmsTxt')return '참고용 파일이며 필수 요건이 아닙니다. AI 추천이나 검색 노출 효과는 확인하지 않았습니다.';
 if(key==='accessibility')return status==='present'?'다른 사용자·검색봇 환경이나 로그인 여부는 별도로 확인하세요.':'요청한 정확한 주소와 공개 서버의 응답 상태를 확인하세요.';
 return '해당 항목이 실제 사업 정보와 일치하고 충분한지 확인하세요.';
}
let activeScans=0;
export async function scanTechnical(targetUrl,options={}){
 const result={targetUrl:typeof targetUrl==='string'?targetUrl:'',items:definitions.map(([key,label])=>({key,label,status:'unknown',evidence:'확인하지 않았습니다.',improvement:'공개 HTTP 응답 확인이 필요합니다.',sourceUrl:''})),warnings:['정적 HTTP 검사이며 검색 노출·순위·사업 사실의 정확성을 보장하지 않습니다.','llms.txt는 참고용이며 필수 요건이나 점수 항목이 아닙니다.']};
 const set=(key,status,evidence,sourceUrl,improvement='')=>Object.assign(result.items.find(i=>i.key===key),{status,evidence:brief(evidence),sourceUrl,improvement:improvement||defaultImprovement(key,status,evidence)});
 let target;try{target=validateTarget(targetUrl);result.targetUrl=target.href;}catch(e){result.targetUrl='';for(const i of result.items)set(i.key,'blocked','요청하지 않음: '+code(e),'');return result;}
 if(activeScans>=4){for(const i of result.items)i.evidence='동시 점검 한도에 도달했습니다.';return result;}activeScans++;
 const timeoutMs=bound(options.timeoutMs,5000,10000),totalMs=bound(options.totalTimeoutMs,20000,30000),maxBytes=bound(options.maxBytes,524288,1048576),maxRequests=bound(options.maxRequests,8,12),maxRedirects=Number.isInteger(options.maxRedirects)&&options.maxRedirects>=0?Math.min(options.maxRedirects,3):3;
 const transport=options.transport??defaultTransport,start=Date.now();let requests=0;
 const get=async(input,policy)=>{
  let u=validateTarget(input),redirects=0;
  while(true){
   if(u.origin!==target.origin)fail('cross-origin-not-allowed');
   if(policy){const d=robotsDecision(policy,u.href);if(!d.known)fail('robots-unknown');if(!d.allowed)fail('robots-disallowed');}
   if(++requests>maxRequests)fail('request-limit');const remaining=totalMs-(Date.now()-start);if(remaining<=0)fail('total-timeout');
   const ms=Math.min(timeoutMs,remaining),controller=new AbortController();let timer,r;
   try{r=await Promise.race([Promise.resolve().then(()=>transport(u.href,{timeoutMs:ms,maxBytes,signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ScanError('timeout'));},ms);})]);}finally{clearTimeout(timer);}
   if(!r||!Number.isInteger(r.status)||r.status<100||r.status>599)fail('invalid-response');
   const headers=normalizeHeaders(r.headers),body=Buffer.isBuffer(r.body)?r.body:Buffer.from(r.body??'');if(body.length>maxBytes)fail('body-limit');if(headers['content-encoding']&&!/^identity$/i.test(headers['content-encoding']))fail('unsupported-content-encoding');
   r={status:r.status,headers,body,url:u.href};
   if([301,302,303,307,308].includes(r.status)){if(++redirects>maxRedirects)fail('redirect-limit');if(!headers.location)fail('redirect-without-location');let next;try{next=new URL(headers.location,u).href;}catch{fail('invalid-redirect');}u=validateTarget(next);continue;}return r;
  }
 };
 const err=(key,e,url)=>set(key,['robots-disallowed','unsafe-ip','unsafe-dns','unsafe-hostname','unsafe-scheme','credentials-not-allowed','ipv6-not-supported','nonstandard-port','cross-origin-not-allowed','remote-address-mismatch'].includes(code(e))?'blocked':'unknown','확인하지 못함: '+code(e),url,'접근 정책과 공개 응답을 확인하세요.');
 try{
  const robotsUrl=new URL('/robots.txt',target).href;let policy;
  try{const r=await get(robotsUrl);if(missing(r)){policy={known:true,rules:[],sitemaps:[]};set('robots','absent','robots.txt HTTP '+r.status+'; 제한 규칙 파일 없음.',r.url);}else if(!ok(r))set('robots',denied(r)?'blocked':'unknown','robots.txt HTTP '+r.status+'; 후속 요청 중단.',r.url);else if(!mime(r,'text/plain'))set('robots','unknown','robots.txt가 text/plain이 아니므로 해석하지 않음.',r.url);else{const text=decode(r);policy=parseRobots(text,r.url);const d=robotsDecision(policy,target.href);const bots=['Googlebot','Bingbot','OAI-SearchBot','GPTBot','ClaudeBot'].map(agent=>{const b=robotsDecision(parseRobots(text,r.url,agent),target.href);return agent+':'+(!b.known?'unknown':b.allowed?'allow':'disallow');}).join(', ');set('robots',!d.known?'unknown':d.allowed?'present':'blocked',d.known?'HTTP '+r.status+'; 검사기 '+d.evidence+'; 요청 URL에 한함; '+bots:'robots 해석 불가: '+policy.reason,r.url);}}catch(e){err('robots',e,robotsUrl);}
  if(!policy?.known){for(const i of result.items)if(i.key!=='robots')set(i.key,'unknown','robots 정책 미확인으로 요청하지 않음.',target.href);return result;}
  const htmlKeys=['mainFacts','noindex','structuredData','metadata','contentStructure'];
  try{
   const r=await get(target.href,policy);
   if(!ok(r)){set('accessibility',missing(r)?'absent':denied(r)?'blocked':'unknown','페이지 HTTP '+r.status,r.url);for(const k of htmlKeys)set(k,denied(r)?'blocked':'unknown','정상 페이지를 읽지 못함: HTTP '+r.status,r.url);}
   else{
    set('accessibility','present','공개 GET에 HTTP '+r.status+' 응답. 렌더링·실제 로그인 화면 여부는 미평가.',r.url);
    let h;try{h=mime(r,'text/html')?inspectHtml(decode(r)):{known:false,reason:'not-text-html'};}catch(e){h={known:false,reason:code(e)};}
    const header=noindex(r.headers['x-robots-tag']);if(header)set('noindex','present','X-Robots-Tag: '+r.headers['x-robots-tag']+'; 적용 범위는 원문에 따름.',r.url);
    if(!h.known){
     for(const k of htmlKeys)if(!(header&&k==='noindex'))set(k,'unknown','HTML을 신뢰성 있게 해석하지 못함: '+h.reason,r.url);
     // Only the immutable, explicitly closed head is eligible for partial proof.
     // Never turn a partial document into negative noindex/JSON-LD findings.
     if(h.completedHead){
      const head=h.completedHead,t=head.title.filter(Boolean),d=head.description.filter(x=>x.trim());
      if(t.length&&d.length)set('metadata','present','완결된 head에서 확인; 본문 미확인 ('+h.reason+'). title: '+t[0]+'; description: '+d[0],r.url,'title과 description을 각각 확인하세요.');
      const meta=head.robotsMeta.find(m=>noindex(m.content));if(!header&&meta)set('noindex','present','완결된 head에서 meta '+meta.name+': '+meta.content+'; 본문 미확인 ('+h.reason+').',r.url);
      if(structured(head.jsonLd).found)set('structuredData','present','완결된 head의 파싱된 JSON-LD에 schema.org LocalBusiness/Organization 타입 있음. 본문 미확인 ('+h.reason+'); 내용 정확성 미검증.',r.url);
     }
    }
    else{
     set('mainFacts',h.bodyText||h.conditionalContent?'unknown':'absent',h.bodyText?'정적 body 텍스트: '+brief(h.bodyText).slice(0,160)+'; 사실의 진실성·충분성은 미평가.':h.conditionalContent?'noscript 조건부 내용은 본문 정보의 존재·부재 판단에서 제외함.':'명시적 body에서 정적 텍스트를 찾지 못함.',r.url,'사업명·서비스·위치·연락처의 정확성과 충분성은 별도 확인하세요.');
     const meta=h.robotsMeta.find(m=>noindex(m.content));if(!header)set('noindex',meta?'present':h.conditionalNoindex?'unknown':'absent',meta?'meta '+meta.name+': '+meta.content:h.conditionalNoindex?'noscript 조건부 robots meta가 있어 noindex 부재를 확정하지 않음.':'읽은 헤더와 지원하는 robots meta에서 noindex/none 없음. 색인 가능 보장은 아님.',r.url);
     const j=structured(h.jsonLd);set('structuredData',j.found?'present':j.known&&h.jsonLd.length===0?'absent':'unknown',j.found?'파싱된 JSON-LD에 schema.org LocalBusiness/Organization 타입 있음. 내용의 정확성·적합성 미검증.':j.known&&h.jsonLd.length===0?'지원 JSON-LD에서 schema.org LocalBusiness/Organization 타입을 찾지 못함. JSON-LD 블록 없음.':'JSON-LD가 있으나 업체 유형·하위 유형인지 확정하지 못했거나 해석에 실패함.',r.url);
     const t=h.title.filter(Boolean),d=h.description.filter(x=>x.trim());set('metadata',t.length&&d.length?'present':!t.length&&!d.length&&!h.conditionalDescription?'absent':'unknown','title: '+(t[0]??'없음')+'; description: '+(d[0]??'없음'),r.url,'title과 description을 각각 확인하세요.');
     const h1=h.h1.filter(Boolean),h2=h.h2.filter(Boolean);set('contentStructure',h1.length&&h2.length&&h.bodyText?'present':!h1.length&&!h2.length&&!h.bodyText&&!h.conditionalContent?'absent':'unknown','h1: '+(h1[0]??'없음')+'; h2: '+(h2[0]??'없음')+'; body 텍스트: '+(h.bodyText?'있음':'없음'),r.url,'페이지 내용에 맞는 제목 계층과 정적 본문을 확인하세요.');
    }
   }
  }catch(e){for(const k of ['accessibility',...htmlKeys])err(k,e,target.href);}
  let sitemapUrl=new URL('/sitemap.xml',target).href;
  if(policy.sitemaps.length)try{sitemapUrl=validateTarget(policy.sitemaps[0]).href;}catch(e){sitemapUrl=null;err('sitemap',e,robotsUrl);}
  if(sitemapUrl)try{const r=await get(sitemapUrl,policy),declared=policy.sitemaps.length>0;if(missing(r))set('sitemap',declared?'unknown':'absent',(declared?'robots.txt 선언이 있으나 ':'관례 경로 ')+ 'HTTP '+r.status+'; 다른 사이트맵은 미확인.',r.url);else if(!ok(r))set('sitemap',denied(r)?'blocked':'unknown','사이트맵 HTTP '+r.status,r.url);else{const xml=inspectSitemap(decode(r));const supported=mime(r,'application/xml')||mime(r,'text/xml');set('sitemap',supported&&xml.known?'present':'unknown',supported&&xml.known?'HTTP '+r.status+'; 제한적 XML 파서로 '+xml.root+' 루트와 사이트맵 네임스페이스, 문서 구조 확인. 제출·검색 반영은 미검증.':'HTTP '+r.status+'; 사이트맵 형식 미확정: '+(supported?xml.reason:'unsupported-content-type')+(declared?'; robots.txt 선언 있음.':'.'),r.url);}}catch(e){err('sitemap',e,sitemapUrl);}
  const llmsUrl=new URL('/llms.txt',target).href;
  try{const r=await get(llmsUrl,policy);if(missing(r))set('llmsTxt','absent','/llms.txt HTTP '+r.status+'; 참고 파일이며 필수 요건 아님.',r.url);else if(!ok(r))set('llmsTxt',denied(r)?'blocked':'unknown','llms.txt HTTP '+r.status,r.url);else if(!mime(r,'text/plain'))set('llmsTxt','unknown','HTTP '+r.status+'이나 text/plain이 아니므로 파일로 확정하지 않음.',r.url);else{const text=decode(r);set('llmsTxt','present',text.trim()?'HTTP '+r.status+' text/plain 참고 파일 확인. AI 추천·노출 효과 미평가.':'HTTP '+r.status+' text/plain 참고 파일은 있으나 내용은 비어 있음.',r.url);}}catch(e){err('llmsTxt',e,llmsUrl);}
  return result;
 }finally{activeScans--;}
}

// Restricted XML subset; no DTD, entities, remote contexts or parser recovery.
export function inspectSitemap(text){
 try{
  if(typeof text!=='string'||text.length>1048576||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))fail('xml-limit');
  let s=text.replace(/^\uFEFF/,'');
  const decl=/^\s*<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])(?:UTF-8|utf-8)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/.exec(s);if(decl)s=s.slice(decl[0].length);
  let i=0,root=null,closed=false,count=0;const stack=[];
  const decodeXml=v=>{if(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(v))fail('xml-entity-unsupported');return v.replace(/&(amp|lt|gt|quot|apos);/g,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[n]));};
  const finish=n=>{const value=n.text.trim();if(['urlset','sitemapindex','url','sitemap'].includes(n.tag)){if(value)fail('xml-container-text');if(['url','sitemap'].includes(n.tag)&&n.locs!==1)fail('xml-location-missing');}else{if(!value)fail('xml-empty-value');if(n.tag==='loc'){let u;try{u=new URL(value);}catch{fail('xml-location-invalid');}if(!['http:','https:'].includes(u.protocol))fail('xml-location-invalid');}}};
  while(i<s.length){
   if(++count>30000||stack.length>8)fail('xml-limit');
   if(s.startsWith('<!--',i)){const end=s.indexOf('-->',i+4);if(end<0||s.slice(i+4,end).includes('--'))fail('xml-comment-invalid');i=end+3;continue;}
   if(s[i]!=='<'){const end=s.indexOf('<',i),raw=s.slice(i,end<0?s.length:end);if(raw.includes(']]>'))fail('xml-text-invalid');const value=decodeXml(raw);if(stack.length)stack.at(-1).text+=value;else if(value.trim())fail('xml-outside-root');i=end<0?s.length:end;continue;}
   const close=/^<\/([A-Za-z][A-Za-z0-9]*)\s*>/.exec(s.slice(i));if(close){const n=stack.pop();if(!n||n.tag!==close[1])fail('xml-unbalanced');finish(n);if(!stack.length)closed=true;i+=close[0].length;continue;}
   const open=/^<([A-Za-z][A-Za-z0-9]*)(\s[^<>]*?)?(\/?)>/.exec(s.slice(i));if(!open)fail('xml-unsupported');const tag=open[1],a=open[2]??'',self=!!open[3],parent=stack.at(-1);
   if(!parent){if(root||closed||!['urlset','sitemapindex'].includes(tag))fail('xml-root-invalid');if(!/^\s+xmlns\s*=\s*(["'])http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9\1\s*$/.test(a))fail('xml-namespace-unsupported');root=tag;}
   else{if(a.trim())fail('xml-attribute-unsupported');const allowed={urlset:['url'],sitemapindex:['sitemap'],url:['loc','lastmod','changefreq','priority'],sitemap:['loc','lastmod']}[parent.tag]??[];if(!allowed.includes(tag))fail('xml-child-unsupported');if(parent.children.has(tag)&&!['url','sitemap'].includes(tag))fail('xml-duplicate-element');parent.children.add(tag);if(tag==='loc')parent.locs++;}
   const n={tag,text:'',locs:0,children:new Set()};if(self){finish(n);if(!parent)closed=true;}else stack.push(n);i+=open[0].length;
  }
  if(!root||!closed||stack.length)fail('xml-incomplete');return {known:true,root};
 }catch(e){return {known:false,reason:code(e)};}
}
