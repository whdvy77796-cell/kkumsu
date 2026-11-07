import {AppError,fail,count} from './core.mjs';
import {validateRevision,revisionLimits,reserveRevisionCost,runRevision,validateDeepAnalysis} from './revision.mjs';
import {clippedRanges} from './inline-diff.mjs';
import {reportPlan,runReportSynthesis} from './report-synthesis.mjs';

export const LONG_MAX_CHARS=100000;
export const CHUNK_TARGET_CHARS=4500;
const MAX_CHARS=6000, MIN_CHARS=40;
const CHECKS={fit:'문항 응답성',logic:'논리·본인 역할',evidence:'원문·수치 근거',wording:'자연스러운 문장',spelling:'맞춤법',length:'분량'};
const SCOPE='각 구간을 따로 검토했습니다. 구간 사이의 맥락·용어·논리 일관성은 제출 전 별도로 확인해야 합니다.';
// Only exhausted content/format review failures permit an unchanged-source fallback.
// Provider, budget, cancellation and runtime failures must still abort the request.
const PRESERVABLE_ERRORS=new Set(['REVISION_UNSAFE','FACT_QUOTE','ANALYSIS_QUOTE','ANALYSIS_REVIEW','AI_FORMAT','REVIEW_TARGET','AI_TRUNCATED']);
const preservationNotice=n=>`${n}개 구간은 AI 수정본의 원문 보존·검수 기준을 충족하지 못해 원문을 그대로 유지했습니다. 해당 구간은 첨삭 완료가 아니며 수정 표시와 AI 분석을 제외했으니 제출 전 직접 확인해주세요.`;
const invalid=()=>fail('INVALID_INPUT','원문 형식 또는 길이를 확인해주세요.');
const badResult=()=>fail('AI_FORMAT','구간 첨삭 결과 형식을 확인해주세요.',422,true);

// Code-point indices only. Separators belong to their original chunk, never synthesized.
export function splitLongRevision(text){
 if(typeof text!=='string'||!text.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))invalid();
 const chars=Array.from(text),n=chars.length;
 if(n>LONG_MAX_CHARS)fail('INPUT_TOO_LARGE','원문은 100,000자 이하로 입력해주세요.',413);
 if(text.trim()&&n<MIN_CHARS)invalid();
 if(!n)return [];
 const boundaries=[];let sinceLine='',lastNonspace='';
 for(let i=0;i<n;i++){
  const ch=chars[i];let rank=0;
  if(ch==='\n'){rank=/^[\t \r]*$/u.test(sinceLine)&&i>0?4:3;sinceLine='';}
  else if(ch==='\r'){rank=3;sinceLine+=ch;}
  else {sinceLine=/[\t ]/u.test(ch)&&sinceLine.length<2?sinceLine+ch:'x';}
  if(/\s/u.test(ch))rank=Math.max(rank,/[.!?。！？]/u.test(lastNonspace)?2:1);
  else lastNonspace=ch;
  if(rank)boundaries.push({at:i+1,rank});
 }
 const parts=[];let start=0,bi=0;
 while(n-start>MAX_CHARS){
  const target=start+CHUNK_TARGET_CHARS,low=start+3000,high=Math.min(start+5250,n-MIN_CHARS);
  let best=null;
  while(bi<boundaries.length&&boundaries[bi].at<low)bi++;
  for(let j=bi;j<boundaries.length&&boundaries[j].at<=high;j++){
   const b=boundaries[j];
   if(chars[b.at-1]==='\r'&&chars[b.at]==='\n')continue;
   if(!best||b.rank>best.rank||(b.rank===best.rank&&Math.abs(b.at-target)<Math.abs(best.at-target)))best=b;
  }
  const end=best?.at??target;parts.push(chars.slice(start,end).join(''));start=end;
 }
 if(start<n)parts.push(chars.slice(start).join(''));
 if(parts.length>1&&count(parts.at(-1))<MIN_CHARS&&count(parts.at(-2))+count(parts.at(-1))<=MAX_CHARS){const tail=parts.pop();parts[parts.length-1]+=tail;}
 return parts;
}

