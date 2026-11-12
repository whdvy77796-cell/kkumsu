import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MemoryStore} from '../lib/guard.mjs';
import {recordAiBatch,readAiSummary,aiAccessPrefix,AI_ACCESS_LUA,AI_ACCESS_READ_LUA,DAILY_CAP,STORE_TTL,MAX_BATCH,REDIS_BATCH_SIZE} from '../lib/ai-access-core.mjs';
import {publicSummary} from '../api/ai-access.js';
const now=Date.parse('2026-11-08T03:00:00Z'),scope={namespace:'synthetic:preview:one'};
const hash=x=>createHash('sha256').update(String(x)).digest('hex');
const event=(n,over={})=>({id:hash(n),at:now,storeId:null,provider:'openai',purpose:'search',verification:'verified',...over});
const read=(store,over={})=>readAiSummary({store,scope,now,since:'2026-01-01T00:00:00Z',...over});
test('empty means not_started, not zero; exact shape and storage errors',async()=>{
 const s=new MemoryStore();assert.deepEqual(await read(s),{state:'not_started',since:null,updatedAt:null,lifetime:null,last7Days:null,breakdown:[]});assert.equal((await read(null)).state,'unavailable');
});
test('site/store, verified split, metadata, request dedupe, no cross namespace or raw leakage',async()=>{
 const s=new MemoryStore(),id='A'.repeat(22),events=[event(1,{storeId:id}),event(2,{verification:'unverified',provider:'anthropic',purpose:'training'})];
 await recordAiBatch({store:s,scope,events,now});await recordAiBatch({store:s,scope,events,now:now+1000});
 const a=await read(s);assert.deepEqual(a.lifetime,{verified:1,unverified:1});assert.equal(a.last7Days,null);assert.equal(a.updatedAt,new Date(now+1000).toISOString());assert.equal(a.breakdown.length,2);
 assert.deepEqual((await read(s,{storeId:id})).lifetime,{verified:1,unverified:0});
 await recordAiBatch({store:s,scope:{namespace:'other'},events,now});assert.deepEqual((await read(s)).lifetime,a.lifetime);
 assert.ok([...s.kv.keys()].every(k=>k.startsWith('yb:ai-access:v1:')));assert.equal(s.aiAccessExpiry.has(aiAccessPrefix(scope)+':site'),false);
 const values=JSON.stringify([...s.kv]);for(const forbidden of ['clientIp','userAgent','cookie','query','host','192.0.2.1'])assert.ok(!values.includes(forbidden));
 assert.equal(s.kv.get(aiAccessPrefix(scope)+':site').firstEventAt,now);
});
test('KST seven calendar days only when full coverage known, not rolling hours',async()=>{
 const s=new MemoryStore(),start=Date.parse('2026-11-01T14:59:59Z');await recordAiBatch({store:s,scope,events:[event(1,{at:start})],now:start});
 await recordAiBatch({store:s,scope,events:[event(2)],now});const a=await read(s);assert.deepEqual(a.lifetime,{verified:2,unverified:0});assert.deepEqual(a.last7Days,{verified:1,unverified:0});
});
test('store expires at 180 days and starts its own coverage, site never resets',async()=>{
 const s=new MemoryStore(),id='B'.repeat(22);await recordAiBatch({store:s,scope,events:[event(1,{storeId:id})],now});
 const later=now+(STORE_TTL+1)*1000;assert.equal((await read(s,{now:later,storeId:id})).state,'not_started');
 await recordAiBatch({store:s,scope,events:[event(2,{at:later,storeId:id})],now:later});const a=await read(s,{now:later,storeId:id});assert.equal(a.since,new Date(later).toISOString());assert.deepEqual(a.lifetime,{verified:1,unverified:0});assert.equal((await read(s,{now:later})).lifetime.verified,2);
});
test('strict sanitized event schema, batch bound, no partial invalid batch',async()=>{
 const s=new MemoryStore();for(const bad of [event(1,{userAgent:'x'}),event(1,{id:'raw'}),event(1,{storeId:'private'}),event(1,{provider:'evil'}),event(1,{purpose:'evil'}),event(1,{verification:'trusted'})])await assert.rejects(recordAiBatch({store:s,scope,events:[event(0),bad],now}));
 await assert.rejects(recordAiBatch({store:s,scope,events:Array(MAX_BATCH+1).fill(event(1)),now}));assert.equal(s.kv.size,0);
});
test('daily cap persists limited and stale replay cannot recount after dedupe expiry',async()=>{
 const s=new MemoryStore();for(let i=0;i<DAILY_CAP;i+=MAX_BATCH)await recordAiBatch({store:s,scope,events:Array.from({length:MAX_BATCH},(_,j)=>event(i+j)),now});
 await recordAiBatch({store:s,scope,events:[event(DAILY_CAP+1)],now});const a=await read(s);assert.equal(a.state,'limited');assert.equal(a.lifetime.verified,DAILY_CAP);
 const later=now+9*86400000;await recordAiBatch({store:s,scope,events:[event(0)],now:later});assert.equal((await read(s,{now:later})).lifetime.verified,DAILY_CAP);
});
test('Redis uses EVAL, declared isolated keys, aggregate/dedupe only and atomic cap',async()=>{
 const calls=[];const store={cmd:async args=>{calls.push(args);return JSON.stringify({accepted:1,duplicates:0,limited:false});}};await recordAiBatch({store,scope,events:[event(1)],now});
 const [op,script,count,...tail]=calls[0];assert.equal(op,'EVAL');assert.equal(script,AI_ACCESS_LUA);assert.equal(Number(count),5);assert.ok(tail.slice(0,5).every(k=>k.startsWith(aiAccessPrefix(scope))));assert.match(script,/HINCRBY/);assert.match(script,/EXPIRE/);assert.match(script,/total>=p.cap/);assert.match(script,/EXISTS.*k\[5\]/);assert.doesNotMatch(tail.at(-1),/userAgent|clientIp|cookie/);
});

