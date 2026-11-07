import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {validateRevision,runRevision,revisionLimits,reserveRevisionStages} from '../lib/revision.mjs';
import {minimumRevisionBudget} from '../lib/revision-api.mjs';
import {RevisionStore,RESERVE_REVISION_STEPWISE} from '../lib/revision-store.mjs';
import {PaymentService} from '../lib/payments.mjs';
import {MockRedis} from './mock-redis.mjs';
// Synthetic fixtures only. No personal data, live AI, or payment.
const original='가상 동아리 전시에서 저는 안내 표지를 만들고 방문객 줄을 정리했습니다. 처음에는 순서를 놓쳐 혼란이 생겼지만 팀원과 상의해 안내 방식을 바꿨습니다. 그 뒤 방문객이 조용히 이동했습니다.';
const revised='가상 동아리 전시에서 저는 안내 표지를 만들고 방문객 줄을 정리했습니다. 초반에 순서를 놓쳐 혼란이 생기자 팀원과 상의해 안내 방식을 바꿨고, 이후 방문객이 조용히 이동했습니다.';
const cfg={maxInputBytes:80000,inputRate:3,outputRate:15,provider:'mock',model:'mock'};
const req=(o={})=>({action:'revise',requestId:randomUUID(),clientVersion:'simple-v5',product:'free',consent:true,consentProvider:'mock',consentModel:'mock',offerVersion:'v4-revision-3000',originalText:original,...o});
const report=()=>({overview:'안내 경험의 흐름을 살펴볼 수 있습니다.',strengths:[{quote:'안내 표지를 만들고',comment:'본인의 행동이 구체적으로 드러납니다.'}],improvements:[{priority:'high',quote:'안내 방식을 바꿨습니다',problem:'변화의 과정이 짧게 설명됩니다.',suggestion:'행동의 순서를 더 분명하게 밝혀 보세요.'}],questions:[]});
const sha=x=>createHash('sha256').update(x).digest('hex');
const draft=()=>({status:'ready',text:revised,changes:[],diagnosis:[],warnings:[],deepAnalysis:report()});
function review(p){const q='안내 표지를 만들고',evidence=[{sourceId:'original',quote:q}],a=p.candidate.deepAnalysis;return {candidateDigest:sha(JSON.stringify([p.candidate.text,a])),checks:['fit','evidence','agency','causality','numbers','naturalness','length'].map(key=>({key,status:'pass',reason:'원문과 대조했습니다.',quote:q,evidence})),claims:[{quote:q,status:'supported',reason:'원문에 있습니다.',evidence}],analysis:{status:'supported',reviewed:1+a.strengths.length+a.improvements.length+a.questions.length,issues:[]}};}
function fakeAI(sequence){let i=0;const calls=[];return {calls,ai:async(system,payload,tokens,options)=>{calls.push({system,payload,tokens});options.onCallStarted?.();options.onUsage?.(1);const value=sequence[i++];if(value===undefined)throw Error('unexpected call');return typeof value==='function'?value(payload):value;}};}
const now=()=>Date.parse('2026-11-07T10:00:00Z');
const service=()=>new PaymentService({secret:'test-session-secret-at-least-thirty-two-chars',origin:'https://example.test',redisURL:'https://redis.test',redisToken:'mock',env:{PAYMENT_MODE:'disabled'}},new MockRedis(now),{now});

