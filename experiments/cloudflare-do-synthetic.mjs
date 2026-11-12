// SYNTHETIC TEST ONLY. Not a production collector or storage implementation.
// This isolated prototype accepts no raw logs, IP addresses, or User-Agent values.
import { DurableObject } from 'cloudflare:workers';
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export default {async fetch(req,env){
 try {
  const enc=new TextEncoder();
  const given=await crypto.subtle.digest('SHA-256',enc.encode(req.headers.get('authorization')||''));
  const expected=await crypto.subtle.digest('SHA-256',enc.encode('Bearer '+env.TEST_KEY));
  if(!crypto.subtle.timingSafeEqual(given,expected))return response({error:'denied'},403);
  if(req.method!=='POST'||new URL(req.url).pathname!=='/test')return response({error:'not found'},404);
  const raw=await req.text();if(raw.length>4096)return response({error:'too large'},413);
  const v=JSON.parse(raw);if(!v||Array.isArray(v)||typeof v!=='object')return response({error:'invalid'},400);
  const keys=Object.keys(v).sort().join(',');
  if(v.op==='read'&&keys!=='op')return response({error:'invalid'},400);
  if(v.op==='add'&&(keys!=='day,id,op,provider,verification'||!/^[a-f0-9]{32}$/.test(v.id)||!/^\d{4}-\d{2}-\d{2}$/.test(v.day)||!['openai','google','anthropic'].includes(v.provider)||!['verified','unverified'].includes(v.verification)))return response({error:'invalid'},400);
  if(!['add','read'].includes(v.op))return response({error:'invalid'},400);
  return await env.COUNTER.get(env.COUNTER.idFromName('synthetic-only-v1')).fetch('https://do.invalid/',{method:'POST',body:raw});
 }catch{return response({error:'unavailable'},503);}
}};
export class SyntheticCounter extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.sql=ctx.storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, provider TEXT NOT NULL, verification TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(day,provider,verification))');}
 async fetch(req){try{
  const v=await req.json();
  if(v.op==='add'){const added=this.ctx.storage.transactionSync(()=>{
   const inserted=this.sql.exec('INSERT OR IGNORE INTO seen(id) VALUES (?) RETURNING id',v.id).toArray().length===1;
   if(inserted)this.sql.exec('INSERT INTO counts(day,provider,verification,n) VALUES (?,?,?,1) ON CONFLICT(day,provider,verification) DO UPDATE SET n=n+1',v.day,v.provider,v.verification);
   return inserted;});return response({added});}
  if(v.op==='read'){const rows=this.sql.exec('SELECT day,provider,verification,n FROM counts ORDER BY day,provider,verification').toArray();const seen=this.sql.exec('SELECT COUNT(*) AS n FROM seen').one().n;return response({rows,seen,storageBytes:this.sql.databaseSize});}
  return response({error:'invalid'},400);
 }catch{return response({error:'storage'},503);}}
}
