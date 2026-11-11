import { HttpError, send, readJson, createStore } from '../lib/guard.mjs';
import { BODY_LIMIT, requestScope, checkStoreOrigin } from '../lib/stores.mjs';
import { validateOwnerRequest, actOnOwnerStore, ownerKeys } from '../lib/owner-stores.mjs';
const authenticateDefault=async args=>(await import('../lib/owner-auth.mjs')).requireSession(args);
export function createHandler(deps={}) {
  return async function handler(req,res) {
    try {
      const env=deps.env || process.env,scope=requestScope(req,env),now=typeof deps.now==='function'?deps.now():deps.now ?? Date.now();
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');
      if (!['GET','POST'].includes(req.method)) {res.setHeader('Allow','GET, POST');throw new HttpError(405,'METHOD','GET 또는 POST 요청만 지원해요.');}
      if (req.method==='POST') checkStoreOrigin(req,scope);
      const store=deps.store || createStore(env,deps.fetcher || fetch);
      if (!store || typeof store.ownerTransaction!=='function' || typeof store.publicTransaction!=='function') throw new HttpError(503,'STORE_CONFIG','가게 저장소가 준비되지 않았어요.');
      const session=await (deps.authenticate || authenticateDefault)({req,store,scope,env,now});
      const accountId=session?.accountId;ownerKeys(scope,accountId);
      let input;
      if (req.method==='POST') input=validateOwnerRequest(await readJson(req,BODY_LIMIT));
      else {
        const url=new URL(req.url || '/api/owner-stores','https://'+scope.host);
        const query=name=>{const value=req.query?.[name] ?? url.searchParams.get(name);if(Array.isArray(value) || url.searchParams.getAll(name).length>1) throw new HttpError(400,'QUERY','요청 주소를 확인해 주세요.');return value;};
        const op=query('op');
        if (op==='list') input={action:'list'};
        else if (op==='read') input={action:'read',id:query('id')};
        else throw new HttpError(400,'QUERY','요청 주소를 확인해 주세요.');
      }
      return send(res,200,await actOnOwnerStore({store,scope,req,env,accountId,session,input,now}));
    } catch(err) {
      return send(res,err instanceof HttpError?err.status:503,{error:err instanceof HttpError?err.message:'가게 저장 상태를 확인하지 못했어요. 같은 주소로 다시 확인해 주세요.',code:err instanceof HttpError?err.code:'STORE'});
    }
  };
}
export default createHandler();
