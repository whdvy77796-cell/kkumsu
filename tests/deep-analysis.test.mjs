import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {validateRevision,revisionLimits,reserveRevisionCost,runRevision,validateDeepAnalysis} from '../lib/revision.mjs';
import {minimumRevisionBudget} from '../lib/revision-api.mjs';
import {PaymentService} from '../lib/payments.mjs';
import {MockRedis} from './mock-redis.mjs';
// All text below is fictional; every AI/network call is a local mock.
const config={maxInputBytes:60000,inputRate:3,outputRate:15,provider:'mock-provider',model:'mock-model'};
const essay='가상 동아리 전시에서 저는 안내 표지를 만들고 방문객 줄을 정리했습니다. 처음에는 순서를 놓쳐 혼란이 생겼지만 팀원과 상의해 안내 방식을 바꿨습니다. 그 뒤 방문객이 조용히 이동했습니다.';
const sha=v=>createHash('sha256').update(v).digest('hex');
const req=(o={})=>({action:'revise',requestId:'12345678-1234-4234-8234-123456789abc',product:'free',consent:true,offerVersion:'v4-revision-3000',clientVersion:'simple-v3',consentProvider:'mock-provider',consentModel:'mock-model',originalText:essay,clarificationRound:0,clarifications:[],...o});
const analysis=(o={})=>({overview:'안내 역할과 상황 변화가 보이지만 결과 서술이 짧습니다.',strengths:[{quote:'안내 표지를 만들고',comment:'본인이 한 행동이 구체적으로 드러납니다.'}],improvements:[{priority:'high',quote:'그 뒤 방문객이 조용히 이동했습니다.',problem:'변화의 원인과 결과의 연결이 간단하게만 제시됩니다.',suggestion:'원문에 있는 범위에서 바꾼 방식과 이동 모습을 한 문단으로 묶으세요.'},{priority:'low',quote:'혼란이 생겼지만',problem:'혼란의 상황이 추상적으로 남아 있습니다.',suggestion:'확인 가능한 사실만 짧게 덧붙이세요.'}],questions:[{quote:'안내 방식을 바꿨습니다',question:'어떤 방식으로 바꾸었는지 기억나는 대로 확인해 보셨나요?'}],...o});
const text='가상 동아리 전시에서 저는 안내 표지를 만들고 방문객 줄을 정리했습니다. 초반에 순서를 놓쳐 혼란이 생기자 팀원과 상의해 안내 방식을 바꿨고, 이후 방문객이 조용히 이동했습니다.';
const draft=(o={})=>({status:'ready',text,changes:[{category:'logic',before:'처음에는 순서를 놓쳐 혼란이 생겼지만 팀원과 상의해 안내 방식을 바꿨습니다.',after:'초반에 순서를 놓쳐 혼란이 생기자 팀원과 상의해 안내 방식을 바꿨고',reason:'원인과 대응 순서를 정리했습니다.'}],diagnosis:[{category:'logic',problem:'결과 문장이 분리되어 있습니다.',suggestion:'연결합니다.'}],warnings:[],deepAnalysis:analysis(),...o});
const review=(p,o={})=>{const quote='안내 표지를 만들고',evidence=[{sourceId:'original',quote}];const a=p.candidate.deepAnalysis||{strengths:[],improvements:[],questions:[]};return {candidateDigest:sha(JSON.stringify([p.candidate.text,a])),checks:['fit','evidence','agency','causality','numbers','naturalness','length'].map(key=>({key,status:'pass',reason:'원문과 대조했습니다.',quote:'안내 표지를 만들고',evidence})),claims:[{quote,status:'supported',evidence,reason:'원문에 있습니다.'}],analysis:{status:'supported',reviewed:1+a.strengths.length+a.improvements.length+a.questions.length,issues:[]},...o};};
const scripted=seq=>{const calls=[];return {calls,ai:async(system,payload,tokens,options)=>{calls.push({system,payload,tokens});options.onCallStarted?.();options.onUsage?.(1);const c=seq[calls.length-1];if(c===undefined)throw Error('unexpected call');return typeof c==='function'?c(payload):c;}};};

