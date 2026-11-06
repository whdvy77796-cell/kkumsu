import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRevision,revisionLimits,reserveRevisionCost,runRevision} from '../lib/revision.mjs';
import {REVISION_LIMITS} from '../lib/revision-api.mjs';
import {config,original,input,ready,reviewed,scripted,hard} from './revision-fixtures.mjs';
const simple=(overrides={})=>input({clientVersion:'simple-v1',prompt:'',limit:null,...overrides});
const run=async(sequence,data=simple())=>{const mock=scripted(sequence);const result=await runRevision(config,data,{ai:mock.ai});return {result,mock};};
test('simple optional inputs normalize without changing offer or original',()=>{
 const raw=simple();delete raw.prompt;delete raw.limit;delete raw.lengthMode;
 const d=validateRevision(raw);assert.equal(d.prompt,'');assert.equal(d.limit,null);assert.equal(d.lengthMode,'characters');assert.equal(d.originalText,original);assert.equal(d.offerVersion,'v4-revision-3000');
 assert.equal(validateRevision(simple({prompt:'   '})).prompt,'');
 assert.equal(REVISION_LIMITS.promptRequired,false);assert.equal(REVISION_LIMITS.limitRequired,false);assert.equal(REVISION_LIMITS.modelCallsBase,2);assert.equal(REVISION_LIMITS.modelCallsMax,4);
});
test('one essay requires 40..6000 code points, allowing internal paragraphs',()=>{
 for(const value of ['', ' '.repeat(40), '가'.repeat(39), '가'.repeat(6001)])assert.throws(()=>validateRevision(simple({originalText:value})),{code:'INVALID_INPUT'});
 for(const value of ['😀'.repeat(40),'가'.repeat(6000),original+'\n\n'+original])assert.equal(validateRevision(simple({originalText:value})).originalText,value);
});
test('null and omitted limits never become zero; supplied limit validation preserved',()=>{
 for(const value of [null,undefined])assert.equal(validateRevision(simple({limit:value})).limit,null);
 for(const value of [0,-1,99,2001,NaN,Infinity,'500',false])assert.throws(()=>validateRevision(simple({limit:value})),{code:'CHAR_LIMIT'});
 assert.equal(validateRevision(simple({limit:100})).limit,100);assert.equal(validateRevision(simple({limit:6000,lengthMode:'utf8-bytes'})).limit,6000);
});
test('promptless and limitless output marks both checks not_checked and preserves one essay',async()=>{
 const {result:r,mock}=await run([ready(),reviewed]);assert.equal(mock.calls.length,2);
 assert.equal(r.sections[0].heading,'다듬은 자기소개서');assert.equal(r.sections[0].charLimit,null);assert.equal(r.sections[0].text,original);
 assert.equal(r.revision.previewVersion,'simple-v1');assert.equal(r.revision.promptProvided,false);assert.equal(r.revision.limitProvided,false);assert.equal(r.revision.limit,null);
 assert.equal(r.quality.isPromptProvided,false);assert.equal(r.quality.isLimitProvided,false);
 for(const key of ['fit','length']){const c=r.quality.checks.find(c=>c.key===key);assert.equal(c.status,'attention');assert.equal(c.not_checked,true);assert.equal(r.review.checks.find(c=>c.key===key).not_checked,true);}
 assert(r.revision.warnings.some(w=>w.includes('문항 적합성 미검토')));assert(r.revision.warnings.some(w=>w.includes('분량 제한 미입력')));assert(!r.revision.diagnosis.some(d=>d.category==='length'));assert.equal(r.quality.repairAttempted,false);
 assert.equal(mock.calls[0].payload.promptProvided,false);assert.equal(mock.calls[0].payload.limitProvided,false);assert(mock.calls[0].system.includes('needs_input 금지'));assert(mock.calls[1].system.includes('문항 불일치·필수 답변 부재 hard를 요구하지 않는다'));
});
test('unchecked fit and length cannot trigger invented hard repair',async()=>{
 const bad=p=>{const r=reviewed(p);for(const c of r.checks)if(['fit','length'].includes(c.key))c.status='hard';return r;};
 const {result,mock}=await run([ready(),bad]);assert.equal(mock.calls.length,2);assert.equal(result.quality.repairAttempted,false);
});
test('unchecked criteria may be omitted but fact and wording criteria remain mandatory',async()=>{
 const without=keys=>p=>({...reviewed(p),checks:reviewed(p).checks.filter(c=>!keys.includes(c.key))});
 assert.equal((await run([ready(),without(['fit','length'])])).result.review.checks.length,7);
 await assert.rejects(run([ready(),without(['fit','length','numbers'])]),{code:'AI_FORMAT'});
 await assert.rejects(run([ready(),without(['evidence'])]),{code:'AI_FORMAT'});
});
test('no prompt means no model-invented required questions or fit diagnosis',async()=>{
 await assert.rejects(run([{status:'needs_input',questions:[{question:'지원동기는?',reason:'필수입니다.'}]}]),{code:'AI_FORMAT'});
 const {result}=await run([ready(original,{diagnosis:[{category:'fit',problem:'문항 부적합',suggestion:'지원동기를 추가하세요.'}]}),reviewed]);assert.deepEqual(result.revision.diagnosis,[]);
});
test('unset limit does not impose an arbitrary 600-character cap',async()=>{
 const value=original.repeat(10);assert(Array.from(value).length>600);
 const {result,mock}=await run([ready(value),reviewed],simple({originalText:value}));assert.equal(result.sections[0].text,value);assert.equal(mock.calls.length,2);assert(!result.revision.diagnosis.some(d=>d.category==='length'));
});
test('selected length limit still repairs excess even without a prompt',async()=>{
 const {result,mock}=await run([ready(original.repeat(2)),reviewed,ready(),reviewed],simple({limit:100}));assert.equal(mock.calls.length,4);assert(result.revision.revisedLength<=100);assert.equal(result.revision.limitProvided,true);assert.equal(result.quality.checks.find(c=>c.key==='length').not_checked,undefined);
});
test('existing V4 provided prompt and limit preserve headings and checks',async()=>{
 const d=input(),{result,mock}=await run([ready(),reviewed],d);assert.equal(result.sections[0].heading,d.prompt);assert.equal(result.sections[0].charLimit,d.limit);assert.equal(result.revision.promptProvided,true);assert.equal(result.revision.limitProvided,true);assert.equal(result.revision.previewVersion,'opening-v1');assert(result.quality.checks.every(c=>c.status==='pass'&&!c.not_checked));assert.equal(mock.calls.length,2);
});
test('resource reservations scale with input and remain finite and bounded',async()=>{
 const small=validateRevision(simple()),large=validateRevision(simple({originalText:'가'.repeat(6000)})),a=revisionLimits(config,small),b=revisionLimits(config,large);
 assert(b.maxTextChars>a.maxTextChars);assert(b.maxTextChars>=6000&&b.maxTextChars<=6500);assert(b.maxOutputTokens>a.maxOutputTokens&&b.maxOutputTokens<=10000);assert.equal(b.baseCalls,2);assert.equal(b.maxCalls,4);
 for(const d of [small,large]){const l=revisionLimits(config,d);assert.equal(l.calls.length,4);assert(l.calls.every(c=>Number.isFinite(c.inputCap)&&c.inputCap<=config.maxInputBytes&&c.maxOutputTokens<=10000));assert(Number.isSafeInteger(reserveRevisionCost(config,d)));}
 assert(reserveRevisionCost(config,large)>reserveRevisionCost(config,small));
 const {result,mock}=await run([ready(large.originalText),reviewed],large);assert.equal(result.sections[0].text,large.originalText);mock.calls.forEach((c,i)=>assert(Buffer.byteLength(c.system+JSON.stringify(c.payload))<=b.calls[i].inputCap));
});
test('number injection remains blocking without prompt or limit at four calls',async()=>{
 const value=original+' 30% 매출을 높였습니다.',mock=scripted([ready(value),reviewed,ready(value),reviewed]);await assert.rejects(runRevision(config,simple(),{ai:mock.ai}),{code:'REVISION_UNSAFE'});assert.equal(mock.calls.length,4);
});
test('semantic role inflation remains blocking without prompt or limit',async()=>{
 const value=original.replace('명단을 정리하고','팀 전체를 총괄하고');await assert.rejects(run([ready(value),hard('agency'),ready(value),hard('agency')]),{code:'REVISION_UNSAFE'});
});
test('numeric units and unsupported claims remain blocking in simple flow',async()=>{
 const source=original+' 3년간 참여했습니다.',value=original+' 3명을 이끌었습니다.';
 await assert.rejects(run([ready(value),reviewed,ready(value),reviewed],simple({originalText:source})),{code:'REVISION_UNSAFE'});
 const unsupported=p=>{const r=reviewed(p);r.claims[0].status='unsupported';return r;};await assert.rejects(run([ready(),unsupported,ready(),unsupported]),{code:'REVISION_UNSAFE'});
});

