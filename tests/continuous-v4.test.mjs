import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {changedRanges,clippedRanges} from '../lib/inline-diff.mjs';
import {validateRevision,revisionLimits,reserveRevisionCost,reserveRevisionStages,runRevision,scoreCardFromReview} from '../lib/revision.mjs';
import {minimumRevisionBudget,measuredRevisionCost} from '../lib/revision-api.mjs';
import {RevisionStore} from '../lib/revision-store.mjs';
import {PaymentService} from '../lib/payments.mjs';
import {callAI} from '../lib/provider.mjs';
import {settings} from '../lib/core.mjs';
import {MockRedis} from './mock-redis.mjs';

// Every example in this file is fictional. No live AI, payment or user text is used.
const original='가상 도서관에서 저는 안내 표지를 만들고 방문객을 도왔습니다. 처음 온 사람들이 위치를 몰라 팀원들과 함께 안내문을 준비했습니다.';
const rewritten='가상 도서관에서 저는 안내 표지를 만들어 방문객을 도왔습니다. 위치를 찾기 어려운 방문객을 위해 팀원들과 함께 안내문을 준비했습니다.';
const config={maxInputBytes:80000,inputRate:3,outputRate:15,provider:'mock',model:'mock'};
const req=(o={})=>({action:'revise',requestId:randomUUID(),product:'free',consent:true,consentProvider:'mock',consentModel:'mock',offerVersion:'v4-revision-3000',clientVersion:'simple-v4',originalText:original,...o});
const side=(structure=12)=>({structure,evidence:13,agency:12,expression:11,spelling:14});
const score=(a=12,b=16)=>({original:side(a),revised:side(b),originalQuote:'가상 도서관에서 저는',revisedQuote:'가상 도서관에서 저는'});
const draft=(text=rewritten)=>({status:'ready',text,changes:[],diagnosis:[],warnings:[]});
const sha=s=>createHash('sha256').update(s).digest('hex');
function review(payload,overrides={}){
 const q='안내 표지를',e=[{sourceId:'original',quote:q}];
 return {candidateDigest:sha(payload.candidate.text),checks:['fit','evidence','agency','causality','numbers','naturalness','length'].map(key=>({key,status:'pass',reason:'원문과 대조했습니다.',quote:q,evidence:e})),claims:[{quote:q,status:'supported',reason:'원문에 있습니다.',evidence:e}],scoreCard:score(),...overrides};
}
function scripted(sequence){const calls=[];return {calls,ai:async(system,payload,tokens,options)=>{calls.push({system,payload,tokens});options.onCallStarted?.();options.onUsage?.(1);const next=sequence[calls.length-1];if(next===undefined)throw Error('unexpected call');return typeof next==='function'?next(payload):next;}};}
const now=()=>Date.parse('2026-11-06T10:00:00Z');
function service(){const store=new MockRedis(now),c={secret:'fictional-session-secret-at-least-thirty-two-chars',origin:'https://example.test',redisURL:'https://redis.test',redisToken:'mock',env:{PAYMENT_MODE:'disabled'}};return new PaymentService(c,store,{now});}
const marker='잠금뒤비공개테스트문장절대전달금지';
function stored(){const text='공개되는가상의수정문 '.repeat(30)+marker;return {source:'ai',product:'revision',sections:[{id:'p1',heading:'PRIVATE_HEADING_SHOULD_NOT_LEAK',text,charLimit:null}],quality:{checks:[]},revision:{previewVersion:'continuous-v2',promptProvided:false,limitProvided:false,lengthMode:'characters',limit:null,originalLength:100,revisedLength:Array.from(text).length,inlineEditRanges:[[1,6],[Math.floor(Array.from(text).length*.7)-1,Math.floor(Array.from(text).length*.7)+1]],scoreCard:scoreCardFromReview(score(),original,rewritten),changes:[],diagnosis:[],warnings:[]},review:{private:marker},sources:[{quote:marker}]};}