test('late events extend counted since but never backdate seven-day receipt coverage',async()=>{
 const s=new MemoryStore(),old=now-6*86400000;
 await recordAiBatch({store:s,scope,events:[event(1,{at:old,storeId:'L'.repeat(22)})],now});
 const site=await read(s),shop=await read(s,{storeId:'L'.repeat(22)});
 assert.equal(site.since,new Date(old).toISOString());assert.equal(shop.since,site.since);assert.equal(site.last7Days,null);assert.equal(shop.last7Days,null);
 assert.equal(s.kv.get(aiAccessPrefix(scope)+':site').coverageSince,now);
});

// Protocol double executes the decoded plan against the synchronous MemoryStore
// semantics. This tests EVAL wiring/retry boundaries, NOT a real Lua interpreter.
function redisDouble(){
 const backing=new MemoryStore(),calls=[],readCalls=[];
 return {backing,calls,readCalls,corrupt:null,failBefore:0,loseAfter:0,async cmd(args){
  if(args[0]==='EVAL'&&args[1]===AI_ACCESS_READ_LUA){
   const n=Number(args[2]),keys=args.slice(3);readCalls.push(args);
   assert.equal(args.length,3+n);assert.equal(keys.length,n);assert.ok(n>=1&&n<=9);assert.equal(keys.length,new Set(keys).size);assert.ok(keys.every(k=>k.startsWith(aiAccessPrefix(scope)+':')));
   if(this.corrupt)return this.corrupt(keys);
   const out=keys.map(k=>{const exp=backing.aiAccessExpiry?.get(k);const h=exp!==undefined&&exp<=Date.now()?{}:backing.kv.get(k)||{};return Object.entries(h).flatMap(([a,v])=>[a,String(v)]);});
   return JSON.stringify(out.map(x=>x.length?x:{}));
  }
  assert.equal(args[0],'EVAL');assert.equal(args[1],AI_ACCESS_LUA);
  const n=Number(args[2]),keys=args.slice(3,3+n),p=JSON.parse(args[3+n]);
  calls.push({keys,p});assert.equal(keys.length,new Set(keys).size);assert.ok(p.events.length<=REDIS_BATCH_SIZE);
  assert.ok(keys.every(k=>k.startsWith(aiAccessPrefix(scope))));
  if(this.failBefore===calls.length)throw new Error('synthetic Redis unavailable');
  const events=p.events.map(e=>{
   assert.ok(e.k.every(i=>Number.isInteger(i)&&i>=1&&i<=keys.length));
   const [provider,purpose,verification]=e.field.split(':');
   return {id:keys[e.k[4]-1].split(':').at(-1),at:e.at,storeId:e.store?keys[e.k[2]-1].split(':').at(-1):null,provider,purpose,verification};
  });
  const result=await recordAiBatch({store:backing,scope,events,now:p.now});
  if(this.loseAfter===calls.length)throw new Error('synthetic lost committed response');
  return JSON.stringify(result);
 }};
}
test('501 events use six bounded EVALs with unique KEYS and preserve mixed stores/duplicates',async()=>{
 const redis=redisDouble(),memory=new MemoryStore(),events=Array.from({length:501},(_,i)=>event(i,{storeId:i%3===0?'A'.repeat(22):i%3===1?'B'.repeat(22):null,verification:i%2?'unverified':'verified'}));
 events[17]={...events[0]};
 for(let i=0;i<events.length;i+=MAX_BATCH){await recordAiBatch({store:redis,scope,events:events.slice(i,i+MAX_BATCH),now});await recordAiBatch({store:memory,scope,events:events.slice(i,i+MAX_BATCH),now});}
 assert.deepEqual(redis.calls.map(c=>c.p.events.length),[100,100,100,100,100,1]);
 assert.deepEqual(await read(redis),await read(memory));
 for(const storeId of ['A'.repeat(22),'B'.repeat(22)])assert.deepEqual(await read(redis,{storeId}),await read(memory,{storeId}));
 assert.equal((await read(redis)).lifetime.verified+(await read(redis)).lifetime.unverified,500);
});
test('lost response after committed Redis chunk is safely replayed without double counting',async()=>{
 const redis=redisDouble(),events=Array.from({length:250},(_,i)=>event('retry-'+i));redis.loseAfter=2;
 await assert.rejects(recordAiBatch({store:redis,scope,events,now}));assert.equal((await read(redis)).lifetime.verified,200);
 redis.loseAfter=0;const retried=await recordAiBatch({store:redis,scope,events,now});
 assert.equal(retried.accepted,50);assert.equal(retried.duplicates,200);assert.equal((await read(redis)).lifetime.verified,250);
});
test('Redis outage before a later chunk preserves prior commits and can be retried',async()=>{
 const redis=redisDouble(),events=Array.from({length:250},(_,i)=>event('before-'+i));redis.failBefore=2;
 await assert.rejects(recordAiBatch({store:redis,scope,events,now}));assert.equal((await read(redis)).lifetime.verified,100);
 redis.failBefore=0;await recordAiBatch({store:redis,scope,events,now});assert.equal((await read(redis)).lifetime.verified,250);
});
test('whole chunk type/numeric validation prevents an earlier event from partially committing',async()=>{
 for(const invalid of ['wrong-type',{verified:'01'},{verified:'nan'},{updatedAt:'bad'},{'google:training:verified':'-1'},{limited:'bad'}]){
  const s=new MemoryStore(),id='T'.repeat(22),key=aiAccessPrefix(scope)+':store:'+id;s.kv.set(key,invalid);
  const before=JSON.stringify([...s.kv]);
  await assert.rejects(recordAiBatch({store:s,scope,events:[event(1),event(2,{storeId:id})],now}));assert.equal(JSON.stringify([...s.kv]),before);
 }
 const s=new MemoryStore(),events=Array.from({length:101},(_,i)=>event('type-'+i,{storeId:i===100?'T'.repeat(22):null}));s.kv.set(aiAccessPrefix(scope)+':store:'+'T'.repeat(22),'wrong-type');
 await assert.rejects(recordAiBatch({store:s,scope,events,now}));assert.equal((await read(s)).lifetime.verified,100);
 s.kv.delete(aiAccessPrefix(scope)+':store:'+'T'.repeat(22));await recordAiBatch({store:s,scope,events,now});assert.equal((await read(s)).lifetime.verified,101);
});
test('daily cap across multiple events/stores leaves explicit zero lower bounds limited',async()=>{
 const s=new MemoryStore(),prefix=aiAccessPrefix(scope);s.kv.set(prefix+':day:2026-11-08',{verified:DAILY_CAP-1});
 const r=await recordAiBatch({store:s,scope,events:[event(1,{storeId:'A'.repeat(22)}),event(2,{storeId:'B'.repeat(22)})],now});
 assert.equal(r.accepted,1);assert.equal(r.limited,true);const limited=await read(s,{storeId:'B'.repeat(22)});assert.equal(limited.state,'limited');assert.deepEqual(limited.lifetime,{verified:0,unverified:0});assert.equal(limited.last7Days,null);
 const empty=new MemoryStore();await recordAiBatch({store:empty,scope,events:[event(3,{at:now-8*86400000,storeId:'C'.repeat(22)})],now});
 for(const storeId of [null,'C'.repeat(22),'Z'.repeat(22)]){const a=await read(empty,{storeId});assert.equal(a.state,'limited');assert.deepEqual(a.lifetime,{verified:0,unverified:0});assert.equal(a.last7Days,null);assert.equal(publicSummary(a).state,'limited');}
});
test('dedupe and store expiry remain equivalent through the Redis batch protocol',async()=>{
 const redis=redisDouble(),id='E'.repeat(22);await recordAiBatch({store:redis,scope,events:[event('ttl',{storeId:id})],now});
 assert.equal(redis.backing.aiAccessExpiry.get(aiAccessPrefix(scope)+':seen:'+hash('ttl')),now+8*86400000);
 assert.equal(redis.backing.aiAccessExpiry.get(aiAccessPrefix(scope)+':store:'+id),now+STORE_TTL*1000);
 const later=now+9*86400000;const r=await recordAiBatch({store:redis,scope,events:[event('ttl',{storeId:id})],now:later});assert.equal(r.limited,true);assert.equal((await read(redis,{now:later})).lifetime.verified,1);
});

