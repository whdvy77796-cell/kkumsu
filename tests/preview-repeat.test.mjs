import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {previewRepeat} from '../lib/preview-repeat.mjs';
import {RevisionStore} from '../lib/revision-store.mjs';
import {RESERVE} from '../lib/store.mjs';
import {SAVE_RESULT} from '../lib/payment-store.mjs';
import {PaymentService} from '../lib/payments.mjs';
import {MockRedis} from './mock-redis.mjs';
import {validateRevision,revisionLimits,runRevision} from '../lib/revision.mjs';

// Synthetic data only: no user essay, live AI, real payment, or remote datastore.
const origin='https://kkumsu-git-insosoe-staged-safety-20261107-kkkkkum.vercel.app';
const safeEnv={VERCEL:'1',VERCEL_ENV:'preview',VERCEL_GIT_PROVIDER:'github',VERCEL_GIT_REPO_OWNER:'whdvy77796-cell',VERCEL_GIT_REPO_SLUG:'kkumsu',VERCEL_GIT_COMMIT_REF:'insosoe-staged-safety-20261107',PAYMENT_MODE:'disabled'};
const config=(overrides={})=>({origin,secret:'fake-session-secret-at-least-32-characters',redisURL:'https://redis.test',redisToken:'mock',env:{...safeEnv},...overrides});
const now=()=>Date.parse('2026-11-07T10:00:00Z');
const essay='가상의 동아리 활동에서 맡은 안내를 준비하고 팀원과 확인했습니다. '.repeat(5);
const full=()=>({source:'ai',product:'revision',sections:[{id:'p1',heading:'다듬은 자기소개서',text:essay}],quality:{checks:[]},revision:{previewVersion:'continuous-v2',promptProvided:false,limitProvided:false,lengthMode:'characters',limit:null,originalLength:100,revisedLength:Array.from(essay).length,inlineEditRanges:[[0,2]],scoreCard:null,changes:[],diagnosis:[],warnings:[]}});
function service(c=config()){const db=new MockRedis(now);return {db,pay:new PaymentService(c,db,{now,uuid:randomUUID})};}

