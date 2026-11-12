import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHmac} from 'node:crypto';
import {createHandler,config,RAW_LIMIT,MAX_ROWS,validDedicatedRedis} from '../api/ai-access-ingest.js';
import {MemoryStore} from '../lib/guard.mjs';
import {readAiSummary} from '../lib/ai-access-core.mjs';
import {requestScope} from '../lib/stores.mjs';
const now=Date.parse('2026-11-08T03:00:00Z'),host='synthetic.vercel.app';
const env={YB_AI_ACCESS_ENABLED:'true',YB_AI_ACCESS_DRAIN_SECRET:'synthetic-secret-012345678901234567890123',YB_AI_ACCESS_PROJECT_ID:'prj_synthetic',YB_AI_ACCESS_STARTED_AT:'2026-11-01T00:00:00Z',VERCEL_ENV:'preview'};
const bot={bot:'synthetic',provider:'openai',purpose:'search',verification:'unverified'};
const row=(over={},proxy={})=>({id:'log-not-request',source:'static',host,projectId:env.YB_AI_ACCESS_PROJECT_ID,environment:'preview',...over,proxy:{host,timestamp:now,method:'GET',statusCode:200,path:'/',vercelId:'synthetic::request-00001',userAgent:['synthetic-bot'],clientIp:'192.0.2.1',...proxy}});
async function run(rows=[row()],opts={}){
 const raw=Buffer.isBuffer(rows)?rows:Buffer.from(typeof rows==='string'?rows:JSON.stringify(rows));
 const headers={host:opts.host||host,'content-type':'application/json','x-vercel-signature':createHmac('sha1',env.YB_AI_ACCESS_DRAIN_SECRET).update(opts.signedRaw??raw).digest('hex'),...opts.headers};
 const req=Readable.from([raw]);req.method=opts.method||'POST';req.headers=headers;if(opts.parsed)req.body=JSON.parse(raw);if(opts.lazyGetter)Object.defineProperty(req,'body',{get(){throw new Error('must not read parsed body');}});
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(x){this.body=x;}};
 const store=opts.store||new MemoryStore();let classified=0;
 await createHandler({env:{...env,...opts.env},store:opts.noStore?undefined:store,now,identifyBot:async()=>{classified++;return opts.unknown?null:bot;},...opts.deps})(req,res);
 return {res,store,classified};
}
const summary=s=>readAiSummary({store:s,scope:requestScope({headers:{host}},env),now,since:env.YB_AI_ACCESS_STARTED_AT});
test('parser disabled; exact HMAC including whitespace and no pre-parsed body',async()=>{
 assert.equal(config.api.bodyParser,false);assert.equal((await run(' [ ] ')).res.statusCode,200);
 assert.equal((await run(' [ ] ',{lazyGetter:true})).res.statusCode,200);
 assert.equal((await run(' [ ] ',{lazyGetter:true,headers:{'x-vercel-signature':'0'.repeat(40)}})).res.statusCode,403);
 assert.equal((await run(' [ ] ',{signedRaw:Buffer.from('[]')})).res.statusCode,403);assert.equal((await run([row()],{parsed:true})).res.statusCode,503);
 for(const signature of [undefined,'bad','0'.repeat(40)])assert.equal((await run([row()],{headers:{'x-vercel-signature':signature}})).res.statusCode,403);
});
test('closed config, POST, JSON, size/row bounds and isolated KV only',async()=>{
 for(const change of [{YB_AI_ACCESS_DRAIN_SECRET:'short'},{YB_AI_ACCESS_PROJECT_ID:''},{YB_AI_ACCESS_STARTED_AT:'2026-02-30T00:00:00Z'},{YB_AI_ACCESS_STARTED_AT:'2026-11-01'},{YB_AI_ACCESS_STARTED_AT:'2027-01-01T00:00:00Z'}])assert.equal((await run([],{env:change})).res.statusCode,503);
 assert.equal((await run([],{env:{YB_AI_ACCESS_ENABLED:'false'}})).res.statusCode,404);
 assert.equal((await run([],{method:'GET'})).res.statusCode,405);assert.equal((await run([],{headers:{'content-type':'application/json; charset=utf-8'}})).res.statusCode,200);
 assert.equal((await run(Buffer.alloc(RAW_LIMIT+1,32))).res.statusCode,503);assert.equal((await run(Array(MAX_ROWS+1).fill({}))).res.statusCode,503);
 assert.equal((await run([],{noStore:true,env:{KV_REST_API_URL:'https://main.example',KV_REST_API_TOKEN:'synthetic-main-token'}})).res.statusCode,503);
});
test('no session or browser header can spoof intake; signed requests need no session',async()=>{
 const good=await run();assert.equal(good.res.statusCode,200);assert.deepEqual((await summary(good.store)).lifetime,{verified:0,unverified:1});
 const bad=await run([row()],{headers:{cookie:'owner-session=synthetic','origin':'https://'+host,'x-vercel-signature':undefined}});assert.equal(bad.res.statusCode,403);assert.equal(bad.store.kv.size,0);
});
test('wrong project/host/environment, private paths, failure statuses, WAF and missing request IDs excluded',async()=>{
 const invalid=[row({projectId:'wrong'}),row({environment:'production'}),row({}, {host:'other.example'}),row({}, {method:'POST'}),row({}, {statusCode:404}),row({}, {statusCode:299.1}),...['deny','challenge','rate_limit'].map(wafAction=>row({}, {wafAction})),...['/api/private','/stores/abc','//stores','/stores/../api/private','/%73tores','/stores/','/stores#private'].map(path=>row({}, {path})),row({}, {vercelId:undefined}),row({}, {vercelId:'a'}),row({}, {timestamp:now+300001}),row({}, {timestamp:Date.parse(env.YB_AI_ACCESS_STARTED_AT)-1})];
 const r=await run(invalid);assert.equal(r.res.statusCode,200);assert.equal(r.classified,0);assert.equal((await summary(r.store)).state,'not_started');
});
test('duplicates use request ID not per-log ID, query ignored, public directory/store accepted',async()=>{
 const id='S'.repeat(22),rows=[row(),row({id:'different-log-id'}),row({}, {vercelId:'synthetic::request-2',path:'/stores?private=query'}),row({}, {vercelId:'synthetic::request-3',path:'/stores/'+id+'?secret=not-saved'})];
 const r=await run(rows);assert.equal(r.res.statusCode,200);assert.equal((await summary(r.store)).lifetime.unverified,3);
 const persisted=JSON.stringify([...r.store.kv]);for(const raw of ['192.0.2.1','synthetic-bot','not-saved','different-log-id','synthetic::request','private=query'])assert.ok(!persisted.includes(raw));
 const unknown=await run([row()],{unknown:true});assert.equal(unknown.store.kv.size,0);
});
test('signed proxy host accepts documented deployment host discrepancy and only confirmed production aliases',async()=>{
 const deploy='kkumsu-example-deployment.vercel.app';
 const preview=await run([row({host:deploy},{vercelId:'synthetic::preview-host'})]);assert.equal((await summary(preview.store)).lifetime.unverified,1);
 const aliases=['www.kkumsu.com','www.kkumsu.net','kkumsu-rho.vercel.app','evil.example'];
 const rows=aliases.map((h,i)=>row({host:deploy,environment:'production'},{host:h,vercelId:'synthetic::prod-'+i}));
 const prod=await run(rows,{host:'www.kkumsu.com',env:{VERCEL_ENV:'production'}});
 const scope=requestScope({headers:{host:'www.kkumsu.com'}},{...env,VERCEL_ENV:'production'});
 assert.equal(prod.res.statusCode,200);assert.equal((await readAiSummary({store:prod.store,scope,now,since:env.YB_AI_ACCESS_STARTED_AT})).lifetime.unverified,3);
});

