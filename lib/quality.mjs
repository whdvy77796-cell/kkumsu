import {AppError,count,isPersonalSource} from './core.mjs';
export {isPersonalSource} from './core.mjs';

export const QUALITY_CRITERIA = Object.freeze(['relevance','specificity','agency','reasoning','roleFit','repetition','cliches','naturalness']);
export const QUALITY_LABELS = Object.freeze({relevance:'문항 응답성',specificity:'구체적인 행동',agency:'본인 기여',reasoning:'판단 이유',roleFit:'지원 직무 연결',repetition:'소재·문장 중복',cliches:'상투어',naturalness:'자연스러운 말투'});
const error = message => { throw new AppError('QUALITY_FORMAT',message,422,true); };
const object = v => v && typeof v==='object' && !Array.isArray(v);
const text = (v,max=300,empty=false) => {if(typeof v!=='string'||count(v)>max||(!empty&&!v.trim()))error('품질 검수 설명 형식을 확인할 수 없습니다.');return v;};
const array = (v,max=15) => {if(!Array.isArray(v)||v.length>max)error('품질 검수 목록 형식을 확인할 수 없습니다.');return v;};
const unique = values => {if(new Set(values).size!==values.length)error('품질 검수 항목이 중복되었습니다.');return values;};
// A correction replaces, rather than augments, the original claim. Employer text is never a personal numeric allowance.
export const effectiveEvidence = f => f.edited===true ? f.text : f.quote;
// Exceptions cover only the numeric occurrence inside a validated span, never all matching numbers.
// Deliberately narrow Korean attribution templates; unrecognized paraphrases still need AI repair.
export function employerNumericSpans(value,profile={}){
 const spans=[],org=String(profile.organization||'').trim(),posting=String(profile.posting||'');
 if(/\d/.test(org)&&/[\p{L}]/u.test(org)&&/^[\p{L}\p{N} .&()_-]{2,80}$/u.test(org)&&!/(?:매출|수익|성과|목표|\d\s*(?:원|건|배|년|개월))/.test(org)&&[...org.matchAll(/\d+(?:[.,]\d+)*/g)].every(m=>/[\p{L}]/u.test(org[m.index-1]||'')||/[\p{L}]/u.test(org[m.index+m[0].length]||''))){
  let at=0;while((at=value.indexOf(org,at))!==-1){const before=value.slice(0,at),after=value.slice(at+org.length);if(!/[\p{L}\p{N}_]$/u.test(before)&&(!/^[\p{L}\p{N}_]/u.test(after)||/^(?:에(?:서|게)?|의|은|는|을|를|와|과|이란|이라는|입니다)(?=$|[\s,.!?])/u.test(after)))spans.push({start:at,end:at+org.length,source:'organization',quote:org});at+=org.length;}
 }
 // Every accepted statement has a bounded, non-achievement ending. No first-person claim can be stripped.
 const statement=/(?:채용\s*)?공고(?:의|에\s*제시된|에\s*명시된|에는)\s*[“‘"']?((?:[^“”‘’"'\n.!?]|(?<=\d)\.(?=\d)){2,140}?)[”’"']?\s*(?:목표에\s*공감합니다|목표를\s*확인했습니다|목표가\s*명시되어\s*있습니다|(?:가|이)\s*명시되어\s*있습니다)(?=[.!?]|$)/gu;
 for(const match of value.matchAll(statement)){
  const before=value.slice(0,match.index);if(before.trim()&&!/[.!?\n]\s*$/.test(before))continue;
  const quote=match[1].trim();if(!/\d/.test(quote)||!posting.includes(quote)||/(?:저는|제가|본인|우리는|우리팀|달성했|달성한|성장시|개선했|높였|늘렸|줄였|기여했)/.test(quote))continue;
  // A numeric target must really be described as a target in its source, not merely an adjacent company statistic.
  const sourceAt=posting.indexOf(quote),sourceContext=posting.slice(Math.max(0,sourceAt-15),sourceAt+quote.length+25);
  if(!/(?:목표|요건|조건|자격|필수|우대)/.test(sourceContext))continue;
  const start=match.index+match[0].indexOf(quote);spans.push({start,end:start+quote.length,source:'posting',quote});
 }
 return spans;
}
export function assertEvidenceNumbers(value,facts,profile={}){
 const allowed=new Set(facts.map(effectiveEvidence).join(' ').match(/\d+(?:[.,]\d+)*/g)||[]),spans=employerNumericSpans(value,profile);
 for(const match of value.matchAll(/\d+(?:[.,]\d+)*/g))if(!allowed.has(match[0])&&!spans.some(s=>match.index>=s.start&&match.index+match[0].length<=s.end))throw new AppError('UNSUPPORTED_NUMBER','선택한 사실에 없는 수치를 차단했습니다.',422,true);
}
function factIds(value,d,allowEmpty=false){const ids=unique(array(value).map(id=>text(id,100)));if((!allowEmpty&&!ids.length)||ids.some(id=>!d.facts.some(f=>f.id===id&&isPersonalSource(f))))error('경험이 아닌 자료 또는 선택하지 않은 사실이 계획의 근거로 쓰였습니다.');return ids;}
function evidence(value,d,required=false){if(value===null&&!required)return null;if(!object(value))error('문항별 행동·판단·결과 근거가 필요합니다.');const ids=factIds(value.factIds,d),body=text(value.text,240);assertEvidenceNumbers(body,d.facts.filter(f=>ids.includes(f.id)),d.profile);if(literalExclusions(d.exclusions).some(term=>body.includes(term)))error('제외한 소재가 근거 계획에 남아 있습니다.');return {text:body,factIds:ids};}

