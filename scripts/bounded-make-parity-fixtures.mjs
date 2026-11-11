// Disposable isolated Redis only. Synthetic cases, no production data.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { accountKeys,newIncarnation,newOperationId,BEGIN_LUA } from '../lib/withdrawal-redis.mjs';
import { detachReplacement,DETACH_LUA } from '../lib/withdrawal-detach-bounded-experiment.mjs';
const dir=process.argv[2];if(!dir)throw Error('temporary output directory required');
const opaque=()=>randomBytes(32).toString('base64url'),id='t'.repeat(22),inc=newIncarnation(),binding=opaque(),workerBinding=opaque(),operationId=newOperationId();
const tuple={accountId:'oa_'+opaque(),provider:'naver',origin:'https://synthetic.invalid',namespace:'yb:qa:parity:'+randomBytes(12).toString('hex')};
const k=accountKeys(tuple),sess=k.session(opaque()),rec=tuple.namespace+':record:'+id;
const p={...tuple,incarnation:inc,operationId,fence:2,binding,workerBinding,expectedRevision:'a'.repeat(32),revision:'b'.repeat(32),stateKey:k.state,sessionKey:sess,workerKey:k.worker,recordKey:rec,base:k.base};
const values={id,revision:p.expectedRevision,ownerAccountId:tuple.accountId,ownerIncarnation:inc,ownerNamespace:tuple.namespace,ownerOrigin:tuple.origin,ownerProvider:tuple.provider,password:{salt:'old\\salt',hash:'hash'},data:{name:'가상가게',sections:[],faqs:{}},hidden:true,expiresAt:null,blob:'',unknown:{nested:[1,{},[],{ownerProvider:'decoy'}],text:'한글 😀 \\ " } , ]'} };
const names=Object.keys(values),cases=[];let seed=0x13579bdf;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
for(let i=0;i<100;i++){
 const order=[...names];for(let j=order.length-1;j>0;j--){const x=rand()%(j+1);[order[j],order[x]]=[order[x],order[j]];}
 const ws=i%3===0?' \n ':'',sep=i%4===0?', \t':',';
 let raw=ws+'{'+ws+order.map((key,j)=>{const sk=(i%5===0&&['ownerAccountId','ownerIncarnation','revision','data'].includes(key))?'"'+[...key].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"':JSON.stringify(key);let val=JSON.stringify(values[key]);if(key==='unknown'&&i%2===0)val='{"huge":900719925474099312345,"minus":-0,"exp":1.2300e+99,"nested":{"ownerProvider":"decoy"}}';if(key==='blob')val=JSON.stringify('a\\"[]{} , '.repeat(i%17));return sk+(j%2?' : ':':')+val;}).join(sep)+ws+'}'+ws;
 cases.push({label:'valid-'+i,raw,replacement:detachReplacement(raw,p),expected:'detached'});
}
for(const key of ['ownerAccountId','ownerIncarnation','ownerNamespace','ownerOrigin','ownerProvider','revision','data','password','__proto__']){
 const extra=key==='__proto__'?'1':JSON.stringify(values[key]);const prefix=key==='__proto__'?'"__proto__":1,"\\u005f_proto__":2,':'"'+key+'":'+extra+',';const raw='{'+prefix+JSON.stringify(values).slice(1);cases.push({label:'duplicate-'+key,raw,replacement:raw,expected:'record-unsafe'});
}
for(const num of ['NaN','Infinity','-Infinity','+1','01','-01','1.','.1','1e','1e+','0x10','-0x1','truex']){
 for(const [place,fragment] of [['root',num],['nested','{"x":'+num+'}'],['array','['+num+']']]){
  const raw=JSON.stringify(values).replace('"expiresAt":null','"expiresAt":null,"malformed":'+fragment);cases.push({label:'invalid-'+place+'-'+num,raw,replacement:raw,expected:'record-unsafe'});
 }
}
for(const [label,fragment] of [['root-control','"text'+String.fromCharCode(0)+'"'],['object-control','{"x":"line\nfeed"}'],['array-control','["tab\tchar"]']]){
 const raw=JSON.stringify(values).replace('"expiresAt":null','"expiresAt":null,"badText":'+fragment);cases.push({label,raw,replacement:raw,expected:'record-unsafe'});
}
for(const [label,fragment] of [['nested-values','{"a":1,"b":true,"c":null,"s":"NaN : 01"}'],['escaped-controls','["\\n","\\t",{"s":"\\u0000"}]']]){
 const raw=JSON.stringify(values).replace('"expiresAt":null','"expiresAt":null,"safeValue":'+fragment);cases.push({label,raw,replacement:detachReplacement(raw,p),expected:'detached'});
}
for(const num of ['-0','0','1.0','-1e-4','1e400','0.00000001','9E+30','1e+02','1E-2']){
 const raw=JSON.stringify(values).replace('"expiresAt":null','"expiresAt":null,"validNumber":'+num);const limited=num==='1e400';cases.push({label:'valid-'+num,raw,replacement:limited?raw:detachReplacement(raw,p),expected:limited?'record-unsafe':'detached'});
}
// Conservative structural prescan: count punctuation even inside valid strings.
const rawNote=n=>JSON.stringify({...values,note:':'.repeat(n)});
const structural=s=>(s.match(/[{}\[\]":,\\]/g)||[]).length;
const count0=structural(rawNote(0));if(count0>=4096)throw Error('boundary fixture');
for(const [label,n,expected] of [['prescan-4096',4096-count0,'detached'],['prescan-4097',4097-count0,'record-too-complex']]){
 const raw=rawNote(n);cases.push({label,raw,replacement:detachReplacement(raw,p),expected});
}
for(const depth of [128,129,1000,1500]){
 const raw=JSON.stringify(values).replace('"expiresAt":null','"expiresAt":null,"deep":'+'['.repeat(depth)+'0'+']'.repeat(depth));
 cases.push({label:'deep-'+depth,raw,replacement:depth===128?detachReplacement(raw,p):raw,expected:depth===128?'detached':'record-unsafe'});
}
const lua=`
local function begin(KEYS,ARGV) ${BEGIN_LUA} end
local function detach(KEYS,ARGV) ${DETACH_LUA} end
local p=cjson.decode(ARGV[1]);local cases=cjson.decode(ARGV[2]);local state,sess,worker,rec,base=p.stateKey,p.sessionKey,p.workerKey,p.recordKey,p.base;local keys={state,sess,worker,rec};local completed=0
local function check(v,n)if not v then error(n,0)end end
if redis.call('EXISTS',unpack(keys))~=0 then return cjson.encode({status='blocked-existing-key'})end
local ok,err=pcall(function()
 local tm=redis.call('TIME');local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
 local a={v=1,base=base,accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,state='active'}
 local s={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,binding=p.binding,issuedAt=now-1000,expiresAt=now+120000}
 redis.call('SET',state,cjson.encode(a));redis.call('SET',sess,cjson.encode(s),'PX',120000)
 local bp={accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=1,binding=p.binding,operationId=p.operationId}
 local b=cjson.decode(begin({state,sess},{cjson.encode(bp)}));check(b.status=='deleting','begin')
 local w={kind='cleanup-worker',accountId=p.accountId,provider=p.provider,origin=p.origin,namespace=p.namespace,incarnation=p.incarnation,fence=2,operationId=p.operationId,binding=p.workerBinding,beginSession=sess,beginBinding=p.binding,expiresAt=now+120000}
 redis.call('SET',worker,cjson.encode(w),'PX',120000)
 for _,c in ipairs(cases) do
  redis.call('SET',rec,c.raw,'PX',120000)
  local out=cjson.decode(detach(keys,{ARGV[1],c.raw,c.raw,c.replacement}))
  check(out.status==c.expected,c.label..':'..tostring(out.status))
  if c.expected=='detached' then check(redis.call('GET',rec)==c.replacement,c.label..':bytes') else check(redis.call('GET',rec)==c.raw,c.label..':changed') end
  check(redis.call('PTTL',rec)>0,c.label..':ttl');completed=completed+1
 end
end)
local removed=redis.call('DEL',unpack(keys));local left=redis.call('EXISTS',unpack(keys));return cjson.encode({status=ok and 'ok' or 'failed',error=ok and cjson.null or tostring(err),completed=completed,removed=removed,left=left})`;
for(let i=0;i<cases.length;i+=20){const group=cases.slice(i,i+20);const n=String(i/20).padStart(2,'0');await writeFile(dir+'/parity-'+n+'.json',JSON.stringify(['EVAL',lua,'0',JSON.stringify(p),JSON.stringify(group)]),{encoding:'utf8',flag:'wx'});}
await writeFile(dir+'/parity-keys.json',JSON.stringify([k.state,sess,k.worker,rec]),{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({cases:cases.length,groups:Math.ceil(cases.length/20)}));