// Internal planning data contains source text. Never log, persist or project this plan.
export function planLongRevision(c,data,options={}){
 if(!data||typeof data!=='object'||Array.isArray(data))invalid();
 const chunks=splitLongRevision(data.originalText);
 if(!data.originalText.trim()||count(data.originalText)<MIN_CHARS)invalid();
 let maxCost=0;const parts=[];
 const add=text=>{
  const chunkIndex=parts.length;
  if(!text.trim()){parts.push({chunkIndex,text,process:false,data:null,limits:null,maxCost:0});return;}
  const d=validateRevision({...data,originalText:text,clientVersion:'simple-v5'});
  let limits;
  try{limits=revisionLimits(c,d);}catch(e){
   // Byte caps vary by script and configuration. Subdivide locally rather than
   // weakening the existing worst-case repair/review input bounds.
   const chars=Array.from(text);
   if(e.code!=='INPUT_TOO_LARGE'||chars.length<MIN_CHARS*2)throw e;
   let cut=Math.floor(chars.length/2);
   if(chars[cut-1]==='\r'&&chars[cut]==='\n'&&chars.length-cut>MIN_CHARS)cut++;
   add(chars.slice(0,cut).join(''));add(chars.slice(cut).join(''));return;
  }
  const cost=reserveRevisionCost(c,d);
  if(!Number.isSafeInteger(cost)||cost<0||!Number.isSafeInteger(maxCost+cost))fail('CONFIG','AI 비용 상한을 확인해주세요.',503);
  maxCost+=cost;
  parts.push({chunkIndex,text,process:true,data:d,limits,maxCost:cost});
 };
 chunks.forEach(add);
 if(options.withReport===true){const report=reportPlan(c);if(!Number.isSafeInteger(maxCost+report.maxCost))fail('CONFIG','AI 비용 상한을 확인해주세요.',503);maxCost+=report.maxCost;return {parts,maxCost,report};}
 return {parts,maxCost};
}

function validatedPart(result,part){
 const r=result?.revision,section=result?.sections?.[0];
 if(result?.product!=='revision'||result?.sections?.length!==1||typeof section?.text!=='string'||!section.text.trim()||!section.text.isWellFormed()||count(section.text)>part.limits.maxTextChars||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(section.text)||r?.previewVersion!=='continuous-v3')badResult();
 // Production runRevision already checks all cards and independent review. Recheck
 // card structure/quotes at the injection seam, never trust unvalidated cards.
 const deepAnalysis=validateDeepAnalysis(r.deepAnalysis,part.data);
 if(result.quality?.checks?.some(x=>x.status==='hard'))badResult();
 const leading=part.text.match(/^\s*/u)[0],trailing=part.text.match(/\s*$/u)[0];
 const candidate=section.text,left=count(candidate)-count(candidate.trimStart()),right=count(candidate.trimEnd());
 const restored=leading+candidate.trim()+trailing,shift=count(leading)-left;
 const ranges=clippedRanges(r.inlineEditRanges,count(candidate),count(candidate)).flatMap(([a,b])=>{
  const start=Math.max(a,left),end=Math.min(b,right);
  return start<end?[[start+shift,end+shift]]:[];
 });
 const changes=(Array.isArray(r.changes)?r.changes:[]).slice(0,8).filter(x=>x&&['logic','evidence','wording','spelling'].includes(x.category)&&typeof x.before==='string'&&x.before.trim()&&count(x.before)<=220&&part.text.includes(x.before)&&typeof x.after==='string'&&x.after.trim()&&count(x.after)<=220&&x.before!==x.after&&restored.includes(x.after)&&typeof x.reason==='string'&&x.reason.trim()&&count(x.reason)<=160).map(({category,before,after,reason})=>({category,before,after,reason}));
 return {text:restored,ranges,changes,deepAnalysis,analysisSanitized:r.analysisSanitized===true,reviewReasonSanitized:r.reviewReasonSanitized===true,quality:result.quality,warnings:Array.isArray(r.warnings)?r.warnings.filter(x=>typeof x==='string'):[]};
}