// All returned objects are reconstructed from an allowlist. Unknown raw model fields, scores and probabilities are never forwarded.
export function validateStrategy(raw,d){
 if(!object(raw))error('문항별 근거 계획이 확인되지 않았습니다.');
 const requirements=array(raw.requirements,15).map(r=>{
  if(!object(r)||!['posting','prompt'].includes(r.source)||!['required','optional'].includes(r.priority))error('지원 요구사항 형식이 올바르지 않습니다.');
  const id=text(r.id,100),quote=text(r.quote,300),prompt=r.source==='prompt'?d.profile.prompts.find(p=>p.id===r.promptId):null;
  const source=r.source==='posting'?d.profile.posting:prompt?.heading;
  if(!source||!source.includes(quote))error('공고·문항 요구에 원문 근거가 없습니다.');
  return {id,source:r.source,...(prompt?{promptId:prompt.id}:{}),quote,priority:r.priority};
 });unique(requirements.map(r=>r.id));
 const plans=array(raw.plans,5).map(p=>{
  if(!object(p)||!d.profile.prompts.some(x=>x.id===p.id))error('문항 계획이 실제 문항과 일치하지 않습니다.');
  const ids=unique(array(p.requirementIds).map(id=>text(id,100)));
  if(!ids.length||ids.some(id=>!requirements.some(r=>r.id===id))||!ids.some(id=>requirements.some(r=>r.id===id&&r.source==='prompt'&&r.promptId===p.id)))error('문항 요구와 경험의 연결이 없습니다.');
  return {id:p.id,requirementIds:ids,claim:evidence(p.claim,d,true),action:evidence(p.action,d,true),judgment:evidence(p.judgment,d),outcome:evidence(p.outcome,d),roleConnection:evidence(p.roleConnection,d)};
 });unique(plans.map(p=>p.id));
 if(plans.length!==d.profile.prompts.length)error('모든 문항에 근거 계획이 필요합니다.');
 if(d.profile.posting?.trim()&&!requirements.some(r=>r.source==='posting'))error('제공한 공고의 요구 분석이 빠졌습니다.');
 if(requirements.some(r=>!plans.some(p=>p.requirementIds.includes(r.id))))error('요구별 경험 매핑이 빠졌습니다.');
 return {version:'v3',requirements,plans};
}