test('legacy v4 normalized request preserves exact JSON serialization for idempotency hash',()=>{const legacy=input();assert.equal(JSON.stringify(validateRevision(legacy)),JSON.stringify(legacy));const newClient=validateRevision(simple());assert.equal(newClient.clientVersion,'simple-v1');assert.notEqual(JSON.stringify(newClient),JSON.stringify(legacy));assert.throws(()=>validateRevision({...legacy,clientVersion:'unknown'}),{code:'INVALID_INPUT'});});

test('large combined optional input is rejected before any AI call if worst-case review cannot fit',async()=>{const request=simple({prompt:'😀'.repeat(800),originalText:'😀'.repeat(6000),organization:'😀'.repeat(200),role:'😀'.repeat(200),posting:'😀'.repeat(3000),clarificationRound:1,clarifications:[{question:'가'.repeat(200),answer:'😀'.repeat(500)},{question:'나'.repeat(200),answer:'😀'.repeat(500)},{question:'다'.repeat(200),answer:'😀'.repeat(500)}]});assert.ok(Buffer.byteLength(JSON.stringify(request))<60000);assert.doesNotThrow(()=>validateRevision(request));let calls=0;await assert.rejects(()=>runRevision(config,request,{ai:async()=>{calls++;throw Error('must not call AI');}}),{code:'INPUT_TOO_LARGE'});assert.equal(calls,0);});
