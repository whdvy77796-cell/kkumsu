import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {validateRevision,runRevision,revisionLimits,reserveRevisionCost,reserveRevisionStages,validateEditNotes} from '../lib/revision.mjs';
// Synthetic fixtures only. No live AI, personal data or payment.
const original='가상 동아리 전시에서 저는 안내 표지를 만들고 방문객 줄을 정리했습니다. 처음에는 순서를 놓쳐 혼란이 생겼지만 팀원과 상의해 안내 방식을 바꿨습니다. 그 뒤 방문객이 조용히 이동했습니다.';
const revised='방문객이 조용히 이동하도록 저는 가상 동아리 전시에서 안내 표지를 만들고 방문객 줄을 정리했습니다. 처음에는 순서를 놓쳐 혼란이 생겼지만 팀원과 상의해 안내 방식을 바꿨고, 그 뒤 방문객이 조용히 이동했습니다.';
const cfg={maxInputBytes:120000,inputRate:3,outputRate:15,provider:'mock',model:'mock'};
const req=(o={})=>({action:'revise',requestId:randomUUID(),clientVersion:'simple-v5',product:'free',consent:true,consentProvider:'mock',consentModel:'mock',offerVersion:'v4-revision-3000',originalText:original,...o});
const sha=x=>createHash('sha256').update(x).digest('hex');
const report=()=>({overview:'안내 경험의 흐름을 살펴볼 수 있습니다.',strengths:[{quote:'안내 표지를 만들고',comment:'본인의 행동이 구체적으로 드러납니다.'}],improvements:[{priority:'high',quote:'안내 방식을 바꿨습니다',problem:'변화의 과정이 짧게 설명됩니다.',suggestion:'실제로 있었다면 행동의 순서를 더 분명하게 밝혀 보세요.'}],questions:[]});
const note=(o={})=>({category:'logic',before:'그 뒤 방문객이 조용히 이동했습니다.',after:'그 뒤 방문객이 조용히 이동했습니다.',reason:'결과를 앞 문장과 이어 읽히게 했습니다.',...o});
const goodNote=()=>note({before:'팀원과 상의해 안내 방식을 바꿨습니다.',after:'팀원과 상의해 안내 방식을 바꿨고,'});
const draft=(changes=[goodNote()],text=revised)=>({status:'ready',text,changes,diagnosis:[],warnings:[],deepAnalysis:report()});
const q='안내 표지를 만들고',ev=[{sourceId:'original',quote:q}];
const KEYS=['fit','evidence','agency','causality','numbers','naturalness','length'];
function review(issues=[]){return p=>{const a=p.candidate.deepAnalysis,n=p.candidate.changes||[],total=1+a.strengths.length+a.improvements.length+a.questions.length+n.length;
 return {candidateDigest:sha(JSON.stringify(n.length?[p.candidate.text,a,n]:[p.candidate.text,a])),checks:KEYS.map(key=>({key,status:'pass',reason:'원문과 대조했습니다.',quote:q,evidence:ev})),claims:[{quote:q,status:'supported',reason:'원문에 있습니다.',evidence:ev}],analysis:{status:issues.length?'unsupported':'supported',reviewed:total,issues}};};}
function fake(seq){let i=0;const calls=[];return {calls,ai:async(system,payload,tokens,o)=>{calls.push({system,payload,tokens});o.onCallStarted?.();o.onUsage?.(1);const v=seq[i++];if(v===undefined)throw Error('unexpected call');return typeof v==='function'?v(payload):v;}};}