test('v4 expert prompt rewrites one complete essay and ignores unprovided context or questions',async()=>{
 const d=validateRevision(req({organization:'가상회사',role:'가상직무',prompt:'가상의 별도 문항입니다',limit:300,clarificationRound:1,clarifications:[{question:'q',answer:'a'}]}));
 assert.equal(d.prompt,'');assert.equal(d.organization,'');assert.equal(d.role,'');assert.equal(d.limit,null);assert.deepEqual(d.clarifications,[]);
 const m=scripted([draft(),review]),out=await runRevision(config,req(),{ai:m.ai});assert.equal(m.calls.length,2);
 for(const phrase of ['당신은 취업 자기소개서 첨삭 전문가입니다','추가 질문 없이 제공된 내용만으로','원문에 없는 경험, 성과, 숫자, 자격증','숫자와 단위는 쉼표·소수점·기호까지 원문 표기대로 보존'])assert.ok(m.calls[0].system.includes(phrase));
 assert.equal(m.calls[0].payload.prompt,undefined);assert.equal(out.sections[0].text,rewritten);assert.equal(out.revision.previewVersion,'continuous-v2');
 assert.equal(out.revision.scoreCard.original.total,62);assert.equal(out.revision.scoreCard.revised.total,66);assert.ok(out.revision.inlineEditRanges.length>0);
});
test('both scores are independent and may stay flat or become lower',()=>{const c=scoreCardFromReview(score(17,8),original,rewritten);assert.equal(c.original.total,67);assert.equal(c.revised.total,58);});
test('invalid, ungrounded, fabricated, or inconsistent ratings are unavailable rather than invented',()=>{
 for(const x of [undefined,{}, {...score(),originalQuote:'없는근거내용입니다'}, {...score(),original:{...side(),agency:21}}, {...score(),revised:{...side(),spelling:12.5}}, {...score(),revised:{...side(),spelling:'14'}}])assert.equal(scoreCardFromReview(x,original,rewritten),null);
 assert.equal(scoreCardFromReview({...score(),revisedQuote:'가상 도서관에서 저는'},original,original),null);
});
test('missing or invalid scores do not block a safe revision',async()=>{const m=scripted([draft(),p=>review(p,{scoreCard:{original:99}})]),out=await runRevision(config,req(),{ai:m.ai});assert.equal(out.revision.scoreCard,null);assert.equal(out.sections[0].text,rewritten);assert.equal(m.calls.length,2);});
test('scores come only from the final review after repair',async()=>{
 const m=scripted([draft(),p=>review(p,{checks:['fit','evidence','agency','causality','numbers','naturalness','length'].map(key=>({key,status:key==='naturalness'?'hard':'pass',reason:'더 확인합니다.',quote:'안내 표지를',evidence:[{sourceId:'original',quote:'안내 표지를'}]})),scoreCard:score(1,2)}),draft(),p=>review(p,{scoreCard:score(10,15)})]);
 const out=await runRevision(config,req(),{ai:m.ai});assert.equal(m.calls.length,4);assert.equal(out.revision.scoreCard.original.breakdown.structure,10);assert.equal(out.revision.scoreCard.revised.breakdown.structure,15);
});
test('changed marks contain offsets only and identify insertions without changing text',()=>{
 assert.deepEqual(changedRanges('같은 글입니다.','같은 글입니다.'),[]);
 const s='가나다 새 문장입니다.',r=changedRanges('가나다 문장입니다.',s),a=Array.from(s);assert.equal(r.map(([x,y])=>a.slice(x,y).join('')).join(''),'새 ');
 const e='시작 😀새 글\n마침',ranges=changedRanges('시작 😀 글\n마침',e);assert.ok(ranges.length);assert.ok(ranges.every(([x,y])=>x>=0&&y<=Array.from(e).length));
});
test('range clipping cannot expose or refer past the free prefix',()=>{assert.deepEqual(clippedRanges([[1,4],[7,11]],8,12),[[1,4],[7,8]]);assert.deepEqual(clippedRanges([[1,4],[3,7]],8,12),[]);assert.deepEqual(clippedRanges([[1,13]],8,12),[]);});
test('v4 uses staged budgets, provider protections and bounded call count',()=>{
 const d=validateRevision(req()),r=new RevisionStore(config),limits=revisionLimits(config,d);
 assert.equal(limits.calls.length,4);assert.ok(reserveRevisionStages(config,d,0,2)<reserveRevisionCost(config,d));assert.ok(minimumRevisionBudget(config,'simple-v4')>0);assert.match(r.reservationScript(d),/staged-v1/);
 assert.ok(Number.isSafeInteger(measuredRevisionCost(config,d,1,new Map())));
});
test('continuous preview returns the exact fixed first 70 percent and never leaks hidden text',async()=>{
 const p=service(),f=stored(),out=await p.saveGeneratedResult('sid-one',randomUUID(),f),full=Array.from(f.sections[0].text),n=Math.floor(full.length*.7),s=out.sections[0];
 assert.equal(out.previewLayout,'continuous-v2');assert.equal(s.segments.filter(x=>x.kind==='visible').map(x=>x.text).join(''),full.slice(0,n).join(''));assert.ok(s.segments.some(x=>x.kind==='locked'));
 assert.ok(!JSON.stringify(out).includes(marker));assert.ok(!JSON.stringify(out).includes('PRIVATE_HEADING_SHOULD_NOT_LEAK'));assert.ok(!JSON.stringify(out).includes('originalQuote'));assert.ok(!out.previewDetails);
 for(const [a,b] of s.segments[0].marks)assert.ok(a>=0&&a<b&&b<=n);
 assert.equal(out.scoreCard.original.total,62);assert.equal(out.scoreCard.revised.total,66);assert.equal(out.purchase.ready,false);
 assert.deepEqual(await p.getPublicResult('sid-one',out.resultId),out);
 const publicAgain=await p.getResult('sid-one',out.resultId);assert.equal(publicAgain.access,'preview');assert.ok(!JSON.stringify(publicAgain).includes(marker));
});
test('short, Unicode and multi-paragraph results obey the exact character disclosure boundary',async()=>{
 for(const text of ['a','😀가😀나\n다라마바사아자','가나다라마바사아자차카타파하'.repeat(9)]){
  const p=service(),f=stored();f.sections[0].text=text;f.revision.inlineEditRanges=[];const out=await p.saveGeneratedResult('sid-'+text.length,randomUUID(),f),expected=Array.from(text).slice(0,Math.floor(Array.from(text).length*.7)).join('');
  assert.equal(out.sections[0].segments.filter(x=>x.kind==='visible').map(x=>x.text).join(''),expected);
 }
});
test('score projections only expose validated numbers and omit arbitrary fields',async()=>{
 const p=service(),f=stored();f.revision.scoreCard.original.secret=marker;f.revision.scoreCard.revised.breakdown.extra=marker;
 const out=await p.saveGeneratedResult('sid-two',randomUUID(),f);assert.ok(!JSON.stringify(out).includes(marker));assert.equal(out.scoreCard.original.secret,undefined);assert.equal(out.scoreCard.revised.breakdown.extra,undefined);
});

