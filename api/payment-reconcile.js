import {timingSafeEqual} from 'node:crypto';
import {settings,AppError,fail} from '../lib/core.mjs';
import {Store} from '../lib/store.mjs';
import {PaymentService} from '../lib/payments.mjs';
import {paymentHeaders,paymentError} from './payment.js';
export const config={maxDuration:90};
export function createReconcileHandler(deps={}){return async function(req,res){paymentHeaders(res);const send=(code,body)=>{res.statusCode=code;res.end(JSON.stringify(body));};try{
 const env=deps.env||process.env,secret=env.CRON_SECRET,provided=req.headers?.authorization;
 if(typeof secret!=='string'||secret.length<32)fail('RECONCILIATION_CONFIG','정산 확인 작업의 인증 설정이 필요합니다.',503);
 const expected='Bearer '+secret;
 if(typeof provided!=='string'||Buffer.byteLength(provided)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))fail('UNAUTHORIZED','인증이 필요합니다.',401);
 if(req.method!=='GET'){res.setHeader('Allow','GET');return send(405,{code:'METHOD',error:'지원하지 않는 방식입니다.',retryable:false});}
 // Server-to-server cron: no browser cookies or Origin/CSRF scheme, no input batch override.
 if(req.headers?.['sec-fetch-site']==='cross-site')fail('ORIGIN','브라우저 교차 사이트 요청은 지원하지 않습니다.',403);
 const c=settings(env),service=deps.service||new PaymentService(c,deps.store||new Store(c,deps.fetcher),deps);
 if(service.p.mode==='disabled')return send(200,{mode:'disabled',skipped:true});
 const report=await service.runReconciliation({limit:10});return send(report.failed?503:200,report);
 }catch(error){return send(error instanceof AppError?error.status:500,paymentError(error));}};}
export default createReconcileHandler();
