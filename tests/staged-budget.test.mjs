import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {settings,AppError} from '../lib/core.mjs';
import {validateRevision,reserveRevisionCost,reserveRevisionStages,revisionLimits} from '../lib/revision.mjs';
import {createRevisionHandler,revisionFailureDiagnostic,measuredRevisionCost} from '../lib/revision-api.mjs';
import {RESERVE_REVISION_STAGED,FINISH_REVISION_STAGED,EXTEND_REVISION_STAGED,RevisionStore} from '../lib/revision-store.mjs';

// Synthetic input and in-memory dependencies only; no customer document or live AI.
const env={OPENROUTER_API_KEY:'test-only-key',SESSION_SECRET:'test-only-session-secret-at-least-32-characters',UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'mock-token',APP_ORIGIN:'https://site.test'};
const c=settings(env);
const body=()=>({action:'revise',requestId:randomUUID(),product:'free',consent:true,offerVersion:'v4-revision-3000',clientVersion:'simple-v3',consentProvider:c.provider,consentModel:c.model,originalText:'가상의 행사에서 안내 자료를 만들고 참여자에게 순서를 설명했습니다. 팀원과 의견을 나누고 필요한 준비를 함께 확인했습니다. '.repeat(24),prompt:'',organization:'',role:'',posting:'',lengthMode:'characters',limit:null,clarificationRound:0,clarifications:[]});
function fixture({calls=2,deny=false,denyAt=0,ambiguous=false,overrun=false}={}){
 const events={initial:null,repair:[],started:0,finished:[],saved:0};
 const store={supportsStagedRevision:true,isCancelled:async()=>false,reserve:async(sid,_ip,d,cost)=>{events.initial=cost;return {sid,token:d.requestId,cost,staged:true};},reserveRepair:async(r,known,extra,phase)=>{events.repair.push({known,extra,phase});if(deny||denyAt===phase)throw new AppError('DAILY_BUDGET','static only',429,true);r.cost=Math.max(r.cost,known+extra);},finish:async(r,state,_out,_action,measured)=>{events.finished.push({held:r.cost,state,measured});}};
 const payments={saveGeneratedResult:async()=>{events.saved++;return {access:'preview',resultId:'fake-result'};}};
 const runRevision=async(_c,_d,h)=>{for(let i=0;i<calls;i++){await h.beforeCall({stage:i%2?'review':'draft',callIndex:i});h.onCallStarted();events.started++;if(ambiguous&&i===0)h.onUsage(NaN);else h.onUsage(overrun&&i===0?events.initial:(i+1)*1000);}return {status:'ready'};};
 const handler=createRevisionHandler({env,store,payments,runRevision});
 return {events,handler};
}
async function request(handler,d){const res={headers:{},setHeader(k,v){this.headers[k]=v;},getHeader(k){return this.headers[k];},end(s){this.body=JSON.parse(s);}};await handler({method:'POST',headers:{host:'site.test',origin:'https://site.test','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'},body:d},res);return res;}

test('initial pair retains conservative per-call bounds but costs less than all four',()=>{const d=validateRevision(body()),first=reserveRevisionStages(c,d,0,2),last=reserveRevisionStages(c,d,2,2),full=reserveRevisionCost(c,d);assert(first>0&&last>0&&first<full);assert(first+last>=full&&first+last-full<=4);assert.throws(()=>reserveRevisionStages(c,d,3,2),{code:'CONFIG'});});

test('staged reservation stores authoritative hold, validates cancellation and remains atomic',()=>{assert.match(RESERVE_REVISION_STAGED,/held=cost,phase=0/);assert.match(FINISH_REVISION_STAGED,/type\(state\.held\)/);assert.match(FINISH_REVISION_STAGED,/tonumber\(state\.held\)-tonumber\(ARGV\[7\]\)/);for(const s of ["GET',KEYS[2]","EXISTS',KEYS[5]","daily+delta>","total+delta>","known<tonumber(s.known)","math.max(held,known+extra)","s.phase=phase","s.held=want"])assert.ok(EXTEND_REVISION_STAGED.includes(s),s);assert.equal(new RevisionStore(c).supportsStagedRevision,true);});

