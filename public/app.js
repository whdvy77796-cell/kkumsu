const $ = (q, root=document) => root.querySelector(q);
const app = $('#app');
const dialog = $('#dialog');
const count = value => [...String(value || '')].length;
const measure = (value, mode) => mode === 'utf8-bytes' ? new TextEncoder().encode(value).length : count(mode === 'no-spaces' ? value.replace(/\s/g, '') : value);
const unit = mode => mode === 'utf8-bytes' ? '바이트' : '자';
const labels = {fit:'문항 적합성',logic:'논리·본인 역할',evidence:'원문 근거',wording:'문장 표현',spelling:'맞춤법',length:'분량'};
const sample = {
 prompt:'지원 직무와 관련하여 문제를 발견하고 개선한 경험을 작성해주세요.',role:'매장 운영',organization:'',posting:'',lengthMode:'characters',limit:600,
 originalText:'카페에서 아르바이트를 하며 바쁜 시간에 동료들과 협력했습니다. 주문이 몰리면 컵과 뚜껑을 찾는 일이 반복되어 준비가 늦어졌습니다. 저는 주문이 많아지기 전에 컵과 뚜껑을 함께 준비했습니다. 그리고 동료에게 준비 순서를 공유했습니다. 이 경험으로 협력이 중요하다는 것을 느꼈습니다.',
 revised:'카페 아르바이트 중 주문이 몰릴 때마다 컵과 뚜껑을 찾느라 준비가 늦어지는 문제를 발견했습니다. 저는 바쁜 시간에 앞서 컵과 뚜껑을 함께 준비하고, 동료에게 준비 순서를 공유했습니다. 이 경험을 통해 협력은 반복되는 불편을 살피고, 함께 일하는 방식을 구체적으로 나누는 데서 시작된다는 것을 배웠습니다.'
};
const emptyInput = () => ({prompt:'',originalText:'',organization:'',role:'',posting:'',lengthMode:'characters',limit:null});
let S = {view:'home',input:emptyInput(),checks:{},questions:[],answers:[],round:0,busy:false,error:'',result:null,sample:false,pending:null,deletion:{state:'idle',payment:false,cache:false},paymentBusy:false,callback:null,leaving:false};
let server = {loading:true,ready:false,freeAvailable:true,paymentReady:false,paymentMode:'disabled'};
let statusConfirmed = false;
let consentTarget = null;
let fileReading=false, fileReadVersion=0, fileMessage='';
const modelIdentity = () => JSON.stringify([String(server.provider||'').trim().toLowerCase(),String(server.model||'').trim().toLowerCase()]);
function aiLabels(){
 const claude=statusConfirmed && /^(?:anthropic\/)?claude[-.]/i.test(String(server.model||'').trim());
 const name=claude?'Claude':'AI';
 const provider=statusConfirmed?String(server.provider||'').trim().toLowerCase():'';
 const recipient=({openrouter:'OpenRouter 및 AI 처리 제공업체',anthropic:'Anthropic',vercel:'Vercel AI Gateway 및 AI 처리 제공업체'})[provider]||'외부 AI 처리 제공업체';
 return {brand:name+' 기반 첨삭',consent:'자소서의 '+name+' 첨삭을 위해 입력 내용을 '+recipient+'에 전송하는 데 동의해요.'};
}
let dialogReturn = null;
let recoveryPending = false;
let sensitiveDialog = false;
const resultIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validLegacyFull(r){return !!r && r.access==='full' && r.product!=='revision' && r.privacy?.autoDeleteOnDelivery!==true && typeof r.resultId==='string' && resultIdPattern.test(r.resultId) && Array.isArray(r.sections) && r.sections.length>0 && r.sections.every(s=>s && typeof s.text==='string');}
function hasLegacyCode(r=S.result){return validLegacyFull(r) && typeof r.recoveryCode==='string' && r.recoveryCode.length===101 && r.recoveryCode.slice(0,36).toLowerCase()===r.resultId.toLowerCase() && /^\.[0-9a-f]{64}$/i.test(r.recoveryCode.slice(36));}
function recoveryBlocked(){return S.busy || S.paymentBusy || recoveryPending || S.deletion.state==='working';}
function clearRecoveryFields(){for(const node of dialog.querySelectorAll('[data-recovery-secret]'))node.value='';}
function recoveryActions(){return el('div',{class:'work-card'},el('div',{class:'button-row'},btn('기존 작성 결과 복구',recoveryDialog,'button secondary',recoveryBlocked()),hasLegacyCode()?btn('기존 복구코드 확인',legacyCodeDialog,'text-button',recoveryBlocked()):null),p('기존 상품의 승인된 결과만 보관 기한 안에 복구할 수 있어요. 신규 첨삭은 복구코드를 발급하지 않으며, 삭제된 결과는 복구할 수 없습니다.','fineprint'));}
function recoveryDialog(){
 if(recoveryBlocked())return;
 openDialog('기존 작성 결과 복구',p('기존 상품에서 받은 복구코드를 입력해주세요. 승인 여부와 최대 7일 보관 기한은 서버에서 확인합니다. 신규 첨삭의 코드 발급이나 새 결과 생성이 아닙니다.'),el('form',{onsubmit:e=>{e.preventDefault();recoverLegacy();}},el('div',{class:'field'},el('label',{for:'legacy-recovery-code'},'기존 복구코드'),el('input',{id:'legacy-recovery-code',type:'password',class:'text-input',autocomplete:'off',spellcheck:'false',maxlength:101,'data-recovery-secret':'',required:true})),el('p',{id:'recovery-error',class:'field-error',role:'alert'}),el('p',{id:'recovery-progress',role:'status'}),el('div',{class:'button-row'},el('button',{type:'submit',id:'recover-submit',class:'button primary'},'기존 결과 복구'),btn('취소',closeDialog,'button secondary'))));
 sensitiveDialog=true;$('#legacy-recovery-code')?.focus();
}
function legacyCodeDialog(){
 if(recoveryBlocked() || !hasLegacyCode())return;
 openDialog('기존 복구코드 확인',p('기존 승인 결과의 보관 기한 안에서만 사용할 수 있어요. 이 코드를 가진 사람은 결과에 접근할 수 있으니 공유하지 마세요. 코드가 필요한 경우 이 칸에서만 별도로 선택해 복사해주세요. 일반 본문 복사와 TXT에는 포함되지 않습니다.'),el('input',{id:'legacy-code-view',type:'text',class:'text-input',value:S.result.recoveryCode,readonly:true,autocomplete:'off',spellcheck:'false',maxlength:101,'aria-label':'기존 복구코드','data-recovery-secret':'',onfocus:e=>e.target.select()}),btn('확인',closeDialog));
 sensitiveDialog=true;
}
async function recoverLegacy(){
 if(recoveryBlocked())return;
 let input=$('#legacy-recovery-code');if(!dialog.open || !input)return;
 let code=input.value;input.value='';input=null;
 if(code.length!==101){code='';$('#recovery-error').textContent='기존 복구코드 101자를 확인하고 다시 입력해주세요.';return;}
 recoveryPending=true;S.paymentBusy=true;
 for(const node of dialog.querySelectorAll('button,input'))node.disabled=true;
 $('#recovery-error').textContent='';$('#recovery-progress').textContent='기존 승인 결과를 확인 중이에요. 확인이 끝날 때까지 이 창을 닫을 수 없어요.';
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),60000);
 let response=null,data=null,recovered=false;
 try{
  // Keep the credential only in this POST body. Do not parse or surface server error bodies.
  const pending=fetch('/api/payment',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'recover',recoveryCode:code}),signal:abort.signal});code='';
  response=await pending;if(!response.ok)throw new Error('RECOVERY_FAILED');
  data=await response.json();const result=data?.result||data;
  if(!validLegacyFull(result))throw new Error('RECOVERY_FAILED');
  acceptResult(result);S.error='';S.view='result';recovered=true;
 }catch{
  $('#recovery-error').textContent='기존 결과를 복구하지 못했어요. 코드와 보관 기한을 확인한 뒤 다시 입력해주세요. 현재 결과는 유지됩니다.';
 }finally{
  code='';data=null;response=null;clearTimeout(timer);clearRecoveryFields();recoveryPending=false;S.paymentBusy=false;
  for(const node of dialog.querySelectorAll('button,input'))node.disabled=false;
  $('#recovery-progress').textContent='';
  if(recovered){closeDialog();render();$('#main h1')?.focus();announce('기존 작성 결과를 복구했어요. 기존 보관 조건이 적용됩니다.');}
  else $('#legacy-recovery-code')?.focus();
 }
}
let sdkPromise;
// Payment credentials only live in memory; remove them before network requests or rendering.
if(['/payment/success','/payment/fail'].includes(location.pathname)){
 const params = new URLSearchParams(location.search);
 if(location.pathname === '/payment/success') S.callback = {orderId:params.get('orderId')||'',paymentKey:params.get('paymentKey')||'',amount:Number(params.get('amount'))};
 else S.error = '결제가 완료되지 않았어요. 결제 내역이 있다면 다시 결제하지 말고 상태를 확인해주세요.';
 S.view='payment'; history.replaceState(null,'','/');
}
function el(tag, attrs={}, ...children){
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(attrs)){
  if(value === null || value === undefined || value === false) continue;
  if(key==='class')node.className=value;
  else if(key==='text')node.textContent=String(value);
  else if(key.startsWith('on') && typeof value==='function')node.addEventListener(key.slice(2).toLowerCase(),value);
  else if(key==='value')node.value=value;
  else if(key==='checked'||key==='disabled')node[key]=Boolean(value);
  else node.setAttribute(key,value===true?'':String(value));
 }
 for(const child of children.flat(Infinity)) if(child !== undefined && child !== null && child !== false)node.append(child instanceof Node?child:document.createTextNode(String(child)));
 return node;
}
const p=(text,cls)=>el('p',{class:cls},text);
const btn=(text,action,cls='button primary',disabled=false)=>el('button',{type:'button',class:cls,onclick:action,disabled},text);
const link=(text,href,cls='')=>el('a',{href,class:cls},text);
const note=(title,text,kind='')=>el('div',{class:'notice '+kind},el('strong',{},title),text?p(text):null);
const announce=text=>{$('#announce').textContent=text;};
function go(view){if(S.busy||S.paymentBusy||S.deletion.state==='working')return;S.view=view;S.error='';render();$('#main h1')?.focus();window.scrollTo({top:0,behavior:'instant'});}
function paymentReason(){return S.result?.purchase?.disabledReason || server.paymentDisabledReason || '사업자·결제·운영 조건을 준비 중이라 현재 전문 결제를 받지 않습니다. 무료 미리보기 이후에도 잠긴 전문을 열 수 없어요.';}
function unavailable(){return server.loading?'AI 연결 상태를 확인하고 있어요. 입력과 가상 예시는 먼저 이용할 수 있어요.':!server.ready?(server.message||'지금은 AI 첨삭 전송을 이용할 수 없어요. 입력과 가상 예시는 계속 이용할 수 있습니다.'):server.freeAvailable===false?'이 브라우저의 첫 무료 미리보기를 이미 이용했어요. 생성한 결과는 결제·결과 확인에서 확인해주세요.':'';}
function canPay(){return !S.sample && !S.busy && !S.paymentBusy && S.deletion.state==='idle' && S.result?.access==='preview' && S.result.purchase?.ready===true && server.paymentReady===true && ['test','live'].includes(S.result.purchase?.mode||server.paymentMode);}
function header(){return el('header',{class:'site-header'},el('div',{class:'header-inner'},el('a',{href:'#',class:'brand',onclick:e=>{e.preventDefault();if(!S.busy&&!S.paymentBusy)go('home');},'aria-label':'인소서 홈'},el('span',{class:'brand-symbol','aria-hidden':'true'},'인'),el('span',{},'인소서',el('small',{},'내 경험을 더 선명하게'))),el('nav',{'aria-label':'주 메뉴'},btn('이용·보관 안내',()=>policy('privacy'),'text-button'),btn('결제·결과 확인',restore,'text-button',S.busy||S.paymentBusy||S.deletion.state==='working'))));}
function footer(){return el('footer',{class:'site-footer wrap'},el('div',{},el('strong',{},'인소서'),p('내가 쓴 이야기에서, 나다운 다음 문장으로.')),el('div',{class:'footer-links'},link('개인정보처리방침','/privacy.html'),link('이용약관·환불 안내','/terms.html'),btn('처리·보관 요약',()=>policy('privacy'),'text-button')),p('AI 결과는 제출 전 직접 확인해주세요. 사실의 진실성·정확성이나 합격을 보장하지 않습니다.','fineprint'));}
function main(...children){return el('main',{id:'main',class:'wrap',tabindex:'-1'},...children);}
function title(eyebrow,heading,description){return el('div',{class:'page-heading'},p(eyebrow,'eyebrow'),el('h1',{tabindex:'-1'},heading),description?p(description,'lead'):null);}
function home(){return inputPage();}
function field(id,label,opts={}){
 const control=el(opts.area?'textarea':'input',{id,name:id,class:'text-input',value:S.input[id]??'',rows:opts.rows||4,type:opts.area?null:opts.type||'text',min:opts.type==='number'?100:null,max:opts.type==='number'?(S.input.lengthMode==='utf8-bytes'?6000:2000):null,step:opts.type==='number'?1:null,placeholder:opts.placeholder,autocomplete:'off','aria-describedby':id+'-description '+id+'-help',required:opts.required,oninput:e=>{clearFormFeedback(e.target);if(id==='originalText'&&fileMessage){fileMessage='';const st=$('#file-status');if(st)st.textContent='';}S.input[id]=opts.type==='number'?(e.target.validity?.badInput?NaN:e.target.value===''?null:Number(e.target.value)):e.target.value;S.pending=null;S.questions=[];S.answers=[];S.round=0;updateCounts();}});
 return el('div',{class:'field '+(opts.class||'')},el('label',{for:id},label,opts.required?el('span',{class:'required'},'필수'):el('span',{class:'optional'},'선택')),control,el('p',{id:id+'-description',class:'field-help'},opts.help||''),el('span',{id:id+'-help',class:'field-count'},opts.counter?count(S.input[id])+' / '+opts.max+'자':''));
}
function fileInputPanel(){
 return el('div',{class:'file-panel'},el('div',{class:'file-panel-main'},el('div',{},el('strong',{},'파일에서 불러오기'),p('PDF · DOCX · TXT · HWPX(시험) · 최대 5MB','field-help')),el('input',{id:'essay-file',type:'file',accept:'.pdf,.docx,.txt,.hwpx,.hwp',class:'sr-only',tabindex:'-1',onchange:chooseEssayFile}),btn('파일 선택',()=>$('#essay-file')?.click(),'button secondary upload-button',fileReading)),p('파일은 브라우저에서 읽고, 불러온 글은 분석 버튼을 누를 때 전송해요. HWPX는 시험 기능이라 내용을 확인해주세요. 구형 HWP와 스캔 이미지 글자 인식은 지원하지 않아요.','file-privacy'),el('p',{id:'file-status',class:'file-status',role:'status','aria-live':'polite'},fileMessage));
}
function chooseEssayFile(e){
 const file=e.target.files?.[0];e.target.value='';if(!file||fileReading)return;
 const load=()=>{closeDialog();void importEssayFile(file);};
 if(S.input.originalText.trim())openDialog('입력한 글을 바꿀까요?',p('파일에서 불러온 글로 현재 입력 내용을 바꿉니다. 기존 내용은 이 화면에서 되돌릴 수 없어요.'),btn('불러오기',load,'button primary'),btn('취소',closeDialog,'button secondary'));
 else void importEssayFile(file);
}
async function importEssayFile(file){
 const token=++fileReadVersion,previous=S.input.originalText;fileReading=true;fileMessage='파일에서 글자를 읽고 있어요.';
 const show=()=>{const status=$('#file-status');if(status)status.textContent=fileMessage;const submit=$('#submit-revision');if(submit)submit.disabled=!!unavailable()||S.busy||fileReading;const upload=$('.upload-button');if(upload)upload.disabled=fileReading;};show();
 try{
  const {readEssayFile}=await import('./file-reader.mjs');const result=await readEssayFile(file);
  if(token!==fileReadVersion||!['home','input'].includes(S.view))return;
  if(S.input.originalText!==previous){fileMessage='읽는 동안 입력한 글이 바뀌어서 파일을 적용하지 않았어요. 다시 선택해주세요.';return;}
  if(!result||typeof result.text!=='string'||!result.text.trim())throw new Error('파일에서 글자를 찾지 못했어요. 텍스트가 있는 파일을 선택하거나 직접 붙여넣어주세요.');
  S.input.originalText=result.text;S.pending=null;S.questions=[];S.answers=[];S.round=0;const area=$('#originalText');if(area){area.value=result.text;clearFormFeedback(area);}updateCounts();
  const notices=Array.isArray(result.warnings)?result.warnings.filter(x=>typeof x==='string').slice(0,2):[];fileMessage=(count(result.text)>6000?'글을 모두 불러왔어요. 6,000자를 넘어 입력창에서 직접 줄여주세요. 자동으로 자르지 않았어요.':'글을 불러왔어요. 누락이나 순서가 없는지 확인해주세요.')+(notices.length?' '+notices.join(' '):'');
 }catch(error){if(token===fileReadVersion)fileMessage=error?.name==='FileReaderError'&&typeof error.message==='string'?error.message:'파일을 읽지 못했어요. 다른 파일을 선택하거나 글을 붙여넣어주세요.';}
 finally{if(token===fileReadVersion){fileReading=false;show();}}
}

