import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LONG_MAX_CHARS,CHUNK_TARGET_CHARS,splitLongRevision,planLongRevision,runLongRevision} from '../lib/long-revision.mjs';
import {revisionLimits,reserveRevisionCost} from '../lib/revision.mjs';
import {clippedRanges} from '../lib/inline-diff.mjs';

const config={maxInputBytes:100000,inputRate:3,outputRate:15};
const cp=s=>Array.from(s).length;
const input=originalText=>({action:'revise',requestId:'12345678-1234-4234-8234-123456789abc',product:'free',consent:true,offerVersion:'v4-revision-3000',clientVersion:'simple-v5',consentProvider:'openrouter',consentModel:'test-model',originalText});
const keys=['fit','logic','evidence','wording','spelling','length'];
function result(d,text=d.originalText){return {source:'ai',product:'revision',sections:[{id:'p1',text}],quality:{checks:keys.map(key=>({key,status:'pass'})),repairAttempted:false},revision:{previewVersion:'continuous-v3',inlineEditRanges:[],deepAnalysis:{overview:'구간을 검토했습니다.',strengths:[{quote:Array.from(d.originalText.trim()).slice(0,20).join(''),comment:'이 구간에 근거가 있습니다.'}],improvements:[],questions:[]},warnings:[]}};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

for(const [name,text] of [
 ['max unbroken astral','😀'.repeat(100000)],
 ['unbroken words','a'.repeat(99999)+'끝'],
 ['mixed Unicode',('한😀e\u0301\r\n다\t ').repeat(9000)],
 ['whitespace',' \t\r\n\u00a0'.repeat(15000)],
 ['tiny tail','가'.repeat(6001)],
 ['target tiny tail','가'.repeat(9001)],
 ['meaning after whitespace',' '.repeat(15000)+'의미'],
 ['meaning before whitespace','의미'+' '.repeat(15000)]
])test('split exact codepoint coverage: '+name,()=>{
 const chunks=splitLongRevision(text);assert.equal(chunks.join(''),text);
 for(const chunk of chunks){assert(chunk.length);assert(cp(chunk)<=6000);assert(chunk.isWellFormed());if(chunk.trim())assert(cp(chunk)>=40);}
 assert.equal(chunks.reduce((n,s)=>n+cp(s),0),cp(text));
});
test('limits and invalid strings fail without truncation',()=>{
 assert.equal(LONG_MAX_CHARS,100000);assert.equal(CHUNK_TARGET_CHARS,4500);
 assert.deepEqual(splitLongRevision(''),[]);assert.deepEqual(splitLongRevision(' \t'),[' \t']);
 for(const text of ['가'.repeat(39),'가'.repeat(40)+'\ud800','가'.repeat(40)+'\0'])assert.throws(()=>splitLongRevision(text),{code:'INVALID_INPUT'});
 assert.throws(()=>splitLongRevision('😀'.repeat(100001)),{code:'INPUT_TOO_LARGE'});
});
test('soft splitting prefers paragraph, line, sentence and whitespace over hard boundaries',()=>{
 for(const sep of ['\n\n','\r\n\r\n','\n','. ',' ']){
  const text='가'.repeat(4300)+sep+'나'.repeat(4300),parts=splitLongRevision(text);
  assert.equal(parts[0],'가'.repeat(4300)+sep);assert.equal(parts.join(''),text);
 }
 const text='가'.repeat(4100)+'\n\n'+'나'.repeat(398)+' '+'다'.repeat(4000);
 assert.equal(splitLongRevision(text)[0],'가'.repeat(4100)+'\n\n');
});
test('four-call conservative plan sums safely, normalizes v5, excludes whitespace costs',()=>{
 const d=input(' '.repeat(14000)+'가'.repeat(7000));d.clientVersion='simple-v4';
 const {parts,maxCost}=planLongRevision(config,d);assert(parts.some(p=>!p.process));
 assert.equal(parts.map(p=>p.text).join(''),d.originalText);
 let sum=0;for(const p of parts){
  if(!p.process){assert.equal(p.maxCost,0);assert.equal(p.data,null);continue;}
  assert.equal(p.data.clientVersion,'simple-v5');assert.equal(p.data.originalText,p.text);
  assert.deepEqual(p.limits,revisionLimits(config,p.data));assert.equal(p.limits.maxCalls,4);
  assert.equal(p.maxCost,reserveRevisionCost(config,p.data));sum+=p.maxCost;
 }
 assert.equal(maxCost,sum);assert(Number.isSafeInteger(maxCost));
 assert.throws(()=>planLongRevision({...config,inputRate:Number.MAX_VALUE},d),{code:'CONFIG'});
 assert.throws(()=>planLongRevision({...config,inputRate:4e9},input('가'.repeat(100000))),{code:'CONFIG'});
 assert.throws(()=>planLongRevision(config,{...d,consent:false}),{code:'CONSENT_REQUIRED'});
 assert.throws(()=>planLongRevision(config,input(' '.repeat(8000))),{code:'INVALID_INPUT'});
});
test('bounded concurrency, out-of-order completion, ordered cards and global ranges',async()=>{
 const d=input(' \t'+'😀'.repeat(14500)+'\r\n'),parts=planLongRevision(config,d).parts;
 const gates=parts.map(deferred),seen=[],started=[],usages=[],before=[];let active=0,maximum=0;
 const run=runLongRevision(config,d,{beforeCall:x=>before.push(x),onCallStarted:i=>started.push(i),onUsage:(i,cost)=>usages.push([i,cost]),runChunk:async(c,chunk,callbacks)=>{
  const i=seen.length;seen.push(chunk);active++;maximum=Math.max(maximum,active);
  await callbacks.beforeCall({stage:'draft',callIndex:0});callbacks.onCallStarted();await gates[i].promise;
  callbacks.onUsage(17+i);active--;
  const text='\n'+String.fromCharCode(65+i)+'😀'+chunk.originalText.trim()+' \t';
  const r=result(chunk,text);r.revision.inlineEditRanges=[[0,cp(text)]];r.revision.deepAnalysis.strengths[0].comment='카드 '+i;
  if(i===1){r.quality.checks.find(x=>x.key==='logic').status='attention';r.quality.repairAttempted=true;}
  return r;
 }});
 await tick();assert.equal(active,3);gates[2].resolve();await tick();assert.equal(seen.length,parts.length);
 gates[0].resolve();gates[1].resolve();for(let i=3;i<gates.length;i++)gates[i].resolve();
 const out=await run;assert.equal(maximum,3);assert.equal(active,0);
 const expected=parts.map((p,i)=>p.text.match(/^\s*/u)[0]+String.fromCharCode(65+i)+'😀'+p.text.trim()+p.text.match(/\s*$/u)[0]).join('');
 assert.equal(out.sections.length,1);assert.equal(out.sections[0].id,'p1');assert.equal(out.sections[0].text,expected);
 let offset=0;const ranges=parts.map((p,i)=>{const leading=cp(p.text.match(/^\s*/u)[0]),length=cp(p.text.trim())+2;const range=[offset+leading,offset+leading+length];offset+=cp(p.text)+2;return range;});
 assert.deepEqual(out.revision.inlineEditRanges,ranges);
 assert.deepEqual(clippedRanges(ranges,Math.floor(cp(expected)*.7),cp(expected)),ranges.filter(([a])=>a<Math.floor(cp(expected)*.7)).map(([a,b])=>[a,Math.min(b,Math.floor(cp(expected)*.7))]));
 assert.deepEqual(out.revision.deepAnalysis.strengths.map(x=>x.comment),parts.map((_,i)=>'카드 '+i));
 assert.match(out.revision.deepAnalysis.overview,/따로/);assert.equal(out.quality.checks.find(x=>x.key==='logic').status,'attention');assert.equal(out.quality.repairAttempted,true);
 assert.equal(out.revision.originalLength,cp(d.originalText));assert.equal(out.revision.revisedLength,cp(expected));assert.equal(out.revision.longChunked,true);
 assert.deepEqual(started,parts.map((_,i)=>i));assert.equal(usages.length,parts.length);assert.deepEqual(before.map(x=>x.chunkIndex),parts.map((_,i)=>i));
 for(const key of ['parts','chunkResults','originalText','sources','review'])assert.equal(out[key],undefined);
 assert.equal(out.revision.publicTeaser,undefined);assert.deepEqual(out.revision.changes,[]);assert.deepEqual(out.revision.diagnosis,[]);
});
test('whitespace chunks bypass AI and boundaries remain byte-for-byte unchanged',async()=>{
 const text='\t '.repeat(9000)+'가'.repeat(8000)+' \r\n',d=input(text);let calls=0;
 const expected=planLongRevision(config,d).parts.filter(p=>p.process).length;
 const out=await runLongRevision(config,d,{runChunk:async(c,p)=>{calls++;return result(p,' \n'+p.originalText.trim()+'\t');}});
 assert.equal(calls,expected);assert.equal(out.sections[0].text,text);
});
test('failure waits all active chunks and billing, stops new work, never leaks partial results',async()=>{
 const gates=[deferred(),deferred(),deferred()];let calls=0,settled=false;const usage=[];const failure=new Error('synthetic chunk failure');
 const pending=runLongRevision(config,input('가'.repeat(30000)),{onUsage:(i,cost)=>usage.push([i,cost]),runChunk:async(c,d,callbacks)=>{
  const i=calls++;await gates[i].promise;callbacks.onUsage(11);return result(d);
 }});
 const observed=pending.then(()=>{settled=true;assert.fail('partial result returned');},e=>{settled=true;return e;});
 await tick();assert.equal(calls,3);gates[0].reject(failure);await tick();assert.equal(settled,false);
 gates[1].resolve();await tick();assert.equal(settled,false);assert.equal(calls,3);
 gates[2].resolve();assert.equal(await observed,failure);assert.equal(usage.length,2);assert.deepEqual(Object.keys(failure),[]);
});
test('invalid chunk cards fail closed; missing checks cannot become passes',async()=>{
 await assert.rejects(runLongRevision(config,input('가'.repeat(100)),{runChunk:async(c,d)=>{const r=result(d);r.revision.deepAnalysis.strengths[0].quote='원문에 없는 발췌';return r;}}),{code:'ANALYSIS_QUOTE'});
 const out=await runLongRevision(config,input('가'.repeat(100)),{runChunk:async(c,d)=>{const r=result(d);r.quality.checks=[];return r;}});
 assert(out.quality.checks.every(x=>x.status==='attention'));
});
test('real runRevision validation path with synthetic AI only',async()=>{
 let calls=0;const source='저는 안내문을 작성하고 팀원들과 내용을 확인했습니다. '.repeat(250);
 const out=await runLongRevision(config,input(source),{ai:async(system,payload,tokens,options)=>{
  calls++;options.onCallStarted?.();options.onUsage?.(10);
  if(options.stage==='draft')return {status:'ready',text:payload.originalText,deepAnalysis:{overview:'이 구간의 역할을 확인했습니다.',strengths:[],improvements:[],questions:[]}};
  const quote=Array.from(payload.candidate.text.trim()).slice(0,20).join(''),evidence=[{sourceId:'original',quote}];
  assert.equal(payload.candidateDigest,createHash('sha256').update(JSON.stringify([payload.candidate.text,payload.candidate.deepAnalysis])).digest('hex'));
  return {candidateDigest:payload.candidateDigest,checks:['fit','evidence','agency','causality','numbers','naturalness','length'].map(key=>({key,status:'pass',reason:'구간 원문과 일치합니다.',quote,evidence})),claims:[{quote,status:'supported',reason:'원문 근거가 있습니다.',evidence}],analysis:{status:'supported',reviewed:1,issues:[]}};
 }});
 assert.equal(out.sections[0].text,source);assert.equal(calls,planLongRevision(config,input(source)).parts.length*2);
});

test('adaptive byte-cap planning preserves exact input and minimum chunks without calls',()=>{
 for(const maxInputBytes of [60000,80000])for(const text of ['가'.repeat(100000),'😀'.repeat(100000),'\r\n'+'😀'.repeat(5999)+' \t',' '.repeat(14000)+'가'.repeat(6001)]){
  const c={...config,maxInputBytes},d=input(text),plan=planLongRevision(c,d);
  assert.equal(plan.parts.map(p=>p.text).join(''),text);
  for(const p of plan.parts){assert(cp(p.text)<=6000);assert(p.text.isWellFormed());if(p.process){assert(cp(p.text)>=40);assert.deepEqual(p.limits,revisionLimits(c,p.data));}}
  assert.equal(plan.maxCost,plan.parts.reduce((n,p)=>n+p.maxCost,0));
 }
 assert.throws(()=>planLongRevision({...config,maxInputBytes:1},input('가'.repeat(6001))),{code:'INPUT_TOO_LARGE'});
});
test('sanitized analysis is retained conservatively in the combined result',async()=>{
 let i=0;const out=await runLongRevision(config,input('가'.repeat(14000)),{runChunk:async(c,d)=>{const r=result(d);r.revision.analysisSanitized=i++===1;return r;}});
 assert.equal(out.revision.analysisSanitized,true);
});
test('failed sibling blocks subsequent calls by in-flight workers without replacing first error',async()=>{
 const gate=deferred(),failGate=deferred();const first=new Error('first failure');let calls=0,after=0,billed=0;
 const pending=runLongRevision(config,input('가'.repeat(14000)),{onUsage:()=>billed++,runChunk:async(c,d,callbacks)=>{
  const i=calls++;await callbacks.beforeCall({stage:'draft',callIndex:0});
  if(i===0){await failGate.promise;throw first;}
  await gate.promise;callbacks.onUsage(10);
  await callbacks.beforeCall({stage:'review',callIndex:1});after++;return result(d);
 }});
 const observed=pending.catch(e=>e);await tick();failGate.resolve();await tick();gate.resolve();
 assert.equal(await observed,first);assert.equal(after,0);assert.equal(billed,2);
});