test('v3 needs only consent and original essay; optional inputs are ignored and not sent',async()=>{
 const d=validateRevision(req({prompt:'가상 문항 열 글자 이상',role:'가상 역할',organization:'가상 조직',posting:'가상 공고',limit:300,lengthMode:'utf8-bytes',clarificationRound:1,clarifications:[{question:'q',answer:'a'}]}));
 assert.equal(d.clientVersion,'simple-v3');assert.equal(d.prompt,'');assert.equal(d.role,'');assert.equal(d.organization,'');assert.equal(d.posting,'');assert.equal(d.limit,null);assert.equal(d.lengthMode,'characters');assert.deepEqual(d.clarifications,[]);assert.equal(d.factsConfirmed,undefined);
 const m=scripted([draft(),review]);const r=await runRevision(config,req(),{ai:m.ai});
 assert.equal(m.calls.length,2);const p=m.calls[0].payload;for(const k of ['prompt','organization','role','posting'])assert.equal(p[k],undefined);assert.equal(p.promptProvided,false);assert.equal(p.limitProvided,false);assert.equal(r.revision.previewVersion,'simple-v1');assert.ok(r.revision.deepAnalysis.improvements.length>=1);
 assert.ok(!r.revision.warnings.some(w=>/문항 적합성|분량 제한/.test(w)));assert.throws(()=>validateRevision(req({consentProvider:undefined})),{code:'INVALID_INPUT'});assert.throws(()=>validateRevision(req({originalText:'짧음'})),{code:'INVALID_INPUT'});
});

test('analysis quotes must be exact continuous original excerpts and schema bounds hold',()=>{
 const d=validateRevision(req());assert.deepEqual(validateDeepAnalysis(analysis(),d).strengths[0].quote,'안내 표지를 만들고');
 const bad=[analysis({strengths:[{quote:'안내 표지를 만들어 줄을 정리',comment:'x'}]}),analysis({improvements:Array(5).fill(analysis().improvements[0])}),analysis({strengths:Array(4).fill(analysis().strengths[0])}),analysis({questions:Array(4).fill(analysis().questions[0])}),analysis({overview:'가'.repeat(301)}),analysis({improvements:[{...analysis().improvements[0],priority:'urgent'}]}),analysis({improvements:[{...analysis().improvements[0],problem:'가'.repeat(241)}]}),analysis({improvements:[{...analysis().improvements[0],quote:'가'.repeat(181)}]}),analysis({extra:1}),analysis({questions:[{quote:'안내 방식을 바꿨습니다',question:'가'.repeat(201)}]}),analysis({strengths:[{quote:'안내 표지를 만들고',comment:'x',extra:1}]})];
 for(const b of bad)assert.throws(()=>validateDeepAnalysis(b,d),{code:/AI_FORMAT|ANALYSIS_QUOTE/});
});

test('invalid or non-source quote in draft fails before any review call',async()=>{
 const m=scripted([draft({deepAnalysis:analysis({strengths:[{quote:'원문에 없는 문장입니다',comment:'x'}]})})]);
 await assert.rejects(()=>runRevision(config,req(),{ai:m.ai}),{code:'ANALYSIS_QUOTE'});assert.equal(m.calls.length,1);
});

test('reviewer receives analysis; unsupported analysis triggers one repair and matching second review (<=4 calls)',async()=>{
 const fixed=analysis({overview:'수정된 개요입니다.'});
 const m=scripted([draft(),p=>review(p,{analysis:{status:'unsupported',reviewed:1+1+2+1,issues:[{ref:'overview',reason:'원문에 없는 주장'}]}}),draft({deepAnalysis:fixed}),review]);
 const r=await runRevision(config,req(),{ai:m.ai});
 assert.equal(m.calls.length,4);assert.deepEqual(m.calls[1].payload.candidate.deepAnalysis,analysis());assert.deepEqual(m.calls[2].payload.repair.deepAnalysis,analysis());assert.deepEqual(m.calls[3].payload.candidate.deepAnalysis,fixed);assert.equal(r.revision.deepAnalysis.overview,'수정된 개요입니다.');assert.equal(r.review.candidateDigest,sha(JSON.stringify([r.sections[0].text,r.revision.deepAnalysis])));assert.equal(r.quality.repairAttempted,true);
 const m2=scripted([draft(),p=>review(p,{analysis:{status:'unsupported',reviewed:5,issues:[{ref:'overview',reason:'x'}]}}),draft(),p=>review(p,{analysis:{status:'unsupported',reviewed:5,issues:[{ref:'overview',reason:'x'}]}})]);
 await assert.rejects(()=>runRevision(config,req(),{ai:m2.ai}),{code:'REVISION_UNSAFE'});assert.equal(m2.calls.length,4);
});