function inputPage(){
 const form=el('form',{id:'revision-form',onsubmit:e=>{e.preventDefault();submitRevision();},novalidate:true},
 field('originalText','자기소개서',{required:true,area:true,rows:8,max:6000,counter:true,placeholder:'작성한 자기소개서를 붙여넣거나 아래에서 파일을 불러오세요.',help:'40~6,000자 · 이름·연락처·주소 등 불필요한 개인정보는 빼주세요.'}),
 fileInputPanel(),
  el('fieldset',{class:'consents'},el('legend',{},'외부 AI 전송 동의 · 필수'),el('label',{class:'check-line',for:'consent'},el('input',{type:'checkbox',id:'consent',required:true,checked:S.checks.consent,disabled:!statusConfirmed,'aria-describedby':'consent-status',onchange:e=>{clearFormFeedback(e.target);S.checks.consent=statusConfirmed && e.target.checked;consentTarget=S.checks.consent?{provider:server.provider,model:server.model}:null;S.pending=null;}}),el('span',{id:'consent-label'},aiLabels().consent)),el('p',{id:'consent-status',class:'field-help',role:'status'},statusConfirmed?'':'연결 상태 확인 후 전송 대상에 동의할 수 있어요.'),btn('처리·보관·삭제 자세히',()=>policy('privacy'),'text-button')),
 el('div',{id:'availability',class:unavailable()?'notice warning':'',role:'status'},unavailable()),
 el('div',{id:'form-error',class:'error-box',role:'alert',tabindex:'-1',hidden:!S.error},S.error),
 el('p',{id:'offer-disclosure',class:'offer-line'},'첫 자소서 분석 일부 무료 · 심층 분석과 수정본 전문 3,000원'),
 el('p',{id:'payment-availability',class:'fineprint payment-status'},server.paymentReady===true?'전문 열람은 별도 결제 승인 후 제공됩니다.':'전문 결제는 준비 중이에요.'),
 el('button',{type:'submit',class:'button primary main-cta',id:'submit-revision',disabled:!!unavailable()||S.busy,'aria-describedby':'offer-disclosure payment-availability'},'내 자소서 분석하기'),
 el('div',{class:'input-links'},btn('가상 예시 보기',showSample,'text-button'),el('button',{type:'button',id:'refresh-status',class:'text-button',onclick:checkStatus,disabled:server.loading},'연결 상태 다시 확인'),btn('입력·첨삭 결과 삭제',eraseDialog,'text-button danger',S.busy||S.paymentBusy)),
 p('무료 이용은 익명 브라우저 기준 1건이며 개인당 1회 인증이 아닙니다. 삭제해도 무료 이용 기록은 초기화되지 않아요.','fineprint'));
 return main(el('section',{class:'workspace simple-workspace'},title('AI 자소서 분석 · 인소서','자소서 하나로, 더 깊이 있게.','붙여넣거나 파일을 불러오세요. 내용의 강점과 아쉬운 점을 분석하고, 내 경험에 근거한 수정 방향을 제안해요.'),el('div',{class:'service-highlights'},el('strong',{id:'ai-brand',class:'ai-brand'},aiLabels().brand),p('전문 제공 후 서비스 서버의 자소서 콘텐츠·재시도 캐시 삭제 요청','deletion-promise'),p('삭제 성공은 서버 응답으로 확인한 뒤 안내해요.','deletion-caveat')),el('div',{class:'usage-notes'},p('취업·인턴 지원용'),p('원문 밖 사실을 추가하지 않도록 대조')),el('section',{class:'work-card input-card'},form),el('details',{class:'storage-details'},el('summary',{},'처리·보관·삭제와 무료 이용 안내'),p('입력 전 내용은 이 페이지 메모리에만 남습니다. 전송 후 서비스 서버와 외부 AI 처리업체가 처리합니다. 미결제 결과는 최대 1시간, 결제 확인 대기·미수신 승인 결과는 최대 24시간 보관합니다. 전문 수신 후 서버 삭제를 요청하며 성공 여부를 표시합니다.'),p('신규 첨삭은 복구코드를 발급하지 않습니다. 전문 수신 후에는 새로고침·닫기 전에 따로 저장해주세요. 기존 상품·쿠폰·복구는 기존 이용 조건이 적용됩니다. 거래기록·로그·백업·외부 AI 보관 정책은 별개입니다.'),link('개인정보처리방침','/privacy.html'),el('span',{},' · '),link('이용약관·환불 안내','/terms.html'))));
}
function updateCounts(){
 for(const id of ['prompt','originalText']){const node=$('#'+id+'-help');if(node)node.textContent=count(S.input[id])+' / '+(id==='prompt'?800:6000)+'자';}
 const mode=S.input.limit===null?'characters':S.input.lengthMode;
 const target=$('.count-notice');if(target)target.replaceChildren(el('strong',{},'원문의 현재 분량'),p(measure(S.input.originalText,mode).toLocaleString('ko-KR')+' '+unit(mode)+' / '+(S.input.limit===null?'제한 미설정':'상한 '+S.input.limit.toLocaleString('ko-KR')+' '+unit(mode))));
}
function validation(){const d=S.input;if(d.prompt.trim()&&(count(d.prompt.trim())<10||count(d.prompt)>800))return ['prompt','지원 문항은 비워두거나 10~800자로 입력해주세요.'];if(!d.originalText.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(d.originalText))return ['originalText','지원하지 않는 제어 문자가 포함되어 있어요. 일반 텍스트로 다시 붙여넣어 주세요.'];if(count(d.originalText.trim())<40||count(d.originalText)>6000)return ['originalText','원문을 40~6,000자로 입력해주세요.'];for(const k of ['organization','role','posting'])if(count(d[k])>(k==='posting'?3000:200))return [k,'입력 가능한 길이를 초과했어요.'];if(d.limit!==null&&(!Number.isInteger(d.limit)||d.limit<100||d.limit>(d.lengthMode==='utf8-bytes'?6000:2000)))return ['limit','분량 상한은 비워두거나 허용 범위 안의 정수로 입력해주세요.'];if(S.checks.consent!==true)return ['consent','외부 AI 전송 내용을 읽고 동의해주세요.'];return null;}
function clearFormFeedback(target){target?.removeAttribute('aria-invalid');S.error='';const node=$('#form-error');if(node){node.textContent='';node.hidden=true;}announce('');}
function formError(text,id){S.error=text;const node=$('#form-error');if(node){node.hidden=false;node.textContent=text;}const target=id?$('#'+id):node;const details=target?.closest('details');if(details)details.open=true;target?.focus();if(id)target?.setAttribute('aria-invalid','true');announce(text);}
function waiting(){return main(el('section',{class:'waiting work-card'},p('내 글의 중심을 놓치지 않도록','eyebrow'),el('div',{class:'loader','aria-hidden':'true'}),el('h1',{tabindex:'-1'},'수정과 별도 검수를 요청했어요.'),p('다음 과정을 서버에서 수행합니다.','lead'),el('ol',{class:'review-flow'},el('li',{},el('b',{},'01'),el('div',{},el('strong',{},'원문을 더 분명하게'),p('글의 구성과 근거, 문장 표현을 살펴봐요.'))),el('li',{},el('b',{},'02'),el('div',{},el('strong',{},'별도 AI 요청으로 검수'),p('원문 근거와 입력된 조건을 다시 확인해요.'))),el('li',{},el('b',{},'03'),el('div',{},el('strong',{},'필요한 경우 보완·재검수'),p('검수에서 발견된 필수 문제가 남으면 공개하지 않아요.')))),note('현재는 서버 응답을 기다리는 중이에요','브라우저에서는 한 번의 요청으로 결과를 받습니다. 세부 단계의 실시간 진행률이나 완료 시각은 제공되지 않아요.'),p('창을 닫거나 새로고침하면 입력 내용이 사라질 수 있어요.','fineprint')));}
function clarificationPage(){return main(el('section',{class:'workspace narrow'},title('추가 확인 · 최대 한 번','사실만 조금 더 알려주세요.','원문만으로 확인하기 어려운 부분이에요. 모르는 내용은 비워두고 계속할 수 있습니다.'),el('form',{class:'work-card',onsubmit:e=>{e.preventDefault();submitRevision(true);}},...S.questions.map((q,i)=>el('div',{class:'field'},el('label',{for:'answer-'+i},q.question),p(q.reason||'입력한 경험의 사실관계를 보완하기 위한 질문입니다.','field-help'),el('textarea',{id:'answer-'+i,rows:4,maxlength:500,class:'text-input',value:S.answers[i]||'',placeholder:'기억나는 사실만 적어주세요. 모르면 비워두어도 괜찮아요.',oninput:e=>{clearFormFeedback(e.target);S.answers[i]=e.target.value;S.pending=null;}}))),p('추가 답변도 같은 AI 처리·보관 조건으로 전송됩니다.','fineprint'),el('div',{id:'form-error',class:'error-box',role:'alert',tabindex:'-1',hidden:!S.error},S.error),el('div',{class:'button-row'},btn('원문 다시 확인',()=>go('input'),'button secondary'),el('button',{type:'submit',class:'button primary',disabled:S.busy},'확인한 내용으로 계속하기')))));}
async function request(url,{method='GET',body,timeout=60000}={}){const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),timeout);try{const response=await fetch(url,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:abort.signal});let data;try{data=await response.json();}catch{data={};}if(!response.ok)throw Object.assign(new Error(data.error||data.message||'요청을 완료하지 못했어요.'),{status:response.status,code:data.code});return data;}finally{clearTimeout(timer);}}
async function submitRevision(clarify=false){
 if(S.busy||S.paymentBusy||fileReading||S.deletion.state==='working')return;
 if(!clarify&&S.questions.length&&S.round===1){go('clarify');return;}
 const invalid=validation();if(invalid){if(!['home','input'].includes(S.view))go('input');formError(invalid[1],invalid[0]);return;}
 if(unavailable()){formError(unavailable());return;}
 if(!statusConfirmed||!consentTarget||consentTarget.provider!==server.provider||consentTarget.model!==server.model){S.checks.consent=false;consentTarget=null;S.pending=null;formError('AI 전송 대상을 다시 확인한 뒤 동의해주세요.','consent');return;}
 if(clarify && S.answers.some(a=>count(a)>500)){formError('추가 답변은 각각 500자 이내로 입력해주세요.');return;}
 if(!S.pending)S.pending={action:'revise',clientVersion:'simple-v3',requestId:crypto.randomUUID(),product:'free',consent:S.checks.consent===true,consentProvider:consentTarget.provider,consentModel:consentTarget.model,offerVersion:'v4-revision-3000',...S.input,prompt:'',organization:'',role:'',posting:'',lengthMode:'characters',limit:null,clarificationRound:clarify?1:0,clarifications:clarify?S.questions.map((q,i)=>({question:q.question,answer:(S.answers[i]||'').trim()})).filter(item=>item.answer.length>0):[]};
 S.busy=true;S.error='';S.sample=false;S.view='waiting';render();$('#main h1')?.focus();
 try{const data=await request('/api/insosoe',{method:'POST',body:S.pending,timeout:235000});if(data.status==='needs_input'){if(clarify||!Array.isArray(data.questions)||data.questions.length>3||data.questions.length<1)throw new Error('추가 확인 응답을 처리하지 못했어요.');S.questions=data.questions;S.answers=data.questions.map(()=> '');S.round=1;S.pending=null;S.view='clarify';}else{acceptResult(data);S.pending=null;S.view='result';}}catch(error){if(error.code==='REQUEST_FAILED')S.pending=null;if(error.code==='AI_PROVIDER_CHANGED'){S.checks.consent=false;consentTarget=null;S.pending=null;await checkStatus();}S.error=error.code==='REQUEST_FAILED'?'이전 요청은 종료됐어요. 다시 누르면 새 요청으로 진행해요.':error.code==='AI_PROVIDER_CHANGED'?'AI 전송 대상이 변경되었어요. 현재 전송 내용을 확인하고 다시 동의해주세요.':error.name==='AbortError'?'응답 확인 시간이 지났어요. 입력은 유지됩니다. 같은 요청으로 다시 확인할 수 있어요.':error.message;S.view=clarify?'clarify':'input';}finally{S.busy=false;render();$('#form-error:not([hidden])')?.focus();if(S.result?.access==='full')void deleteDelivered();}
}
function acceptResult(data){
 const r=data?.result||data;if(!r?.resultId||!['preview','full'].includes(r.access)||!Array.isArray(r.sections)||!r.sections.length)throw new Error('결과 형식을 확인하지 못했어요.');
 if(r.access==='preview'){
  if(r.sections.some(s=>typeof s.heading!=='string'||!Array.isArray(s.segments)||s.segments.some(seg=>!['visible','locked'].includes(seg.kind)||(seg.kind==='visible'&&typeof seg.text!=='string'))))throw new Error('미리보기 형식이 올바르지 않아요.');
  S.result={product:r.product,resultId:r.resultId,access:'preview',sections:r.sections.map(s=>({id:s.id,heading:s.heading,charCount:s.charCount,charLimit:s.charLimit,segments:s.segments.map(x=>x.kind==='visible'?{kind:'visible',text:x.text}:{kind:'locked',lines:Math.max(1,Math.min(8,Number(x.lines)||3))})})),quality:{checks:(r.quality?.checks||[]).map(c=>({key:c.key,label:c.label,status:c.status}))},revisionSummary:r.revisionSummary,previewDetails:previewDetailsData(r.previewDetails),purchase:r.purchase,privacy:r.privacy};
 }else{if(r.sections.some(s=>typeof s.text!=='string'))throw new Error('전문 형식이 올바르지 않아요.');S.result=r;}
 S.sample=false;S.deletion={state:'idle',payment:false,cache:false};server.freeAvailable=false;server.latestResultId=r.resultId;
}
function showSample(){if(S.busy||S.paymentBusy||S.deletion.state==='working')return;S.sample=true;go('sample');}
function samplePage(){
 const demonstration={previewDetails:{analysisPreview:{priority:'high',problem:'반복된 상황을 어떻게 바꿨는지는 드러나지만, 변화 이후의 확인 내용은 보이지 않아요.'},highlights:[{category:'logic',label:'논리와 본인 역할',text:'경험과 본인의 행동이 자연스럽게 이어지도록 살펴봤어요.'},{category:'wording',label:'문장 표현',text:'문장의 뜻이 더 분명하게 전달되도록 살펴봤어요.'}],example:{before:"카페에서 아르바이트를 하며 바쁜 시간에",after:"카페 아르바이트 중 주문이 몰릴 때마다"},exampleCategory:'wording',additionalExamples:[{before:'이 경험으로 협력이 중요하다는 것을 느꼈습니다.',after:'이 경험을 통해 협력은 반복되는 불편을 살피고, 함께 일하는 방식을 구체적으로 나누는 데서 시작된다는 것을 배웠습니다.',category:'logic',beforeTruncated:false,afterTruncated:false}],note:'미리 작성한 가상 예시입니다. 입력한 자소서를 분석한 결과나 실제 이용자·합격 사례가 아닙니다.'}};
 return main(el('section',{class:'workspace'},title('가상 예시 · AI 호출·결제 없음','내 글은 이렇게 미리 볼 수 있어요.','개선점과 수정 전후 일부를 먼저 확인하는 화면 체험입니다.'),note('고정된 가상 예시입니다','입력 내용은 읽거나 전송하지 않고, AI를 호출하지 않아요. 결제·무료 이용 횟수에도 영향을 주지 않습니다.','sample-notice'),el('div',{class:'sample-prompt'},el('span',{class:'eyebrow'},'가상 자소서 원문'),p(sample.originalText)),previewInsights(demonstration),el('article',{class:'result-paper'},el('div',{class:'result-paper-heading'},el('span',{class:'eyebrow'},'가상 잠금 화면'),el('h2',{},'나머지 전문은 미리보기에 포함되지 않아요.')),...docExcerpts({previewDetails:demonstration.previewDetails},{segments:[]}),p('아래 블러는 실제 문장을 가린 것이 아닌 가짜 표시입니다. 실제 미리보기에서도 잠긴 전문은 브라우저에 전송되지 않습니다.','fineprint'),el('div',{class:'locked-text','aria-hidden':'true'},...Array.from({length:4},(_,i)=>el('div',{class:'skeleton-line'+(i===3?' skeleton-line-short':'')})),el('span',{class:'lock-caption'},'전문 비공개 · 실제 문장이 아닌 잠금 표시입니다.'))),el('section',{class:'purchase-panel'},el('div',{},p('가상 상품 안내 · 구독 없이 자소서 1편','eyebrow'),el('h2',{},'심층 분석과 수정본 전문'),p('전체 진단 · 수정 전후 비교 · 상세 개선 방향 · TXT 저장')),el('div',{class:'purchase-price'},p('3,000원','price'),el('button',{type:'button',class:'button primary',disabled:true,'aria-describedby':'sample-payment-notice'},'전문·변경 이유 더 보기 · 3,000원')),el('div',{class:'notice warning',id:'sample-payment-notice'},el('strong',{},'전문 결제는 준비 중이에요.'),p('이 가상 예시에서는 결제하거나 전문을 열 수 없습니다. 실제 결제 승인이나 무료권 사용을 대신하지 않아요.')),p('무료는 첫 자소서 분석·첨삭 일부 미리보기이며 전문은 포함되지 않습니다. 표시된 예시는 고정된 화면 설명용입니다.','fineprint')),el('div',{class:'button-row'},btn('내 초안으로 돌아가기',()=>{S.sample=false;go('input');},'button primary'),btn('홈으로',()=>{S.sample=false;go('home');},'button secondary'))));
}
function previewDetailsData(details){
 if(!details||typeof details!=='object')return null;
 return {highlights:Array.isArray(details.highlights)?details.highlights.filter(x=>x&&typeof x.text==='string').map(x=>({category:typeof x.category==='string'?x.category:'',label:typeof x.label==='string'?x.label:'',text:x.text})):[],example:typeof details.example?.before==='string'&&typeof details.example?.after==='string'?{before:details.example.before,after:details.example.after}:null,exampleCategory:typeof details.exampleCategory==='string'?details.exampleCategory:'',exampleMarks:details.exampleMarks||null,exampleClipped:details.exampleClipped||null,additionalExamples:Array.isArray(details.additionalExamples)?details.additionalExamples.filter(x=>x&&typeof x.before==='string'&&typeof x.after==='string').slice(0,2).map(x=>({before:x.before,after:x.after,category:typeof x.category==='string'?x.category:'',beforeTruncated:x.beforeTruncated===true,afterTruncated:x.afterTruncated===true,marks:x.marks||null})):[],note:typeof details.note==='string'?details.note:'',analysisPreview:details.analysisPreview&&['high','medium','low'].includes(details.analysisPreview.priority)&&typeof details.analysisPreview.problem==='string'&&count(details.analysisPreview.problem)<=101?{priority:details.analysisPreview.priority,problem:details.analysisPreview.problem}:null};
}
// 코드포인트 단위 LCS. 결과는 {same|del|ins} 조각 목록이며 DOM에는 텍스트 노드로만 들어간다.
function diffParts(a,b){
 const x=[...a],y=[...b];let s=0;
 while(s<x.length&&s<y.length&&x[s]===y[s])s++;
 let e=0;
 while(e<x.length-s&&e<y.length-s&&x[x.length-1-e]===y[y.length-1-e])e++;
 const m=x.slice(s,x.length-e),n=y.slice(s,y.length-e),ops=[];
 for(const c of x.slice(0,s))ops.push(['same',c]);
 if(m.length*n.length>160000){for(const c of m)ops.push(['del',c]);for(const c of n)ops.push(['ins',c]);}
 else{
  const w=n.length+1,t=new Uint16Array((m.length+1)*w);
  for(let i=m.length-1;i>=0;i--)for(let j=n.length-1;j>=0;j--)t[i*w+j]=m[i]===n[j]?t[(i+1)*w+j+1]+1:Math.max(t[(i+1)*w+j],t[i*w+j+1]);
  let i=0,j=0;
  while(i<m.length&&j<n.length){if(m[i]===n[j]){ops.push(['same',m[i]]);i++;j++;}else if(t[(i+1)*w+j]>=t[i*w+j+1]){ops.push(['del',m[i++]]);}else{ops.push(['ins',n[j++]]);}}
  while(i<m.length)ops.push(['del',m[i++]]);while(j<n.length)ops.push(['ins',n[j++]]);
 }
 for(const c of x.slice(x.length-e))ops.push(['same',c]);
 const out=[];for(const [k,c] of ops){const last=out[out.length-1];if(last&&last.kind===k)last.text+=c;else out.push({kind:k,text:c});}
 return out;
}
function diffNodes(parts,side){
 const keep=side==='before'?'del':'ins',hidden=side==='before'?'삭제된 부분 시작':'바뀐 부분 시작';
 return parts.filter(x=>x.kind==='same'||x.kind===keep).map(x=>{if(x.kind==='same')return document.createTextNode(x.text);const whitespace=/^\s+$/u.test(x.text),label=whitespace?(/[\r\n]/u.test(x.text)?'줄바꿈':'공백'):'';return el(side==='before'?'del':'ins',{class:'diff-mark'+(whitespace?' diff-whitespace':''),...(whitespace?{'data-space-label':label}:{})},el('span',{class:'sr-only'},'['+hidden+(label?' '+label:'')+'] '),x.text,el('span',{class:'sr-only'},' [끝]'));});
}
// Offset ranges are computed against the full verified pair by the server.
// Validate them before use; do not infer edits from differently clipped windows.
function markedExcerpt(text,ranges,side){
 const chars=[...text];if(!Array.isArray(ranges)||ranges.length>chars.length)return null;
 let prev=0;for(const r of ranges){if(!Array.isArray(r)||r.length!==2||!Number.isSafeInteger(r[0])||!Number.isSafeInteger(r[1])||r[0]<prev||r[1]<=r[0]||r[1]>chars.length)return null;prev=r[1];}
 const parts=[];let at=0;for(const [start,end] of ranges){if(start>at)parts.push({kind:'same',text:chars.slice(at,start).join('')});parts.push({kind:side==='before'?'del':'ins',text:chars.slice(start,end).join('')});at=end;}if(at<chars.length)parts.push({kind:'same',text:chars.slice(at).join('')});return diffNodes(parts,side);
}
function correctionCard(pair,index,total){
 const beforeMarked=markedExcerpt(pair.before,pair.marks?.before,'before'),afterMarked=markedExcerpt(pair.after,pair.marks?.after,'after');
 const verified=beforeMarked!==null&&afterMarked!==null,clipped=pair.beforeTruncated||pair.afterTruncated;
 const parts=!verified&&!clipped?diffParts(pair.before,pair.after):null;
 const beforeNodes=verified?beforeMarked:parts?diffNodes(parts,'before'):[document.createTextNode(pair.before)];
 const afterNodes=verified?afterMarked:parts?diffNodes(parts,'after'):[document.createTextNode(pair.after)];
 return el('article',{class:'correction-card'},
  !verified&&clipped?p('잘린 발췌 구간은 오해를 피하려고 변경 부분 강조 없이 비교합니다.','fineprint'):null,
  el('div',{class:'correction-card-head'},el('span',{class:'correction-no'},'교정 '+(index+1)+(total>1?' / '+total:'')),el('span',{class:'pill'},Object.hasOwn(labels,pair.category)?labels[pair.category]:'표현')),
  el('div',{class:'correction-pair'},
   el('section',{class:'correction-side before','aria-label':'수정 전'},el('h4',{},el('span',{class:'side-mark','aria-hidden':'true'},'−'),'수정 전'),el('p',{class:'essay correction-text'},...beforeNodes,pair.beforeTruncated?el('span',{class:'omitted'},' · 일부 발췌'):null)),
   el('section',{class:'correction-side after','aria-label':'수정 후'},el('h4',{},el('span',{class:'side-mark','aria-hidden':'true'},'+'),'수정 후'),el('p',{class:'essay correction-text'},...afterNodes,pair.afterTruncated?el('span',{class:'omitted'},' · 일부 발췌'):null))));
}
function correctionPairs(d){
 if(!d)return [];
 const list=[];
 if(d.example)list.push({before:d.example.before,after:d.example.after,category:d.exampleCategory||'',beforeTruncated:d.exampleClipped?.before===true,afterTruncated:d.exampleClipped?.after===true,marks:d.exampleMarks||null});
 for(const x of d.additionalExamples||[])list.push(x);
 return list.filter(x=>x.before.trim()&&x.after.trim()&&x.before.trim()!==x.after.trim()).slice(0,3);
}
function correctionNotebook(d){
 const pairs=correctionPairs(d);
 return el('section',{class:'correction-notebook','aria-label':'교정 노트'},
  el('div',{class:'correction-heading'},el('h3',{class:'correction-title'},'교정 노트'),el('p',{class:'correction-legend'},el('del',{class:'diff-mark'},'수정 전 표시'),' → ',el('ins',{class:'diff-mark'},'수정 후 표시'),' · 바뀐 글자만 밑줄·배경으로 강조')),
  pairs.length?el('div',{class:'correction-list'},...pairs.map((x,i)=>correctionCard(x,i,pairs.length))):p('이번에는 공개할 수 있는 수정 전후 예시가 없어요. 바뀐 부분이 없거나 공개 가능한 짧은 발췌를 만들지 못했습니다. 없는 수정을 만들어 보여드리지 않아요.','fineprint'));
}
function docExcerpts(r,section){
 const pairs=correctionPairs(r.previewDetails);if(!pairs.length)return [];
 const shown=(section.segments||[]).filter(s=>s.kind==='visible').map(s=>s.text).join('\n');
 const fresh=pairs.filter(x=>!shown.includes(x.after.trim()));if(!fresh.length)return [];
 return [el('div',{class:'doc-excerpts'},p('공개된 수정 후 발췌','eyebrow'),...fresh.map(x=>p(x.after+(x.afterTruncated?' · 일부 발췌':''),'essay')))];
}
function previewInsights(r){const d=r.previewDetails;return el('section',{class:'preview-insights'},el('h2',{},'자소서 분석 미리보기'),p('원문에서 살핀 부분과 공개된 수정 전후 발췌입니다.','fineprint'),d?.analysisPreview?el('article',{class:'analysis-teaser'},el('span',{class:'analysis-tag'},'먼저 살펴볼 점'),el('h3',{},'AI가 발견한 개선 포인트'),p(d.analysisPreview.problem),p('상세 개선 방향과 나머지 심층 분석은 전문에서 확인할 수 있어요.','fineprint')):null,correctionNotebook(d),d?.highlights?.length?el('div',{class:'review-aspects'},el('h3',{},'함께 살핀 관점'),el('ul',{class:'improvement-list'},...d.highlights.map(h=>el('li',{},el('strong',{},h.label||labels[h.category]||'표현과 흐름'),p(h.text))))):null,d?.note?p(d.note,'fineprint'):null);}
function resultContext(r){const summary=r.access==='full'?r.revision:r.revisionSummary;const fit=(r.quality?.checks||[]).find(c=>c.key==='fit');const missingPrompt=summary?.promptProvided===false||fit&&['not_checked','not_applicable','skipped','unverified'].includes(fit.status)||r.product==='revision'&&r.sections.every(s=>!s.heading?.trim()||['자기소개서 첨삭','자소서 첨삭','자기소개서'].includes(s.heading.trim()));return el('div',{class:'result-context'},missingPrompt?p('별도로 받은 문항이 없어 문항 적합성을 독립 검수하지 않았어요. 원문에 적힌 문항은 분석에 참고할 수 있어요.','fineprint'):null,summary&&(summary.limitProvided===false||summary.limit==null)?p('별도 분량 설정이 없어 원문 속 제한의 준수 여부는 확인하지 않았어요.','fineprint'):null);}
function qualityChecks(result){const checks=result.quality?.checks||[];return el('section',{class:'quality-panel'},el('div',{class:'section-heading compact'},el('h2',{},'수정 후, 함께 살핀 항목'),p('AI의 원문 대조·검수이지, 경험의 진실성 인증이나 채용 평가가 아닙니다.','fineprint')),el('ul',{class:'check-grid'},...checks.map(c=>el('li',{class:c.status==='pass'?'pass':'attention'},el('span',{'aria-hidden':'true'},c.status==='pass'?'✓':'!'),el('span',{},c.label||labels[c.key]||'검수 항목'),el('small',{},c.status==='pass'?'확인':['not_checked','not_applicable','skipped','unverified'].includes(c.status)?'미확인':'직접 확인 필요')))));
}
function resultPage(){const r=S.result;if(!r)return paymentPage();const full=r.access==='full',revision=isDeletionRevision(r);const summary=full?r.revision:r.revisionSummary;return main(el('section',{class:'workspace'},title(full?'내 경험을 더 선명하게 · 전문':revision?'첫 자소서 무료 분석·첨삭 미리보기':'기존 작성 결과 · 미리보기',full?(revision?'다듬은 글과 바꾼 이유예요.':'이전에 작성한 글이에요.'):(revision?'내 글의 달라진 시작을 확인하세요.':'기존 작성 결과의 일부예요.'),full?'제출 전 지원 문항과 경험의 사실관계를 직접 확인해주세요. 필요한 내용은 지금 복사하거나 저장하세요.':revision?'수정본의 일부만 공개됩니다. 잠긴 부분은 브라우저에 전달되지 않습니다.':'작성 결과의 일부만 공개됩니다. 잠긴 부분은 브라우저에 전달되지 않습니다.'),S.error?note('아직 확인하지 못했어요',S.error,'warning'):null,full?deletionNotice():null,summary?el('div',{class:'result-meta'},el('span',{},'원문 '+summary.originalLength+' '+unit(summary.lengthMode)),el('span',{'aria-hidden':'true'},'→'),el('strong',{},'수정 '+summary.revisedLength+' '+unit(summary.lengthMode)),el('span',{},summary.limit==null?'제한 미설정':'상한 '+summary.limit+' '+unit(summary.lengthMode)),el('span',{},'변경 '+(full?(r.revision?.changes||[]).length:summary.changeCount)+'곳')):null,resultContext(r),full&&revision?fullAnalysis(r):null,!full&&revision?previewInsights(r):null,qualityChecks(r),...r.sections.map((section,si)=>el('article',{class:'result-paper'},el('div',{class:'result-paper-heading'},el('span',{class:'eyebrow'},revision?(full?'수정본 전문':'수정 후 일부'):(full?'작성 결과 전문':'작성 결과 일부')),el('h2',{},section.heading||'내 자소서')),full?p(section.text,'essay revised-text'):el('div',{class:'preview-body'},...(si===0&&revision?docExcerpts(r,section):[]),...section.segments.map(seg=>seg.kind==='visible'?p(seg.text,'essay'):el('div',{class:'locked-text','aria-hidden':'true'},...Array.from({length:seg.lines},(_,i)=>el('div',{class:'skeleton-line'+(i===seg.lines-1?' skeleton-line-short':'')})),el('span',{class:'lock-caption'},'전문 비공개 · 실제 문장이 아닌 잠금 표시입니다.')))))),full?(revision?fullDetails(r):null):purchasePanel(),full?el('div',{class:'result-actions'},btn('수정본 복사',copyFull),btn('TXT 저장',downloadFull,'button secondary'),btn('내 입력 지우기',eraseDialog,'text-button danger',S.deletion.state==='working'||S.paymentBusy)):el('div',{class:'button-row'},btn('결제 상태 다시 확인',restore,'button secondary',S.paymentBusy),btn('결과·입력 삭제',eraseDialog,'text-button danger',S.paymentBusy)),!revision?recoveryActions():null,p(retentionText(r),'fineprint')));}
function fullAnalysis(r){
 const a=r.revision?.deepAnalysis;if(!a||typeof a.overview!=='string')return null;
 const strengths=Array.isArray(a.strengths)?a.strengths:[],improvements=Array.isArray(a.improvements)?a.improvements:[],questions=Array.isArray(a.questions)?a.questions:[];
 const priority={high:'먼저 개선',medium:'개선 권장',low:'다듬기'};
 return el('section',{class:'analysis-report','aria-label':'자소서 심층 분석'},el('div',{class:'section-heading compact'},p('AI ANALYSIS','eyebrow'),el('h2',{},'자소서 심층 분석'),p('자소서에 적힌 내용과 표현을 바탕으로 살펴본 의견이에요. 경험의 진실성이나 채용 결과를 인증하지 않습니다.','fineprint')),
  el('article',{class:'analysis-overview'},el('h3',{},'전체 진단'),p(a.overview)),
  strengths.length?el('div',{class:'analysis-group'},el('h3',{},'이 글의 강점'),...strengths.map(x=>el('article',{class:'analysis-card strength'},el('p',{class:'analysis-quote'},'“'+x.quote+'”'),p(x.comment)))):null,
  improvements.length?el('div',{class:'analysis-group'},el('h3',{},'우선 개선할 점'),...improvements.map((x,i)=>el('article',{class:'analysis-card'},el('div',{class:'analysis-card-top'},el('span',{class:'analysis-tag'},priority[x.priority]||'개선 포인트'),el('span',{},String(i+1).padStart(2,'0'))),el('p',{class:'analysis-quote'},'“'+x.quote+'”'),el('strong',{},'아쉬운 점'),p(x.problem),el('strong',{},'개선 방향'),p(x.suggestion)))):null,
  questions.length?el('div',{class:'analysis-group'},el('h3',{},'직접 확인하면 좋은 점'),...questions.map(x=>el('article',{class:'analysis-card question'},el('p',{class:'analysis-quote'},'“'+x.quote+'”'),p(x.question)))):null);
}

