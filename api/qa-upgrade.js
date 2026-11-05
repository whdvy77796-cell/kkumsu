// TEMPORARY PREVIEW-ONLY QA. Remove this route before merging to production.
// The only input is the committed, explicitly fictional QA_LIVE_CASE fixture.
// It runs the ordinary API + budget + storage code and returns its own fictional
// result to the authenticated operator, never arbitrary stored customer content.
import {timingSafeEqual} from 'node:crypto';
import fixture from '../QA_LIVE_CASE.json' with {type:'json'};
import {settings} from '../lib/core.mjs';
import {Store} from '../lib/store.mjs';
import {PaymentService} from '../lib/payments.mjs';
import {createHandler} from './insosoe.js';
export default async function qa(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Referrer-Policy','no-referrer');
 const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
 if(process.env.VERCEL_ENV!=='preview')return send(404,{code:'NOT_FOUND'});
 const secret=process.env.INSOSOE_QA_SECRET||'',actual=String(req.headers.authorization||''),expected='Bearer '+secret;
 if(secret.length<32||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return send(401,{code:'UNAUTHORIZED'});
 if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{code:'METHOD'});}
 try{
  const c=settings(process.env),store=new Store(c),payments=new PaymentService(c,store);
  let captured;
  const save=payments.saveGeneratedResult.bind(payments);
  payments.saveGeneratedResult=async(sid,id,full)=>{const preview=await save(sid,id,full);captured=full;return preview;};
  const shim={statusCode:200,setHeader:(...args)=>res.setHeader(...args),getHeader:(...args)=>res.getHeader(...args),end(body){res.statusCode=this.statusCode;res.end(JSON.stringify({scope:'FIXED_SYNTHETIC_CASE_ONLY',fixture:fixture.label,source:fixture.source,publicResponse:JSON.parse(body),...(captured?{syntheticFullResult:captured}:{})}));}};
  const input={method:'POST',url:req.url,headers:req.headers,socket:req.socket,body:JSON.parse(JSON.stringify(fixture.request))};
  await createHandler({env:process.env,store,payments})(input,shim);
 }catch{return send(500,{code:'QA_FAILED',message:'검증 요청을 완료하지 못했습니다.'});}
}
