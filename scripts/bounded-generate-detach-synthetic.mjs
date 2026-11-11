// EXPERIMENT ONLY. Generates a tiny 541-byte synthetic-record, 13-check Redis EVAL.
// Only execute with explicit review, isolated test keys and a reviewed Redis target.
// Authority test key is persistent during EVAL; if execution is interrupted,
// inspect and clean ONLY the exact synthetic keys from the generated command.
// Never run large-record tests against a shared live Redis primary.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { accountKeys, newIncarnation, newOperationId, BEGIN_LUA } from '../lib/withdrawal-redis.mjs';
import { detachReplacement, DETACH_LUA } from '../lib/withdrawal-detach-bounded-experiment.mjs';
const opaque=()=>randomBytes(32).toString('base64url'), id='s'.repeat(22), inc=newIncarnation(),binding=opaque(),workerBinding=opaque(),operationId=newOperationId();
const tuple={accountId:'oa_'+opaque(),provider:'naver',origin:'https://synthetic.invalid',namespace:'yb:qa:detach:'+randomBytes(12).toString('hex')};
const keys=accountKeys(tuple),sess=keys.session(opaque()),rec=tuple.namespace+':record:'+id;
const p={...tuple,incarnation:inc,operationId,fence:2,binding,workerBinding,expectedRevision:'a'.repeat(32),revision:'b'.repeat(32)};
const raw=`{\n "id":"${id}","revision":"${p.expectedRevision}","ownerAccountId":"${tuple.accountId}","ownerIncarnation":"${inc}","ownerNamespace":"${tuple.namespace}","ownerOrigin":"${tuple.origin}","ownerProvider":"${tuple.provider}","password":{"salt":"synthetic","hash":"synthetic"},"data":{"name":"가상가게","sections":[],"faqs":{}},"hidden":true,"expiresAt":null,"unknown":{"big":900719925474099312345,"escaped":"a\\/b","arr":[[],{}]}}`;
const replacement=detachReplacement(raw,p);
const noInc=raw.replace(`"ownerIncarnation":"${inc}",`,'');
const arrData=raw.replace('"data":{"name":"가상가게","sections":[],"faqs":{}}','"data":[]');
const arrPass=raw.replace('"password":{"salt":"synthetic","hash":"synthetic"}','"password":[]');
if(noInc===raw||arrData===raw||arrPass===raw)throw Error('fixture');
const lit=s=>{const b=[...Buffer.from(String(s),'utf8')],q=[];for(let i=0;i<b.length;i+=40)q.push('string.char('+b.slice(i,i+40).join(',')+')');return q.length?q.join('..'):"''";};
const source=`
local function begin(KEYS,ARGV) ${BEGIN_LUA} end
local function detach(KEYS,ARGV) ${DETACH_LUA} end
local state=${lit(keys.state)};local sess=${lit(sess)};local worker=${lit(keys.worker)};local rec=${lit(rec)};local base=${lit(keys.base)}
local p=cjson.decode(${lit(JSON.stringify(p))});local raw=${lit(raw)};local replacement=${lit(replacement)};local noInc=${lit(noInc)};local arrData=${lit(arrData)};local arrPass=${lit(arrPass)}
local keys={state,sess,worker,rec};local completed={}
local function check(v,name)if not v then error(name)end end
local function run(body,verified,expected,next) return cjson.decode(detach(keys,{cjson.encode(body),verified,expected,next})) end
local function nowms()local t=redis.call('TIME');return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)end
if redis.call('EXISTS',unpack(keys))~=0 then return cjson.encode({status='blocked-existing-key'})end
local ok,err=pcall(function()
 local now=nowms()
 local a={v=1,base=base,accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,state='active'}
 local s={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,binding=p.binding,issuedAt=now-1000,expiresAt=now+120000}
 redis.call('SET',state,cjson.encode(a));redis.call('SET',sess,cjson.encode(s),'PX',120000)
 local bp={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,binding=p.binding,operationId=p.operationId}
 local b=cjson.decode(begin({state,sess},{cjson.encode(bp)}));check(b.status=='deleting','begin')
 local w={kind='cleanup-worker',accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=2,operationId=p.operationId,binding=p.workerBinding,beginSession=sess,beginBinding=p.binding,expiresAt=now+120000}
 redis.call('SET',worker,cjson.encode(w),'PX',120000)
 redis.call('SET',rec,noInc,'PX',120000)
 local missing=run(p,noInc,noInc,noInc);check(missing.status=='ownership-missing' and redis.call('GET',rec)==noInc,'missing-inc');table.insert(completed,'legacy-incarnation-blocked')
 redis.call('SET',rec,arrData,'PX',120000);local ad=run(p,arrData,arrData,arrData);check(ad.status=='record-unsafe' and redis.call('GET',rec)==arrData,'array-data');table.insert(completed,'array-data-blocked')
 redis.call('SET',rec,arrPass,'PX',120000);local ap=run(p,arrPass,arrPass,arrPass);check(ap.status=='record-unsafe' and redis.call('GET',rec)==arrPass,'array-password');table.insert(completed,'array-password-blocked')
 redis.call('SET',rec,raw,'PX',120000)
 local proof=run(p,raw,raw..' ',replacement);check(proof.status=='proof-conflict' and redis.call('GET',rec)==raw,'proof');table.insert(completed,'proof-bound')
 local wrong={};for k,v in pairs(p)do wrong[k]=v end;wrong.operationId=${lit(opaque())}
 local barrier=run(wrong,raw,raw,replacement);check(barrier.status=='barrier' and redis.call('GET',rec)==raw,'wrong-operation');table.insert(completed,'wrong-operation-blocked')
 local bad=run(p,raw,raw,'{}');check(bad.status=='replacement-mismatch' and redis.call('GET',rec)==raw,'malicious-replacement');table.insert(completed,'arbitrary-replacement-blocked')
 redis.call('SET',rec,raw..' ','KEEPTTL')
 local conflict=run(p,raw,raw,replacement);check(conflict.status=='conflict' and redis.call('GET',rec)==raw..' ','stale-cas');table.insert(completed,'stale-raw-cas')
 redis.call('SET',rec,raw,'PX',120000)
 local before=redis.call('PTTL',rec);local result=run(p,raw,raw,replacement);local after=redis.call('PTTL',rec)
 check(result.status=='detached' and result.receipt==false and redis.call('GET',rec)==replacement and after>0 and after<=before and before-after<5000,'detach-bytes-ttl');table.insert(completed,'small-record-bytes-ttl')
 local duplicate=run(p,raw,raw,replacement);check(duplicate.status=='conflict','duplicate');table.insert(completed,'duplicate-cas-blocked')
 redis.call('SET',rec,raw,'PX',120000);w.beginBinding=${lit(opaque())};redis.call('SET',worker,cjson.encode(w),'PX',120000)
 local lineage=run(p,raw,raw,replacement);check(lineage.status=='worker-authority' and redis.call('GET',rec)==raw,'wrong-worker-lineage');table.insert(completed,'wrong-worker-lineage-blocked')
 w.beginBinding=p.binding;redis.call('SET',worker,cjson.encode(w),'PX',120000);redis.call('DEL',sess)
 local logout=run(p,raw,raw,replacement);check(logout.status=='detached' and redis.call('GET',rec)==replacement,'logout-worker');table.insert(completed,'trusted-worker-continues-after-logout')
 redis.call('SET',rec,raw,'PX',120000);redis.call('LPUSH',sess,'irrelevant');local oldtype=run(p,raw,raw,replacement);check(oldtype.status=='detached' and redis.call('GET',rec)==replacement,'old-session-type');table.insert(completed,'trusted-worker-ignores-old-session-type')
 redis.call('SET',rec,raw,'PX',120000);redis.call('SET',sess,cjson.encode(s),'PX',120000);w.expiresAt=now-1;redis.call('SET',worker,cjson.encode(w),'PX',120000)
 local ew=run(p,raw,raw,replacement);check(ew.status=='worker-authority' and redis.call('GET',rec)==raw,'expired-worker');table.insert(completed,'expired-worker-blocked')
end)
local removed=redis.call('DEL',unpack(keys));local left=redis.call('EXISTS',unpack(keys))
return cjson.encode({status=ok and 'ok' or 'failed',error=ok and cjson.null or tostring(err),completed=completed,removed=removed,left=left})
`;
function minify(s){let i=0,out='';const white=/\s/;while(i<s.length){let c=s[i];if(white.test(c)){while(i<s.length&&white.test(s[i]))i++;out+='--[[]]';continue}if(c==="'"||c==='"'){let q=c;out+=c;i++;while(i<s.length){c=s[i++];if(c===' '){out+='\\032';continue}out+=c;if(c==='\\'&&i<s.length){out+=s[i++];continue}if(c===q)break}continue}if(s.startsWith('--',i)){const m=s.slice(i+2).match(/^\[(=*)\[/);if(m){const end=']'+m[1]+']';const j=s.indexOf(end,i+2+m[0].length);if(j<0)throw Error('comment');i=j+end.length}else{const j=s.indexOf('\n',i);i=j<0?s.length:j}out+='--[[]]';continue}const lm=c==='['&&s.slice(i).match(/^\[(=*)\[/);if(lm){const end=']'+lm[1]+']';const j=s.indexOf(end,i+lm[0].length);if(j<0)throw Error('longstring');out+=s.slice(i,j+end.length);i=j+end.length;continue}out+=c;i++}return out}
const compact=minify(source);if(/\s/.test(compact)||/redis\.call\s*\(\s*['"](?:FLUSH|SCAN|KEYS)/i.test(source)||!tuple.namespace.startsWith('yb:qa:detach:'))throw Error('unsafe harness');
if (!process.argv[2]) throw Error('Specify a new temporary output file, never commit the generated command');
await writeFile(process.argv[2],'EVAL '+compact+' 0',{encoding:'utf8',flag:'wx'});console.log(JSON.stringify({syntheticKeys:4,recordBytes:Buffer.byteLength(raw),scriptLength:compact.length,checks:13}));
