import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createStore } from '../lib/guard.mjs';
import { requestScope } from '../lib/stores.mjs';
import { recordAiBatch, REDIS_BATCH_SIZE } from '../lib/ai-access-core.mjs';
import { strictStartedAt, validDedicatedRedis, validAiProjectId } from '../lib/ai-access-config.mjs';
export { strictStartedAt, validDedicatedRedis } from '../lib/ai-access-config.mjs';

export const config = { api: { bodyParser: false } };
export const RAW_LIMIT = 1100000;
// Vercel documents a 1 MB payload, not a 500-row transport batch.
// The larger intake cap is chunked into bounded aggregate transactions.
export const MAX_ROWS = 10000;
// Bound processing work; Redis/official-feed network calls also have their own shorter timeouts.
export const MAX_PROCESSING_MS = 45000;
const reply=(res,status)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(status===200?{ok:true}:{error:'Unavailable'}));};
async function rawBytes(req){
  const length=req.headers['content-length'];
  if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>RAW_LIMIT))throw new Error('BODY');
  // Vercel exposes req.body as a lazy getter: touching it would consume/parse
  // the raw stream before signature verification. Reject an already materialized
  // own body value without ever invoking a getter.
  const bodyDescriptor=Object.getOwnPropertyDescriptor(req,'body');
  if(bodyDescriptor&&Object.hasOwn(bodyDescriptor,'value')&&bodyDescriptor.value!==undefined)throw new Error('BODY');
  const chunks=[];let size=0;
  for await(const chunk of req){
    if(!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))throw new Error('BODY');
    size+=chunk.byteLength;if(size>RAW_LIMIT)throw new Error('BODY');chunks.push(Buffer.from(chunk));
  }
  if(length!==undefined&&Number(length)!==size)throw new Error('BODY');
  return Buffer.concat(chunks);
}
// A production deployment has three confirmed public aliases sharing one
// store namespace. Preview remains strictly bound to its own branch host.
const productionHosts=new Set(['www.kkumsu.com','www.kkumsu.net','kkumsu-rho.vercel.app']);
function candidate(row,scope,project,started,now){
  if(!row||typeof row!=='object'||Array.isArray(row)||!['static','lambda'].includes(row.source)||row.projectId!==project||row.environment!==(scope.production?'production':'preview')||row.customEnvironment)return null;
  const p=row.proxy;
  // Vercel's top-level host can be the generated deployment hostname while
  // proxy.host is the actual requested public host. The signed proxy host,
  // project and environment together define the allowed collection boundary.
  if(!p||typeof p!=='object'||Array.isArray(p)||(scope.production?!productionHosts.has(p.host):p.host!==scope.host)||p.method!=='GET'||!Number.isInteger(p.statusCode)||p.statusCode<200||p.statusCode>299||[p.wafAction,row.wafAction].some(v=>v!==undefined&&!['log','bypass'].includes(v)))return null;
  if(!Number.isSafeInteger(p.timestamp)||p.timestamp<started||p.timestamp>now+300000)return null;
  if(typeof p.path!=='string'||p.path.length>8192)return null;
  const pathname=p.path.split('?')[0];
  const match=/^\/stores\/([A-Za-z0-9_-]{22})$/.exec(pathname);
  if(!['/','/stores'].includes(pathname)&&!match)return null;
  const requestId=p.vercelId??row.requestId;
  if(typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:.-]{7,255}$/.test(requestId))return null;
  let ua=p.userAgent;
  if(Array.isArray(ua)){if(ua.length!==1)return null;ua=ua[0];}
  if(typeof ua!=='string'||!ua||ua.length>2048)return null;
  // Drains can omit/mask IPs. Preserve the known UA as an unverified candidate.
  const clientIp=typeof p.clientIp==='string'&&p.clientIp.length<=64?p.clientIp:null;
  return {id:createHash('sha256').update(requestId).digest('hex'),at:p.timestamp,storeId:match?match[1]:null,userAgent:ua,clientIp};
}
export function createHandler(deps={}){
  return async function handler(req,res){
    try{
      const env=deps.env||process.env;
      const clock=typeof deps.clock==='function'?deps.clock:()=>performance.now();
      const deadline=clock()+MAX_PROCESSING_MS;
      const checkDeadline=()=>{if(clock()>=deadline)throw new Error('AI_ACCESS_DEADLINE');};
      if(env.YB_AI_ACCESS_ENABLED!=='true')return reply(res,404);
      const secret=env.YB_AI_ACCESS_DRAIN_SECRET,started=strictStartedAt(env.YB_AI_ACCESS_STARTED_AT);
      const now=typeof deps.now==='function'?deps.now():deps.now??Date.now();
      if(typeof secret!=='string'||Buffer.byteLength(secret)<32||!validAiProjectId(env.YB_AI_ACCESS_PROJECT_ID)||started===null||started>now)return reply(res,503);
      if(req.method!=='POST'){res.setHeader('Allow','POST');return reply(res,405);}
      // Accept only JSON, optionally declaring UTF-8. Signature verification
      // still uses the original bytes, never decoded/re-serialized content.
      const contentType=req.headers['content-type'];
      const encoding=req.headers['content-encoding'];
      if((encoding!==undefined&&String(encoding).toLowerCase()!=='identity')||typeof contentType!=='string'||!/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:"utf-8"|utf-8))?[ \t]*$/i.test(contentType))return reply(res,415);
      const signature=req.headers['x-vercel-signature'];
      if(typeof signature!=='string'||! /^[a-fA-F0-9]{40}$/.test(signature))return reply(res,403);
      const raw=await rawBytes(req),expected=createHmac('sha1',secret).update(raw).digest();
      checkDeadline();
      if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return reply(res,403);
      const scope=requestScope(req,env);
      // Isolated credentials only. No fallback to the site's normal KV or dev store.
      let store=deps.store;
      if(!store){
        if(!validDedicatedRedis(env))return reply(res,503);
        store=createStore({VERCEL:'1',KV_REST_API_URL:env.YB_AI_ACCESS_REDIS_URL,KV_REST_API_TOKEN:env.YB_AI_ACCESS_REDIS_TOKEN});
      }
      if(!store)return reply(res,503);
      const rows=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
      if(!Array.isArray(rows)||rows.length>MAX_ROWS)return reply(res,503);
      const classifier=deps.identifyBot||(await import('../lib/ai-bots.mjs')).identifyBot;
      const events=[];
      // Classify the whole batch before writing, so classifier failure is not a
      // partial success. Sequential bounded evaluation avoids lookup fan-out.
      for(const row of rows){
        checkDeadline();
        const c=candidate(row,scope,env.YB_AI_ACCESS_PROJECT_ID,started,now);if(!c)continue;
        const bot=await classifier({userAgent:c.userAgent,clientIp:c.clientIp,now});if(!bot)continue;
        events.push({id:c.id,at:c.at,storeId:c.storeId,provider:bot.provider,purpose:bot.purpose,verification:bot.verification});
      }
      const record=deps.recordBatch||recordAiBatch;
      for(let offset=0;offset<events.length;offset+=REDIS_BATCH_SIZE){
        checkDeadline();
        await record({store,scope,events:events.slice(offset,offset+REDIS_BATCH_SIZE),now});
      }
      return reply(res,200);
    }catch{return reply(res,503);}
  };
}
export default createHandler();
