/**
 * EXPERIMENT ONLY, based on WIP 0102668. Not connected to any route.
 *
 * INTEGRATION CONTRACT / SECURITY BOUNDARY:
 * Permanent authority is ONE signed registry STRING, never expiring. Account
 * incarnation/epoch/tombstone and exact ownership manifest live together. Derived
 * barriers/indexes are never authority. Missing key/type/TTL/signature fails closed.
 * initializeVerifiedEmpty is ONLY for an independently verified NEW namespace;
 * NEVER invoke it on missing authority. Losing the key AND completeness evidence
 * cannot be recovered or proven deleted using internal data. An older valid whole
 * signed registry can be replayed by storage rollback: external durable monotonic
 * checkpoints/backups and reconciliation are REQUIRED; HMAC is not anti-rollback.
 *
 * API mutators return {next,result}. CAS exact input.raw -> next using CAS_LUA;
 * expose result ONLY after confirmed commit. On timeout outcome is UNKNOWN: reread.
 * CAS has one SET after all checks: no multiwrite Lua rollback assumption. This
 * module does not include a Redis client and its tests are synthetic, not Redis.
 * A registry write affects only the target account epoch, not other sessions.
 *
 * Authenticate provider identity before choosing account id. issueOAuth is an
 * identity-bound lifecycle fence, NOT OAuth state/PKCE/CSRF. Capture it BEFORE
 * asynchronous work, exchange after provider validation. Unknown identity at
 * OAuth start requires independent durable pre-provider state/fresh-consent flow;
 * do not mint a new lifecycle fence at callback and call it a stale-callback fix.
 * Sessions require authorize on EVERY operation, atomically coupled to the real
 * store mutation. authorize followed by a separate write has a TOCTOU race.
 *
 * claim ONLY changes the registry sidecar and assumes independently authorized
 * ownership/password proof. Real public records/sidecars must bind account AND
 * incarnation AND scope/store id. Exact manifest membership is also required.
 * Legacy accountId-only owners are NOT imported/inherited/detached. Production
 * ownership is UNKNOWN, not assumed absent. Public ID/URL/password/data/TTL/raw
 * remain untouched here. Multi-resource atomic claim/unlink integration is NOT
 * supplied. NEVER chain this CAS and a separate store write as a transaction.
 *
 * begin freezes manifest and bumps this account epoch. cleanupPlan is NOT deletion
 * proof. acknowledge accepts an attestation signed with a DISTINCT trusted cleanup
 * verifier key, bound to exact complete manifest/incarnation/operation. That
 * verifier must durably detach/reconcile EVERY id, preserve raw bytes and TTL,
 * check revisions, reject ambiguous/missing records and partial external writes.
 * An empty/partial index is NOT evidence. A signature authenticates the verifier,
 * not truth of its claim. There is intentionally no receipt issuer in this module.
 * Unverified deletion stays deleting and prevents re-registration.
 *
 * Tombstones/manifests must persist; privacy retention policy is unresolved. This
 * bounded single-registry prototype is not a scalable production architecture.
 * External-effect atomicity, rollback prevention, provider unlink, durable storage,
 * recovery, rotation and full OAuth integration remain BLOCKED prerequisites.
 * WIP's five TODO tests remain unchanged. Passing this suite is NOT their fix.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const fail = code => { throw Object.assign(new Error(code), {code}); };
const exact = (x, keys) => x && Object.getPrototypeOf(x)===Object.prototype && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const integer = x => Number.isSafeInteger(x) && x>=0;
const idOK = x => typeof x==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const hex = x => typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const canonical = x => JSON.stringify(x, function(k,v) { return v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v; });
const digest = x => createHash('sha256').update(canonical(x)).digest('hex');
const unique = a => new Set(a).size===a.length;
const nonce = () => randomBytes(32).toString('hex');
const root = links => ({count:links.length,hash:digest(links.map(x=>({id:x.id,inc:x.inc})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0))});
export const CAS_LUA = `
local t=redis.call('TYPE',KEYS[1]); if type(t)=='table' then t=t.ok end
if t~='string' then return 'BLOCKED_TYPE' end
if redis.call('PTTL',KEYS[1])~=-1 then return 'BLOCKED_TTL' end
if redis.call('GET',KEYS[1])~=ARGV[1] then return 'CONFLICT' end
redis.call('SET',KEYS[1],ARGV[2]); return 'OK'
`;
export function createAccountLifecycle({scope,secret,receiptSecret}) {
  if (!idOK(scope) || typeof secret!=='string' || secret.length<32 || typeof receiptSecret!=='string' || receiptSecret.length<32 || secret===receiptSecret) fail('CONFIG');
  function seal(data,key=secret) { const payload=canonical(data); return canonical({payload,mac:createHmac('sha256',key).update(payload).digest('hex')}); }
  function open(raw,key=secret) {
    try { if(typeof raw!=='string'||raw.length>4_000_000) fail('CORRUPT'); const e=JSON.parse(raw);
      if(!exact(e,['payload','mac'])||typeof e.payload!=='string'||!hex(e.mac)||canonical(e)!==raw) fail('CORRUPT');
      const mac=createHmac('sha256',key).update(e.payload).digest(); if(!timingSafeEqual(mac,Buffer.from(e.mac,'hex'))) fail('SIGNATURE');
      const p=JSON.parse(e.payload); if(canonical(p)!==e.payload) fail('CORRUPT'); return p;
    } catch(e) { if(e.code) throw e; fail('CORRUPT'); }
  }
  function check(a) {
    if(!exact(a,['id','inc','epoch','status','sessions','links','manifest','operation','used'])||!idOK(a.id)||!hex(a.inc)||!integer(a.epoch)||!['active','deleting','deleted'].includes(a.status)||!Array.isArray(a.sessions)||a.sessions.length>1000||!Array.isArray(a.links)||a.links.length>100||!Array.isArray(a.used)||a.used.length>1000) fail('CORRUPT');
    if(!unique(a.sessions.map(s=>s?.id))||!unique(a.links.map(l=>l?.id))||!unique(a.used.map(s=>s?.id))) fail('CORRUPT');
    for(const s of a.sessions) if(!exact(s,['id','epoch','exp'])||!hex(s.id)||!integer(s.epoch)||!integer(s.exp)||s.epoch>a.epoch) fail('CORRUPT');
    for(const u of a.used) if(!exact(u,['id','exp'])||!hex(u.id)||!integer(u.exp)) fail('CORRUPT');
    for(const l of a.links) if(!exact(l,['id','inc'])||!idOK(l.id)||l.inc!==a.inc) fail('CORRUPT');
    if(canonical(a.manifest)!==canonical(root(a.links))) fail('MANIFEST');
    if(a.status==='active'&&a.operation!==null) fail('CORRUPT');
    if(a.status!=='active'&&(!exact(a.operation,['id','inc','epoch','manifest'])||!hex(a.operation.id)||a.operation.inc!==a.inc||a.operation.epoch!==a.epoch||canonical(a.operation.manifest)!==canonical(a.manifest))) fail('CORRUPT');
    if(a.status==='deleted'&&a.sessions.length) fail('CORRUPT');
  }
  function inspect(cell) {
    if(!cell||cell.type!=='string') fail('AUTHORITY_MISSING_OR_TYPE'); if(cell.ttl!==-1) fail('AUTHORITY_TTL');
    const r=open(cell.raw); if(!exact(r,['v','scope','serial','accounts'])||r.v!==1||r.scope!==scope||!integer(r.serial)||!Array.isArray(r.accounts)||r.accounts.length>1000||!unique(r.accounts.map(a=>a?.id))) fail('CORRUPT');
    r.accounts.forEach(check); return r;
  }
  const time = n => {if(!integer(n)||n>Number.MAX_SAFE_INTEGER-3_600_000) fail('TIME');};
  const account = (r,id) => {if(!idOK(id)) fail('ID');return r.accounts.find(a=>a.id===id);};
  function finish(r,result) { r.serial++; if(!integer(r.serial)) fail('EXHAUSTED'); r.accounts.forEach(check); return {next:seal(r),result}; }
  function grant(kind,a,now,extra={}) { time(now); return seal({v:1,scope,kind,id:a.id,inc:a.inc,epoch:a.epoch,iat:now,exp:now+60_000,jti:nonce(),...extra}); }
  function parseGrant(raw,kind,now,extra=[]) {
    time(now); const g=open(raw); if(!exact(g,['v','scope','kind','id','inc','epoch','iat','exp','jti',...extra])||g.v!==1||g.scope!==scope||g.kind!==kind||!idOK(g.id)||!(g.inc===null||hex(g.inc))||!(g.epoch===null||integer(g.epoch))||!integer(g.iat)||!integer(g.exp)||g.exp-g.iat!==60_000||g.iat>now||now>=g.exp||!hex(g.jti)) fail('GRANT'); return g;
  }
  function match(a,g) { if(!a||a.inc!==g.inc||a.epoch!==g.epoch) fail('FENCE'); }
  function session(r,token,now) {
    time(now); const s=open(token); if(!exact(s,['v','scope','kind','id','inc','epoch','sid','exp'])||s.v!==1||s.scope!==scope||s.kind!=='session'||!hex(s.sid)||!integer(s.exp)||now>=s.exp) fail('SESSION');
    const a=account(r,s.id); match(a,s); if(a.status!=='active'||!a.sessions.some(x=>x.id===s.sid&&x.epoch===s.epoch&&x.exp===s.exp)) fail('SESSION'); return {a,s};
  }
  const api = {
    initializeVerifiedEmpty() {return seal({v:1,scope,serial:0,accounts:[]});},
    inspect,
    issueOAuth(cell,id,now) {const r=inspect(cell),a=account(r,id); if(a?.status==='deleting') fail('DELETING');return grant('oauth',a||{id,inc:null,epoch:null},now);},
    exchange(cell,token,now) {
      const r=inspect(cell),g=parseGrant(token,'oauth',now); let a=account(r,g.id);
      if(a) { match(a,g); if(a.status==='deleting') fail('DELETING'); if(a.used.some(u=>u.id===g.jti)) fail('REPLAY'); }
      else {if(g.inc!==null||g.epoch!==null||r.accounts.length>=1000) fail('FENCE'); a={id:g.id,inc:nonce(),epoch:0,status:'active',sessions:[],links:[],manifest:root([]),operation:null,used:[]};r.accounts.push(a);}
      if(a.status==='deleted') { a.inc=nonce();a.epoch=0;a.status='active';a.sessions=[];a.links=[];a.manifest=root([]);a.operation=null;a.used=[]; }
      a.used=a.used.filter(x=>x.exp>now);a.sessions=a.sessions.filter(x=>x.exp>now);
      if(a.used.length>=1000||a.sessions.length>=1000) fail('CAPACITY');
      a.used.push({id:g.jti,exp:g.exp}); const s={v:1,scope,kind:'session',id:a.id,inc:a.inc,epoch:a.epoch,sid:nonce(),exp:now+3_600_000};a.sessions.push({id:s.sid,epoch:s.epoch,exp:s.exp});return finish(r,seal(s));
    },
    authorize(cell,token,now) {const {a,s}=session(inspect(cell),token,now);return {id:a.id,inc:a.inc,epoch:a.epoch,sid:s.sid};},
    authorizeLink(cell,token,id,now) {const {a}=session(inspect(cell),token,now); if(!idOK(id)||!a.links.some(l=>l.id===id&&l.inc===a.inc)) fail('NOT_OWNED');return {id,accountId:a.id,inc:a.inc};},
    claim(cell,token,id,now) {const r=inspect(cell),{a}=session(r,token,now);if(!idOK(id)) fail('ID');if(r.accounts.some(x=>x.status!=='deleted'&&x.links.some(l=>l.id===id)&&x.id!==a.id)) fail('OWNED');if(!a.links.some(l=>l.id===id)){if(a.links.length>=100) fail('CAPACITY');a.links.push({id,inc:a.inc});a.manifest=root(a.links);} return finish(r,{id,inc:a.inc});},
    issueBegin(cell,token,now) {const {a,s}=session(inspect(cell),token,now);return grant('begin',a,now,{sid:s.sid});},
    begin(cell,token,now) {const r=inspect(cell),g=parseGrant(token,'begin',now,['sid']),a=account(r,g.id);if(!hex(g.sid)) fail('GRANT');
      if(a&&a.inc===g.inc&&a.operation?.id===g.jti&&a.operation.epoch===g.epoch+1) return {next:cell.raw,result:{status:a.status,operation:a.operation.id}};
      match(a,g);if(a.status!=='active'||!a.sessions.some(s=>s.id===g.sid&&s.epoch===g.epoch&&s.exp>now)) fail('SESSION');
      a.epoch++;if(!integer(a.epoch)) fail('EXHAUSTED');a.status='deleting';a.operation={id:g.jti,inc:a.inc,epoch:a.epoch,manifest:{...a.manifest}};return finish(r,{status:'deleting',operation:g.jti});},
    cleanupPlan(cell,id) {const a=account(inspect(cell),id);if(!a||a.status==='active') fail('NOT_DELETING');return {v:1,scope,kind:'detached',id:a.id,inc:a.inc,operation:a.operation.id,epoch:a.epoch,manifest:{...a.manifest},ids:a.links.map(l=>l.id).sort()};},
    acknowledge(cell,receipt,now) {time(now);const r=inspect(cell),p=open(receipt,receiptSecret);if(!exact(p,['v','scope','kind','id','inc','operation','epoch','manifest','ids','verifiedAt'])||!integer(p.verifiedAt)||p.verifiedAt>now||now-p.verifiedAt>60_000) fail('RECEIPT');
      const expected=api.cleanupPlan(cell,p.id),{verifiedAt,...proof}=p;if(canonical(proof)!==canonical(expected)) fail('RECEIPT');const a=account(r,p.id);if(a.status==='deleted')return {next:cell.raw,result:{status:'deleted'}};a.status='deleted';a.sessions=[];return finish(r,{status:'deleted'});
    }
  };
  return Object.freeze(api);
}
