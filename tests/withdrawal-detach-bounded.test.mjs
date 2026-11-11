// EXPERIMENT ONLY. Synthetic pure tests + opt-in disposable LOOPBACK Redis.
// node --test tests/withdrawal-detach.test.mjs
// WITHDRAWAL_TEST_REDIS_ACK=synthetic-only WITHDRAWAL_TEST_REDIS_PORT=16379
// No production env or REST URLs used, no FLUSHDB. Redis tests SKIP by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {detachReplacement,createDetachAdapter,DETACH_LUA} from '../lib/withdrawal-detach-bounded-experiment.mjs';
import {accountKeys,newIncarnation,newOperationId,BEGIN_LUA} from '../lib/withdrawal-redis.mjs';
import {rawObjectMembers,patchRawObject} from '../lib/guard.mjs';
const tuple={accountId:'oa_'+newIncarnation(),provider:'google',origin:'https://synthetic.invalid',namespace:'synthetic:detach:'+newOperationId()};
const inc=newIncarnation(),binding=newIncarnation(),workerBinding=newIncarnation(),op=newOperationId();
const k=accountKeys(tuple),sessionKey=k.session(newIncarnation()),id='a'.repeat(22),recordKey=tuple.namespace+':record:'+id;
const p={...tuple,incarnation:inc,operationId:op,fence:2,binding,workerBinding,sessionKey,recordKey,expectedRevision:'a'.repeat(32),revision:'b'.repeat(32)};
function raw(extra={}){return JSON.stringify({id,revision:p.expectedRevision,ownerAccountId:tuple.accountId,ownerIncarnation:inc,ownerNamespace:tuple.namespace,ownerOrigin:tuple.origin,ownerProvider:tuple.provider,password:{salt:'old\\salt',hash:'original'},data:{sections:[],faqs:{},intro:'한글 😀'},publicUrl:'https://synthetic.invalid/s/'+id,expiresAt:null,...extra});}
const segment=(s,key)=>{const m=rawObjectMembers(s).members.get(key);return s.slice(m.first,m.last);};
test('165k legacy JSON bytes retained, only explicit owner fields and revision change',()=>{
 const s=raw({blob:'x'.repeat(165000)}).replace('"blob":','"unknown":{"n":900719925474099312345,"z":-0,"e":1.2300e+99,"arr":[],"obj":{},"escaped":"a\\/b\\u0061","dupe":{"x":1,"x":2}},"blob":');
 const next=detachReplacement(s,p);const old=rawObjectMembers(s),now=rawObjectMembers(next);
 for(const key of old.members.keys()){if(key.startsWith('owner')||key==='revision')continue;assert.equal(segment(next,key),segment(s,key),key);}
 assert.equal(now.value.revision,p.revision);assert.equal(now.value.ownerAccountId,undefined);assert.equal(now.value.ownerIncarnation,undefined);assert.ok(s.length>165000);
});
test('legacy accountId without incarnation fails closed; detached cannot be silently adopted',()=>{
 assert.throws(()=>detachReplacement(patchRawObject(raw(),{ownerIncarnation:undefined}),p),/OWNERSHIP_MISSING/);
 assert.throws(()=>detachReplacement(detachReplacement(raw(),p),{...p,expectedRevision:p.revision,revision:'c'.repeat(32)}),/OWNERSHIP_MISSING/);
});
test('every explicit ownership dimension required and exactly equal',()=>{
 for(const name of ['accountId','incarnation','namespace','origin','provider'])assert.throws(()=>detachReplacement(raw(),{...p,[name]:'different'}),/OWNERSHIP_MISMATCH/);
});
test('hidden is preserved; deleted tombstone, duplicate roots, huge/deep raw blocked',()=>{
 const s=raw({hidden:true});assert.equal(segment(detachReplacement(s,p),'hidden'),'true');
 assert.throws(()=>detachReplacement(raw({deleted:true}),p),/RECORD_UNSAFE/);
 assert.throws(()=>detachReplacement(raw({data:[]}),p),/RECORD_UNSAFE/);
 assert.throws(()=>detachReplacement(raw({password:[]}),p),/RECORD_UNSAFE/);
 assert.throws(()=>detachReplacement(raw().replace('{','{"revision":"x",'),p),/RAW_UNSAFE/);
 assert.throws(()=>detachReplacement(raw({blob:'x'.repeat(1048576)}),p),/RAW_UNSAFE/);
 assert.throws(()=>detachReplacement(raw().replace('"expiresAt":null','"expiresAt":null,"deep":'+'['.repeat(130)+'0'+']'.repeat(130)),p),/RAW_UNSAFE/);
});
test('escaped names, adjacent owner removals and trailing owner property retain valid JSON',()=>{
 const s=raw().replace('"ownerAccountId"','"owner\\u0041ccountId"');assert.equal(JSON.parse(detachReplacement(s,p)).id,id);
 const r=JSON.parse(raw());const last=r.ownerProvider;delete r.ownerProvider;r.ownerProvider=last;assert.equal(JSON.parse(detachReplacement(JSON.stringify(r),p)).id,id);
});
test('server adapter rejects client replacement, stale proof, and never retries uncertain EVAL',async()=>{
 const s=raw();let calls=0;
 const malicious=createDetachAdapter({command:async()=>{calls++;},verifyRequestSnapshot:async()=>({...p,verifiedRaw:s,replacementRaw:'{}'})});
 await assert.rejects(()=>malicious({}),/UNTRUSTED_REPLACEMENT/);assert.equal(calls,0);
 const stale=createDetachAdapter({command:async()=>{calls++;return s+' ';},verifyRequestSnapshot:async()=>({...p,verifiedRaw:s})});
 assert.equal((await stale({})).status,'conflict');assert.equal(calls,1);
 calls=0;const uncertain=createDetachAdapter({command:async c=>{calls++;if(c[0]==='GET')return s;throw Error('timeout');},verifyRequestSnapshot:async()=>({...p,verifiedRaw:s})});
 const r=await uncertain({});assert.equal(r.status,'indeterminate');assert.equal(r.retry,false);assert.equal(calls,2);
});
function parse(b,at=0){const end=b.indexOf('\r\n',at);if(end<0)return null;const type=String.fromCharCode(b[at]),text=b.subarray(at+1,end).toString(),pos=end+2;
 if(type==='+')return {value:text,end:pos};if(type==='-')return {error:Error(text),end:pos};if(type===':')return {value:Number(text),end:pos};
 if(type==='$'){const n=Number(text);if(n===-1)return {value:null,end:pos};if(b.length<pos+n+2)return null;return {value:b.subarray(pos,pos+n).toString(),end:pos+n+2};}
 if(type==='*'){const n=Number(text);let next=pos;const value=[];for(let i=0;i<n;i++){const r=parse(b,next);if(!r)return null;if(r.error)return r;value.push(r.value);next=r.end;}return {value,end:next};}throw Error('RESP');}