test('review rejects stale digest, wrong coverage count, bad refs and inconsistent status',async()=>{
 const cases=[p=>review(p,{candidateDigest:sha(p.candidate.text)}),p=>review(p,{analysis:{status:'supported',reviewed:2,issues:[]}}),p=>review(p,{analysis:{status:'unsupported',reviewed:5,issues:[{ref:'improvements[9]',reason:'x'}]}}),p=>review(p,{analysis:{status:'supported',reviewed:5,issues:[{ref:'overview',reason:'x'}]}}),p=>{const r=review(p);delete r.analysis;return r;}];
 for(const c of cases)await assert.rejects(()=>runRevision(config,req(),{ai:scripted([draft(),c]).ai}),{code:/AI_FORMAT|REVIEW_TARGET|ANALYSIS_REVIEW/});
});

test('deterministic guards catch invented numbers and hiring/ATS claims in analysis',async()=>{
 for(const bad of [analysis({overview:'방문객이 300명 늘었다고 쓰세요.'}),analysis({overview:'ATS 통과 가능한 글입니다.'})]){
  const m=scripted([draft({deepAnalysis:bad}),review,draft({deepAnalysis:bad}),review]);
  await assert.rejects(()=>runRevision(config,req(),{ai:m.ai}),{code:'REVISION_UNSAFE'});assert.ok(m.calls.length<=4);
 }
});

test('limits: v3 budget is higher, reservation precedes calls, old versions unchanged, oversize rejected before spending',()=>{
 const v3=validateRevision(req()),v2=validateRevision(req({clientVersion:'simple-v2'}));
 const l3=revisionLimits(config,v3),l2=revisionLimits(config,v2);assert.equal(l3.maxCalls,4);assert.equal(l3.calls.length,4);
 assert.ok(l3.calls[1].inputCap>l2.calls[1].inputCap);assert.ok(l3.calls[0].maxOutputTokens>l2.calls[0].maxOutputTokens);assert.ok(reserveRevisionCost(config,v3)>reserveRevisionCost(config,v2));
 assert.ok(minimumRevisionBudget(config,'simple-v3')>minimumRevisionBudget(config));
 assert.equal(l2.calls[2].maxOutputBytes,42000);
 assert.throws(()=>revisionLimits({...config,maxInputBytes:20000},validateRevision(req({originalText:'가'.repeat(2500)}))),{code:'INPUT_TOO_LARGE'});
});

test('simple-v2 remains compatible (no analysis) and rejects unknown versions',async()=>{
 const d=req({clientVersion:'simple-v2',prompt:'',limit:null});const m=scripted([{status:'ready',text:essay,changes:[],diagnosis:[],warnings:[]},p=>{const r=review(p,{candidateDigest:sha(p.candidate.text)});delete r.analysis;return r;}]);
 const r=await runRevision(config,d,{ai:m.ai});assert.equal(r.revision.deepAnalysis,undefined);assert.equal(r.revision.previewVersion,'simple-v1');assert.equal(m.calls[0].payload.originalText,essay);assert.ok(m.calls[0].payload.organization!==undefined);
 assert.throws(()=>validateRevision(req({clientVersion:'simple-v9',factsConfirmed:true,previewDisclosureAccepted:true})),{code:'INVALID_INPUT'});
});

