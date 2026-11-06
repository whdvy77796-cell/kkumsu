import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ix=process.argv.indexOf('--out');
if(ix<0||!process.argv[ix+1])throw new Error('Usage: node scripts/build-ui-v4-qa.mjs --out ABSOLUTE_TEMP_DIRECTORY');
const out=path.resolve(process.argv[ix+1]);
if(out===root||out.startsWith(path.join(root,'public')))throw new Error('Never output QA into public/');
await fs.mkdir(out,{recursive:true});
const [html,css,js]=await Promise.all(['public/index.html','public/style.css','public/app.js'].map(p=>fs.readFile(path.join(root,p),'utf8')));
const prompt='지원 직무와 관련하여 문제를 발견하고 개선한 경험을 작성해주세요.';
const original='카페에서 아르바이트를 하며 바쁜 시간에 동료들과 협력했습니다. 주문이 몰리면 컵과 뚜껑을 찾는 일이 반복되어 준비가 늦어졌습니다. 저는 주문이 많아지기 전에 컵과 뚜껑을 함께 준비했습니다. 그리고 동료에게 준비 순서를 공유했습니다. 이 경험으로 협력이 중요하다는 것을 느꼈습니다.';
const revised='카페 아르바이트 중 주문이 몰릴 때마다 컵과 뚜껑을 찾느라 준비가 늦어지는 문제를 발견했습니다. 저는 바쁜 시간에 앞서 컵과 뚜껑을 함께 준비하고, 동료에게 준비 순서를 공유했습니다. 이 경험을 통해 협력은 반복되는 불편을 살피고, 함께 일하는 방식을 구체적으로 나누는 데서 시작된다는 것을 배웠습니다.';
const checks=['fit','logic','evidence','wording','spelling','length'].map((key,i)=>({key,label:['문항 적합성','논리·본인 역할','원문 근거','자연스러운 문장','맞춤법','분량'][i],status:'pass'}));
const resultId='a219377a-9baf-4e0b-b5cc-44d7cc517a34';
const full={product:'revision',source:'ai',resultId,access:'full',sections:[{id:'p1',heading:prompt,text:revised,charLimit:600}],quality:{checks,repairAttempted:false},revision:{lengthMode:'characters',limit:600,originalLength:[...original].length,revisedLength:[...revised].length,changes:[{category:'logic',before:'이 경험으로 협력이 중요하다는 것을 느꼈습니다.',after:'이 경험을 통해 협력은 반복되는 불편을 살피고, 함께 일하는 방식을 구체적으로 나누는 데서 시작된다는 것을 배웠습니다.',reason:'막연한 소감을 준비·공유 행동에서 얻은 배움과 연결했습니다.'}],diagnosis:[{category:'logic',problem:'마무리가 추상적입니다.',suggestion:'본인의 행동과 배운 점을 연결합니다.'}],confirmedFacts:[],warnings:['제출 전 실제 경험과 맞는지 직접 확인해주세요.']},review:{},sources:[],privacy:{autoDeleteOnDelivery:true}};
const preview={product:'revision',resultId,access:'preview',sections:[{id:'p1',heading:prompt,charCount:[...revised].length,charLimit:600,segments:[{kind:'visible',text:revised.slice(0,Math.floor(revised.length*.2))},{kind:'locked',lines:5}]}],quality:{checks},revisionSummary:{lengthMode:'characters',limit:600,originalLength:[...original].length,revisedLength:[...revised].length,changeCount:1,diagnosisCategories:['logic']},purchase:{amount:3000,currency:'KRW',mode:'disabled',ready:false,disabledReason:'로컬 QA: 실제 결제는 비활성화되어 있습니다. 결제 우회는 제공하지 않습니다.'},privacy:{autoDeleteOnDelivery:true}};
function stub(config){
 if(location.protocol!=='file:')throw new Error('QA STUB REQUIRES file:');
 const calls=[];let posts=0,deletes=0;
 Object.defineProperty(window,'__V4_QA_CALLS__',{value:calls});
 window.fetch=async(input,options={})=>{
  const url=typeof input==='string'?input:input.url,method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
  calls.push({url,method,body});
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  if(!String(url).startsWith('/api/'))throw new Error('QA blocks all non-stub requests');
  if(method==='DELETE'){deletes++;if(config.scenario==='delete-failure'&&deletes===1)return reply({error:'QA simulated deletion failure'},503);if(url==='/api/insosoe'&&!['cache','revision'].includes(body?.scope))return reply({error:'Expected cache or revision scope'},400);return reply({deleted:true,cacheCleared:true});}
  if(url==='/api/insosoe'&&method==='GET')return reply({product:'revision',ready:config.scenario!=='budget-disabled',freeAvailable:true,paymentReady:false,paymentMode:'disabled',message:config.scenario==='budget-disabled'?'로컬 QA: AI 예산 한도에 도달했습니다. 입력과 가상 예시는 이용할 수 있어요.':'로컬 QA입니다.',offer:{version:'v4-revision-3000',amount:3000,currency:'KRW',freePreviewLimit:1},latestResultId:config.full.resultId,privacy:{autoDeleteOnDelivery:true}});
  if(url==='/api/insosoe'&&method==='POST'){posts++;if(config.scenario==='network-retry'&&posts===1)return reply({error:'로컬 QA: 첫 응답 확인 실패. 같은 요청을 재시도해주세요.'},503);if(body?.action!=='revise'||body?.offerVersion!=='v4-revision-3000'||body?.product!=='free')return reply({error:'Contract mismatch'},400);if(config.scenario==='needs-input'&&body.clarificationRound===0)return reply({source:'ai',product:'revision',status:'needs_input',questions:[{id:'q1',question:'컵과 뚜껑을 함께 준비한 것은 본인의 제안이었나요?',reason:'지원자 본인의 역할을 확인합니다.'},{id:'q2',question:'동료에게 준비 순서를 어떻게 공유했나요?',reason:'원문에 없는 공유 방법을 임의로 추가하지 않습니다.'},{id:'q3',question:'직접 확인한 변화가 있다면 알려주세요.',reason:'확인되지 않은 성과나 숫자는 작성하지 않습니다.'}],message:'최대 세 가지 사실만 추가 확인합니다.',freeAvailable:true});return reply(config.preview);}
  if(String(url).startsWith('/api/payment')&&method==='GET')return reply(['full','delete-failure'].includes(config.scenario)?config.full:config.preview);
  return reply({error:'QA: payment operations are disabled'},403);
 };
 document.addEventListener('click',e=>{if(e.target?.id!=='qa-fill')return;for(const [id,value] of Object.entries({prompt:config.prompt,originalText:config.original,role:'매장 운영'})){const node=document.getElementById(id);if(node){node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));}}});
}
const scenarios=['preview','needs-input','full','delete-failure','budget-disabled','network-retry'];
for(const scenario of scenarios){
 const injection='('+stub.toString()+')('+JSON.stringify({scenario,full,preview,prompt,original}).replaceAll('<','\\u003c')+');';
 let result=html.replace('<link rel="stylesheet" href="/style.css">','<style>'+css+'</style>').replace('<script type="module" src="/app.js"></script>','<script>'+injection+'</script><script type="module">'+js.replaceAll('</script','<\\/script')+'</script>').replace('<link rel="icon" href="/logo.svg" type="image/svg+xml">','');
 result=result.replace('<body>','<body><aside style="padding:10px 18px;background:#743a27;color:white;font:13px/1.7 sans-serif">로컬 QA · '+scenario+' · 외부 API/AI/결제 호출 없음 <button type="button" id="qa-fill" style="margin-left:12px;padding:5px 10px">입력 화면에 가상 원문 채우기</button></aside>');
 await fs.writeFile(path.join(out,'v4-'+scenario+'.html'),result);
}
await fs.writeFile(path.join(out,'README.md'),['# V4 UI QA: fixed stub, not real AI','Open with file://. All requests intercepted.','preview: input, QA fill, 3 consents, submit. <=25% visible and payment disabled.','needs-input: same flow; max3 optional questions, one round.','full: click 결제·결과 확인. Approved fixture, auto deletes.','delete-failure: same, first delete fails then retry succeeds.','budget-disabled: input and virtual sample accessible, real submit disabled.','network-retry: first submit fails; repeat preserves requestId.','Inspect window.__V4_QA_CALLS__ for request contract.','Keyboard policy modal: Tab, Shift+Tab, Escape, return focus.','Widths 1440px/390px. Never deploy QA output.'].join('\n'));
console.log(JSON.stringify({out,files:scenarios.map(s=>'v4-'+s+'.html'),realApiCalls:0,realPayments:0},null,2));
