// Pure JavaScript contracts ONLY. These do not execute Redis or prove integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {accountKeys,newIncarnation,newOperationId,validCursor,boundedRetry,TRANSITIONS,BLOCKED,BEGIN_LUA,ACTIVE_GUARD_LUA} from '../lib/withdrawal-redis.mjs';
const tuple={accountId:'oa_'+'a'.repeat(43),provider:'google',origin:'https://synthetic.invalid',namespace:'synthetic:withdrawal'};
test('account-specific bounded keys; no global registry and one hash slot',()=>{
 const a=accountKeys(tuple),b=accountKeys({...tuple,accountId:'oa_'+'b'.repeat(43)});assert.notEqual(a.state,b.state);assert.equal(a.base.length,83);
 for(const k of [a.state,a.permit,a.worker,a.receipt,a.session(newIncarnation())])assert.ok(k.startsWith(a.base+':'));
 assert.throws(()=>accountKeys({...tuple,accountId:'bad'}));assert.throws(()=>accountKeys({...tuple,origin:'http://bad.invalid'}));
 assert.doesNotThrow(()=>accountKeys({...tuple,namespace:'한'.repeat(85)}));assert.throws(()=>accountKeys({...tuple,namespace:'한'.repeat(86)}));
});
test('incarnations and operation IDs are independent random opaque 256-bit values',()=>{
 const ids=new Set(Array.from({length:1000},()=>newIncarnation()));assert.equal(ids.size,1000);for(const v of ids)assert.match(v,/^[A-Za-z0-9_-]{43}$/);assert.ok(!ids.has(newOperationId()));
});
test('cursor remains uint64 decimal string, never JS number',()=>{
 for(const v of ['0','1','9007199254740993','18446744073709551615'])assert.equal(validCursor(v),true);
 for(const v of [0,9007199254740993,'01','-1','','18446744073709551616','1e3'])assert.equal(validCursor(v),false);
});
test('retries bounded at four and use unchanged raw password/owner proof',async()=>{
 const c={operationId:newOperationId(),verifiedRaw:' {"password":"synthetic"} ',incarnation:newIncarnation()};const original=structuredClone(c),seen=[];
 const result=await boundedRetry(c,async wire=>{seen.push(structuredClone(wire));wire.verifiedRaw='changed';return {status:'retry'};});
 assert.equal(result.status,'retry-exhausted');assert.equal(seen.length,4);for(const got of seen)assert.deepEqual(got,original);assert.deepEqual(c,original);
});
test('no automatic retry of unknown errors or changed proof',async()=>{
 let n=0;await assert.rejects(boundedRetry({},async()=>{n++;throw Error('indeterminate');}),/indeterminate/);assert.equal(n,1);
});
test('deleted and re-enrollment paths remain blocked, Redis TIME embedded',()=>{
 assert.deepEqual(TRANSITIONS.active,['deleting']);assert.deepEqual(TRANSITIONS.deleting,[]);assert.deepEqual(TRANSITIONS.deleted,[]);assert.ok(BLOCKED.includes('deleted-transition'));assert.ok(BLOCKED.includes('record-detach'));assert.match(ACTIVE_GUARD_LUA,/redis.call\('TIME'\)/);assert.match(BEGIN_LUA,/may cache TIME/);assert.match(BEGIN_LUA,/fence-exhausted/);
});
