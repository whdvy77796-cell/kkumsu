import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {runRevision} from '../lib/revision.mjs';
import {safeRevisionError,revisionFailureDiagnostic} from '../lib/revision-api.mjs';
import {AppError} from '../lib/core.mjs';
// All inputs and model outputs below are fictional. No network or customer text.
const original='가상의 독서 행사에서 저는 안내 표지를 정리하고 팀원과 위치를 확인했습니다. 방문객에게 행사장 방향을 설명했고 행사 뒤 팀원과 질문 내용을 살펴봤습니다.';
const revised='가상의 독서 행사에서 저는 안내 표지를 정리하고 팀원과 위치를 확인했습니다. 방문객에게 행사장 방향을 설명한 뒤 팀원과 질문 내용을 살펴봤습니다.';
const quote='안내 표지를 정리하고';
const cfg={maxInputBytes:120000,inputRate:3,outputRate:15,provider:'mock',model:'mock'};
const req=()=>({action:'revise',requestId:randomUUID(),clientVersion:'simple-v5',product:'free',consent:true,consentProvider:'mock',consentModel:'mock',offerVersion:'v4-revision-3000',originalText:original});
const sha=x=>createHash('sha256').update(x).digest('hex');
const rep=()=>({overview:'행사에서 한 행동과 확인 과정을 살펴봅니다.',strengths:[{quote,comment:'직접 한 행동이 보입니다.'}],improvements:[{priority:'high',quote:'팀원과 위치를 확인했습니다',problem:'확인 과정이 짧습니다.',suggestion:'실제로 있었다면 확인한 방법을 적어 보세요.'}],questions:[]});
const note=()=>({category:'logic',before:'방문객에게 행사장 방향을 설명했고',after:'방문객에게 행사장 방향을 설명한 뒤',reason:'행동 순서를 이어 주었습니다.'});
const draft=()=>({status:'ready',text:revised,changes:[note()],diagnosis:[],warnings:[],deepAnalysis:rep()});
const keys=['fit','evidence','agency','causality','numbers','naturalness','length'];
function reviewed(p,alter=()=>{}){const c=p.candidate,a=c.deepAnalysis,n=c.changes||[],ev=[{sourceId:'original',quote}];const r={candidateDigest:sha(JSON.stringify(n.length?[c.text,a,n]:[c.text,a])),checks:keys.map(key=>({key,status:'pass',quote,reason:'원문과 대조했습니다.',evidence:ev.map(x=>({...x}))})),claims:[{quote,status:'supported',reason:'원문에 있습니다.',evidence:ev.map(x=>({...x}))}],analysis:{status:'supported',reviewed:1+a.strengths.length+a.improvements.length+a.questions.length+n.length,issues:[]}};alter(r);return r;}
function mock(seq){let i=0;const calls=[];return {calls,ai:async(system,payload,tokens,options)=>{calls.push({system,payload,tokens});options.onCallStarted?.();options.onUsage?.(1);const v=seq[i++];if(v===undefined)throw Error('unexpected call');return typeof v==='function'?v(payload):v;}};}
const ok=p=>reviewed(p);
const badReason=p=>reviewed(p,r=>{r.checks[1].reason='가'.repeat(170);r.claims[0].reason='';});
test('malformed review explanations are replaced only as metadata, while grounded review remains required',async()=>{
 for(const bad of [badReason,p=>reviewed(p,r=>{r.checks[1].reason=null;}),p=>reviewed(p,r=>{r.claims[0].reason='\u0000';})]){
  const m=mock([draft(),bad]),r=await runRevision(cfg,req(),{ai:m.ai});assert.equal(m.calls.length,2);assert.equal(r.sections[0].text,revised);assert.equal(r.review.reasonSanitized,true);assert.equal(r.revision.reviewReasonSanitized,true);assert(r.revision.warnings.some(x=>x.includes('기본 안내')));assert.equal(r.review.claims[0].status,'supported');assert.deepEqual(r.review.claims[0].evidence,[{sourceId:'original',quote}]);assert(!JSON.stringify(r.review).includes('가'.repeat(170)));
 }
});
test('invalid metadata never upgrades unsupported personal claims or hard checks',async()=>{
 const unsupported=p=>reviewed(p,r=>{r.claims[0].status='unsupported';r.claims[0].reason=null;});
 await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),unsupported,draft(),unsupported]).ai}),e=>e.code==='REVISION_UNSAFE'&&e.details.issueKeys.includes('evidence'));
 const hard=p=>reviewed(p,r=>{r.checks.find(x=>x.key==='agency').status='hard';r.checks.find(x=>x.key==='agency').reason='';});
 await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),hard,draft(),hard]).ai}),e=>e.code==='REVISION_UNSAFE'&&e.details.issueKeys.includes('agency'));
});
for(const field of ['check_quote','claim_quote','evidence_quote'])test('malformed '+field+' still retries and fails closed',async()=>{
 const bad=p=>reviewed(p,r=>{if(field==='check_quote')r.checks[1].quote='가'.repeat(221);if(field==='claim_quote')r.claims[0].quote='가'.repeat(221);if(field==='evidence_quote')r.claims[0].evidence[0].quote='가'.repeat(221);});
 const m=mock([draft(),bad,bad]);let caught;try{await runRevision(cfg,req(),{ai:m.ai});assert.fail('invalid quote accepted');}catch(e){caught=e;}
 assert.equal(caught.code,'AI_FORMAT');assert.equal(caught.safeReviewField,field);assert.equal(m.calls.length,3);const diag=revisionFailureDiagnostic(caught,3);assert.equal(diag.formatField,field);assert.equal(safeRevisionError(caught).formatField,field);assert(!JSON.stringify(diag).includes(original));assert(!m.calls[2].payload.formatRetry.includes(original));assert(m.calls[2].payload.formatRetry.includes('220자 이하'));
});
test('after draft retry a malformed review gets a final review retry, within four calls',async()=>{
 const malformed={status:'ready',text:'',changes:[],diagnosis:[],warnings:[],deepAnalysis:rep()};
 const bad=p=>reviewed(p,r=>{r.claims[0].quote='가'.repeat(221);});
 const m=mock([malformed,draft(),bad,ok]),r=await runRevision(cfg,req(),{ai:m.ai});
 assert.equal(m.calls.length,4);assert.equal(r.sections[0].text,revised);assert.equal(m.calls[3].payload.candidateDigest,m.calls[2].payload.candidateDigest);assert(m.calls[3].payload.formatRetry.includes('claims의 quote'));
});
test('a third-call report-only review failure removes only unverified fields',async()=>{
 const bad=p=>reviewed(p,r=>{r.claims[0].quote='가'.repeat(221);});
 const incomplete=p=>reviewed(p,r=>{r.analysis.status='unsupported';r.analysis.issues=[{ref:'improvements[0]',reason:'근거가 불충분합니다.'},{ref:'changes[0]',reason:'설명을 확인하지 못했습니다.'}];});
 const m=mock([draft(),bad,incomplete]),r=await runRevision(cfg,req(),{ai:m.ai});
 assert.equal(m.calls.length,3);assert.equal(r.sections[0].text,revised);assert.equal(r.revision.analysisSanitized,true);assert.equal(r.revision.deepAnalysis.improvements.length,0);assert.equal(r.revision.deepAnalysis.strengths.length,1);assert.deepEqual(r.revision.changes,[]);assert.equal(r.review.analysis.sanitized,true);assert.equal(r.review.reviewedCandidateDigest,r.review.candidateDigest);assert.notEqual(r.review.sanitizedCandidateDigest,r.review.candidateDigest);assert.equal(r.review.reviewedTextDigest,sha(revised));
});
test('report-only salvage never masks a hard personal-fact failure',async()=>{
 const bad=p=>reviewed(p,r=>{r.claims[0].quote='가'.repeat(221);});
 const unsafe=p=>reviewed(p,r=>{r.analysis.status='unsupported';r.analysis.issues=[{ref:'overview',reason:'근거가 불충분합니다.'}];r.claims[0].status='unsupported';});
 await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),bad,unsafe]).ai}),e=>e.code==='REVISION_UNSAFE'&&e.details.issueKeys.includes('evidence'));
});
test('if report repair output is malformed, the previously reviewed text survives with bad report fields removed',async()=>{
 const incomplete=p=>reviewed(p,r=>{r.analysis.status='unsupported';r.analysis.issues=[{ref:'improvements[0]',reason:'근거가 불충분합니다.'}];});
 const m=mock([draft(),incomplete,{status:'ready',text:'',changes:[],diagnosis:[],warnings:[],deepAnalysis:rep()}]);
 const r=await runRevision(cfg,req(),{ai:m.ai});assert.equal(m.calls.length,3);assert.equal(r.sections[0].text,revised);assert.equal(r.revision.analysisSanitized,true);assert.equal(r.revision.deepAnalysis.improvements.length,0);
});
test('provider failure or cancellation during report repair is never hidden by fallback',async()=>{
 const incomplete=p=>reviewed(p,r=>{r.analysis.status='unsupported';r.analysis.issues=[{ref:'overview',reason:'근거가 불충분합니다.'}];});
 for(const code of ['PROVIDER_TIMEOUT','REQUEST_CANCELLED']){const fail=()=>{throw new AppError(code,'가상 오류',503,true);};await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),incomplete,fail]).ai}),{code});}
});