// This isolated optimization task MUST NOT connect to Redis, even with ambient env.
const enabled=false,port=Number.NaN;
function cmd(...args){return new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port});let data=Buffer.alloc(0),done=false;const finish=(e,v)=>{if(done)return;done=true;socket.destroy();e?reject(e):resolve(v);};socket.setTimeout(5000,()=>finish(Error('timeout')));socket.on('error',finish);socket.on('data',b=>{data=Buffer.concat([data,b]);try{const r=parse(data);if(r)finish(r.error,r.value);}catch(e){finish(e);}});socket.on('connect',()=>socket.write('*'+args.length+'\r\n'+args.map(v=>{const s=String(v);return '$'+Buffer.byteLength(s)+'\r\n'+s+'\r\n';}).join('')));});}
test('actual Redis single-store Lua, synthetic only; NOT service race proof',{skip:!enabled},async t=>{
 assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535,'explicit loopback port required');
 const keys=[k.state,sessionKey,k.worker,recordKey];
 const time=async()=>{const [s,u]=await cmd('TIME');return Number(s)*1000+Math.floor(Number(u)/1000);};
 const put=async(key,v,ttl)=>cmd('SET',key,JSON.stringify(v),...(ttl?['PX',ttl]:[]));
 const seed=async(s=raw(),ttl)=>{await cmd('DEL',...keys);const now=await time();await put(k.state,{v:1,base:k.base,...tuple,incarnation:inc,fence:1,state:'active'});await put(sessionKey,{...tuple,incarnation:inc,fence:1,binding,issuedAt:now-10,expiresAt:now+60000},60000);const begun=JSON.parse(await cmd('EVAL',BEGIN_LUA,2,k.state,sessionKey,JSON.stringify({...p,fence:1})));assert.equal(begun.status,'deleting');await put(k.worker,{...p,kind:'cleanup-worker',binding:workerBinding,beginSession:sessionKey,beginBinding:binding,expiresAt:now+60000},60000);await cmd('SET',recordKey,s,...(ttl?['PX',ttl]:[]));return s;};
 const ev=(s,body=p,replacement=detachReplacement(s,p),expected=s)=>cmd('EVAL',DETACH_LUA,4,...keys,JSON.stringify(body),s,expected,replacement).then(JSON.parse);
 try{
 await t.test('165k raw, unknown numeric lexemes and TTL preserved exactly',async()=>{const s=await seed(raw({hidden:true,blob:'x'.repeat(165000)}).replace('"expiresAt":null','"expiresAt":null,"unknown":[900719925474099312345,{},[],-0,1.2300e+99]'),60000);const before=await cmd('PTTL',recordKey);assert.equal((await ev(s)).status,'detached');assert.equal(await cmd('GET',recordKey),detachReplacement(s,p));const after=await cmd('PTTL',recordKey);assert.ok(after>0&&after<=before&&before-after<5000);});
 await t.test('persistent TTL remains persistent and immediate duplicate is conflict',async()=>{const s=await seed();assert.equal((await ev(s)).status,'detached');assert.equal(await cmd('PTTL',recordKey),-1);assert.equal((await ev(s)).status,'conflict');});
 await t.test('malicious replacement cannot alter password/data/id/expiry/unknown',async()=>{for(const field of ['password','data','id','expiresAt','injected']){const s=await seed();const bad=patchRawObject(detachReplacement(s,p),{[field]:JSON.stringify('evil')});assert.equal((await ev(s,p,bad)).status,'replacement-mismatch');assert.equal(await cmd('GET',recordKey),s);}});
 await t.test('wrong tuple, operation, incarnation and state rejected unchanged',async()=>{for(const name of ['accountId','namespace','origin','provider','incarnation','operationId']){const s=await seed();const val=name==='accountId'?'oa_'+newIncarnation():name==='provider'?'naver':name==='origin'?'https://other.invalid':newIncarnation();assert.equal((await ev(s,{...p,[name]:val})).status,'barrier');assert.equal(await cmd('GET',recordKey),s);}const s=await seed();const st=JSON.parse(await cmd('GET',k.state));st.state='active';await put(k.state,st);assert.equal((await ev(s)).status,'barrier');});
 await t.test('wrong lineage/worker blocked while trusted worker survives logout',async()=>{let s=await seed();assert.equal((await ev(s,{...p,binding:newIncarnation()})).status,'session');await cmd('DEL',sessionKey);assert.equal((await ev(s)).status,'detached');s=await seed();const se=JSON.parse(await cmd('GET',sessionKey));se.expiresAt=(await time())-1;await put(sessionKey,se,60000);assert.equal((await ev(s)).status,'detached');s=await seed();assert.equal((await ev(s,{...p,workerBinding:newIncarnation()})).status,'worker-authority');assert.equal(await cmd('GET',recordKey),s);});
 await t.test('verifiedRaw and expectedRaw cannot diverge; CAS prevents interposed writes',async()=>{const s=await seed();assert.equal((await ev(s,p,detachReplacement(s,p),s+' ')).status,'proof-conflict');await cmd('SET',recordKey,s+' ');assert.equal((await ev(s)).status,'conflict');assert.equal(await cmd('GET',recordKey),s+' ');});
 await t.test('legacy missing incarnation, already detached and deleted records reject',async()=>{let s=patchRawObject(raw(),{ownerIncarnation:undefined});await seed(s);assert.equal((await ev(s,p,s)).status,'ownership-missing');s=detachReplacement(raw(),p);await seed(s);assert.equal((await ev(s,p,s)).status,'ownership-missing');s=raw({deleted:true});await seed(s);assert.equal((await ev(s,p,s)).status,'record-deleted');});
 await t.test('array data/password fail closed inside Redis too',async()=>{for(const field of ['data','password']){const s=raw({[field]:[]});await seed(s);assert.equal((await ev(s,p,s)).status,'record-unsafe');assert.equal(await cmd('GET',recordKey),s);}});
 await t.test('old session wrong type does not strand trusted worker',async()=>{const s=await seed();await cmd('DEL',sessionKey);await cmd('LPUSH',sessionKey,'unrelated');assert.equal((await ev(s)).status,'detached');});
 await t.test('wrong authority/worker/record types, oversized raw and expired timestamp reject',async()=>{for(const key of [k.state,k.worker,recordKey]){const s=await seed();await cmd('DEL',key);await cmd('LPUSH',key,'wrong');assert.notEqual((await ev(s)).status,'detached');}let s=await seed(raw({expiresAt:(await time())-1}));assert.equal((await ev(s)).status,'record-expired');s=await seed();await cmd('SET',recordKey,'x'.repeat(1048577));assert.equal((await ev(s)).status,'conflict');});
 await t.test('two concurrent exact-CAS detaches: one success, one conflict',async()=>{const s=await seed();const results=await Promise.all([ev(s),ev(s)]);assert.deepEqual(results.map(x=>x.status).sort(),['conflict','detached']);});
 await t.test('logout after snapshot does not strand authorized deletion worker',async()=>{const s=await seed();const adapter=createDetachAdapter({verifyRequestSnapshot:async()=>({...p,verifiedRaw:s}),command:async c=>{const result=await cmd(...c);if(c[0]==='GET')await cmd('DEL',sessionKey);return result;}});assert.equal((await adapter({})).status,'detached');assert.notEqual(await cmd('GET',recordKey),s);});
 await t.test('LIMITATION: unfenced restore after success resurrects owner, requiring external fence',async()=>{const s=await seed();assert.equal((await ev(s)).status,'detached');await cmd('SET',recordKey,s);assert.equal(JSON.parse(await cmd('GET',recordKey)).ownerIncarnation,inc);});
 }finally{await cmd('DEL',...keys);}
});