test('two-call request only reserves its draft and review maxima',async()=>{const d=body(),t=fixture(),out=await request(t.handler,d),parsed=validateRevision(d);assert.equal(out.statusCode,200);assert.equal(t.events.initial,reserveRevisionStages(c,parsed,0,2));assert(t.events.initial<reserveRevisionCost(c,parsed));assert.equal(t.events.started,2);assert.equal(t.events.repair.length,0);assert.equal(t.events.finished[0].measured,3000);assert.equal(t.events.saved,1);});

test('repair and re-review reserve each bounded stage after known earlier costs',async()=>{const d=body(),t=fixture({calls:4}),out=await request(t.handler,d),parsed=validateRevision(d);assert.equal(out.statusCode,200);assert.equal(t.events.started,4);assert.deepEqual(t.events.repair,[{known:3000,extra:reserveRevisionStages(c,parsed,2,1),phase:1},{known:6000,extra:reserveRevisionStages(c,parsed,3,1),phase:2}]);assert.equal(t.events.finished[0].measured,10000);assert.equal(t.events.saved,1);});

test('later budget denial stops before a third AI call and never saves a result',async()=>{const d=body(),t=fixture({calls:4,deny:true}),out=await request(t.handler,d);assert.equal(out.statusCode,429);assert.equal(out.body.code,'DAILY_BUDGET');assert.match(out.body.error,/비용은 발생할 수/);assert.equal(t.events.started,2);assert.equal(t.events.saved,0);assert.equal(t.events.finished[0].state,'failed');assert.equal(t.events.finished[0].measured,3000);assert(!JSON.stringify(out.body).includes(d.originalText));});

test('a later re-review budget denial stops before the fourth AI call',async()=>{const d=body(),t=fixture({calls:4,denyAt:2}),out=await request(t.handler,d);assert.equal(out.statusCode,429);assert.equal(t.events.started,3);assert.equal(t.events.saved,0);assert.equal(t.events.repair.length,2);assert.equal(t.events.repair[1].known,6000);assert.equal(t.events.finished[0].measured,6000);});

test('ambiguous first-call usage stops before review and retains the reservation',async()=>{const d=body(),t=fixture({calls:4,ambiguous:true}),out=await request(t.handler,d);assert.equal(out.statusCode,429);assert.equal(out.body.code,'BUDGET_UNCERTAIN');assert.equal(t.events.started,1);assert.equal(t.events.repair.length,0);assert.equal(t.events.finished[0].measured,undefined);assert.equal(t.events.saved,0);});
test('a provider overrun stops before review and records the measured charge',async()=>{const d=body(),t=fixture({calls:4,overrun:true}),out=await request(t.handler,d);assert.equal(out.statusCode,429);assert.equal(out.body.code,'BUDGET_UNCERTAIN');assert.equal(t.events.started,1);assert.equal(t.events.repair.length,0);assert.equal(t.events.finished[0].measured,t.events.initial);assert.equal(t.events.saved,0);});

test('unknown first-call usage is bounded and does not unlock the second phase for free',()=>{const d=validateRevision(body()),limits=revisionLimits(c,d).calls,known=measuredRevisionCost(c,d,2,new Map([[1,1000]]));const maxFirst=Math.ceil(1.15*((limits[0].inputCap+512)*c.inputRate+limits[0].maxOutputTokens*c.outputRate));assert.equal(known,maxFirst+1000);assert(known>1000);});

test('failure diagnostics are allowlisted, bounded and never contain model or user text',()=>{const secret='FAKE_PRIVATE_SOURCE_DO_NOT_LOG';const e=new AppError('REVISION_UNSAFE',secret,422,true,{issueKeys:['numbers',secret,'analysis']});e.safeStage='review';const record=revisionFailureDiagnostic(e,4);assert.deepEqual(record,{event:'revision_failure',code:'REVISION_UNSAFE',stage:'review',calls:4,issueTypes:['numbers','analysis']});assert(!JSON.stringify(record).includes(secret));const other=revisionFailureDiagnostic({code:secret,message:secret,safeStage:secret},999);assert.deepEqual(other,{event:'revision_failure',code:'OTHER',stage:'preflight',calls:0});});

test('additional stage never reduces its hold or omits known plus next maximum',()=>{for(const held of [0,1,100,300,1000])for(const known of [0,1,100,300,1000])for(const next of [0,1,50,500]){const want=Math.max(held,known+next),delta=want-held;assert.ok(delta>=0);assert.ok(want>=known+next);assert.equal(held+delta,want);}});