test('unprovided fit and length checks are always not_checked even when model metadata is malformed',async()=>{
 const model=p=>reviewed(p,r=>{for(const key of ['fit','length']){const x=r.checks.find(v=>v.key===key);x.status='nonsense';x.quote=null;x.reason=null;x.evidence=null;}});
 const m=mock([draft(),model]),r=await runRevision(cfg,req(),{ai:m.ai});
 for(const key of ['fit','length']){const x=r.review.checks.find(v=>v.key===key);assert.equal(x.status,'attention');assert.equal(x.not_checked,true);assert.equal(x.quote,'');assert.deepEqual(x.evidence,[]);}
 assert.equal(m.calls.length,2);
});
test('optional check null quote and evidence mean empty, never a passed required source check',async()=>{
 const optional=p=>reviewed(p,r=>{const x=r.checks.find(v=>v.key==='numbers');x.status='attention';x.quote=null;x.evidence=null;});
 const r=await runRevision(cfg,req(),{ai:mock([draft(),optional]).ai});assert.equal(r.review.checks.find(x=>x.key==='numbers').status,'attention');assert.deepEqual(r.review.checks.find(x=>x.key==='numbers').evidence,[]);
 const missing=p=>reviewed(p,r=>{const x=r.checks.find(v=>v.key==='agency');x.quote=null;x.evidence=null;});
 await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),missing,missing]).ai}),{code:'AI_FORMAT'});
});
test('a supported claim still cannot pass without source evidence',async()=>{
 const missing=p=>reviewed(p,r=>{r.claims[0].evidence=null;});
 await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),missing,missing]).ai}),{code:'AI_FORMAT'});
});