export async function runLongRevision(c,data,deps={}){
 const synthesizeReport=deps.synthesizeReport===true;
 const {parts}=planLongRevision(c,data,{withReport:synthesizeReport}),results=new Array(parts.length);
 const {runChunk=runRevision,runReport=runReportSynthesis,beforeCall,onCallStarted,onUsage,synthesizeReport:_sr,...rest}=deps;
 let next=0,failed=false,failure;
 const worker=async()=>{
  while(!failed&&next<parts.length){
   const i=next++,part=parts[i];
   if(!part.process){results[i]={text:part.text,ranges:[]};continue;}
   try{
    const result=await runChunk(c,part.data,{...rest,longChunk:true,
     beforeCall:async info=>{if(failed)throw failure;if(typeof beforeCall==='function')await beforeCall({...info,chunkIndex:i});if(failed)throw failure;}, 
     onCallStarted:typeof onCallStarted==='function'?()=>onCallStarted(i):undefined,
     onUsage:typeof onUsage==='function'?cost=>onUsage(i,cost):undefined});
    results[i]=validatedPart(result,part);
   }catch(e){
    if(failed)continue;
    if(PRESERVABLE_ERRORS.has(e?.code)){
     // Discard the rejected candidate, every AI card, warning and edit range.
     // Keep the exact original including its Unicode and separator bytes.
     results[i]={text:part.text,ranges:[],preserved:true};
    }else {failed=true;failure=e;}
   }
  }
 };
 // Wait for every active provider call's usage before rejecting. Nothing is saved
 // here and there is no independently public chunk preview.
 await Promise.all(Array.from({length:Math.min(3,parts.length)},()=>worker()));
 if(failed)throw failure;
 const preservedChunks=results.filter(x=>x.preserved===true).length;
 if(preservedChunks===parts.filter(x=>x.process).length)throw new AppError('REVISION_UNSAFE','모든 구간의 AI 수정본을 안전하게 확인하지 못해 결과를 제공하지 않았습니다. 원문은 유지되며 다시 시도해주세요.',422,true,{preservedChunks});
 const notice=preservedChunks?preservationNotice(preservedChunks):'';
 const revised=results.map(x=>x.text).join(''),ranges=[];
 let offset=0;for(const result of results){for(const [a,b] of result.ranges)ranges.push([offset+a,offset+b]);offset+=count(result.text);}
 const processed=results.filter(x=>x.deepAnalysis);
 const changes=processed.flatMap(x=>x.changes||[]).slice(0,200);
 let deepAnalysis={overview:SCOPE+(notice?' '+notice:''),strengths:[],improvements:[],questions:[]},reportResult=null;
 for(const result of processed)for(const key of ['strengths','improvements','questions'])deepAnalysis[key].push(...result.deepAnalysis[key]);
 if(synthesizeReport){reportResult=await runReport(c,{originalText:data.originalText,parts:parts.map((part,i)=>({text:part.text,deepAnalysis:results[i]?.deepAnalysis,preserved:results[i]?.preserved===true}))},{...rest,beforeCall,onCallStarted,onUsage,chunkIndex:parts.length});deepAnalysis=reportResult.deepAnalysis;}
 const checks=Object.entries(CHECKS).map(([key,label])=>{
  const entries=processed.map(x=>x.quality?.checks?.find(y=>y.key===key));
  const notChecked=key==='fit'||key==='length'||entries.some(x=>!x||x.not_checked||x.status==='not_checked');
  return {key,label,status:!preservedChunks&&!notChecked&&entries.every(x=>x.status==='pass')?'pass':'attention',...(notChecked?{not_checked:true}:{}),reason:(key==='fit'?'문항 미입력: 문항 적합성 미검토. ':key==='length'?'분량 제한 미입력. ':'')+SCOPE+(notice?' '+notice:'')};
 });
 return {source:'ai',product:'revision',sections:[{id:'p1',heading:'다듬은 자기소개서',text:revised,charLimit:null}],
  quality:{isPromptProvided:false,isLimitProvided:false,scope:'chunk_source_alignment_not_cross_chunk_consistency',checks,repairAttempted:processed.some(x=>x.quality?.repairAttempted===true)},
  revision:{previewVersion:'continuous-v3',longChunked:true,preservedChunks,analysisSanitized:preservedChunks>0||processed.some(x=>x.analysisSanitized)||reportResult?.sanitized===true,reviewReasonSanitized:processed.some(x=>x.reviewReasonSanitized),...(reportResult?{reportScope:reportResult.scope}:{}),inlineEditRanges:ranges,promptProvided:false,limitProvided:false,lengthMode:'characters',limit:null,originalLength:count(data.originalText),revisedLength:count(revised),deepAnalysis,changes,diagnosis:[],warnings:[...new Set([...processed.flatMap(x=>x.warnings),...(notice?[notice]:[]),SCOPE,'원문과의 대조이며 사실의 진실성이나 합격을 인증하지 않습니다.'])]}};
}
