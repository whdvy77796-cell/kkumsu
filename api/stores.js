import { HttpError, send, readJson, createStore } from '../lib/guard.mjs';
import { BODY_LIMIT, requestScope, checkStoreOrigin, validateRequest, actOnStore, publicStore, renderStore, renderUnavailable, renderDirectory } from '../lib/stores.mjs';
export function createHandler(deps={}) {
  return async function handler(req,res) {
    try {
      const env=deps.env || process.env,scope=requestScope(req,env);
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','no-referrer');
      if (!scope.production) res.setHeader('X-Robots-Tag','noindex, nofollow');
      if (!['GET','POST'].includes(req.method)) {res.setHeader('Allow','GET, POST');throw new HttpError(405,'METHOD','GET 또는 POST 요청만 지원해요.');}
      if (req.method==='POST') checkStoreOrigin(req,scope);
      const store=deps.store || createStore(env,deps.fetcher || fetch);
      if (!store || typeof store.publicTransaction!=='function') throw new HttpError(503,'STORE_CONFIG','가게 저장소가 준비되지 않았어요.');
      if (req.method==='POST') {
        const body=await readJson(req,BODY_LIMIT),input=validateRequest(body);
        const result=await actOnStore({store,scope,req,env,input});
        return send(res,result.status,result.body);
      }
      const url=new URL(req.url || '/api/stores','https://'+scope.host);
      const query=name=>{const value=req.query?.[name] ?? url.searchParams.get(name);if (Array.isArray(value)) throw new HttpError(400,'QUERY','요청 주소를 확인해 주세요.');return value;};
      const view=query('view');
      if (view==='directory' || view==='page') {
        let html;
        try { html=view==='directory'?await renderDirectory(store,scope,query('page') || '1'):renderStore(scope,await publicStore(store,scope,query('id'))); }
        catch (err) {
          if (view!=='page' || !(err instanceof HttpError) || err.code!=='NOT_FOUND') throw err;
          html=renderUnavailable(scope,query('id'));
          res.statusCode=404; res.setHeader('X-Robots-Tag','noindex, nofollow');
        }
        if (res.statusCode!==404) res.statusCode=200;
        res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
        res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        return res.end(html);
      }
      if (view) throw new HttpError(400,'QUERY','요청 주소를 확인해 주세요.');
      return send(res,200,await publicStore(store,scope,query('id')));
    } catch(err) {
      return send(res,err instanceof HttpError?err.status:503,{error:err instanceof HttpError?err.message:'가게 저장 상태를 확인하지 못했어요. 같은 주소로 다시 확인해 주세요.',code:err instanceof HttpError?err.code:'STORE'});
    }
  };
}
export default createHandler();