test('v4 safely discards unrequested model notes before independently reviewing the full text',async()=>{
 const bad={...draft(),changes:[{category:'not-a-real-category',before:'fictional'}],diagnosis:[{category:'not-a-real-category',problem:'fictional',suggestion:'fictional'}],warnings:{unexpected:'untrusted'}};
 const m=scripted([bad,review]),out=await runRevision(config,req(),{ai:m.ai});
 assert.equal(m.calls.length,2);assert.equal(out.sections[0].text,rewritten);assert.deepEqual(out.revision.changes,[]);assert.deepEqual(out.revision.diagnosis,[]);assert.ok(!JSON.stringify(out).includes('not-a-real-category'));
});

test('mock approval unlocks the complete new essay and edit marks, never before approval',async()=>{
 const now=()=>Date.parse('2026-11-06T08:00:00Z'),db=new MockRedis(now),env={OPENROUTER_API_KEY:'fake-unit-key',SESSION_SECRET:'fake-session-secret-at-least-32-chars',UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'mock',APP_ORIGIN:'https://site.test',PAYMENT_MODE:'test',PAYMENT_READY:'true',TOSS_CLIENT_KEY:'test_ck_fakeunitkey',TOSS_SECRET_KEY:'test_sk_fakeunitkey',TOSS_MERCHANT_ID:'unitmid',NODE_ENV:'development'};
 const c=settings(env);let state='IN_PROGRESS',orderId;const fetcher=async(url)=>{if(url.endsWith('/confirm'))state='DONE';return new Response(JSON.stringify({mId:'unitmid',orderId,paymentKey:'unit-payment-reference',totalAmount:3000,balanceAmount:3000,currency:'KRW',type:'NORMAL',method:'카드',status:state,approvedAt:state==='DONE'?new Date(now()).toISOString():null}));};
 const service=new PaymentService(c,db,{now,fetcher,uuid:randomUUID}),f=stored(),preview=await service.saveGeneratedResult('mock-owner',randomUUID(),f);
 assert.equal(preview.access,'preview');assert.ok(!JSON.stringify(preview).includes(marker));const order=await service.createOrder('mock-owner',preview.resultId,{termsAccepted:true,immediateDeliveryAccepted:true});orderId=order.orderId;assert.equal(order.amount,3000);
 const full=await service.confirm('mock-owner',{orderId,paymentKey:'unit-payment-reference',amount:3000});assert.equal(full.access,'full');assert.equal(full.sections[0].text,f.sections[0].text);assert.deepEqual(full.revision.inlineEditRanges,f.revision.inlineEditRanges);assert.equal(full.revision.scoreCard.original.total,62);assert.equal(full.recoveryCode,undefined);
});

test('known provider cost is retained even when token counters are missing',async()=>{
 const measured=[],c={provider:'openrouter',model:'anthropic/claude-sonnet-5.5',apiKey:'fake-unit-key',maxInputBytes:3000,inputRate:3,outputRate:15,timeout:1000};
 await callAI(c,'시스템',{},100,{requireBilledCost:true,onUsage:n=>measured.push(n),fetcher:async()=>({ok:true,text:async()=>JSON.stringify({usage:{cost:1},choices:[{message:{content:'{}'},finish_reason:'stop'}]})})});
 assert.equal(measured.length,1);assert.ok(measured[0]>=1100000);
});