test('v5 uses one essay, grounded report, independent review and no score',async()=>{
 const d=validateRevision(req({prompt:'가상의 별도 문항',role:'가상 역할',limit:300}));assert.equal(d.prompt,'');assert.equal(d.role,'');assert.equal(d.limit,null);
 const m=fakeAI([draft(),review]),r=await runRevision(cfg,req(),{ai:m.ai});assert.equal(m.calls.length,2);assert.equal(r.revision.previewVersion,'continuous-v3');assert.ok(r.revision.deepAnalysis.improvements.length);assert.ok(r.revision.inlineEditRanges.length);assert.equal(r.revision.scoreCard,undefined);assert.equal(r.review.scoreCard,undefined);assert.ok(!m.calls[1].system.includes('scoreCard:'));assert.ok(m.calls[1].system.includes('점수, 등급, 합격 가능성을 만들지 않는다'));
});
test('v5 rejects unsupported report quotations and checks bounds before review',async()=>{
 const d=draft();d.deepAnalysis.strengths[0].quote='원문에 없는 문구입니다';const m=fakeAI([d,d]);await assert.rejects(()=>runRevision(cfg,req(),{ai:m.ai}),{code:'ANALYSIS_QUOTE'});assert.equal(m.calls.length,2);
});
test('v5 preserves staged budget and strong consent checks',()=>{
 const d=validateRevision(req());assert.equal(new RevisionStore(cfg).reservationScript(d),RESERVE_REVISION_STEPWISE);assert.equal(revisionLimits(cfg,d).calls.length,4);assert.ok(reserveRevisionStages(cfg,d,0,1)>0);assert.ok(minimumRevisionBudget(cfg,'simple-v5')>0);assert.throws(()=>validateRevision(req({consent:false})),{code:'CONSENT_REQUIRED'});
});
test('v5 report is projected without hidden revision text, arbitrary fields or scores',async()=>{
 const marker='비공개수정문고유표식절대출력금지',body='공개되는가상의수정문 '.repeat(30)+marker,a=report();a.overview='안전한 전체 진단입니다.';a.strengths.push({quote:'가상의 안전한 근거',comment:marker});a.improvements.push({priority:'high',quote:marker,problem:'구성은 더 명료하게 정리할 수 있습니다.',suggestion:marker});a.questions.push({quote:marker,question:'직접 확인하면 좋겠습니다.'});a.extra=marker;
 const data={source:'ai',product:'revision',sections:[{id:'p1',heading:'ignored',text:body}],quality:{checks:[]},revision:{previewVersion:'continuous-v3',lengthMode:'characters',limit:null,originalLength:100,revisedLength:Array.from(body).length,inlineEditRanges:[[0,2]],deepAnalysis:a,scoreCard:{secret:marker},changes:[],diagnosis:[],warnings:[]},review:{private:marker},sources:[{quote:marker}]};
 const p=service(),out=await p.saveGeneratedResult('synthetic-owner',randomUUID(),data),visible=Math.floor(Array.from(body).length*.7);assert.equal(out.access,'preview');assert.equal(out.previewLayout,'continuous-v2');assert.equal(out.sections[0].segments[0].text,Array.from(body).slice(0,visible).join(''));assert.ok(out.analysisReport);assert.equal(out.analysisReport.overview,'안전한 전체 진단입니다.');assert.equal(out.scoreCard,undefined);assert.ok(!JSON.stringify(out).includes(marker));assert.ok(!JSON.stringify(out.analysisReport).includes(marker.slice(0,8)));assert.ok(out.sections[0].segments.filter(x=>x.kind==='locked').every(x=>!('text' in x)));assert.equal(out.purchase.ready,false);assert.deepEqual(await p.getPublicResult('synthetic-owner',out.resultId),out);await assert.rejects(()=>p.getPublicResult('different-owner',out.resultId),{code:'RESULT_NOT_FOUND'});
});
test('short hidden suffix also cannot reappear in an analysis field',async()=>{
 const p=service(),data={source:'ai',product:'revision',sections:[{id:'p1',heading:'x',text:'abcdefXYZ'}],quality:{checks:[]},revision:{previewVersion:'continuous-v3',lengthMode:'characters',limit:null,originalLength:9,revisedLength:9,inlineEditRanges:[],changes:[],diagnosis:[],deepAnalysis:{overview:'XYZ',strengths:[],improvements:[],questions:[]}}};const out=await p.saveGeneratedResult('synthetic-short',randomUUID(),data);assert.ok(!JSON.stringify(out).includes('XYZ'));
});

test('hidden short sentence stays private when report changes punctuation',async()=>{
 const p=service(),hidden='숨겨진상세내용이충분히있습니다.성과를 냈습니다.',data={source:'ai',product:'revision',sections:[{id:'p1',heading:'x',text:'공'.repeat(90)+hidden}],quality:{checks:[]},revision:{previewVersion:'continuous-v3',lengthMode:'characters',limit:null,originalLength:110,revisedLength:110,inlineEditRanges:[],changes:[],diagnosis:[],deepAnalysis:{overview:'성과를 냈습니다!',strengths:[],improvements:[],questions:[]}}};
 const out=await p.saveGeneratedResult('synthetic-punctuation',randomUUID(),data);assert.equal(out.analysisReport.overview,'');assert.ok(!JSON.stringify(out).replace(/[\s\p{P}\p{S}]/gu,'').includes('성과를냈습니다'));
});


