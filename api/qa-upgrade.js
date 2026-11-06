// TEMPORARY PREVIEW-ONLY QA. Remove this route before merging to production.
// Reuses only the already-generated fictional case. No model call, arbitrary
// input, customer lookup, payment approval, or nonzero cost reservation.
import {timingSafeEqual} from 'node:crypto';
import fixture from '../QA_LIVE_CASE.json' with {type:'json'};
import recorded from '../QA_V3_LIVE_RESULT.json' with {type:'json'};
import {settings,identity,hmac,validate,AppError} from '../lib/core.mjs';
import {Store} from '../lib/store.mjs';
import {PaymentService} from '../lib/payments.mjs';

export default async function qa(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Referrer-Policy','no-referrer');
 const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
 if(process.env.VERCEL_ENV!=='preview')return send(404,{code:'NOT_FOUND'});
 const secret=process.env.INSOSOE_QA_SECRET||'',actual=String(req.headers.authorization||''),expected='Bearer '+secret;
 if(secret.length<32||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return send(401,{code:'UNAUTHORIZED'});
 if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{code:'METHOD'});}
 let reservation,store;
 try{
  const c=settings(process.env);if(!c.origin||req.headers.origin!==c.origin)return send(403,{code:'ORIGIN'});
  if(recorded.scope!=='FIXED_SYNTHETIC_CASE_NOT_REAL_APPLICANT'||recorded.status!==200||recorded.data?.scope!=='FIXED_SYNTHETIC_CASE_ONLY')throw new Error('Invalid fixed fixture');
  const data=validate(JSON.parse(JSON.stringify(fixture.request))),sid=identity(req,res,c);store=new Store(c);const payments=new PaymentService(c,store);payments.requireStorage();
  reservation=await store.reserve(sid,hmac(c.secret,'ip:preview-fixed-fixture-replay'),data,0);
  if(reservation.cached)return send(200,{scope:'FIXED_SYNTHETIC_REPLAY_NO_NEW_AI',result:await payments.getPublicResult(sid,reservation.cached.resultId),additionalModelCalls:0,reservedCostMicros:0});
  const result=await payments.saveGeneratedResult(sid,data.requestId,JSON.parse(JSON.stringify(recorded.data.syntheticFullResult)));
  await store.finish(reservation,'done',result,'generate',0);reservation=null;
  return send(200,{scope:'FIXED_SYNTHETIC_REPLAY_NO_NEW_AI',result,additionalModelCalls:0,reservedCostMicros:0});
 }catch(e){if(reservation&&!reservation.cached)try{await store.finish(reservation,'failed',null,'generate',0);}catch{}return send(e instanceof AppError?e.status:500,{code:e instanceof AppError?e.code:'QA_FAILED'});}
}
