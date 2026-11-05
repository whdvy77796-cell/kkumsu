import {settings,AppError} from '../lib/core.mjs';
import {Store} from '../lib/store.mjs';
import {PaymentService} from '../lib/payments.mjs';
import {paymentHeaders,paymentBody,paymentError} from './payment.js';
// Payment events are untrusted lookup hints, NOT authenticated grants.
// Do not apply browser Origin/CSRF checks to server-to-server notifications.
// The payout HMAC scheme is not a PAYMENT_STATUS_CHANGED signature scheme.
export function createWebhookHandler(deps={}){return async function(req,res){paymentHeaders(res);const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};try{if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{code:'METHOD',error:'POST만 지원합니다.',retryable:false});}const c=settings(deps.env||process.env),service=deps.service||new PaymentService(c,deps.store||new Store(c,deps.fetcher),deps);const body=await paymentBody(req,64000);return send(200,await service.webhook(body));}catch(e){return send(e instanceof AppError?e.status:500,paymentError(e));}};}
export default createWebhookHandler();