test('v5 review restores only whitespace differences to actual source and revision spans',async()=>{
 const o=original.replace('안내 표지를','안내  \n표지를'),d=draft();d.text=revised.replace('안내 표지를','안내  \n표지를');
 const m=fakeAI([d,review]),r=await runRevision(cfg,req({originalText:o}),{ai:m.ai});
 const claim=r.review.claims[0];assert.equal(claim.quote,'안내  \n표지를 만들고');assert.equal(claim.evidence[0].quote,'안내  \n표지를 만들고');
});
test('v5 retries a malformed reviewer quote once without exposing or accepting the bad quote',async()=>{
 const bad=p=>{const r=review(p);r.claims[0].evidence[0]={sourceId:'original',quote:'원문에 존재하지 않는 문장'};return r;};
 const m=fakeAI([draft(),bad,review]),r=await runRevision(cfg,req(),{ai:m.ai});assert.equal(m.calls.length,3);assert.equal(r.source,'ai');assert.ok(!JSON.stringify(r).includes('원문에 존재하지 않는 문장'));
});
test('v5 still rejects repeated fabricated reviewer evidence',async()=>{
 const bad=p=>{const r=review(p);r.claims[0].evidence[0]={sourceId:'original',quote:'없는 문장'};return r;};const m=fakeAI([draft(),bad,bad]);await assert.rejects(()=>runRevision(cfg,req(),{ai:m.ai}),{code:'FACT_QUOTE'});assert.equal(m.calls.length,3);
});
test('v5 removes only unverified analysis cards when revised text passed independent review',async()=>{
 const flagged=p=>{const r=review(p);r.analysis={status:'unsupported',reviewed:r.analysis.reviewed,issues:[{ref:'improvements[0]',reason:'개선 설명의 근거가 부족합니다.'}]};return r;};
 const m=fakeAI([draft(),flagged,draft(),flagged]),r=await runRevision(cfg,req(),{ai:m.ai});assert.equal(m.calls.length,4);assert.equal(r.sections[0].text,revised);assert.equal(r.revision.analysisSanitized,true);assert.equal(r.revision.deepAnalysis.improvements.length,0);assert.equal(r.revision.deepAnalysis.strengths.length,1);assert.ok(r.review.reviewedCandidateDigest);assert.notEqual(r.review.reviewedCandidateDigest,r.review.candidateDigest);
});
test('v5 never publishes a revision with unsupported facts even when analysis is also flagged',async()=>{
 const flagged=p=>{const r=review(p);r.analysis={status:'unsupported',reviewed:r.analysis.reviewed,issues:[{ref:'improvements[0]',reason:'근거 부족'}]};r.claims[0].status='unsupported';return r;};const m=fakeAI([draft(),flagged,draft(),flagged]);await assert.rejects(()=>runRevision(cfg,req(),{ai:m.ai}),{code:'REVISION_UNSAFE'});
});

test('v5 retries one malformed draft and independently reviews the replacement',async()=>{const bad=draft();bad.deepAnalysis.strengths[0].quote='없는 인용';const m=fakeAI([bad,draft(),review]);const r=await runRevision(cfg,req(),{ai:m.ai});assert.equal(m.calls.length,3);assert.equal(r.source,'ai');assert.equal(r.revision.deepAnalysis.strengths[0].quote,'안내 표지를 만들고');});
test('v5 rejects a repeatedly fabricated draft quote before any review',async()=>{const bad=draft();bad.deepAnalysis.strengths[0].quote='없는 인용';const m=fakeAI([bad,bad]);await assert.rejects(()=>runRevision(cfg,req(),{ai:m.ai}),{code:'ANALYSIS_QUOTE'});assert.equal(m.calls.length,2);});

test('long chunk severe compression triggers repair and independently reviewed full-length replacement',async()=>{const long=original.repeat(10),full={...draft(),text:long},m=fakeAI([draft(),review,full,review]);const r=await runRevision(cfg,req({originalText:long}),{ai:m.ai,longChunk:true});assert.equal(m.calls.length,4);assert.equal(r.sections[0].text,long);assert.equal(r.quality.repairAttempted,true);});
test('long chunk cannot publish a persistently overcompressed revision',async()=>{const long=original.repeat(10),m=fakeAI([draft(),review,draft(),review]);await assert.rejects(()=>runRevision(cfg,req({originalText:long}),{ai:m.ai,longChunk:true}),e=>e.code==='REVISION_UNSAFE'&&e.details.issueKeys.includes('coverage'));assert.equal(m.calls.length,4);});
