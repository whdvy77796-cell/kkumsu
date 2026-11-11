// Disposable synthetic Redis only. Never point at production or shared live data.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { accountKeys, newIncarnation, newOperationId, BEGIN_LUA } from '../lib/withdrawal-redis.mjs';
import { detachReplacement, DETACH_LUA } from '../lib/withdrawal-detach-lexical-experiment.mjs';
const out=process.argv[2];if(!out)throw Error('temporary output directory required');
const lua=`
local function begin(KEYS,ARGV) ${BEGIN_LUA} end
local function detach(KEYS,ARGV) ${DETACH_LUA} end
local p=cjson.decode(ARGV[1]);local raw=ARGV[2];local replacement=ARGV[3]
local state,sess,worker,rec,base=p.stateKey,p.sessionKey,p.workerKey,p.recordKey,p.base
local keys={state,sess,worker,rec}
local function check(v,name) if not v then error(name) end end
if redis.call('EXISTS',unpack(keys))~=0 then return cjson.encode({status='blocked-existing-key'}) end
local completed=false
local ok,err=pcall(function()
 local tm=redis.call('TIME');local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
 local a={v=1,base=base,accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,state='active'}
 local s={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,binding=p.binding,issuedAt=now-1000,expiresAt=now+120000}
 redis.call('SET',state,cjson.encode(a));redis.call('SET',sess,cjson.encode(s),'PX',120000)
 local bp={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,binding=p.binding,operationId=p.operationId}
 local b=cjson.decode(begin({state,sess},{cjson.encode(bp)}));check(b.status=='deleting','begin')
 local w={kind='cleanup-worker',accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=2,operationId=p.operationId,binding=p.workerBinding,beginSession=sess,beginBinding=p.binding,expiresAt=now+120000}
 redis.call('SET',worker,cjson.encode(w),'PX',120000);redis.call('SET',rec,raw,'PX',120000)
 local before=redis.call('PTTL',rec)
 local got=cjson.decode(detach(keys,{ARGV[1],raw,raw,replacement}))
 local after=redis.call('PTTL',rec)
 if p.expectComplex then
  check(got.status=='record-too-complex','budget-status-'..tostring(got.status))
  check(redis.call('GET',rec)==raw,'original-preserved')
 else
  check(got.status=='detached' and got.receipt==false,'detach')
  check(redis.call('GET',rec)==replacement,'exact-bytes')
 end
 check(after>0 and after<=before,'ttl');completed=true
end)
local removed=redis.call('DEL',unpack(keys));local left=redis.call('EXISTS',unpack(keys))
return cjson.encode({status=ok and completed and 'ok' or 'failed',completed=completed,error=ok and cjson.null or tostring(err),removed=removed,left=left})`;
for (const spec of [{name:'165k',target:165474,fields:10},{name:'near-1m-simple',target:1048000,fields:10},{name:'near-1m-punctuation',target:1048000,fields:10,punctuationBlob:true},{name:'near-1m-500-fields',target:1048000,fields:500},{name:'near-1m-many-fields',target:1048000,fields:20000,expectComplex:true},{name:'near-1m-many-escapes',target:1048000,fields:10,expectComplex:true,escapeBlob:true},{name:'near-1m-many-objects',target:1048000,fields:10,expectComplex:true,objects:200000}]){
 const opaque=()=>randomBytes(32).toString('base64url'),id='s'.repeat(22),inc=newIncarnation(),binding=opaque(),workerBinding=opaque(),operationId=newOperationId();
 const tuple={accountId:'oa_'+opaque(),provider:'naver',origin:'https://synthetic.invalid',namespace:'yb:qa:isolated:'+randomBytes(12).toString('hex')};
 const k=accountKeys(tuple),sess=k.session(opaque()),rec=tuple.namespace+':record:'+id;
 const p={...tuple,incarnation:inc,operationId,fence:2,binding,workerBinding,expectedRevision:'a'.repeat(32),revision:'b'.repeat(32),stateKey:k.state,sessionKey:sess,workerKey:k.worker,recordKey:rec,base:k.base,expectComplex:spec.expectComplex===true};
 const obj={id,revision:p.expectedRevision,ownerAccountId:tuple.accountId,ownerIncarnation:inc,ownerNamespace:tuple.namespace,ownerOrigin:tuple.origin,ownerProvider:tuple.provider,password:{salt:'synthetic',hash:'synthetic'},data:{name:'가상가게',sections:[],faqs:{}},hidden:true,expiresAt:null};
 for(let i=0;i<spec.fields;i++)obj['unknown_'+String(i).padStart(5,'0')]='v';
 if(spec.objects)obj.swarm=Array.from({length:spec.objects},()=>({}));
 obj.blob='';const delta=spec.target-Buffer.byteLength(JSON.stringify(obj));if(delta<0)throw Error('fixture too big');obj.blob=spec.escapeBlob?'\\'.repeat(Math.floor(delta/2))+'x'.repeat(delta%2):spec.punctuationBlob?'{}[]:,'.repeat(Math.ceil(delta/6)).slice(0,delta):'x'.repeat(delta);
 const raw=JSON.stringify(obj),replacement=detachReplacement(raw,p);if(Buffer.byteLength(raw)!==spec.target||Buffer.byteLength(raw)>1048576)throw Error('size mismatch');
 const body=JSON.stringify(['EVAL',lua,'0',JSON.stringify(p),raw,replacement]);
 const file=out+'/'+spec.name+'.json';await writeFile(file,body,{encoding:'utf8',flag:'wx'});
 await writeFile(out+'/'+spec.name+'-keys.json',JSON.stringify([k.state,sess,k.worker,rec]),{encoding:'utf8',flag:'wx'});
 console.log(JSON.stringify({name:spec.name,bytes:Buffer.byteLength(raw),fields:spec.fields,requestBytes:Buffer.byteLength(body)}));
}