test('repeat access exists only on the exact protected, payment-disabled test deployment',()=>{
 assert.equal(previewRepeat(config()),true);
 const failures=[{VERCEL:undefined},{VERCEL:'0'},{VERCEL_ENV:'production'},{VERCEL_ENV:'development'},{VERCEL_GIT_PROVIDER:'other'},{VERCEL_GIT_REPO_OWNER:'other'},{VERCEL_GIT_REPO_SLUG:'other'},{VERCEL_GIT_COMMIT_REF:'insosoe-analysis-qa-20261106'},{VERCEL_GIT_COMMIT_REF:'main'},{PAYMENT_MODE:'test'},{PAYMENT_MODE:'live'}];
 for(const change of failures)assert.equal(previewRepeat(config({env:{...safeEnv,...change}})),false,JSON.stringify(change));
 assert.equal(previewRepeat(config({origin:'https://www.kkumsu.com'})),false);assert.equal(previewRepeat(config({origin:origin+'/'})),false);assert.equal(previewRepeat({}),false);
});
test('the ordinary used key and all budget/quota checks remain present in atomic scripts',()=>{
 assert.ok(RESERVE.includes("ARGV[9]~='1' and redis.call('EXISTS',KEYS[6])"));assert.ok(RESERVE.includes("current+cost>"));assert.ok(RESERVE.includes("KEYS[3]) or '0')>=tonumber(ARGV[4])"));assert.ok(RESERVE.includes("KEYS[4]) or '0')>=tonumber(ARGV[5])"));
 assert.ok(SAVE_RESULT.includes("ARGV[5]~='1' and redis.call('EXISTS',KEYS[4])"));assert.ok(SAVE_RESULT.includes("redis.call('SET',KEYS[4],'1')"));
 const s=new RevisionStore(config());assert.equal(s.repeatAllowed('fake-sid'),true);assert.equal(s.keys('fake-sid','ip','fake-id')[5],'insosoe:v4:used:fake-sid');
});
test('repeat mode saves two separate encrypted previews without deleting the first or altering payment',async()=>{
 const {db,pay}=service(),owner='fake-owner',id1=randomUUID(),id2=randomUUID();
 const one=await pay.saveGeneratedResult(owner,id1,full()),record1=await pay.resultRecord(one.resultId),cipher1=record1.cipher,expiry1=record1.expiresAt;
 const two=await pay.saveGeneratedResult(owner,id2,full()),again=await pay.saveGeneratedResult(owner,id1,full());
 assert.notEqual(one.resultId,two.resultId);assert.equal(again.resultId,one.resultId);assert.equal((await pay.resultRecord(one.resultId)).cipher,cipher1);assert.equal((await pay.resultRecord(one.resultId)).expiresAt,expiry1);
 assert.equal((await pay.resultRecord(two.resultId)).owner,owner);assert.ok(db.get('insosoe:v4:used:'+owner));assert.equal(one.freeAvailable,true);assert.equal(two.freeAvailable,true);assert.equal(one.purchase.ready,false);assert.equal(two.purchase.ready,false);
 assert.equal((await pay.getResult(owner,one.resultId)).access,'preview');assert.equal((await pay.getResult(owner,two.resultId)).access,'preview');
});
test('normal and production environments continue rejecting a second successful revision',async()=>{
 for(const cfg of [config({env:{...safeEnv,VERCEL_ENV:'production'}}),config({env:{...safeEnv,VERCEL_GIT_COMMIT_REF:'insosoe-analysis-qa-20261106'}}),config({env:{...safeEnv,PAYMENT_MODE:'test'}})]){
  const {pay}=service(cfg),owner='fake-owner';await pay.saveGeneratedResult(owner,randomUUID(),full());await assert.rejects(()=>pay.saveGeneratedResult(owner,randomUUID(),full()),e=>e.code==='FREE_ALREADY_USED');
 }
});

test('V4 review cap safely bounds escaped characters and supplementary Unicode',async()=>{
 const cfg={maxInputBytes:80000,inputRate:3,outputRate:15,provider:'mock',model:'mock'},source='가상 안내문을 만들었습니다. '+('😀"\\\n\t가'.repeat(680));
 const body={action:'revise',requestId:randomUUID(),product:'free',consent:true,consentProvider:'mock',consentModel:'mock',offerVersion:'v4-revision-3000',clientVersion:'simple-v4',originalText:source};
 const d=validateRevision(body),limits=revisionLimits(cfg,d),quote='가상 안내문',evidence=[{sourceId:'original',quote}];let calls=0;
 const ai=async(system,payload)=>{calls++;assert.ok(Buffer.byteLength(system+JSON.stringify(payload))<=limits.calls[calls-1].inputCap);if(calls===1)return {status:'ready',text:source,changes:[],diagnosis:[],warnings:[]};return {candidateDigest:payload.candidateDigest,checks:['fit','evidence','agency','causality','numbers','naturalness','length'].map(key=>({key,status:'pass',reason:'원문과 대조했습니다.',quote,evidence})),claims:[{quote,status:'supported',reason:'원문에 있습니다.',evidence}]};};
 const out=await runRevision(cfg,body,{ai});assert.equal(calls,2);assert.equal(out.sections[0].text,source);
});

test('minimal V5 branch cannot enable repeat without explicit approval',()=>{const o='https://kkumsu-git-insosoe-minimal-v5-20261107-kkkkkum.vercel.app',e={...safeEnv,VERCEL_GIT_COMMIT_REF:'insosoe-minimal-v5-20261107'};assert.equal(previewRepeat(config({origin:o,env:e})),false);assert.equal(previewRepeat(config({origin,env:e})),false);assert.equal(previewRepeat(config({origin:o,env:{...e,VERCEL_ENV:'production'}})),false);assert.equal(previewRepeat(config({origin:o,env:{...e,PAYMENT_MODE:'live'}})),false);});