test('v5 prompt asks for substantive restructuring, fuller report and grounded notes without scores',async()=>{
 const m=fake([draft(),review()]);await runRevision(cfg,req(),{ai:m.ai});const s=m.calls[0].system;
 for(const w of ['구조와 강조','최대 3','최대 4','실제로 있었다면','changes','한 번만 나타나는','65%'])assert.ok(s.includes(w),w);
 assert.ok(!s.includes('changes, diagnosis, warnings는 모두 빈 배열'));assert.ok(!s.includes('strengths 최대 2개'));assert.ok(s.includes('점수, 등급, 합격 가능성은 만들지 않는다'));
 assert.ok(m.calls[1].system.includes('changes[0]'));
});
test('v5 emits validated notes as revision.changes, reviews them and extends the digest',async()=>{
 const m=fake([draft(),review()]),r=await runRevision(cfg,req(),{ai:m.ai});
 assert.deepEqual(r.revision.changes,[goodNote()]);assert.equal(m.calls.length,2);
 assert.deepEqual(m.calls[1].payload.candidate.changes,[goodNote()]);assert.equal(m.calls[1].payload.analysisReviewedExpected,4);
 assert.equal(r.revision.scoreCard,undefined);
});
test('v5 without valid notes keeps the legacy digest and empty changes',async()=>{
 const m=fake([draft([]),review()]),r=await runRevision(cfg,req(),{ai:m.ai});assert.deepEqual(r.revision.changes,[]);assert.equal(m.calls[1].payload.candidate.changes,undefined);assert.equal(m.calls[1].payload.analysisReviewedExpected,3);
 const same=fake([draft([goodNote()],original),review()]);const r2=await runRevision(cfg,req(),{ai:same.ai});assert.deepEqual(r2.revision.changes,[]);
});
test('invalid, duplicate, ambiguous and unsupported notes are omitted safely and bounded to eight',()=>{
 const d=validateRevision(req());
 const out=validateEditNotes([
  note({before:'원문에 없는 문장입니다.',after:'안내 표지'}),
  note({before:'안내 표지를 만들고',after:'존재하지 않는 수정문'}),
  note({before:'방문객',after:'방문객'}),
  note({category:'fit'}),note({extra:1}),
  note({before:'  ',after:'x'}),note({reason:''}),note({reason:'x'.repeat(161)}),
  note({before:'안내 표지를 만들고',after:'안내 표지를 만들고',reason:'참여율이 37%로 올랐습니다.'}),
  note({before:'안내 표지를 만들고',after:'안내 표지를 만들고',reason:'합격 가능성이 높아집니다.'}),
  null,'x',goodNote(),goodNote(),
 ],d,revised);
 assert.deepEqual(out,[goodNote()]);
 assert.deepEqual(validateEditNotes('x',d,revised),[]);
 const names='가나다라마바사아자차카타',sents=Array.from({length:12},(_,i)=>'문장'+names[i]+'입니다.'),src=sents.join(' ')+' '+'가'.repeat(40);
 const d2=validateRevision(req({originalText:src})),fin=sents.map(x=>x+'!').join(' ')+' '+'가'.repeat(40);
 const ns=sents.map(x=>note({before:x,after:x+'!'}));
 assert.equal(validateEditNotes(ns,d2,fin).length,8);
});
test('unsupported note reason fails review and is sanitized, not shown, after repair is exhausted',async()=>{
 const bad=review([{ref:'changes[0]',reason:'원문에 없는 동기를 말합니다.'}]);
 const m=fake([draft(),bad,draft(),bad]),r=await runRevision(cfg,req(),{ai:m.ai});
 assert.equal(m.calls.length,4);assert.deepEqual(r.revision.changes,[]);assert.equal(r.revision.analysisSanitized,true);assert.equal(r.review.analysis.sanitized,true);
 assert.equal(m.calls[2].payload.repair.changes.length,1);
});
test('review must cover notes: wrong reviewed count or unknown ref is rejected',async()=>{
 const stale=p=>({...review()(p),analysis:{status:'supported',reviewed:2,issues:[]}});
 await assert.rejects(()=>runRevision(cfg,req(),{ai:fake([draft(),stale,stale]).ai}),{code:'ANALYSIS_REVIEW'});
 const ref=review([{ref:'changes[3]',reason:'없는 노트'}]);
 await assert.rejects(()=>runRevision(cfg,req(),{ai:fake([draft(),ref,ref]).ai}),{code:'ANALYSIS_REVIEW'});
});
test('v5 cost, input and output bounds stay inside configured caps with the fuller report',()=>{
 const d=validateRevision(req({originalText:'가'.repeat(4500)})),l=revisionLimits(cfg,d);
 assert.equal(l.calls.length,4);assert.equal(l.maxCalls,4);
 for(const c of l.calls){assert.ok(c.inputCap<=cfg.maxInputBytes);assert.ok(c.maxOutputTokens>0);}
 // Draft-capable calls (including retry slots) carry report + notes; the final review keeps the V3-sized review cap.
 for(const i of [0,1,2])assert.ok(l.calls[i].maxOutputBytes>=71000,'call '+i);
 assert.ok(l.calls[3].maxOutputBytes>=38000);
 // Prompt-sized worst-case review response (7 checks, 16 claims, 20 note/report issues) fits the final-review byte cap.
 const s=n=>'가'.repeat(n),e=[{sourceId:'original',quote:s(60)},{sourceId:'original',quote:s(60)}];
 const rv={candidateDigest:'a'.repeat(64),checks:Array(7).fill({key:'fit',status:'pass',reason:s(60),quote:s(50),evidence:e}),claims:Array(16).fill({quote:s(50),status:'supported',evidence:e,reason:s(60)}),analysis:{status:'unsupported',reviewed:19,issues:Array(20).fill({ref:'changes[7]',reason:s(160)})}};
 assert.ok(Buffer.byteLength(JSON.stringify(rv))<=l.calls[3].maxOutputBytes);
 const total=reserveRevisionCost(cfg,d);assert.ok(total>=reserveRevisionStages(cfg,d,0,2));assert.ok(reserveRevisionStages(cfg,d,0,4)>0);
 const a={overview:'가'.repeat(300),strengths:Array(3).fill({quote:'가'.repeat(180),comment:'가'.repeat(240)}),improvements:Array(4).fill({priority:'high',quote:'가'.repeat(180),problem:'가'.repeat(240),suggestion:'가'.repeat(240)}),questions:Array(3).fill({quote:'가'.repeat(180),question:'가'.repeat(200)})};
 const notes=Array(8).fill({category:'logic',before:'가'.repeat(220),after:'가'.repeat(220),reason:'가'.repeat(160)});
 assert.ok(Buffer.byteLength(JSON.stringify({text:'가'.repeat(4500),a,notes}))<=l.calls[0].maxOutputBytes);
 assert.throws(()=>revisionLimits({...cfg,maxInputBytes:20000},validateRevision(req({originalText:'가'.repeat(6000)}))),{code:'INPUT_TOO_LARGE'});
});
test('legacy v3 and v4 protocols are unchanged by v5 notes',async()=>{
 const d3=validateRevision(req({clientVersion:'simple-v3'})),d4=validateRevision(req({clientVersion:'simple-v4'}));
 assert.equal(revisionLimits(cfg,d3).calls[0].maxOutputBytes,42000+17000);assert.equal(revisionLimits(cfg,d4).calls[0].maxOutputBytes,42000);
 const m3=fake([draft([]),p=>({...review()(p),candidateDigest:sha(JSON.stringify([p.candidate.text,p.candidate.deepAnalysis]))})]);
 const r3=await runRevision(cfg,req({clientVersion:'simple-v3'}),{ai:m3.ai});assert.equal(r3.revision.previewVersion,'simple-v1');assert.equal(m3.calls[1].payload.candidate.changes,undefined);assert.ok(!m3.calls[0].system.includes('65%'));
 const m4=fake([{status:'ready',text:revised,changes:[goodNote()],diagnosis:[],warnings:[]},p=>({candidateDigest:sha(p.candidate.text),checks:KEYS.map(key=>({key,status:'pass',reason:'확인',quote:q,evidence:ev})),claims:[{quote:q,status:'supported',reason:'확인',evidence:ev}]})]);
 const r4=await runRevision(cfg,req({clientVersion:'simple-v4'}),{ai:m4.ai});assert.deepEqual(r4.revision.changes,[]);
});