const now=()=>Date.parse('2026-11-06T10:00:00Z');
const service=()=>new PaymentService({secret:'test-only-session-secret-over-thirty-two-chars',origin:'https://example.test',redisURL:'https://redis.test',redisToken:'mock-token',env:{PAYMENT_MODE:'disabled'}},new MockRedis(now),{now});
const stored=(deep)=>({source:'ai',product:'revision',sections:[{id:'p1',heading:'다듬은 자기소개서',text:text.repeat(2),charLimit:null}],quality:{checks:[]},revision:{previewVersion:'simple-v1',promptProvided:false,limitProvided:false,lengthMode:'characters',limit:null,originalLength:90,revisedLength:200,changes:[],diagnosis:[{category:'logic',problem:'x',suggestion:'y'}],warnings:[],confirmedFacts:[],...(deep?{deepAnalysis:deep,publicTeaser:(()=>{const x=['high','medium','low'].flatMap(pr=>deep.improvements.filter(y=>y.priority===pr))[0],c=Array.from(x.problem.trim());return {priority:x.priority,problem:c.length>100?c.slice(0,100).join('').trimEnd()+'…':c.join('')};})()}:{})},review:{marker:'검수전용'},sources:[]});

test('free projection exposes at most one bounded priority+problem; full has whole analysis; old results have none',async()=>{
 const s=service(),deep=analysis({improvements:[{priority:'low',quote:'혼란이 생겼지만',problem:'낮은 우선순위 문제 설명입니다.',suggestion:'비공개제안낮음'},{priority:'high',quote:'그 뒤 방문객이 조용히 이동했습니다.',problem:'결론 부분의 연결이 약해 읽는 사람이 변화의 이유를 놓칠 수 있습니다. '+'가'.repeat(150),suggestion:'비공개제안높음'}]});
 const out=await s.saveGeneratedResult('owner',randomUUID(),stored(deep)),json=JSON.stringify(out);
 assert.deepEqual(Object.keys(out.previewDetails.analysisPreview).sort(),['priority','problem']);assert.equal(out.previewDetails.analysisPreview.priority,'high');assert.ok(Array.from(out.previewDetails.analysisPreview.problem).length<=101);
 for(const secret of ['비공개제안','검수전용','deepAnalysis','strengths','questions'])assert.ok(!json.includes(secret),secret);for(const k of ['revision','review','sources'])assert.equal(out[k],undefined);
 const visible=out.sections[0].segments.filter(x=>x.kind==='visible').map(x=>x.text).join('');assert.ok(Array.from(visible).length<=Math.floor(Array.from(text.repeat(2)).length*.25));
 const rec=await s.resultRecord(out.resultId),full=s.projection(rec,true);assert.deepEqual(full.revision.deepAnalysis,deep);assert.equal(full.access,'full');
 const old=await s.saveGeneratedResult('old-owner',randomUUID(),stored());assert.equal(old.previewDetails.analysisPreview,undefined);assert.equal(s.projection(await s.resultRecord(old.resultId),true).revision.deepAnalysis,undefined);
});

test('free analysis teaser is dropped when the problem text overlaps revised text or source quotes',async()=>{
 const s=service(),leaky=analysis({improvements:[{priority:'high',quote:'혼란이 생겼지만',problem:'가상 동아리 전시에서 저는 안내 표지를 만들고 방문객 줄을 정리했습니다 라고 쓰여 있습니다.',suggestion:'z'}]});
 const out=await s.saveGeneratedResult('owner',randomUUID(),stored(leaky));assert.equal(out.previewDetails.analysisPreview,undefined);
});

test('good writing may have no fabricated improvement and whitespace-only quote differences map back to original',()=>{const d=validateRevision(req({originalText:'가상의 동아리\n   전시 행사에 참여해 팀원들과 안내 표지를 정리하고 방문객이 이동할 수 있도록 도왔습니다.'}));const x={overview:'수행한 일이 명확합니다.',strengths:[{quote:'동아리 전시 행사에 참여해',comment:'담당 업무가 드러납니다.'}],improvements:[],questions:[]};const out=validateDeepAnalysis(x,d);assert.equal(out.strengths[0].quote,'동아리\n   전시 행사에 참여해');assert.deepEqual(out.improvements,[]);});

test('review gets a computed expected coverage count and equivalent numeric strings normalize safely',async()=>{const m=scripted([draft(),p=>{assert.equal(p.analysisReviewedExpected,1+p.candidate.deepAnalysis.strengths.length+p.candidate.deepAnalysis.improvements.length+p.candidate.deepAnalysis.questions.length);const r=review(p);r.analysis.reviewed=String(r.analysis.reviewed);return r;}]);const out=await runRevision(config,req(),{ai:m.ai});assert.equal(typeof out.review.analysis.reviewed,'number');assert.equal(m.calls.length,2);});