function fullDetails(r){const rev=r.revision||{};const changes=rev.changes||[];return el('section',{class:'changes'},el('div',{class:'section-heading compact'},p('수정 전후 비교','eyebrow'),el('h2',{},'무엇을, 왜 바꿨나요?')),changes.length?changes.map((c,i)=>el('article',{class:'change-card'},el('div',{class:'change-heading'},el('span',{class:'pill'},labels[c.category]||c.category||'표현'),el('span',{},String(i+1).padStart(2,'0'))),el('div',{class:'change-comparison'},el('div',{},el('h3',{},'수정 전 발췌'),p(c.before,'quote before')),el('div',{},el('h3',{},'수정 후 발췌'),p(c.after,'quote after'))),p(c.reason,'change-reason'))):note('좋은 문장은 그대로 두었어요','서버가 제공한 변경 내역이 없습니다. 불필요한 재작성을 하지 않을 수 있어요.'),(rev.diagnosis||[]).length?el('div',{class:'diagnosis'},el('h3',{},'원문에서 살핀 부분'),...rev.diagnosis.map(d=>note(labels[d.category]||'검토',d.problem+' '+d.suggestion))):null,(rev.warnings||[]).length?el('div',{class:'notice warning'},el('h3',{},'제출 전 직접 확인해주세요'),el('ul',{},...rev.warnings.map(w=>el('li',{},typeof w==='string'?w:JSON.stringify(w))))):null);}
function isDeletionRevision(r=S.result){return r?.product==='revision'||r?.privacy?.autoDeleteOnDelivery===true;}
function retentionText(r=S.result){return isDeletionRevision(r)?'미결제 최대 1시간 · 결제 확인 대기 및 미수신 승인 결과 최대 24시간. 전문 전달 후 삭제를 요청하며 거래기록·로그·백업·외부 AI 보관 정책은 별개입니다.':'기존 상품: 미결제 결과 최대 24시간 · 결제 확인 대기 및 승인된 결과 최대 7일(승인된 결과는 승인일부터). 기존 복구 조건이 적용되며 거래기록·로그·백업·외부 AI 보관 정책은 별개입니다.';}
function deliveryText(r=S.result){return isDeletionRevision(r)?'승인 후 전문이 제공되면 서버 삭제를 요청합니다. 복구코드는 발급되지 않으며 새로고침·닫기 뒤 복구할 수 없으니 별도로 보관해주세요.':'기존 상품의 보관·복구 조건이 적용됩니다. 미결제 최대 24시간, 결제 확인 대기 및 승인된 결과 최대 7일(승인된 결과는 승인일부터)이며 복구 조건은 별도입니다.';}
function purchasePanel(){return el('section',{class:'purchase-panel'},el('div',{},p(S.result?.product==='revision'?'구독 없이 · 미리 본 그 자소서 1편':'구독 없이 · 미리 본 그 결과 1건','eyebrow'),el('h2',{},isDeletionRevision()?'심층 분석과 수정본 전문까지.':'미리 본 결과의 전문 열람'),p(isDeletionRevision()?'전체 진단 · 근거별 개선 제안 · 수정본 전문 · TXT 저장':'전문 복사 · TXT 저장 · 기존 상품 조건 적용')),el('div',{class:'purchase-price'},p('3,000원','price'),btn((server.paymentMode==='test'?'테스트 결제 안내':(isDeletionRevision()?'전문·변경 이유 더 보기 · 3,000원':'전문 열람 · 3,000원'))+' →',checkout,'button primary',!canPay())),!canPay()?note('전문 결제 준비 중이에요',paymentReason(),'warning'):null,p(deliveryText()+' 새 글 생성·추가 재수정은 포함하지 않아요.','fineprint'));}
function deletionNotice(){const d=S.deletion;if(S.result?.product!=='revision'&&S.result?.privacy?.autoDeleteOnDelivery!==true)return note('기존 결과의 보관 정책이 적용됩니다','신규 첨삭 결과와 보관 조건이 다를 수 있어요. 기존 이용약관을 확인해주세요.');if(d.state==='done')return note('서버 콘텐츠·재시도 캐시 삭제를 확인했어요','지금 보이는 전문은 이 화면 메모리에만 남아 있습니다. 새로고침하거나 닫으면 복구할 수 없으니 지금 복사·TXT로 저장해주세요. 거래기록·로그·백업·외부 AI 정책은 별개입니다.','success');if(d.state==='failed')return el('div',{class:'notice warning',role:'status'},el('strong',{},'전문은 받았지만 서버 삭제는 아직 완료되지 않았어요'),p((d.payment?'결과 콘텐츠 삭제 확인. ':'결과 콘텐츠 삭제 미확인. ')+(d.cache?'재시도 캐시 삭제 확인.':'재시도 캐시 삭제 미확인.')+' 현재 화면의 전문은 복사·저장할 수 있어요. 새로고침으로 복구를 보장하지 않습니다.'),btn('서버 삭제 다시 요청',deleteDelivered,'button secondary'));return note('전문을 받았고, 서버 삭제를 확인 중이에요','확인 전에는 삭제가 완료된 것으로 보지 마세요. 새로고침·창 닫기 전 필요한 전문을 복사하거나 저장해주세요.');}
async function deleteDelivered(){if(S.busy||S.paymentBusy||S.sample||S.deletion.state==='working'||S.deletion.state==='done'||S.result?.access!=='full'||!(S.result.product==='revision'||S.result.privacy?.autoDeleteOnDelivery===true))return;const id=S.result.resultId;S.deletion.state='working';render();try{if(!S.deletion.payment){const response=await request('/api/payment',{method:'DELETE',body:{resultId:id}});if(response.pending||response.deleted!==true||response.contentDeleted===false)throw new Error('DELETE_PENDING');S.deletion.payment=true;}if(!S.deletion.cache){const response=await request('/api/insosoe',{method:'DELETE',body:{scope:'cache'}});if(response.pending||response.deleted!==true||response.cacheCleared===false)throw new Error('DELETE_PENDING');S.deletion.cache=true;}S.deletion.state='done';if(server.latestResultId===id)server.latestResultId=null;S.pending=null;S.input.originalText='';S.input.posting='';S.answers=[];S.questions=[];}catch{S.deletion.state='failed';}finally{render();announce(S.deletion.state==='done'?'서버 콘텐츠와 재시도 캐시 삭제를 확인했어요.':'서버 삭제를 아직 완료하지 못했어요. 다시 요청할 수 있어요.');}}
function openDialog(heading,...children){if(recoveryPending)return;clearRecoveryFields();sensitiveDialog=false;dialogReturn=document.activeElement;dialog.replaceChildren(el('div',{class:'dialog-top'},el('h2',{id:'dialog-title',tabindex:'-1'},heading),btn('닫기',closeDialog,'text-button')),el('div',{class:'dialog-body'},...children));if(!dialog.open)dialog.showModal();$('#dialog-title').focus();}
function closeDialog(){if(recoveryPending)return;clearRecoveryFields();dialog.close();if(sensitiveDialog){dialog.replaceChildren();sensitiveDialog=false;}if(dialogReturn?.isConnected)dialogReturn.focus();else $('#main h1')?.focus();dialogReturn=null;}
dialog.addEventListener('close',()=>{clearRecoveryFields();if(sensitiveDialog&&!recoveryPending){dialog.replaceChildren();sensitiveDialog=false;}});
dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
dialog.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const focusable=[...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(n=>!n.hidden);const first=focusable[0],last=focusable.at(-1);if(!first){e.preventDefault();dialog.focus();return;}if(e.shiftKey&&(document.activeElement===first||document.activeElement===$('#dialog-title'))){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}});
function policy(kind){openDialog(kind==='privacy'?'내 글의 처리·보관·삭제':'이용·결제 안내',p('현재 화면에서는 입력한 자소서와 생성·검수 요청이 서비스 서버와 외부 AI 처리업체에 전송됩니다. 파일 자체는 브라우저에서 읽습니다. 이름·연락처 등 불필요한 개인정보를 넣지 마세요.'),el('h3',{},'브라우저와 서버를 구분해요'),p('입력 원문과 수정본을 localStorage·sessionStorage에 저장하지 않습니다. 입력창 내용은 현재 페이지 메모리에만 유지됩니다. 서버에는 수정본·심층 분석 보고서·변경 전 발췌·검수 근거 등이 암호화 임시 보관될 수 있고, 재시도 캐시도 사용합니다.'),el('h3',{},'전문을 받으면 삭제를 요청해요'),p('신규 첨삭의 미결제 결과는 최대 1시간, 결제 확인 대기·미수신 승인 결과는 최대 24시간 보관합니다. 전문을 수신하고 표시한 뒤 서버 콘텐츠 및 재시도 캐시 삭제를 요청하며 성공 여부를 표시합니다. 실패하면 삭제 완료라고 안내하지 않습니다.'),p('전문 수신 후에는 복구코드를 발급하지 않습니다. 새로고침·창 닫기 뒤 복구할 수 없으니 복사·TXT로 보관해주세요. 기존 상품에는 기존 보관 조건이 적용됩니다.'),el('h3',{},'모든 곳에서 사라진다는 뜻은 아니에요'),p('거래기록은 별도 보관하며 로그·백업·외부 AI 업체의 보관 정책과 법적 예외는 별개입니다. 즉각적인 물리적 메모리 소거나 외부 업체의 무보관을 보장하지 않습니다. 삭제는 자동 환불이 아니고 무료 한도를 초기화하지 않습니다.'),el('div',{class:'button-row'},link('개인정보처리방침 전문','/privacy.html','button secondary'),link('이용약관·환불 안내','/terms.html','button secondary')));}
function checkout(){if(!canPay())return;openDialog(S.result?.product==='revision'?'이 자소서 1편의 전문 열람':'이 결과 1건의 전문 열람',p('3,000원(KRW) · 구독·자동 결제 없음'),server.paymentMode==='test'?note('테스트 결제 환경','실제 구매·청구가 아닙니다.','warning'):null,p(deliveryText()),link('이용약관·환불 안내','/terms.html'),...Object.entries(server.paymentLegal||{}).filter(([k,v])=>['businessName','representative','businessNumber','supportEmail','refundPolicy','deliveryTerms','financialRetention'].includes(k)&&typeof v==='string').map(([k,v])=>p(v,'fineprint')),el('label',{class:'check-line'},el('input',{id:'pay-terms',type:'checkbox'}),el('span',{},'이용·결제 조건과 환불 안내를 확인하고 동의합니다.')),el('label',{class:'check-line'},el('input',{id:'pay-delivery',type:'checkbox'}),el('span',{},'결제 승인 후 디지털 콘텐츠의 즉시 제공에 동의합니다. 제공 개시 후 법령에 따라 청약철회가 제한될 수 있음을 확인했습니다.')),p('법령상 보장되는 환불 권리는 이 동의로 배제되지 않습니다.','fineprint'),el('p',{id:'checkout-error',role:'alert',class:'field-error'}),btn('결제창 열기',launchPayment));}
async function loadSdk(){if(window.TossPayments)return window.TossPayments;if(!sdkPromise)sdkPromise=new Promise((resolve,reject)=>{const script=el('script',{src:'https://js.tosspayments.com/v2/standard',async:true});script.onload=()=>window.TossPayments?resolve(window.TossPayments):reject(new Error('SDK'));script.onerror=()=>{script.remove();sdkPromise=null;reject(new Error('SDK'));};document.head.append(script);});return sdkPromise;}
async function launchPayment(){if(!canPay())return;if(!$('#pay-terms')?.checked||!$('#pay-delivery')?.checked){$('#checkout-error').textContent='이용 조건과 즉시 제공 동의를 모두 확인해주세요.';$('#pay-terms').focus();return;}closeDialog();S.paymentBusy=true;S.error='';render();try{const order=await request('/api/payment',{method:'POST',body:{action:'create',resultId:S.result.resultId,termsAccepted:true,immediateDeliveryAccepted:true}});if(order.amount!==3000||order.currency!=='KRW'||!['test','live'].includes(order.mode)||typeof order.orderId!=='string'||typeof order.clientKey!=='string')throw new Error('ORDER');const success=new URL(order.successUrl),fail=new URL(order.failUrl);if(success.origin!==location.origin||fail.origin!==location.origin||success.pathname!=='/payment/success'||fail.pathname!=='/payment/fail')throw new Error('CALLBACK');const Toss=await loadSdk();S.leaving=true;await Toss(order.clientKey).payment({customerKey:Toss.ANONYMOUS}).requestPayment({method:'CARD',amount:{currency:'KRW',value:3000},orderId:order.orderId,orderName:order.orderName,successUrl:order.successUrl,failUrl:order.failUrl,card:{flowMode:'DEFAULT'}});}catch{S.leaving=false;S.error='결제창을 완료하지 못했어요. 이미 결제 내역이 있다면 다시 결제하지 말고 상태를 확인해주세요.';}finally{S.paymentBusy=false;render();}}
async function confirmPayment(){if(S.paymentBusy)return;const cb=S.callback;if(!cb?.paymentKey||!cb.orderId||cb.amount!==3000){S.error='결제 확인 정보가 올바르지 않아요. 결제·결과 확인에서 상태를 확인해주세요.';S.callback=null;render();return;}S.paymentBusy=true;render();try{const data=await request('/api/payment',{method:'POST',body:{action:'confirm',...cb}});acceptResult(data);if(S.result.access!=='full')throw new Error('NOT_CONFIRMED');S.callback=null;S.error='';S.view='result';}catch{S.error='승인 확인을 완료하지 못했어요. 다시 결제하지 말고 같은 승인 확인을 재시도해주세요.';}finally{S.paymentBusy=false;render();if(S.result?.access==='full')void deleteDelivered();}}
async function restore(){if(S.busy||S.paymentBusy||S.deletion.state==='working')return;if(S.result?.access==='full'){go('result');return;}S.paymentBusy=true;S.view='payment';S.error='';render();try{const id=S.result?.resultId||server.latestResultId;const data=await request('/api/payment'+(id?'?resultId='+encodeURIComponent(id):''));acceptResult(data);S.view='result';}catch(e){S.error=e.status===404||e.status===410?'이 브라우저에서 아직 수신하지 않은 결과가 없거나 보관 기한이 지났어요. 전문 전달 후 삭제된 신규 첨삭 결과는 복구할 수 없습니다.':'결과를 확인하지 못했어요. 이미 결제했다면 다시 결제하지 말고 상태 확인을 재시도해주세요.';}finally{S.paymentBusy=false;render();if(S.result?.access==='full')void deleteDelivered();}}
function paymentPage(){return main(el('section',{class:'workspace narrow'},title('결제·결과 확인','이미 결제했다면, 상태부터 확인해요.','결제 여부와 전문 이용 권한은 서버에서 확인합니다.'),el('div',{class:'work-card'},S.paymentBusy?note('서버 확인 중','잠시만 기다려주세요.'):null,S.error?note('확인이 필요해요',S.error,'warning'):null,el('div',{class:'button-row'},S.callback?btn('같은 결제 승인 다시 확인',confirmPayment,'button primary',S.paymentBusy):null,btn('미수신 결과 확인',restore,'button secondary',S.paymentBusy),btn('내 입력으로 돌아가기',()=>go('input'),'text-button',S.paymentBusy)),p('신규 첨삭은 전문 전달 후 삭제하는 방식입니다. 복구코드를 발급하지 않으며, 삭제된 결과는 다시 열 수 없어요.','fineprint')),recoveryActions()));}
function fullText(includeHeading=true){return S.result?.access==='full'?S.result.sections.map(s=>(includeHeading?s.heading+'\n\n':'')+s.text).join('\n\n'):'';}
async function copyFull(){const text=fullText(S.result?.product!=='revision');if(!text)return;try{await navigator.clipboard.writeText(text);announce('수정본을 복사했어요.');openDialog('수정본을 복사했어요',p('필요한 곳에 붙여넣고, 제출 전 내용을 다시 확인해주세요.'),btn('확인',closeDialog));}catch{openDialog('아래 전문을 선택해 복사해주세요',p('브라우저에서 자동 복사를 허용하지 않았어요.'),el('textarea',{rows:12,readonly:true,class:'text-input',value:text,'aria-label':'복사용 수정본',onfocus:e=>e.target.select()}));}}
function downloadFull(){
 const text=fullText();if(!text)return;const rev=S.result.revision;const reasons=(rev?.changes||[]).map(c=>'['+(labels[c.category]||'변경')+']\n수정 전: '+c.before+'\n수정 후: '+c.after+'\n이유: '+c.reason).join('\n\n');
 const a=rev?.deepAnalysis;let analysis='';if(a){const lines=['전체 진단','────────────',a.overview||''];if(a.strengths?.length)lines.push('\n이 글의 강점',...a.strengths.map(x=>'원문: '+x.quote+'\n'+x.comment));if(a.improvements?.length)lines.push('\n우선 개선할 점',...a.improvements.map(x=>'원문: '+x.quote+'\n아쉬운 점: '+x.problem+'\n개선 방향: '+x.suggestion));if(a.questions?.length)lines.push('\n직접 확인할 점',...a.questions.map(x=>'원문: '+x.quote+'\n'+x.question));analysis=lines.join('\n\n');}
 const blob=new Blob(['\ufeff'+text+(analysis?'\n\n심층 분석\n────────────\n'+analysis:'')+(reasons?'\n\n변경 이유\n────────────\n'+reasons:'')],{type:'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob);const link=el('a',{href:url,download:'인소서_분석과_수정본.txt'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);announce('TXT 저장을 요청했어요. 다운로드 목록에서 확인해주세요.');
}
function eraseDialog(){if(S.busy||S.paymentBusy||S.deletion.state==='working')return;openDialog('입력과 결과를 지울까요?',p('현재 화면의 원문·결과도 사라집니다. 필요한 전문을 먼저 복사하거나 TXT로 저장해주세요. 삭제는 환불이 아니며 무료 이용 기록을 초기화하지 않습니다.'),btn('지우기',erase,'button danger-button'),btn('돌아가기',closeDialog,'button secondary'));}
async function erase(){closeDialog();const id=S.result?.resultId;S.busy=true;S.error='';try{if(id&&S.deletion.state!=='done'){const d=await request('/api/payment',{method:'DELETE',body:{resultId:id}});if(d.pending||d.deleted!==true||d.cacheCleared===false)throw new Error('PENDING');}const d=await request('/api/insosoe',{method:'DELETE',body:{scope:'revision'}});if(d.pending||d.deleted!==true||d.cacheCleared===false)throw new Error('PENDING');if(server.latestResultId===id)server.latestResultId=null;S.input=emptyInput();fileMessage='';fileReadVersion++;fileReading=false;S.checks={};consentTarget=null;S.result=null;S.questions=[];S.answers=[];S.round=0;S.pending=null;S.sample=false;S.deletion={state:'idle',payment:false,cache:false};S.view='home';S.busy=false;render();openDialog('삭제 요청의 성공을 확인했어요',p('현재 화면의 입력·결과와 서비스의 삭제 대상 콘텐츠를 정리했습니다. 거래기록·로그·백업·외부 AI 보관 정책은 별개입니다.'));}catch{S.busy=false;S.error='서버 삭제가 완료됐는지 확인하지 못했어요. 입력·결과는 화면에 남겨 두었습니다. 잠시 후 다시 요청해주세요.';render();}}
function render(){announce('');app.replaceChildren(header(),({home,input:inputPage,waiting,clarify:clarificationPage,result:resultPage,sample:samplePage,payment:paymentPage}[S.view]||home)(),footer());app.setAttribute('aria-busy',String(S.busy||S.paymentBusy));if(['home','input'].includes(S.view))updateCounts();}
async function checkStatus(){
 if(server.loading && statusConfirmed)return;
 const previousIdentity=consentTarget?JSON.stringify([String(consentTarget.provider).trim().toLowerCase(),String(consentTarget.model).trim().toLowerCase()]):statusConfirmed?modelIdentity():null;
 server.loading=true;
 const refresh=()=>{
  const retry=$('#refresh-status');if(retry)retry.disabled=server.loading;
  const availability=$('#availability');if(availability){availability.textContent=unavailable();availability.className=unavailable()?'notice warning':'';$('#submit-revision').disabled=!!unavailable()||S.busy||fileReading;}
  const payment=$('#payment-availability');if(payment)payment.textContent=server.paymentReady===true?'전문 열람은 별도 결제 승인 후 제공됩니다.':'전문 결제는 준비 중이에요.';
  const labels=aiLabels();const brand=$('#ai-brand');if(brand)brand.textContent=labels.brand;
  const label=$('#consent-label');if(label)label.textContent=labels.consent;
  const consent=$('#consent');if(consent){consent.checked=S.checks.consent===true;consent.disabled=!statusConfirmed;}
 };
 refresh();
 try{server={...await request('/api/insosoe',{timeout:10000}),loading:false};statusConfirmed=typeof server.provider==='string'&&!!server.provider.trim()&&typeof server.model==='string'&&!!server.model.trim();if(!statusConfirmed){server.ready=false;server.message='AI 전송 대상을 확인하지 못해 생성할 수 없어요. 연결 상태를 다시 확인해주세요.';}}
 catch{server={...server,loading:false,ready:false,paymentReady:false,message:'서버 연결을 확인하지 못했어요. 입력은 유지됩니다. 연결 상태를 다시 확인하거나 가상 예시를 이용해주세요.'};statusConfirmed=false;}
 const changed=statusConfirmed && previousIdentity!==null && previousIdentity!==modelIdentity();
 if(changed){S.checks.consent=false;consentTarget=null;S.pending=null;}
 const consentStatus=$('#consent-status');if(consentStatus)consentStatus.textContent=!statusConfirmed?'연결 상태 확인 후 전송 대상에 동의할 수 있어요.':changed?'AI 전송 대상이 변경되었거나 다시 확인이 필요해요. 내용을 읽고 다시 동의해주세요.':'';
 // Status updates must not replace input nodes, close details, or move keyboard focus.
 refresh();
}
window.addEventListener('beforeunload',e=>{if(S.leaving)return;if(S.input.originalText||S.result?.access==='full'||S.busy||S.paymentBusy||S.deletion.state==='working'){e.preventDefault();e.returnValue='';}});
render();await checkStatus();if(S.callback)await confirmPayment();
