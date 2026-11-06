import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {validateRevision,revisionLimits,reserveRevisionCost,runRevision} from '../lib/revision.mjs';
import {createRevisionHandler,minimumRevisionBudget,REVISION_LIMITS} from '../lib/revision-api.mjs';
import {settings} from '../lib/core.mjs';
import {PaymentService,REVISION_OFFER} from '../lib/payments.mjs';
import {MockRedis} from './mock-redis.mjs';
import {config,original,input,ready,reviewed,scripted,hard} from './revision-fixtures.mjs';
const env={OPENROUTER_API_KEY:'fake-v2-test-only-api-key',SESSION_SECRET:'fake-v2-test-session-secret-at-least-32-chars',UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'mock-only',APP_ORIGIN:'https://site.test'};
const connection=settings(env);
const v2=(overrides={})=>({action:'revise',clientVersion:'simple-v2',requestId:'12345678-1234-4234-8234-123456789abc',product:'free',consent:true,offerVersion:'v4-revision-3000',consentProvider:connection.provider,consentModel:connection.model,prompt:'',originalText:original,organization:'',role:'',posting:'',lengthMode:'characters',limit:null,clarificationRound:0,clarifications:[],...overrides});
function fixture(){
 const events={reserved:0,ai:0,saved:0,data:[],finished:[]};
 const store={reserve:async(sid,ip,data,cost)=>{events.reserved++;events.data.push(data);return {sid,token:data.requestId,cost};},finish:async(_r,status)=>events.finished.push(status),isCancelled:async()=>false};
 const payments={saveGeneratedResult:async(_sid,_id,result)=>{events.saved++;return {access:'preview',product:'revision',resultId:'mock-result',previewVersion:result.revision.previewVersion};}};
 const mock=scripted([ready(),reviewed]);
 return {events,handler:createRevisionHandler({env,store,payments,ai:async(...args)=>{events.ai++;return mock.ai(...args);}})};
}
async function request(handler,body){const res={headers:{},setHeader(k,v){this.headers[k]=v;},getHeader(k){return this.headers[k];},end(raw){this.body=JSON.parse(raw);}};await handler({method:'POST',headers:{host:'site.test',origin:'https://site.test','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'},body},res);return res;}
function noOldFlags(d){for(const key of ['factsConfirmed','previewDisclosureAccepted'])assert.equal(Object.hasOwn(d,key),false);}
for(const consent of [undefined,null,false,'true',1])test('v2 strict consent rejects before reservation and AI: '+String(consent),async()=>{
 const data=v2({consent});if(consent===undefined)delete data.consent;
 assert.throws(()=>validateRevision(data),{code:'CONSENT_REQUIRED'});
 const t=fixture(),r=await request(t.handler,data);assert.equal(r.body.code,'CONSENT_REQUIRED');assert.equal(t.events.reserved,0);assert.equal(t.events.ai,0);assert.equal(t.events.saved,0);
});
test('v2 valid single consent reaches real engine without fabricated declarations',async()=>{
 const t=fixture(),raw=v2(),saved=JSON.stringify(raw),r=await request(t.handler,raw);
 assert.equal(r.statusCode,200);assert.equal(r.body.access,'preview');assert.equal(r.body.previewVersion,'simple-v1');assert.equal(t.events.reserved,1);assert.equal(t.events.ai,2);assert.equal(t.events.saved,1);assert.deepEqual(t.events.finished,['done']);noOldFlags(t.events.data[0]);assert.equal(JSON.stringify(raw),saved);
});
test('v2 never inserts or forwards legacy fact/price flags even when supplied',()=>{
 for(const value of [undefined,false,true,null,'true']){const d=validateRevision(v2({factsConfirmed:value,previewDisclosureAccepted:value}));noOldFlags(d);assert.equal(d.consent,true);assert.equal(d.clientVersion,'simple-v2');assert.equal(d.consentProvider,connection.provider);assert.equal(d.consentModel,connection.model);assert.deepEqual(validateRevision(d),d);}
});
for(const field of ['consentProvider','consentModel']){
 for(const value of [undefined,null,'',' ',42,'x'.repeat(201),'bad\u0000','bad\ud800'])test('v2 connection field is required and bounded: '+field+' '+String(value).slice(0,12),async()=>{
  const t=fixture(),r=await request(t.handler,v2({[field]:value}));assert.equal(r.body.code,'INVALID_INPUT');assert.equal(t.events.reserved,0);assert.equal(t.events.ai,0);
 });
 test('v2 changed '+field+' blocks before reservation and AI',async()=>{const t=fixture(),r=await request(t.handler,v2({[field]:'different-model-or-provider'}));assert.equal(r.statusCode,409);assert.equal(r.body.code,'AI_PROVIDER_CHANGED');assert.equal(t.events.reserved,0);assert.equal(t.events.ai,0);});
}
for(const version of [undefined,null,'v3','v4-revision-0'])test('v2 offer version remains mandatory: '+String(version),async()=>{
 const t=fixture(),r=await request(t.handler,v2({offerVersion:version,previewDisclosureAccepted:true}));assert.equal(r.body.code,'OFFER_CONFIRMATION_REQUIRED');assert.equal(t.events.reserved,0);assert.equal(t.events.ai,0);
});
test('v2 optional prompt/limit semantics remain unchanged',()=>{
 for(const value of [undefined,null,'   '])assert.equal(validateRevision(v2({prompt:value})).prompt,'');
 for(const value of [undefined,null]){const d=validateRevision(v2({limit:value,lengthMode:undefined}));assert.equal(d.limit,null);assert.equal(d.lengthMode,'characters');}
 for(const value of [false,0,99,2001,'500'])assert.throws(()=>validateRevision(v2({limit:value})),{code:'CHAR_LIMIT'});
});
// Frozen pre-v2 normalized wire bytes: key ordering is part of the retry hash.
const legacyJSON='{"action":"revise","requestId":"12345678-1234-4234-8234-123456789abc","product":"free","consent":true,"factsConfirmed":true,"previewDisclosureAccepted":true,"offerVersion":"v4-revision-3000","prompt":"협업 과정에서 본인이 수행한 역할을 설명해주세요.","originalText":"동아리 행사에서 저는 참가자 명단을 정리하고 안내문을 작성했습니다. 팀원들과 누락된 내용을 확인한 뒤 안내문을 배포하여 준비 업무를 마쳤습니다.","organization":"가상기업","role":"운영 인턴","posting":"","lengthMode":"characters","limit":500,"clarificationRound":0,"clarifications":[]}';
const simpleV1JSON='{"action":"revise","requestId":"12345678-1234-4234-8234-123456789abc","product":"free","consent":true,"factsConfirmed":true,"previewDisclosureAccepted":true,"offerVersion":"v4-revision-3000","clientVersion":"simple-v1","prompt":"","originalText":"동아리 행사에서 저는 참가자 명단을 정리하고 안내문을 작성했습니다. 팀원들과 누락된 내용을 확인한 뒤 안내문을 배포하여 준비 업무를 마쳤습니다.","organization":"가상기업","role":"운영 인턴","posting":"","lengthMode":"characters","limit":null,"clarificationRound":0,"clarifications":[]}';
const sha=s=>createHash('sha256').update(s).digest('hex');
for(const [name,raw,expected] of [['legacy omitted',input(),legacyJSON],['legacy explicit',input({clientVersion:'legacy-v4'}),legacyJSON],['simple-v1',input({clientVersion:'simple-v1',prompt:'',limit:null}),simpleV1JSON]])test(name+' exact serialized bytes and retry hash unchanged',()=>{
 const actual=JSON.stringify(validateRevision(raw));assert.deepEqual(Buffer.from(actual),Buffer.from(expected));assert.equal(sha(actual),sha(expected));assert.equal(JSON.stringify(validateRevision(JSON.parse(actual))),expected);
});
for(const clientVersion of [undefined,'legacy-v4','simple-v1'])for(const [field,code] of [['consent','CONSENT_REQUIRED'],['factsConfirmed','VERIFICATION_REQUIRED'],['previewDisclosureAccepted','OFFER_CONFIRMATION_REQUIRED']])test('legacy '+String(clientVersion)+' still requires '+field,()=>{
 for(const value of [undefined,false])assert.throws(()=>validateRevision(input({clientVersion,[field]:value})),{code});
});
test('v2 promptless run marks missing checks and retains simple-v1 preview',async()=>{
 const mock=scripted([ready(),reviewed]),r=await runRevision(config,v2({prompt:null,limit:null}),{ai:mock.ai});assert.equal(mock.calls.length,2);assert.equal(r.revision.previewVersion,'simple-v1');assert.equal(r.sections[0].text,original);assert.equal(r.sections[0].charLimit,null);assert.equal(r.revision.promptProvided,false);assert.equal(r.revision.limitProvided,false);
 for(const key of ['fit','length'])assert.equal(r.quality.checks.find(c=>c.key===key).not_checked,true);
 for(const call of mock.calls){noOldFlags(call.payload);assert.equal(call.payload.promptProvided,false);assert.equal(call.payload.limitProvided,false);}
 const questions=scripted([{status:'needs_input',questions:[{question:'지원 동기는?',reason:'필수'}]}]);await assert.rejects(runRevision(config,v2(),{ai:questions.ai}),{code:'AI_FORMAT'});
});
test('v2 four-byte worst-case preflight rejects before reservation and AI',async()=>{
 const raw=v2({prompt:'😀'.repeat(800),originalText:'😀'.repeat(6000),organization:'😀'.repeat(200),role:'😀'.repeat(200),posting:'😀'.repeat(3000),clarificationRound:1,clarifications:[{question:'가'.repeat(200),answer:'😀'.repeat(500)},{question:'나'.repeat(200),answer:'😀'.repeat(500)},{question:'다'.repeat(200),answer:'😀'.repeat(500)}]});
 assert.ok(Buffer.byteLength(JSON.stringify(raw))<60000);assert.doesNotThrow(()=>validateRevision(raw));assert.throws(()=>revisionLimits(config,validateRevision(raw)),{code:'INPUT_TOO_LARGE'});
 const mock=scripted([]);await assert.rejects(runRevision(config,raw,{ai:mock.ai}),{code:'INPUT_TOO_LARGE'});assert.equal(mock.calls.length,0);
 const t=fixture(),r=await request(t.handler,raw);assert.equal(r.body.code,'INPUT_TOO_LARGE');assert.equal(t.events.reserved,0);assert.equal(t.events.ai,0);
});
test('v2 keeps cost, call caps, price and operational budgets unchanged',()=>{
 const d=validateRevision(v2()),old=validateRevision(input({...v2(),clientVersion:'simple-v1',factsConfirmed:true,previewDisclosureAccepted:true}));assert.deepEqual(revisionLimits(config,d),revisionLimits(config,old));assert.equal(reserveRevisionCost(config,d),reserveRevisionCost(config,old));assert.equal(revisionLimits(config,d).maxCalls,4);assert.equal(REVISION_LIMITS.modelCallsMax,4);assert.equal(REVISION_LIMITS.modelCallsBase,2);
 assert.deepEqual(REVISION_OFFER,{version:'v4-revision-3000',amount:3000,currency:'KRW',freePreviewLimit:1});const c=settings(env);assert.equal(c.totalBudget,2000000);assert.equal(c.dailyBudget,1000000);
 const minimum=v2({requestId:'00000000-0000-4000-8000-000000000001',originalText:'매장 아르바이트 중 주문 내용을 다시 확인하고 담당자에게 전달했습니다. 고객에게는 확인이 끝나면 다시 안내하겠다고 설명했습니다.'});assert.equal(minimumRevisionBudget(c),reserveRevisionCost(c,validateRevision(minimum)));
 assert.throws(()=>validateRevision(v2({product:'paid'})),{code:'PAYMENT_NOT_READY'});assert.throws(()=>validateRevision(v2({prompt:'대학 입학 지원 동기를 설명해주세요.'})),{code:'UNSUPPORTED_PURPOSE'});
});
for(const kind of ['new number','changed unit','role inflation','unsupported fact'])test('v2 safety cannot be bypassed: '+kind,async()=>{
 let raw=v2(),value=original,review=reviewed;
 if(kind==='new number')value+=' 30% 매출을 높였습니다.';
 if(kind==='changed unit'){raw=v2({originalText:original+' 3년간 참여했습니다.'});value+=' 3명을 이끌었습니다.';}
 if(kind==='role inflation'){value=original.replace('명단을 정리하고','팀 전체를 총괄하고');review=hard('agency');}
 if(kind==='unsupported fact')review=p=>{const r=reviewed(p);r.claims[0].status='unsupported';return r;};
 const mock=scripted([ready(value),review,ready(value),review]);await assert.rejects(runRevision(config,raw,{ai:mock.ai}),{code:'REVISION_UNSAFE'});assert.deepEqual(mock.calls.map(c=>c.options.stage),['draft','review','draft','review']);
});
test('v2 keeps encrypted fixed 25% preview and deletion behavior without payment',async()=>{
 const now=()=>Date.parse('2026-11-06T10:00:00Z'),db=new MockRedis(now),c={secret:'test-only-session-secret-over-thirty-two-chars',origin:'https://example.test',redisURL:'https://redis.test',redisToken:'mock-token',env:{PAYMENT_MODE:'disabled'}},service=new PaymentService(c,db,{now});
 const before='저는 참가자 명단을 정리하고',after='저는 참가자 명단을 정돈하고',value=original.replace(before,after),marker='비공개이유표식',mock=scripted([ready(value,{changes:[{category:'wording',before,after,reason:marker}]}),reviewed]);
 const full=await runRevision(config,v2(),{ai:mock.ai}),out=await service.saveGeneratedResult('owner',randomUUID(),full),record=await service.resultRecord(out.resultId);
 assert.equal(record.previewScheme,'simple-v1');assert.equal(record.expiresAt-now(),3600000);assert.ok(record.cipher);assert.ok(!JSON.stringify(record).includes(value));assert.equal(out.access,'preview');assert.equal(out.purchase.amount,3000);assert.equal(out.purchase.ready,false);assert.equal(out.purchase.mode,'disabled');assert.ok(!JSON.stringify(out).includes(marker));assert.equal(out.revision,undefined);assert.equal(out.review,undefined);
 assert.ok(before.includes(out.previewDetails.example.before));assert.ok(after.includes(out.previewDetails.example.after));assert.ok(Array.from(out.previewDetails.example.before).length+Array.from(out.previewDetails.example.after).length<=Math.floor(Array.from(value).length*.25));assert.deepEqual(out,await service.getPublicResult('owner',out.resultId));
 assert.equal((await service.deleteResult('owner',out.resultId)).deleted,true);assert.equal(db.get(service.db.key('result',out.resultId)),null);assert.ok(db.get('insosoe:v4:used:owner'));await assert.rejects(service.getPublicResult('owner',out.resultId),{code:'RESULT_EXPIRED'});
});
