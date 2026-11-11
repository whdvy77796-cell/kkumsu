import { createHash, randomBytes } from 'node:crypto';
import { HttpError, clientId } from './guard.mjs';
import { SESSION_BINDING } from './owner-auth.mjs';
import { validId, normalizeData, verifyPassword, storeKeys } from './stores.mjs';
export const OWNER_LIST_LIMIT = 100;
export const OWNER_LIST_SCAN = 500;
const denied = () => new HttpError(404,'NOT_FOUND','연결된 가게를 찾지 못했어요.');
const bad = () => new HttpError(400,'FIELDS','입력 항목을 확인해 주세요.');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact = (v,keys) => object(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
export function validateOwnerRequest(body) {
  if (!object(body)) throw bad();
  if (body.action==='unlink') {
    if (!exact(body,['action','id'])) throw bad();
    validId(body.id);return {...body};
  }
  if (body.action==='claim') {
    if (!exact(body,['action','id','password'])) throw bad();
    validId(body.id);
    if (typeof body.password!=='string' || body.password.length<8 || body.password.length>64) throw new HttpError(400,'PASSWORD','비밀번호는 8~64자로 입력해 주세요.');
    return {...body};
  }
  if (body.action==='update') {
    if (!exact(body,['action','id','consent','data','expectedRevision'])) throw bad();
    if (typeof body.expectedRevision!=='string' || !/^[a-f0-9]{32}$/.test(body.expectedRevision)) throw bad();
    validId(body.id);
    if (body.consent!==true) throw new HttpError(400,'CONSENT','공개할 정보를 확인하고 동의해 주세요.');
    return {...body,data:normalizeData(body.data)};
  }
  throw bad();
}
export function ownerKeys(scope,accountId,id) {
  if (typeof accountId!=='string' || !accountId || accountId.length>512 || /[\u0000-\u001f\u007f]/.test(accountId)) throw new HttpError(401,'SESSION','로그인이 필요해요.');
  const index=scope.namespace+':owner:'+createHash('sha256').update(accountId).digest('hex');
  return id===undefined ? [index] : [storeKeys(scope,validId(id))[0],index];
}
const project=r=>({id:r.id,data:r.data,hidden:!!r.hidden,updatedAt:r.updatedAt,revision:r.revision});
const conflict=()=>new HttpError(409,'CONFLICT','다른 곳에서 가게 정보가 변경되었어요. 최신 내용을 다시 불러온 뒤 수정해 주세요.');
export async function actOnOwnerStore({store,scope,req,env,accountId,session,input,now=Date.now()}) {
  const proof=session?.[SESSION_BINDING];
  if (!proof || proof.accountId!==accountId || proof.provider!==session.provider || proof.namespace!==scope.namespace || proof.origin!==env.YB_AUTH_ORIGIN || !/^yb:auth:v1:[a-f0-9]{64}:session:[a-f0-9]{64}$/.test(proof.key)) throw new HttpError(401,'SESSION','로그인이 필요해요.');
  if (input.action!=='list') validId(input.id);
  const keys=ownerKeys(scope,accountId,input.id);
  const tx=async(op,p={})=>{
    const r=await store.ownerTransaction(op,[...keys,proof.key],{now,accountId,prefix:scope.namespace+':record:',scopeNamespace:scope.namespace,authOrigin:env.YB_AUTH_ORIGIN,session:proof,...p});
    if (r?.status==='session') throw new HttpError(401,'SESSION','로그인이 필요해요.');
    if (!r || !r.status) throw new HttpError(503,'STORE','저장 상태를 확인하지 못했어요.');
    return r;
  };
  if (input.action==='list') {
    const r=await tx('list',{limit:OWNER_LIST_LIMIT,scan:OWNER_LIST_SCAN});
    if (r.status!=='ok' || !Array.isArray(r.stores)) throw new HttpError(503,'STORE','목록을 확인하지 못했어요.');
    return {stores:r.stores};
  }
  if (input.action==='read') {
    const r=await tx('read'); if (r.status!=='ok') throw denied(); return project(r.record);
  }
  if (input.action==='claim') {
    const secret=env.SESSION_SECRET || env.OPENROUTER_API_KEY || (scope.local?'local-development-only-store-secret':null);
    if (!secret) throw new HttpError(503,'STORE_CONFIG','가게 보안 설정이 아직 안 됐어요.');
    const ipReq={headers:env.VERCEL?{'x-vercel-forwarded-for':req.headers['x-vercel-forwarded-for']}: {},socket:req.socket};
    const ip=clientId(ipReq,secret),ns=scope.namespace;
    // Share the legacy API's exact IP AND target-ID buckets.
    const rate=await store.publicTransaction('rate',storeKeys(scope,input.id),{now,counters:[{key:ns+':limit:auth:ip:'+ip,limit:8,ttl:900},{key:ns+':limit:auth:id:'+input.id,limit:8,ttl:900}]});
    if (rate?.status==='limited') throw new HttpError(429,'RATE_LIMIT','이용 횟수를 초과했어요. 잠시 후 다시 시도해 주세요.');
    if (rate?.status!=='ok') throw new HttpError(503,'STORE','이용 횟수를 확인하지 못했어요.');
  }
  for (let attempt=0;attempt<4;attempt++) {
    let old;
    if (input.action==='claim') {
      old=await store.getJson(keys[0]);
      const matches=await verifyPassword(input.password,old?.password);
      if (!matches || old.deleted || (old.expiresAt && old.expiresAt<=now)) throw new HttpError(403,'AUTH','가게 주소 또는 비밀번호를 확인해 주세요.');
    } else {
      const read=await tx('read'); if (read.status!=='ok') throw denied(); old=read.record;
    }
    if (input.action==='update' && old.revision!==input.expectedRevision) throw conflict();
    const revision=randomBytes(16).toString('hex');
    // The lossless transaction preserves omitted situations and unknown data fields.
    const data=input.data;
    const r=await tx(input.action,{expected:old.revision,revision,data,updatedAt:now});
    if (r.status==='conflict') {if(input.action==='update') throw conflict();continue;}
    if (r.status==='denied' || r.status==='missing') {
      if (input.action==='claim') throw new HttpError(403,'AUTH','이 계정으로 가게를 연결할 수 없어요.');
      throw denied();
    }
    if (r.status==='capacity') throw new HttpError(409,'OWNER_LIMIT','계정당 가게는 최대 100개까지 연결할 수 있어요.');
    if (r.status!=='ok') throw new HttpError(503,'STORE','저장 상태를 확인하지 못했어요.');
    if (input.action==='unlink') return {id:input.id,unlinked:true};
    return input.action==='claim'?{id:input.id,linked:true,url:'/stores/'+input.id}:project(r.record);
  }
  throw new HttpError(409,'BUSY','다른 변경이 진행 중이에요. 내용을 다시 확인해 주세요.');
}
