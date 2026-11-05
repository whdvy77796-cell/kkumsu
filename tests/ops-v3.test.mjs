import test from 'node:test';
import assert from 'node:assert/strict';
import {createReconcileHandler} from '../api/payment-reconcile.js';
const secret='fake-cron-secret-for-isolated-unit-tests-only';
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},end(x){this.body=JSON.parse(x);}});
test('disabled payment reconciliation is an authenticated no-op without provider calls',async()=>{let called=0;const h=createReconcileHandler({env:{CRON_SECRET:secret},service:{p:{mode:'disabled'},runReconciliation:async()=>{called++;throw Error();}}}),r=response();await h({method:'GET',headers:{authorization:'Bearer '+secret}},r);assert.equal(r.statusCode,200);assert.equal(r.body.skipped,true);assert.equal(called,0);});
test('payment reconciliation is GET-only even with valid authentication',async()=>{for(const method of ['POST','HEAD','DELETE']){const h=createReconcileHandler({env:{CRON_SECRET:secret},service:{get p(){throw Error('Service must not be reached');}}}),r=response();await h({method,headers:{authorization:'Bearer '+secret}},r);assert.equal(r.statusCode,405);assert.equal(r.headers.Allow,'GET');}});
test('cron authentication happens before disabled mode or any service access',async()=>{const h=createReconcileHandler({env:{CRON_SECRET:secret},service:{get p(){throw Error('Service must not be reached');}}}),r=response();await h({method:'GET',headers:{authorization:'Bearer invalid'}},r);assert.equal(r.statusCode,401);assert.ok(!JSON.stringify(r.body).includes(secret));});