test('Redis summary uses exactly one read-only EVAL, bounded to 9 unique owner-scoped keys, with parity',async()=>{
 const redis=redisDouble(),memory=new MemoryStore(),id='A'.repeat(22),other='O'.repeat(22);
 const early=now-2*86400000,events=[event(1,{at:early,storeId:id}),event(2,{storeId:id,verification:'unverified',provider:'google',purpose:'user'}),event(3,{storeId:other})];
 for(const st of [redis,memory])await recordAiBatch({store:st,scope,events,now});
 // Make coverage old enough for last7Days on both.
 for(const st of [redis.backing,memory])for(const [k,v] of st.kv)if(v&&typeof v==='object'&&k.includes(':site')||k.includes(':store:'+id)&&!k.includes(':day:')&&!k.includes(':seen:'))v.coverageSince=Date.parse('2026-01-01T00:00:00Z');
 for(const storeId of [null,id]){
  redis.readCalls.length=0;const a=await read(redis,{storeId}),b=await read(memory,{storeId});
  assert.deepEqual(a,b);assert.equal(redis.readCalls.length,1);assert.equal(redis.readCalls[0][2],String(storeId?9:8));
  assert.notEqual(a.last7Days,null);assert.equal(a.state,'active');
  assert.ok(!redis.readCalls[0].some(x=>typeof x==='string'&&x.includes(':store:'+other)));
 }
 redis.readCalls.length=0;const nodays=await read(redis,{since:'2026-11-08T00:00:00Z'});assert.equal(nodays.last7Days,null);assert.equal(redis.readCalls.length,1);assert.equal(redis.readCalls[0][2],'1');
 redis.readCalls.length=0;assert.equal((await read(redis,{storeId:'Z'.repeat(22)})).state,'not_started');assert.equal(redis.readCalls.length,1);
});
test('Redis summary preserves limited and not_started semantics in one EVAL',async()=>{
 const redis=redisDouble();await recordAiBatch({store:redis,scope,events:[event(3,{at:now-8*86400000,storeId:'C'.repeat(22)})],now});redis.readCalls.length=0;
 for(const storeId of [null,'C'.repeat(22),'Z'.repeat(22)]){const a=await read(redis,{storeId});assert.equal(a.state,'limited');assert.deepEqual(a.lifetime,{verified:0,unverified:0});assert.equal(a.last7Days,null);}
 assert.equal(redis.readCalls.length,3);
 assert.equal((await read(redisDouble())).state,'not_started');
});
test('malformed or corrupt Redis read replies are unavailable, never zero or partial',async()=>{
 const good=['verified','1','since',String(now),'coverageSince',String(now),'updatedAt',String(now)];
 const cases={
  notArray:()=>JSON.stringify({status:'unavailable'}),
  null:()=>null,
  badJson:()=>'{',
  wrongLength:keys=>JSON.stringify([good,...keys.slice(2).map(()=>[])]),
  oddFlat:()=>JSON.stringify([['verified']]),
  nonString:()=>JSON.stringify([['verified',1]]),
  duplicateField:()=>JSON.stringify([['verified','1','verified','2']]),
  negative:()=>JSON.stringify([['verified','-1']]),
  nan:()=>JSON.stringify([['verified','abc','since',String(now)]]),
  leadingZero:()=>JSON.stringify([['verified','01','since',String(now)]]),
  badLimited:()=>JSON.stringify([['verified','1','since',String(now),'updatedAt',String(now),'limited','x']]),
  badDay:keys=>JSON.stringify(keys.map((k,i)=>i===0?['verified','1','since','0','coverageSince','0','updatedAt',String(now)]:i===1?['verified','x']:[])),
 };
 for(const [name,corrupt] of Object.entries(cases)){
  const redis=redisDouble();redis.corrupt=corrupt;const a=await read(redis);
  assert.deepEqual(a,{state:'unavailable',since:null,updatedAt:null,lifetime:null,last7Days:null,breakdown:[]},name);
  assert.equal(redis.readCalls.length,1,name);
 }
 const throwing={cmd:async()=>{throw new Error('WRONGTYPE');}};assert.equal((await read(throwing)).state,'unavailable');
 assert.match(AI_ACCESS_READ_LUA,/HGETALL/);assert.doesNotMatch(AI_ACCESS_READ_LUA,/HSET|HINCRBY|EXPIRE|\bSET\b|DEL|redis\.call\('(?!HGETALL)/);
});
