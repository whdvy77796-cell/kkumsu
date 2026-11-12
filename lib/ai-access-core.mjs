import { createHash } from 'node:crypto';

export const MAX_BATCH = 500;
export const DAILY_CAP = 10000;
const DAY = 86400000;
const DEDUPE_TTL = 8 * 86400;
const DAILY_TTL = 15 * 86400;
export const STORE_TTL = 180 * 86400;
const providers = ['openai', 'anthropic', 'google'];
const purposes = ['search', 'training', 'user', 'search_engine'];
const fields = ['id', 'at', 'storeId', 'provider', 'purpose', 'verification'];
const idPattern = /^[A-Za-z0-9_-]{22}$/;
const day = at => new Date(at + 9 * 3600000).toISOString().slice(0, 10);
const iso = at => new Date(at).toISOString();
const validTime = at => Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000;
export function aiAccessPrefix(scope) {
  if (typeof scope?.namespace !== 'string' || !scope.namespace || scope.namespace.length > 512) throw new Error('AI_ACCESS_SCOPE');
  return 'yb:ai-access:v1:' + createHash('sha256').update(scope.namespace).digest('hex');
}
export function validAiEvent(e) {
  return e !== null && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length === fields.length && fields.every(k => Object.hasOwn(e, k)) && typeof e.id === 'string' && /^[a-f0-9]{64}$/.test(e.id) && validTime(e.at) && (e.storeId === null || (typeof e.storeId === 'string' && idPattern.test(e.storeId))) && providers.includes(e.provider) && purposes.includes(e.purpose) && ['verified','unverified'].includes(e.verification);
}

// At most 100 events share one EVAL. All keys are deduplicated and declared;
// event references are 1-based indices into KEYS, never dynamic Redis keys.
export const REDIS_BATCH_SIZE = 100;
export const AI_ACCESS_LUA = `-- yb:ai-access:v1:batch
local p=cjson.decode(ARGV[1])
local function fail() return cjson.encode({status='unavailable'}) end
if #p.events<1 or #p.events>100 or #p.keyTypes~=#KEYS then return fail() end
local function kind(k) local t=redis.call('TYPE',k);if type(t)=='table' then return t.ok end;return t end
local function valid(v)
 return v==false or v==nil or ((v=='0' or string.match(v,'^[1-9]%d*$')) and #v<=16 and tonumber(v)<=9007199254740000)
end
-- Lua errors do not roll back. Inspect every touched key and every field that
-- can reach HINCRBY/number arithmetic before the first mutation in this chunk.
for i,k in ipairs(KEYS) do
 local t=kind(k)
 if p.keyTypes[i]~='hash' and p.keyTypes[i]~='string' then return fail() end
 if t~='none' and t~=p.keyTypes[i] then return fail() end
 if t=='string' and redis.call('GET',k)~='1' then return fail() end
 if t=='hash' then
  for _,f in ipairs(p.numericFields) do if not valid(redis.call('HGET',k,f)) then return fail() end end
  local limited=redis.call('HGET',k,'limited');if limited and limited~='1' then return fail() end
 end
end
for _,e in ipairs(p.events) do
 if #e.k~=5 then return fail() end
 for i,v in ipairs(e.k) do
  if type(v)~='number' or v%1~=0 or v<1 or v>#KEYS or p.keyTypes[v]~=(i==5 and 'string' or 'hash') then return fail() end
 end
end
local result={accepted=0,duplicates=0,limited=false}
local function stamp(k)
 redis.call('HSETNX',k,'since',p.now);redis.call('HSETNX',k,'coverageSince',p.now)
 local old=tonumber(redis.call('HGET',k,'updatedAt') or '0')
 if p.now>old then redis.call('HSET',k,'updatedAt',p.now) end
end
for _,e in ipairs(p.events) do
 local k={};for i,index in ipairs(e.k) do k[i]=KEYS[index] end
 local function limited()
  result.limited=true;redis.call('HSET',k[1],'limited','1');stamp(k[1])
  if e.store then redis.call('HSET',k[3],'limited','1');stamp(k[3]);redis.call('EXPIRE',k[3],p.storeTtl) end
 end
 local function count(key)
  stamp(key);redis.call('HINCRBY',key,e.verification,1);redis.call('HINCRBY',key,e.field,1)
  local first=tonumber(redis.call('HGET',key,'firstEventAt') or tostring(e.at))
  local last=tonumber(redis.call('HGET',key,'lastEventAt') or tostring(e.at))
  redis.call('HSET',key,'firstEventAt',math.min(first,e.at),'lastEventAt',math.max(last,e.at))
  redis.call('HSET',key,'since',math.min(tonumber(redis.call('HGET',key,'since')),e.at))
 end
 if e.stale then limited()
 elseif redis.call('EXISTS',k[5])==1 then
  result.duplicates=result.duplicates+1;stamp(k[1]);if e.store then stamp(k[3]);redis.call('EXPIRE',k[3],p.storeTtl) end
 else
  local total=tonumber(redis.call('HGET',k[2],'verified') or '0')+tonumber(redis.call('HGET',k[2],'unverified') or '0')
  if total>=p.cap then limited()
  else
   count(k[1]);count(k[2]);redis.call('EXPIRE',k[2],p.dayTtl)
   if e.store then count(k[3]);count(k[4]);redis.call('EXPIRE',k[3],p.storeTtl);redis.call('EXPIRE',k[4],p.dayTtl) end
   redis.call('SET',k[5],'1','EX',p.dedupeTtl);result.accepted=result.accepted+1
   if total+1>=p.cap then limited() end
  end
 end
end
return cjson.encode(result)`;
const numericFields=['verified','unverified','since','coverageSince','updatedAt','firstEventAt','lastEventAt',...providers.flatMap(provider=>purposes.flatMap(purpose=>['verified','unverified'].map(v=>provider+':'+purpose+':'+v)))];
const validStoredNumber=v=>v===undefined||(/^(0|[1-9]\d*)$/.test(String(v))&&String(v).length<=16&&Number(v)<=9007199254740000);