test('storage/classification failure is generic with no payload disclosure, signed malformed JSON not accepted',async()=>{
 const r=await run([row()],{deps:{recordBatch:async()=>{throw new Error('secret 192.0.2.1');}}});assert.equal(r.res.statusCode,503);assert.equal(r.res.body,'{"error":"Unavailable"}');
 assert.equal((await run('{')).res.statusCode,503);
});

test('documented byte-sized batches over 500 rows are fully processed in bounded chunks; retry idempotent',async()=>{
 const rows=Array.from({length:501},(_,i)=>row({id:'log-'+i},{vercelId:'synthetic::batch-'+i}));
 const r=await run(rows);assert.equal(r.res.statusCode,200);assert.equal((await summary(r.store)).lifetime.unverified,501);
 const again=await run(rows,{store:r.store});assert.equal(again.res.statusCode,200);assert.equal((await summary(r.store)).lifetime.unverified,501);
});

test('missing IP still reaches classifier and counts unverified',async()=>{
 let observed;const r=await run([row({}, {clientIp:undefined})],{deps:{identifyBot:async args=>{observed=args;return bot;}}});
 assert.equal(r.res.statusCode,200);assert.equal(observed.clientIp,null);assert.equal((await summary(r.store)).lifetime.unverified,1);
});
test('dedicated Redis rejects main endpoints and unsafe URL components',()=>{
 const dedicated={YB_AI_ACCESS_REDIS_URL:'https://telemetry.example',YB_AI_ACCESS_REDIS_TOKEN:'synthetic'};
 assert.equal(validDedicatedRedis(dedicated),true);
 for(const url of ['http://telemetry.example','https://user:password@telemetry.example','https://telemetry.example?token=bad','https://telemetry.example#bad','not-url'])assert.equal(validDedicatedRedis({...dedicated,YB_AI_ACCESS_REDIS_URL:url}),false);
 for(const key of ['KV_REST_API_URL','UPSTASH_REDIS_REST_URL'])assert.equal(validDedicatedRedis({...dedicated,[key]:'https://TELEMETRY.example:443/'}),false);
});

test('optional UTF-8 JSON charset preserves raw signature checks and rejects other media types',async()=>{
 for(const contentType of ['application/json; charset=utf-8','Application/JSON; Charset="UTF-8"']){
  assert.equal((await run(' [ ] ',{headers:{'content-type':contentType}})).res.statusCode,200);
  assert.equal((await run(' [ ] ',{signedRaw:Buffer.from('[]'),headers:{'content-type':contentType}})).res.statusCode,403);
 }
 for(const contentType of ['text/json','application/json; charset=iso-8859-1','application/json; charset=utf-8; extra=1','application/json, text/plain'])assert.equal((await run([],{headers:{'content-type':contentType}})).res.statusCode,415);
});

test('only static/lambda sources qualify even when other signed sources include successful proxy fields',async()=>{
 const forbidden=[undefined,null,'firewall','edge','build','external','redirect','unknown','STATIC'];
 const rejected=await run(forbidden.map((source,i)=>row({source},{vercelId:'synthetic::rejected-'+i})));
 assert.equal(rejected.res.statusCode,200);assert.equal(rejected.classified,0);assert.equal(rejected.store.kv.size,0);
 const accepted=await run(['static','lambda'].map((source,i)=>row({source},{vercelId:'synthetic::accepted-'+i})));
 assert.equal(accepted.res.statusCode,200);assert.equal((await summary(accepted.store)).lifetime.unverified,2);
});