const optionalGaps=new Set(['metrics','reaction','extraScene','style']);
// Preserve an explicit requirement. Only recognizable optional/negative wording relaxes it.
export function promptRequiresGap(kind,heading){
 const patterns={metrics:/(?:정량|수치|숫자|백분율|퍼센트|측정값|매출액|수량)/,reaction:/(?:고객|손님|상대방|이용자).{0,15}(?:반응|감정|피드백|만족|감사)|감사\s*(?:표현|반응)/,extraScene:/(?:추가|다른|두\s*가지|두\s*개|2개|2가지|여러)\s*(?:사례|경험|장면)|사례.{0,8}(?:비교|두\s*개)/,style:/(?:존댓말|경어체|서술체|대화체|문체|말투|개조식|글머리|영어로|한국어로)/};
 const pattern=patterns[kind];if(!pattern)return false;
 return String(heading||'').split(/[.!?;,()\n]+|(?:이고|이며|하되|하지만|이지만|그리고|반면|적고|쓰고)/).some(sentence=>pattern.test(sentence)&&!/(?:선택사항|선택적으로|선택입니다|선택\s*항목|가능하면|있다면|있으면|있을\s*경우|기억나면|없어도|없으면|생략|필수가?\s*아니|요구하지|불필요|작성하지|쓰지|제외)/.test(sentence));
}
const gapKinds=new Set(['none','personalAction','judgment','promptAnswer','factSupport','roleConnection',...optionalGaps]);
export function validateReview(raw,sections,d){
 if(!object(raw))error('별도 품질 검수 결과가 없습니다.');
 const reviewed=array(raw.sections,5).map(s=>{
  if(!object(s))error('문항별 품질 검수 형식이 올바르지 않습니다.');
  const section=sections.find(x=>x.id===s.id);if(!section)error('검수 문항이 최종본과 일치하지 않습니다.');
  const criteria=array(s.criteria,QUALITY_CRITERIA.length).map(c=>{
   if(!object(c)||!QUALITY_CRITERIA.includes(c.key)||!['pass','warn','hard'].includes(c.status)||!gapKinds.has(c.missingKind))error('독립 검수 기준이 누락되거나 잘못되었습니다.');
   const reason=text(c.reason,300),quote=text(c.quote,180,true),ids=factIds(c.factIds,d,true),question=text(c.question??'',240,true);
   if(quote&&!section.text.includes(quote))error('검수 인용문이 최종 문장과 일치하지 않습니다.');
   if(ids.some(id=>!section.sourceFactIds?.includes(id)))error('검수 출처가 해당 문항의 출처와 일치하지 않습니다.');
   if(c.status==='pass'&&['relevance','specificity','agency'].includes(c.key)&&(!quote||!ids.length))error('통과 판정에 구체적인 문장과 사실 근거가 필요합니다.');
   const heading=d.profile.prompts.find(p=>p.id===s.id)?.heading;
   const requirementQuote=c.requirementQuote===undefined?'':text(c.requirementQuote,300,true);
   if(requirementQuote&&!heading?.includes(requirementQuote))error('필수 부족의 문항 인용이 실제 문항과 일치하지 않습니다.');
   const status=optionalGaps.has(c.missingKind)&&c.status==='hard'&&!requirementQuote&&!promptRequiresGap(c.missingKind,heading)?'warn':c.status;
   if(status==='hard'&&(c.missingKind==='none'||!question))error('필수 부족에는 구체적인 추가 질문이 필요합니다.');
   return {key:c.key,status,reason,quote,factIds:ids,missingKind:c.missingKind,question,...(requirementQuote?{requirementQuote}:{})};
  });unique(criteria.map(x=>x.key));
  if(criteria.length!==QUALITY_CRITERIA.length)error('독립 검수 기준이 누락되었습니다.');
  return {id:s.id,criteria};
 });unique(reviewed.map(s=>s.id));
 if(reviewed.length!==d.profile.prompts.length)error('모든 문항의 별도 검수가 필요합니다.');
 return {version:'v3',scope:'submission_readiness_not_hiring_probability',sections:reviewed};
}
export function alignStrategy(strategy,sections){for(const plan of strategy.plans){const section=sections.find(s=>s.id===plan.id);for(const part of ['claim','action','judgment','outcome','roleConnection'])if(plan[part]?.factIds.some(id=>!section?.sourceFactIds?.includes(id)))error('근거 계획과 최종 문항의 사실 출처가 일치하지 않습니다.');}}
export const hardFindings=review=>review.sections.flatMap(s=>s.criteria.filter(c=>c.status==='hard').map(c=>({id:s.id,...c})));
export const qualityWarnings=review=>review.sections.flatMap(s=>s.criteria.filter(c=>c.status==='warn').map(c=>QUALITY_LABELS[c.key]+': '+c.reason));
// Common literal requests only. Semantic exclusions and paraphrases still require independent AI review.
export function literalExclusions(value){
 const parts=String(value||'').split(/[\n;!?]+|(?<!\d)[.,]|[.,](?!\d)/u),terms=[];
 const instruction=/(?:쓰지\s*(?:말아\s*주세요|마세요)|적지\s*(?:말아\s*주세요|마세요)|넣지\s*(?:말아\s*주세요|마세요)|언급(?:을)?\s*(?:하지\s*(?:말아\s*주세요|마세요)|금지)|사용(?:을)?\s*(?:하지\s*(?:말아\s*주세요|마세요)|금지)|제외(?:해\s*주세요|해줘|해주세요)?|빼\s*주세요|삭제해\s*주세요)\s*$/u;
 for(let part of parts){
  part=part.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g,'');if(!part)continue;
  const hasInstruction=instruction.test(part);
  if(hasInstruction){
   part=part.replace(instruction,'').replace(/\s*(?:글|문장|자기소개서)에서\s*$/,'').trim();
   // Corrections often put the superseded value after a reason or contrast clause.
   part=part.split(/(?:으니|했으니|했지만|하였으니)\s*/u).at(-1).replace(/^(?:처음|이전|원래)\s*답변의\s*/,'');
   part=part.replace(/\s*(?:이야기|경험|내용|사항)(?:은|는|을|를)?\s*$/,'').replace(/(?:은|는|을|를)\s*$/,'').trim();
   if(/가나다순/.test(part))terms.push('가나다순');
  }
  part=part.replace(/^["'“”‘’]+|["'“”‘’]+$/g,'').trim();
  if(part.length>=2&&part.length<=100)terms.push(part);
 }
 return [...new Set(terms)];
}
export function deterministicSections(sections,d){
 for(const s of sections){
  if(!Array.isArray(s.sourceFactIds)||!s.sourceFactIds.length||s.sourceFactIds.length>15||s.sourceFactIds.some(id=>!d.facts.some(f=>f.id===id&&isPersonalSource(f))))throw new AppError('FACT_SOURCE','초안 사실 출처가 유효하지 않습니다.',422,true);
  assertEvidenceNumbers(s.text,d.facts.filter(f=>s.sourceFactIds.includes(f.id)),d.profile);
  if(literalExclusions(d.exclusions).some(term=>s.text.includes(term)))throw new AppError('EXCLUDED_CONTENT','제외 요청한 소재가 남아 있습니다.',422,true);
 }
}
export const QUALITY_STRATEGY_PROMPT=' strategy를 함께 반환: {requirements:[{id,source:"posting"|"prompt",promptId(문항일때),quote(공고/문항의 연속 원문 최대300자),priority:"required"|"optional"}],plans:[{id(문항ID),requirementIds:[],claim:{text,factIds:[]},action:{text,factIds:[]},judgment:{text,factIds:[]}|null,outcome:{text,factIds:[]}|null,roleConnection:{text,factIds:[]}|null}]}. 요구는 최대15개로 핵심만, 모든 문항 요구와 제공된 공고의 핵심 요구를 포함하고 요구마다 계획에 매핑. 모든 계획은 자신의 문항 요구와 연결. 각 text최대240자. claim/action은 실제 본인행동 근거 필수. judgment/outcome/roleConnection은 미확인시 null, 창작금지. 직무 연결은 확인된 행동을 어떤 업무에 활용할지 구분하며 회사 특징을 추측하지 않는다. 공고요구는 사용자 경력/숫자가 아님. 숫자있는 회사명은 정확한 고유명사만 쓴다. 회사 수치가 필요하면 공고 원문을 짧게 그대로 인용하여 공고의 목표임을 명시하고 본인성과와 분리한다. 예: 공고의 "매출 30% 성장" 목표에 공감합니다. q1~q5는 경험근거로 사용금지. 모든 개인근거는 선택 facts 중 fact만. 정정text가 있으면 이전 quote/originalText의 숫자·역할은 폐기. 구조화 계획도 같은 사실·제외사항 검수 대상. 핵심 행동·판단·결과를 구분하고 문항끼리 같은 경험을 써도 주장/장면은 다르게 설계. 합격률·점수·상대우위 예측 금지.';
export const QUALITY_REVIEW_PROMPT=' 추가로 review:{sections:[{id,criteria:[{key,status:"pass"|"warn"|"hard",reason(보통40~70자,최대300자),quote(반환 최종본문의 연속원문 보통20~50자,최대180자,없으면 빈문자열),factIds:[],missingKind:"none"|"personalAction"|"judgment"|"promptAnswer"|"factSupport"|"roleConnection"|"metrics"|"reaction"|"extraScene"|"style",question(필수부족시 구체적 질문 최대240자),requirementQuote(문항의 명시적 요구 때문에 hard이면 해당 요구의 연속 원문 최대300자,선택적 보강이면 생략)}]}]} 필수. 출력은 간결하게 유지: reason은 한 문장40~70자, 통과 relevance/specificity/agency의 quote는20~50자, 그 외 quote는 판정 설명에 꼭 필요하지 않으면 빈문자열. 같은 근거를 길게 반복하지 말고 최종본문과 필수검수 구조를 먼저 완결한다. 매 문항 8기준 relevance/specificity/agency/reasoning/roleFit/repetition/cliches/naturalness를 각각 독립판정. 앞선 계획/자기평가를 그대로 믿지 말고 최종본과 근거 대조. 문항 질문에 실제 답했는지, 본인행동·기여가 팀성과와 분리되는지, 판단이유가 요구되면 실제로 있는지, 공고직무 연결이 구체적인지, 문항간 중복·상투어·부자연스러움 검사. relevance/specificity/agency 통과는 최종본문quote와 factIds 필수. 필수 문항에 답하지 못함/본인행동 없음/출처없는 주장만 hard. 작은 표현개선은 warn. 문항이 수치·고객반응·추가장면·특정문체를 명시적으로 요구하면 해당 근거 부재는 hard로 유지하며 필수 질문을 적는다. 문항이 요구하지 않는 수치·감사·고객감정·추가장면 부재만 metrics/reaction/extraScene으로 warn. 정량 요구가 없으면 사실에 있는 정성적 결과로 충분. 이유가 문항 필수가 아니면 판단이유 추가는 선택적 보강. hard에는 어떤 상황에서 직접 무엇을 했는지 등 문항에 맞는 질문 하나를 명시. 이미 수정된 문제는 최종본 hard에 남기지 말 것. 전략 오류가 있으면 strategy도 수정해서 반환, 기존 전략이 유효하면 생략 가능. audit.sufficient는 optional 보강 때문에 false로 하지 않는다. 최종본 자체가 사용불가한 미해결 문제만 hard. 합격점수/확률 금지.';
export const INTERVIEW_QUALITY_PROMPT=' profile.posting과 prompts를 읽고 실제 문항/직무에 연결되는 경험부터 찾는다. 공고의 필수 자격·업무 경험이 확인되지 않았으면 충족했다고 가정하지 말고 쉬운 질문 하나로 확인하라. 필수 자격이 없다는 답도 그대로 인정하고 모든 요구를 충족한 것처럼 꾸미거나 채용을 보장하지 않는다. 지원에 무관한 경험을 무작정 늘리지 않는다. 쉬운 질문 하나로만 진행: 최신 경험에서 상황→직접한 행동→왜 그 선택→확인된 변화 중 가장 중요한 빈칸 하나를 묻는다. 무엇/왜/결과를 한꺼번에 요구하지 않는다. 숫자가 없어도 바뀐 행동·완료된 일을 말할 수 있게 안내하고 모르면 없다고 답해도 됨. 구체 답변에 근거한 발견 label은 행동 소재를 이름붙일 뿐 뛰어난 역량/인재라는 일반 칭찬 금지. 선택지에서 성과를 유도/가정하지 말고 선택적 보강만 남았으면 ready. 꼬리질문은 sourceAnswerIds를 1개이상 연결하며 인용 가능한 실제 경험을 title/helper에 언급.';