function memoryGet(store, key, now) {
  store.aiAccessExpiry ||= new Map();
  if ((store.aiAccessExpiry.get(key) ?? Infinity) <= now) { store.kv.delete(key); store.aiAccessExpiry.delete(key); }
  return store.kv.get(key);
}
function memoryRecord(store, keys, p) {
  // No await: identical atomicity to the Lua event transaction.
  const values=keys.map(k=>memoryGet(store,k,p.now));
  if (values.some((v,i)=>v!==undefined && (i===4 ? v!=='1' : !v || typeof v!=='object' || Array.isArray(v)))) return 'unavailable';
  for(const v of values.slice(0,4))if(v)for(const f of ['verified','unverified',p.field,'since','coverageSince','updatedAt','firstEventAt','lastEventAt']){
    if(v[f]!==undefined&&(!/^\d+$/.test(String(v[f]))||Number(v[f])>9007199254740000))return 'unavailable';
  }
  const put=(i,v,ttl)=>{store.kv.set(keys[i],v);if(ttl)store.aiAccessExpiry.set(keys[i],p.now+ttl*1000);};
  const stamp=(i)=>{const v=values[i]||{};v.since??=p.now;v.coverageSince??=p.now;v.updatedAt=Math.max(v.updatedAt||0,p.now);put(i,v,i===2?p.storeTtl:0);return v;};
  const limited=()=>{stamp(0).limited='1';if(p.store)stamp(2).limited='1';return 'limited';};
  if(p.stale)return limited();
  if(values[4]){stamp(0);if(p.store)stamp(2);return 'duplicate';}
  const total=Number(values[1]?.verified||0)+Number(values[1]?.unverified||0);
  if(total>=p.cap)return limited();
  for(const i of p.store?[0,1,2,3]:[0,1]){
    const v=stamp(i);v[p.verification]=Number(v[p.verification]||0)+1;v[p.field]=Number(v[p.field]||0)+1;
    v.firstEventAt=Math.min(v.firstEventAt??p.at,p.at);v.lastEventAt=Math.max(v.lastEventAt??p.at,p.at);v.since=Math.min(v.since,p.at);
    put(i,v,i===2?p.storeTtl:i===1||i===3?p.dayTtl:0);
  }
  put(4,'1',p.dedupeTtl);
  if(total+1>=p.cap){limited();return 'accepted_limited';}return 'accepted';
}
function chunkPlan(prefix,events,now){
  const keys=[],keyTypes=[],indices=new Map();
  const ref=(key,type)=>{if(!indices.has(key)){indices.set(key,keys.length+1);keys.push(key);keyTypes.push(type);}return indices.get(key);};
  const planned=events.map(e=>{
    const date=day(e.at),base=e.storeId?prefix+':store:'+e.storeId:prefix+':unused';
    const names=[prefix+':site',prefix+':day:'+date,base,base+':day:'+date,prefix+':seen:'+e.id];
    return {k:names.map((key,i)=>ref(key,i===4?'string':'hash')),at:e.at,store:e.storeId!==null,verification:e.verification,field:e.provider+':'+e.purpose+':'+e.verification,stale:e.at<now-7*DAY};
  });
  return {keys,p:{now,events:planned,keyTypes,numericFields,cap:DAILY_CAP,dayTtl:DAILY_TTL,storeTtl:STORE_TTL,dedupeTtl:DEDUPE_TTL}};
}
function memoryBatch(store,keys,p){
  // Validate the entire chunk, synchronously, before any event mutation.
  for(let i=0;i<keys.length;i++){
    const v=memoryGet(store,keys[i],p.now);if(v===undefined)continue;
    if(p.keyTypes[i]==='string'){if(v!=='1')throw new Error('AI_ACCESS_STORE');continue;}
    if(!v||typeof v!=='object'||Array.isArray(v)||!numericFields.every(f=>validStoredNumber(v[f]))||(v.limited!==undefined&&v.limited!=='1'))throw new Error('AI_ACCESS_STORE');
  }
  const result={accepted:0,duplicates:0,limited:false};
  for(const e of p.events){
    const state=memoryRecord(store,e.k.map(i=>keys[i-1]),{...p,...e});
    if(state==='unavailable')throw new Error('AI_ACCESS_STORE');
    if(state==='accepted'||state==='accepted_limited')result.accepted++;
    if(state==='duplicate')result.duplicates++;
    if(state==='limited'||state==='accepted_limited')result.limited=true;
  }
  return result;
}
export async function recordAiBatch({store,scope,events,now=Date.now()}) {
  const prefix=aiAccessPrefix(scope);
  if(!validTime(now)||!Array.isArray(events)||events.length>MAX_BATCH||!events.every(e=>validAiEvent(e)&&e.at<=now+300000))throw new Error('AI_ACCESS_EVENTS');
  if(!store || (typeof store.cmd!=='function' && !(store.kv instanceof Map)))throw new Error('AI_ACCESS_STORE');
  const result={accepted:0,duplicates:0,limited:false};
  for(let offset=0;offset<events.length;offset+=REDIS_BATCH_SIZE){
    const {keys,p}=chunkPlan(prefix,events.slice(offset,offset+REDIS_BATCH_SIZE),now);
    let r;
    if(typeof store.cmd==='function'){
      const raw=await store.cmd(['EVAL',AI_ACCESS_LUA,String(keys.length),...keys,JSON.stringify(p)]);
      try{r=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw new Error('AI_ACCESS_STORE');}
    }else r=memoryBatch(store,keys,p);
    if(!r||!Number.isSafeInteger(r.accepted)||r.accepted<0||!Number.isSafeInteger(r.duplicates)||r.duplicates<0||r.accepted+r.duplicates>p.events.length||typeof r.limited!=='boolean')throw new Error('AI_ACCESS_STORE');
    result.accepted+=r.accepted;result.duplicates+=r.duplicates;result.limited||=r.limited;
  }
  return result;
}
const empty=state=>({state,since:null,updatedAt:null,lifetime:null,last7Days:null,breakdown:[]});
const counts=h=>({verified:Number(h?.verified||0),unverified:Number(h?.unverified||0)});
// Read-only: one EVAL, HGETALL on declared KEYS only. A non-hash key makes
// Redis raise WRONGTYPE, which fails the whole read (=> unavailable).
export const READ_BATCH_MAX_KEYS = 9;
export const AI_ACCESS_READ_LUA = `-- yb:ai-access:v1:read
if #KEYS<1 or #KEYS>9 then return redis.error_reply('AI_ACCESS_READ') end
local out={}
for i,k in ipairs(KEYS) do out[i]=redis.call('HGETALL',k) end
return cjson.encode(out)`;
const plainHash=()=>Object.create(null);
function parseFlat(v){
  // cjson encodes an empty Lua table as {}; a non-empty reply is a flat array.
  if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===0)return plainHash();
  if(!Array.isArray(v)||v.length%2||v.length>256)throw new Error('AI_ACCESS_STORE');
  const h=plainHash();
  for(let i=0;i<v.length;i+=2){
    if(typeof v[i]!=='string'||typeof v[i+1]!=='string'||Object.hasOwn(h,v[i]))throw new Error('AI_ACCESS_STORE');
    h[v[i]]=v[i+1];
  }
  return h;
}
async function readHashes(store,keys,now){
  if(!Array.isArray(keys)||!keys.length||keys.length>READ_BATCH_MAX_KEYS||new Set(keys).size!==keys.length)throw new Error('AI_ACCESS_STORE');
  if(typeof store?.cmd==='function'){
    const raw=await store.cmd(['EVAL',AI_ACCESS_READ_LUA,String(keys.length),...keys]);
    let r;try{r=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw new Error('AI_ACCESS_STORE');}
    if(!Array.isArray(r)||r.length!==keys.length)throw new Error('AI_ACCESS_STORE');
    return r.map(parseFlat);
  }
  if(store?.kv instanceof Map)return keys.map(k=>{
    const v=memoryGet(store,k,now);
    if(v===undefined)return plainHash();
    if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('AI_ACCESS_STORE');
    return Object.assign(plainHash(),v);
  });
  throw new Error('AI_ACCESS_STORE');
}
// Every field later turned into a number or flag must be well-formed; a
// corrupt value is unavailable, never a silent 0/NaN.
function checkedHash(h){
  if(!numericFields.every(f=>validStoredNumber(h[f]))||(h.limited!==undefined&&h.limited!=='1'))throw new Error('AI_ACCESS_STORE');
  return h;
}
export async function readAiSummary({store,scope,storeId=null,now=Date.now(),since}){
  try{
    if(!validTime(now)||(storeId!==null&&!idPattern.test(storeId)))return empty('unavailable');
    const prefix=aiAccessPrefix(scope),base=storeId===null?prefix+':site':prefix+':store:'+storeId;
    const configured=typeof since==='string'?Date.parse(since):NaN;
    const windowStart=Date.parse(day(now)+'T00:00:00+09:00')-6*DAY;
    // Day keys are only needed when the configured start can cover the window.
    const wantDays=Number.isFinite(configured)&&configured<=windowStart;
    const dayKeys=wantDays?Array.from({length:7},(_,i)=>(storeId===null?prefix+':day:':base+':day:')+day(windowStart+i*DAY)):[];
    const keys=storeId===null?[base,...dayKeys]:[base,prefix+':site',...dayKeys];
    const hashes=await readHashes(store,keys,now);
    const h=checkedHash(hashes[0]),site=storeId===null?h:checkedHash(hashes[1]);
    const dayHashes=hashes.slice(storeId===null?1:2);
    const lifetime=counts(h);
    if(!Number.isSafeInteger(lifetime.verified)||!Number.isSafeInteger(lifetime.unverified)||lifetime.verified<0||lifetime.unverified<0)return empty('unavailable');
    if(!lifetime.verified&&!lifetime.unverified){
      if(h.limited!=='1'&&site.limited!=='1')return empty('not_started');
      const start=Number(h.since??site.since),updated=Number(h.updatedAt??site.updatedAt);
      return {state:'limited',since:validTime(start)?iso(start):null,updatedAt:validTime(updated)?iso(updated):null,lifetime,last7Days:null,breakdown:[]};
    }
    // since bounds actual counted events. coverageSince is the independent
    // receipt/reset boundary: late delivery must not invent earlier coverage.
    const start=Number(h.since),coverage=Number(h.coverageSince);
    if(!validTime(start)||start>now)return empty('unavailable');
    let last7Days=null;
    if(validTime(coverage)&&Number.isFinite(configured)&&Math.max(coverage,configured)<=windowStart){
      last7Days={verified:0,unverified:0};
      if(dayHashes.length!==7)return empty('unavailable');
      for(const d of dayHashes){
        const c=counts(checkedHash(d));
        if(!Number.isSafeInteger(last7Days.verified+c.verified)||!Number.isSafeInteger(last7Days.unverified+c.unverified))return empty('unavailable');
        last7Days.verified+=c.verified;last7Days.unverified+=c.unverified;
      }
    }
    const breakdown=[];
    for(const provider of providers)for(const purpose of purposes){
      const verified=Number(h[provider+':'+purpose+':verified']||0),unverified=Number(h[provider+':'+purpose+':unverified']||0);
      if(verified||unverified)breakdown.push({provider,purpose,verified,unverified});
    }
    return {state:h.limited==='1'||site.limited==='1'?'limited':'active',since:iso(start),updatedAt:iso(Number(h.updatedAt)),lifetime,last7Days,breakdown};
  }catch{return empty('unavailable');}
}