test('bidirectional and zero-width reason controls are replaced without exposing them',async()=>{
 for(const c of ['\u200b','\u202e',String.fromCodePoint(0xe0001)]){const model=p=>reviewed(p,r=>{r.claims[0].reason='가상'+c+'사유';});const r=await runRevision(cfg,req(),{ai:mock([draft(),model]).ai});assert.equal(r.review.reasonSanitized,true);assert(!JSON.stringify(r.review).includes(c));}
});
test('unknown report issue references never trigger report salvage',async()=>{
 const bad=p=>reviewed(p,r=>{r.analysis.status='unsupported';r.analysis.issues=[{ref:'claims[0]',reason:'원문 근거 없음'}];});
 await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),bad,bad]).ai}),{code:'ANALYSIS_REVIEW'});
});
test('all flagged report cards and edit notes are removed and an incomplete notice remains',async()=>{
 const first=p=>reviewed(p,r=>{r.claims[0].quote='가'.repeat(221);});
 const all=p=>reviewed(p,r=>{r.analysis.status='unsupported';r.analysis.issues=['overview','strengths[0]','improvements[0]','changes[0]'].map(ref=>({ref,reason:'원문 근거 확인 필요'}));});
 const r=await runRevision(cfg,req(),{ai:mock([draft(),first,all]).ai});assert.equal(r.sections[0].text,revised);assert.equal(r.revision.analysisSanitized,true);assert.equal(r.revision.deepAnalysis.strengths.length,0);assert.equal(r.revision.deepAnalysis.improvements.length,0);assert.equal(r.revision.changes.length,0);assert(r.revision.deepAnalysis.overview.includes('제외'));
});
test('a repair draft with changed text cannot reuse an old review digest',async()=>{
 let old;const failReview=p=>{const r=reviewed(p,x=>{x.claims[0].status='unsupported';});old=r.candidateDigest;return r;};
 const changed={...draft(),text:revised+' 확인했습니다.'};const stale=p=>({...reviewed(p),candidateDigest:old});
 await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),failReview,changed,stale]).ai}),{code:'REVIEW_TARGET'});
});

test('source quote matching rejects invisible insertion and different Korean codepoints',async()=>{
 for(const altered of [quote.slice(0,1)+'\u200b'+quote.slice(1),quote.normalize('NFD')]){const bad=p=>reviewed(p,r=>{r.claims[0].evidence[0].quote=altered;});await assert.rejects(()=>runRevision(cfg,req(),{ai:mock([draft(),bad,bad]).ai}),{code:'FACT_QUOTE'});}
});
test('whitespace-only quote variation is restored to an exact source slice',async()=>{
 const q=quote.replaceAll(' ','\u3000');const model=p=>reviewed(p,r=>{r.claims[0].evidence[0].quote=q;});const r=await runRevision(cfg,req(),{ai:mock([draft(),model]).ai});assert.equal(r.review.claims[0].evidence[0].quote,quote);
});
