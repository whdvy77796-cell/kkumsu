import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRevisionHandler,safeRevisionError} from '../lib/revision-api.mjs';
import {RevisionStore,RESERVE_REVISION_LONG,RESERVE_REVISION_STEPWISE} from '../lib/revision-store.mjs';
import {settings,AppError} from '../lib/core.mjs';
import {PaymentService} from '../lib/payments.mjs';
import {MockRedis} from './mock-redis.mjs';
const env={OPENROUTER_API_KEY:'test-only-key',SESSION_SECRET:'fake-test-secret-at-least-thirty-two-chars',UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'mock-token',APP_ORIGIN:'https://site.test',PAYMENT_MODE:'disabled'};
const c=settings(env),source='가상 자원봉사 활동에서 팀원과 함께 안내 자료를 살펴보고 필요한 내용을 정리했습니다. '.repeat(160);
const body=()=>({action:'revise',requestId:randomUUID(),product:'free',consent:true,consentProvider:c.provider,consentModel:c.model,offerVersion:'v4-revision-3000',clientVersion:'simple-v5',originalText:source});
const request=async(handler,b)=>{const res={headers:{},setHeader(k,v){this.headers[k]=v},getHeader(k){return this.headers[k]},end(x){this.body=JSON.parse(x)}};await handler({method:'POST',headers:{host:'site.test',origin:'https://site.test','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'},body:b},res);return res};
const syntheticFull=()=>({source:'ai',product:'revision',sections:[{id:'p1',heading:'다듬은 자기소개서',text:'가상 결과입니다. '.repeat(2200)}],quality:{checks:[]},revision:{previewVersion:'continuous-v3',longChunked:true,inlineEditRanges:[],lengthMode:'characters',limit:null,originalLength:Array.from(source).length,revisedLength:2200*Array.from('가상 결과입니다. ').length,deepAnalysis:{overview:'가상 글 분석입니다.',strengths:[],improvements:[],questions:[]},changes:[],diagnosis:[],warnings:[]}});

test('long v5 uses one long lock, one reservation, one final save and accounts out-of-order calls',async()=>{
 let reserved=0,finished=null,saved=0;const store={supportsStagedRevision:true,reserve:async(_sid,_ip,d,cost)=>{reserved=cost;return {sid:'test',token:d.requestId,cost}},finish:async(_r,status,_out,_action,cost)=>{finished={status,cost}},isCancelled:async()=>false};
 const payments={saveGeneratedResult:async(_s,_id,data)=>{saved++;assert.equal(data.revision.longChunked,true);return {resultId:randomUUID(),access:'preview',sections:[{heading:'p1',segments:[{kind:'visible',text:'synthetic'}]}]}}};
 const handler=createRevisionHandler({env,store,payments,runLongRevision:async(_c,_d,h)=>{await h.beforeCall({chunkIndex:0,callIndex:0});h.onCallStarted(0);await h.beforeCall({chunkIndex:1,callIndex:0});h.onCallStarted(1);h.onUsage(1,25);h.onUsage(0,15);return syntheticFull();}});
 const r=await request(handler,body());assert.equal(r.statusCode,200);assert.equal(saved,1);assert.ok(reserved>40);assert.deepEqual(finished,{status:'done',cost:40});assert(!JSON.stringify(r.body).includes(source));
});
test('long user cancellation fails before chunk calls and does not save a partial result',async()=>{
 let saved=0,calls=0,settled;const store={supportsStagedRevision:true,reserve:async(_sid,_ip,d,cost)=>({sid:'test',token:d.requestId,cost}),finish:async(_r,status)=>{settled=status},isCancelled:async()=>true};
 const payments={saveGeneratedResult:async()=>{saved++}};const handler=createRevisionHandler({env,store,payments,runLongRevision:async(_c,_d,h)=>{await h.beforeCall({chunkIndex:0,callIndex:0});calls++;return syntheticFull()}});
 const r=await request(handler,body());assert.equal(r.statusCode,409);assert.equal(r.body.code,'REQUEST_CANCELLED');assert.equal(calls,0);assert.equal(saved,0);assert.equal(settled,'failed');
});
test('long v5 reservation script is long-lived and nonstaged; short v5 remains staged',()=>{const s=new RevisionStore(c);assert.equal(s.reservationScript(body()),RESERVE_REVISION_LONG);assert.equal(s.reservationScript({...body(),originalText:'가'.repeat(100)}),RESERVE_REVISION_STEPWISE)});
test('long encrypted result projects one global 70% prefix, withholds suffix and reports lengths',async()=>{
 const now=()=>Date.parse('2026-11-07T10:00:00Z'),db=new MockRedis(now),pay=new PaymentService({...c,env:{PAYMENT_MODE:'disabled'}},db,{now}),full=syntheticFull(),marker='비공개고유단어잠금구간';
 full.sections[0].text+=' '+marker;full.revision.originalLength=50000;full.revision.revisedLength=Array.from(full.sections[0].text).length;full.revision.deepAnalysis.strengths=Array.from({length:7},(_,i)=>({quote:'안전한 가상 인용',comment:'내용 구성 검토 '+String.fromCharCode(65+i)}));full.revision.deepAnalysis.questions=[{quote:marker,question:marker}];
 const out=await pay.saveGeneratedResult('test-owner',randomUUID(),full),pfx=Math.floor(Array.from(full.sections[0].text).length*0.7);assert.equal(out.sections.length,1);assert.equal(out.sections[0].segments[0].text,Array.from(full.sections[0].text).slice(0,pfx).join(''));assert(!JSON.stringify(out).includes(marker));assert.equal(out.revisionSummary.originalLength,50000);assert.equal(out.revisionSummary.revisedLength,full.revision.revisedLength);assert.equal(out.analysisReport.strengths.length,7);assert.equal(out.analysisReport.questions.length,0);assert.equal(out.purchase.ready,false);
});

test('all preserved chunks explain incomplete result without exposing input',()=>{const e=new AppError('REVISION_UNSAFE','PRIVATE SOURCE SHOULD NOT APPEAR',422,true,{preservedChunks:2});const r=safeRevisionError(e);assert.match(r.error,/모든 구간/);assert(!JSON.stringify(r).includes('PRIVATE SOURCE'));});