// Range-contract tests: all fixtures are generated synthetic content.
// Lua source assertions below are regression tripwires, NOT Lua execution proof.
const ownerNames=['ownerAccountId','ownerIncarnation','ownerNamespace','ownerOrigin','ownerProvider'];
const ownerSet=new Set(ownerNames);
const basePairs=Object.entries(JSON.parse(raw()));
const owners=basePairs.filter(([key])=>ownerSet.has(key));
const keepers=basePairs.filter(([key])=>!ownerSet.has(key));
const member=([key,value])=>JSON.stringify(key)+':'+JSON.stringify(value);
const objectFrom=pairs=>'{'+pairs.map(member).join(',')+'}';
const expectedFrom=pairs=>objectFrom(pairs.filter(([key])=>!ownerSet.has(key)).map(([key,value])=>[key,key==='revision'?p.revision:value]));
function* permutations(items){if(!items.length){yield [];return;}for(let i=0;i<items.length;i++)for(const tail of permutations([...items.slice(0,i),...items.slice(i+1)]))yield [items[i],...tail];}
test('5040 exhaustive block orders: all adjacent/split/first/last owner runs, revision positions',()=>{
 const rev=keepers.find(([key])=>key==='revision');const rest=keepers.filter(([key])=>key!=='revision');let count=0;
 for(const blocks of permutations([...owners.map(pair=>[pair]),[rev],rest])){const pairs=blocks.flat();assert.equal(detachReplacement(objectFrom(pairs),p),expectedFrom(pairs));count++;}
 assert.equal(count,5040);
});
test('500 reproducible interleavings preserve exact member bytes, including Unicode and escape-heavy values',()=>{
 let state=0x12345678;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
 const lexemes=new Map([...basePairs.map(pair=>[pair[0],member(pair)]),['unknown','"unknown":{"n":900719925474099312345,"z":-0,"e":1.2300e+99,"a":[],"o":{},"x":{"d":1,"d":2}}']]);
 // This retained value contains quote, slash, backslash, tabs, actual non-ASCII.
 lexemes.set('text','"text":'+JSON.stringify('한글 😀 " \\ /\n\t'.repeat(20)));
 for(let attempt=0;attempt<500;attempt++){
  const order=[...lexemes.keys()];for(let i=order.length-1;i>0;i--){const j=rand()%(i+1);[order[i],order[j]]=[order[j],order[i]];}
  const s='{'+order.map(key=>lexemes.get(key)).join(',')+'}';
  const want='{'+order.filter(key=>!ownerSet.has(key)).map(key=>key==='revision'?'"revision":"'+p.revision+'"':lexemes.get(key)).join(',')+'}';
  assert.equal(detachReplacement(s,p),want);
 }
});
test('explicit whitespace contract, first/middle/final runs and trailing root whitespace',()=>{
 const o=owners.map(member).join(' ,\n\t');const r=keepers.map(member).join(',');const revised=keepers.map(([key,value])=>member([key,key==='revision'?p.revision:value])).join(',');
 assert.equal(detachReplacement(' \n{ \t'+o+' ,\r\n  '+r+' \t}\r\n',p),' \n{ \t\r\n  '+revised+' \t}\r\n');
 assert.equal(detachReplacement(' \n{ '+r+' \t, \r\n'+o+' \n}\t',p),' \n{ '+revised+' \t}\t');
 const split=keepers.findIndex(([key])=>key==='revision');
 const left=keepers.slice(0,split+1).map(member).join(',');const right=keepers.slice(split+1).map(member).join(',');
 const changedLeft=keepers.slice(0,split+1).map(([key,value])=>member([key,key==='revision'?p.revision:value])).join(',');
 assert.equal(detachReplacement('{'+left+', \t'+o+' ,\n '+right+'}',p),'{'+changedLeft+', \t\n '+right+'}');
});
test('all owner names and revision may be Unicode escaped without normalizing retained keys',()=>{
 let s=raw();for(const key of [...ownerNames,'revision']){const encoded=key.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');s=s.replace(JSON.stringify(key),'"'+encoded+'"');}
 s=s.replace('"data"','"\\u0064ata"');const next=detachReplacement(s,p);
 assert.equal(JSON.parse(next).revision,p.revision);assert.ok(next.includes('"\\u0064ata"'));assert.ok(next.includes('"\\u0072\\u0065'));
 for(const key of ownerNames)assert.equal(Object.hasOwn(JSON.parse(next),key),false);
});
test('duplicate root aliases rejected for every owner, revision, and prototype-like unknown key',()=>{
 for(const key of [...ownerNames,'revision','data','password']){
  const escaped='\\u'+key.charCodeAt(0).toString(16).padStart(4,'0')+key.slice(1);
  const dup=raw().replace('{','{"'+escaped+'":'+JSON.stringify(JSON.parse(raw())[key])+',');
  assert.throws(()=>detachReplacement(dup,p),/RAW_UNSAFE/);
 }
 assert.throws(()=>detachReplacement(raw().replace('{','{"__proto__":1,"\\u005f_proto__":2,'),p),/RAW_UNSAFE/);
 const s=raw().replace('{','{"__proto__":{"ownerProvider":"evil"},"constructor":false,"toString":null,');
 const next=detachReplacement(s,p);for(const key of ['__proto__','constructor','toString'])assert.equal(segment(next,key),segment(s,key));
});
test('escaped quote/backslash parity and nested owner lookalikes remain untouched',()=>{
 for(let n=0;n<33;n++){
  const s=raw({unknown:{ownerProvider:'keep',ownerIncarnation:inc,revision:'keep',literal:'\\'.repeat(n)+'"],}{,\\u0022'},password:{salt:'\\'.repeat(n),hash:'"hash\\'},data:{nested:[{},[],{literal:'} ] , " \\'}]}});
  const next=detachReplacement(s,p);for(const key of ['unknown','password','data'])assert.equal(segment(next,key),segment(s,key));
 }
});
test('exact 165474-byte synthetic large record and 1MiB boundary retain every unmodified byte',()=>{
 for(const size of [165474,1048576]){
  const empty=raw({blob:''});const s=raw({blob:'x'.repeat(size-Buffer.byteLength(empty))});assert.equal(Buffer.byteLength(s),size);
  const next=detachReplacement(s,p);for(const key of rawObjectMembers(s).members.keys())if(!ownerSet.has(key)&&key!=='revision')assert.equal(segment(next,key),segment(s,key));
 }
 const empty=raw({blob:''});assert.throws(()=>detachReplacement(raw({blob:'x'.repeat(1048577-Buffer.byteLength(empty))}),p),/RAW_UNSAFE/);
});
test('depth 128 accepted; depth 129 rejected; nested brackets inside strings are not nesting',()=>{
 const nested=depth=>raw().replace('"expiresAt":null','"expiresAt":null,"deep":'+'['.repeat(depth)+'0'+']'.repeat(depth));
 assert.equal(segment(detachReplacement(nested(128),p),'deep'),'['.repeat(128)+'0'+']'.repeat(128));
 assert.throws(()=>detachReplacement(nested(129),p),/RAW_UNSAFE/);
 assert.equal(JSON.parse(detachReplacement(raw({text:'[{}]'.repeat(1000)}),p)).text,'[{}]'.repeat(1000));
});
test('malformed JSON and non-object roots never produce replacement',()=>{
 const invalid=['',null,123,'null','[]','[{}]','true','{} junk',raw()+raw(),raw().slice(0,-1),raw().replace('"expiresAt":null','"expiresAt":NaN'),raw().replace('"expiresAt":null','"expiresAt":01'),raw().replace('"expiresAt":null','"expiresAt":+1'),raw().replace('"expiresAt":null','"expiresAt":1.'),raw().replace('"expiresAt":null','"expiresAt":"\\x20"'),raw().replace('"expiresAt":null','"expiresAt":"bad\nline"'),raw().replace('"expiresAt":null','"expiresAt":[1,}'),raw().replace(/}$/,',}'),raw().replace('"expiresAt":null','"expiresAt":true false')];
 for(const s of invalid)assert.throws(()=>detachReplacement(s,p));
});
test('password/data require objects; owner and revision cannot be coerced',()=>{
 for(const field of ['password','data'])for(const value of [null,[],true,false,0,'{}'])assert.throws(()=>detachReplacement(raw({[field]:value}),p),/RECORD_UNSAFE/);
 for(const name of ownerNames)for(const value of [null,[],{},0,false])assert.throws(()=>detachReplacement(raw({[name]:value}),p),/OWNERSHIP_MISMATCH/);
 for(const revision of [null,1,{},p.expectedRevision,'F'.repeat(32),'b'.repeat(31)])assert.throws(()=>detachReplacement(raw(),{...p,revision}),/REVISION/);
});
test('adapter rejects malformed fence/worker proof before any command; does not mint authority',async()=>{
 const s=raw();for(const change of [{fence:1},{fence:-1},{fence:2.1},{fence:Number.MAX_SAFE_INTEGER+1},{workerBinding:''},{workerBinding:null},{binding:''},{incarnation:''},{operationId:''},{sessionKey:'client-session'}]){
  let commands=0;const detach=createDetachAdapter({verifyRequestSnapshot:async()=>({...p,verifiedRaw:s,...change}),command:async()=>{commands++;throw Error('must not run');}});
  await assert.rejects(()=>detach({}),/PROOF/);assert.equal(commands,0);
 }
 for(const field of ['expectedRaw','replacementRaw']){let commands=0;const detach=createDetachAdapter({verifyRequestSnapshot:async()=>({...p,verifiedRaw:s,[field]:s}),command:async()=>{commands++;}});await assert.rejects(()=>detach({}),/UNTRUSTED_REPLACEMENT/);assert.equal(commands,0);}
});
test('adapter binds exact snapshot, operation, worker and independently computed replacement',async()=>{
 const s=raw({unknown:'synthetic only'});const seen=[];const detach=createDetachAdapter({verifyRequestSnapshot:async()=>({...p,verifiedRaw:s}),command:async c=>{seen.push(c);if(c[0]==='GET')return s;return JSON.stringify({status:'replacement-mismatch'});}});
 assert.deepEqual(await detach({clientWorker:'ignored'}),{status:'replacement-mismatch'});assert.equal(seen.length,2);
 const ev=seen[1];assert.deepEqual(ev.slice(0,7),['EVAL',DETACH_LUA,'4',k.state,sessionKey,k.worker,recordKey]);const wire=JSON.parse(ev[7]);
 assert.equal(wire.fence,p.fence);assert.equal(wire.operationId,p.operationId);assert.equal(wire.workerBinding,p.workerBinding);assert.equal(ev[8],s);assert.equal(ev[9],s);assert.equal(ev[10],detachReplacement(s,{...p,revision:wire.revision}));
});
test('Lua source tripwires only: one scan/assembly/write, immutable proof, fences, worker recheck, TTL',()=>{
 assert.equal((DETACH_LUA.match(/spans\(raw\)/g)||[]).length,1);assert.ok(DETACH_LUA.includes('pcall(spans,raw)'));assert.ok(DETACH_LUA.includes("error('SCAN_BUDGET_EXCEEDED',0)"));assert.ok(DETACH_LUA.includes("result('record-too-complex')"));assert.ok(DETACH_LUA.includes('for j=1,4097 do'));assert.ok(DETACH_LUA.indexOf('for j=1,4097 do')<DETACH_LUA.indexOf('local decoded,r=pcall(cjson.decode,raw)'));assert.equal((DETACH_LUA.match(/table\.concat\(parts\)/g)||[]).length,1);
 assert.equal((DETACH_LUA.match(/redis\.call\('SET'/g)||[]).length,1);assert.ok(!DETACH_LUA.includes('local function remove('));
 for(const literal of ["verifiedRaw~=expectedRaw","raw~=expectedRaw","s.fence~=p.fence","s.operationId~=p.operationId","w.fence==s.fence","w.operationId==s.operationId","w.binding==p.workerBinding","w.beginSession==s.beginSession","w.beginBinding==s.beginBinding","w.expiresAt>nowms()","redis.call('PTTL',KEYS[3])>0","changed~=replacementRaw","if not worker() then return result('expired') end","redis.call('SET',KEYS[4],changed,'XX','KEEPTTL')"])assert.ok(DETACH_LUA.includes(literal),literal);
 assert.ok(DETACH_LUA.indexOf("changed~=replacementRaw")<DETACH_LUA.indexOf("if not worker() then return result('expired')"));
 assert.ok(DETACH_LUA.indexOf("local finalttl=")<DETACH_LUA.indexOf("local wrote="));
});
