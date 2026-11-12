/** ISOLATED, NOT WIRED TO HTTP. A migration building block, not release approval.
 * Existing Google accountId, cookie/session key, raw fields and TTL are retained.
 * Grant issuer remains BLOCKED: never create grants from a login or missing key.
 * Reuses prior per-account authority validation; single-primary Redis only.
 */
import { ACTIVE_GUARD_LUA } from './withdrawal-redis.mjs';
export const LEGACY_ADOPT_LUA = ACTIVE_GUARD_LUA + String.raw`
if #KEYS~=3 or KEYS[1]==KEYS[2] or KEYS[1]==KEYS[3] or KEYS[2]==KEYS[3] then return result('invalid') end
local p=request();if not p then return result('invalid') end
local a=authority(KEYS[1]);if not a then return result('authority-missing-or-corrupt') end
if a.state~='active' then return result('barrier') end
if not tuple(a,p) or a.incarnation~=p.incarnation or a.fence~=p.fence then return result('epoch') end
if p.provider~='google' then return result('legacy-provider') end
if type(KEYS[2])~='string' or #KEYS[2]~=148 or not string.match(KEYS[2],'^yb:auth:v1:%x+:session:%x+$') then return result('session') end
if KEYS[3]~=a.base..':legacy-adoption:'..redis.sha1hex(KEYS[2]) then return result('grant-key') end
local s,raw=read(KEYS[2]);local now=nowms()
if not s or not tuple(s,a) or not opaque(s.binding) or s.binding~=p.binding or not integer(s.issuedAt) or not integer(s.expiresAt) or s.issuedAt>now or s.expiresAt<=now or s.expiresAt-s.issuedAt~=604800000 or redis.call('PTTL',KEYS[2])<=0 then return result('session') end
-- Exact raw CAS is a migration requirement, not an optional hint.
if type(p.expectedRaw)~='string' or raw~=p.expectedRaw then return result('conflict') end
if s.incarnation~=nil or s.fence~=nil then return result('already-versioned') end
local g=read(KEYS[3])
if not g or redis.call('PTTL',KEYS[3])<=0 or g.kind~='reconciled-legacy-session' or not tuple(g,a) or g.incarnation~=a.incarnation or g.fence~=a.fence or g.sessionKey~=KEYS[2] or g.expectedRaw~=raw or not integer(g.expiresAt) or g.expiresAt<=now then return result('adoption-authority') end
-- Retain raw session bytes, including unknown fields and exact numeric lexemes.
-- Append only to an object explicitly checked by the lossless JS preparer.
if type(p.replacementRaw)~='string' or #p.replacementRaw>8192 then return result('invalid') end
local ok,next=pcall(cjson.decode,p.replacementRaw)
if not ok or type(next)~='table' or not tuple(next,s) or next.binding~=s.binding or next.issuedAt~=s.issuedAt or next.expiresAt~=s.expiresAt or next.incarnation~=a.incarnation or next.fence~=a.fence then return result('invalid') end
-- Grant binds the exact reviewed bytes; arbitrary caller replacement is rejected.
if g.replacementRaw~=p.replacementRaw then return result('adoption-authority') end
redis.call('SET',KEYS[2],p.replacementRaw,'KEEPTTL')
redis.call('DEL',KEYS[3])
return result('adopted',{accountId=a.accountId,incarnation=a.incarnation,fence=a.fence})
`;

// No grant/authority issuer is exported. Lifecycle authority must already exist
// from an independent durable reconciliation, not inferred from this snapshot.
export function prepareLegacySession(raw, authority) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw)>7000) throw Error('RAW_UNSAFE');
  // Conservatively reject duplicate keys (including escaped spellings) without
  // rewriting any JSON. Nested values are accepted only through a duplicate-key
  // scan of every object; large numeric values remain untouched in raw output.
  let i=0;
  function ws(){while (/\s/.test(raw[i]||'') && i<raw.length)i++;}
  function str(){const start=i++;while(i<raw.length){if(raw[i]==='\\'){i+=2;continue;}if(raw[i++]==='"')return JSON.parse(raw.slice(start,i));}throw Error('RAW_UNSAFE');}
  function value(){ws();if(raw[i]==='"'){str();return;}if(raw[i]==='{'){i++;ws();const seen=new Set();if(raw[i]==='}'){i++;return;}while(i<raw.length){ws();if(raw[i]!=='"')throw Error('RAW_UNSAFE');const key=str();if(seen.has(key))throw Error('RAW_UNSAFE');seen.add(key);ws();if(raw[i++]!==':')throw Error('RAW_UNSAFE');value();ws();if(raw[i]==='}'){i++;return;}if(raw[i++]!==',')throw Error('RAW_UNSAFE');}throw Error('RAW_UNSAFE');}if(raw[i]==='['){i++;ws();if(raw[i]===']'){i++;return;}while(i<raw.length){value();ws();if(raw[i]===']'){i++;return;}if(raw[i++]!==',')throw Error('RAW_UNSAFE');}throw Error('RAW_UNSAFE');}const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(i));if(!m)throw Error('RAW_UNSAFE');i+=m[0].length;}
  value();ws();if(i!==raw.length)throw Error('RAW_UNSAFE');
  const s=JSON.parse(raw);
  if(!s||Array.isArray(s)||typeof s!=='object'||Object.hasOwn(s,'incarnation')||Object.hasOwn(s,'fence'))throw Error('RAW_UNSAFE');
  if(!authority || authority.state!=='active' || !/^[A-Za-z0-9_-]{43}$/.test(authority.incarnation) || !Number.isSafeInteger(authority.fence) || authority.fence<1 || authority.fence>1000000000000)throw Error('AUTHORITY');
  for(const key of ['accountId','provider','origin','namespace'])if(s[key]!==authority[key])throw Error('TUPLE');
  if(s.provider!=='google')throw Error('LEGACY_PROVIDER');
  const end=raw.lastIndexOf('}');
  return raw.slice(0,end)+',"incarnation":'+JSON.stringify(authority.incarnation)+',"fence":'+authority.fence+raw.slice(end);
}