// Synthetic regression: a rewrite must not silently drop the author's explicit
// statement that an outcome or effect was not measured or verified.
const qualifier='다만 방문객의 만족도나 질문 건수의 변화를 조사하지는 않았으므로 그 효과를 수치로 말할 수는 없습니다.';
test('an omitted unmeasured-outcome qualification triggers repair and is preserved',async()=>{
 const source=original+' '+qualifier,good=revised+' '+qualifier;
 const m=fake([draft([],revised),review(),draft([],good),review()]);
 const r=await runRevision(cfg,req({originalText:source}),{ai:m.ai});
 assert.equal(m.calls.length,4);assert(m.calls[2].payload.repair.issues.some(x=>x.key==='coverage'));assert(r.sections[0].text.includes(qualifier));
});
test('repeated omission of explicit outcome qualification fails closed even when lengths are similar',async()=>{
 const source=original+' '+qualifier,m=fake([draft([],revised),review(),draft([],revised),review()]);
 await assert.rejects(()=>runRevision(cfg,req({originalText:source}),{ai:m.ai}),e=>e.code==='REVISION_UNSAFE'&&e.details.issueKeys.includes('coverage'));
});
test('source qualification survives harmless whitespace changes without a retry',async()=>{
 const source=original+' '+qualifier,good=revised+' '+qualifier.replaceAll(' ','  ');
 const m=fake([draft([],good),review()]);await runRevision(cfg,req({originalText:source}),{ai:m.ai});assert.equal(m.calls.length,2);
});
test('another explicit unmeasured effect qualification is protected',async()=>{
 const src='모든 활동에서 결과를 수치로 측정한 것은 아닙니다.',source=original+' '+src;
 const m=fake([draft([],revised),review(),draft([],revised),review()]);
 await assert.rejects(()=>runRevision(cfg,req({originalText:source}),{ai:m.ai}),{code:'REVISION_UNSAFE'});
});
