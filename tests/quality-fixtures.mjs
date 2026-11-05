// Test-only scaffolding for legacy MECHANICAL checks. This is not a semantic quality assessor.
// It adds the required envelope to mocked responses, never changing sections, sources, audit,
// missing questions, warnings, provider usage or stop reasons. quality-v3.test.mjs bypasses it.
import {QUALITY_CRITERIA,isPersonalSource,effectiveEvidence} from '../lib/quality.mjs';
const clip=(value,max)=>Array.from(String(value||'')).slice(0,max).join('');
export function mechanicalStrategy(data,sections=[]){
 const prompts=data.profile.prompts,posting=data.profile.posting||'';
 const requirements=prompts.map((p,i)=>({id:'req'+i,source:'prompt',promptId:p.id,quote:clip(p.heading,300),priority:'required'}));
 if(posting.trim())requirements.push({id:'posting',source:'posting',quote:clip(posting,300),priority:'required'});
 const facts=data.facts.filter(isPersonalSource);
 return {requirements,plans:prompts.map((p,i)=>{
  const section=sections.find(s=>s?.id===p.id),fact=facts.find(f=>section?.sourceFactIds?.includes(f.id))||facts[0];
  if(!fact)throw new Error('Mechanical fixture requires a real q6+ personal fact.');
  const evidence={text:clip(effectiveEvidence(fact),240),factIds:[fact.id]};
  return {id:p.id,requirementIds:['req'+i,...(posting.trim()?['posting']:[])],claim:{...evidence},action:{...evidence},judgment:null,outcome:null,roleConnection:null};
 })};
}
export function mechanicalReview(data,sections=[]){return {sections:sections.filter(s=>s&&typeof s.id==='string'&&typeof s.text==='string').map(s=>({id:s.id,criteria:QUALITY_CRITERIA.map(key=>({key,status:'pass',reason:'기계적 회귀검사를 위한 모의 독립검수입니다.',quote:clip(s.text,40),factIds:(s.sourceFactIds||[]).filter(id=>data.facts.some(f=>f.id===id&&isPersonalSource(f))),missingKind:'none',question:''}))}))};}
export function withMechanicalQuality(output,data,stage){
 if(!output||!data?.profile?.prompts||!Array.isArray(data.facts)||!Array.isArray(output.sections)||!output.sections.length)return output;
 return {...output,...(!Object.hasOwn(output,'strategy')?{strategy:mechanicalStrategy(data,output.sections)}:{}),...(stage==='review'&&!Object.hasOwn(output,'review')?{review:mechanicalReview(data,output.sections)}:{})};
}
export function qualityMockDeps(deps){
 const out={...deps};
 if(deps.ai)out.ai=async(system,payload,tokens,meta)=>withMechanicalQuality(await deps.ai(system,payload,tokens,meta),payload,meta?.stage);
 if(deps.fetcher)out.fetcher=async(url,opts)=>{
  const response=await deps.fetcher(url,opts);
  let payload;try{const request=JSON.parse(opts?.body);if(!Array.isArray(request.messages))return response;payload=JSON.parse(request.messages.at(-1).content);}catch{return response;}
  if(!Array.isArray(payload?.facts)||!payload.profile||!response.ok||typeof response.text!=='function'||response.body)return response;
  return {...response,text:async()=>{
   const raw=await response.text();let parsed;try{parsed=JSON.parse(raw);}catch{return raw;}
   const choice=parsed.choices?.[0];if(choice?.finish_reason!=='stop'||typeof choice.message?.content!=='string')return raw;
   let output;try{output=JSON.parse(choice.message.content);}catch{return raw;}
   choice.message.content=JSON.stringify(withMechanicalQuality(output,payload,payload.draft?'review':'draft'));
   return JSON.stringify(parsed);
  }};
 };
 return out;
}
