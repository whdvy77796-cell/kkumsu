import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHandler } from '../api/stores.js';
import { MemoryStore } from '../lib/guard.mjs';
import { requestScope, storeKeys } from '../lib/stores.mjs';
import { SITEMAP_PAGE_SIZE, MAX_SITEMAP_PAGES } from '../lib/sitemap.mjs';

const ENV={VERCEL:'1',VERCEL_ENV:'production',SESSION_SECRET:'synthetic-test-secret'};
const HOST='www.lookhereai.com';
const req=(view,host=HOST)=>{const r=Readable.from([]);r.method='GET';r.url='/api/stores?'+view;r.headers={host};r.socket={remoteAddress:'127.0.0.1'};return r;};
const res=()=>({statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(v){this.body=v;}});
async function call(h,view,host){const out=res();await h(req(view,host),out);return out;}
const scope=requestScope(req(''),ENV);
const id=n=>String(n).padStart(22,'0');
const data={name:'Synthetic',address:'Test address',headline:'Test',intro:'Test',sections:[],faqs:[]};
async function seed(st,n,extra={}){
 const key=storeKeys(scope,id(n));
 const record={id:id(n),data,createdAt:n+1,updatedAt:n+1,revision:'synthetic',hidden:false,expiresAt:null,password:{hash:'never-publish'},...extra};
 return st.publicTransaction('create',key,{now:Date.now(),record,ttl:0,counters:[]});
}
const urls=body=>[...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]);

test('automatic index and bounded pages contain only valid canonical public links',async()=>{
 const st=new MemoryStore(),h=createHandler({env:ENV,store:st});
 for(let n=0;n<205;n++)await seed(st,n);
 // Leave stale index members deliberately: metadata checks must still exclude them.
 for(const [n,patch] of [[2,{hidden:true}],[3,{deleted:true}],[4,{expiresAt:Date.now()-1000}]]){
  const key=storeKeys(scope,id(n))[0],record=JSON.parse(st.kv.get(key));st.kv.set(key,JSON.stringify({...record,...patch}));
 }
 const index=await call(h,'view=sitemap-index');assert.equal(index.statusCode,200,index.body);
 assert.match(index.headers['content-type'],/^application\/xml/);assert.equal(index.headers['cache-control'],'no-store');
 const pages=Math.ceil(205/SITEMAP_PAGE_SIZE);
 assert.deepEqual(urls(index.body),Array.from({length:pages},(_,i)=>'https://www.lookhereai.com/sitemaps/stores/'+(i+1)));
 const results=[];for(let n=1;n<=pages;n++){const p=await call(h,'view=sitemap-page&page='+n);assert.equal(p.statusCode,200);results.push(p);}
 const all=results.flatMap(p=>urls(p.body));assert.equal(all.length,202);assert.equal(new Set(all).size,202);
 for(const n of [2,3,4])assert.ok(!all.includes('https://www.lookhereai.com/stores/'+id(n)));
 assert.ok(all.includes('https://www.lookhereai.com/stores/'+id(0)));
 assert.ok(results.every(p=>!/never-publish|password|updatedAt|lastmod/.test(p.body)));
 assert.equal(st.kv.get(scope.namespace+':directory').size,205,'sitemap GET must not change the existing directory index');
 // Fresh requests show new and hidden records without waiting for an application cache.
 await seed(st,206);let p=await call(h,'view=sitemap-page&page=1');assert.ok(urls(p.body).includes('https://www.lookhereai.com/stores/'+id(206)));
 const key=storeKeys(scope,id(206))[0];st.kv.set(key,JSON.stringify({...JSON.parse(st.kv.get(key)),hidden:true}));
 p=await call(h,'view=sitemap-page&page=1');assert.ok(!urls(p.body).includes('https://www.lookhereai.com/stores/'+id(206)));
 const oldDomain=await call(h,'view=sitemap-page&page=1','www.kkumsu.com');assert.equal(oldDomain.statusCode,200);assert.ok(!oldDomain.body.includes('www.kkumsu.com'));
});

test('preview uses its own noindex host and isolated records; invalid hosts and pages fail closed',async()=>{
 const st=new MemoryStore(),preview=createHandler({env:{...ENV,VERCEL_ENV:'preview'},store:st});
 const previewHost='qa.vercel.app',previewScope=requestScope(req('',previewHost),{...ENV,VERCEL_ENV:'preview'});
 await st.publicTransaction('create',storeKeys(previewScope,id(10)),{now:Date.now(),record:{id:id(10),data,createdAt:1,hidden:false,expiresAt:null},ttl:7200,counters:[]});
 await seed(st,11);
 const index=await call(preview,'view=sitemap-index',previewHost);assert.equal(index.statusCode,200);assert.match(index.headers['x-robots-tag'],/noindex/);assert.ok(index.body.includes('https://qa.vercel.app/sitemaps/stores/1'));assert.ok(!index.body.includes('www.lookhereai.com'));
 const isolated=await call(preview,'view=sitemap-page&page=1',previewHost);assert.equal(isolated.statusCode,200);assert.match(isolated.headers['x-robots-tag'],/noindex/);assert.ok(isolated.body.includes('https://qa.vercel.app/stores/'+id(10)));assert.ok(!isolated.body.includes(id(11)));
 for(const view of ['view=sitemap-index','view=sitemap-page&page=1']){
  const out=await call(preview,view,'preview.example.com');assert.equal(out.statusCode,404);assert.match(out.headers['x-robots-tag'],/noindex/);assert.ok(!out.body.includes('/stores/'));
 }
 const h=createHandler({env:ENV,store:st});
 for(const page of ['0','-1','1.5','0001','50001','a','']){
  const out=await call(h,'view=sitemap-page&page='+page);assert.equal(out.statusCode,400,page);
 }
 const invalid={publicTransaction:async(op)=>op==='sitemap-meta'?{status:'ok',total:MAX_SITEMAP_PAGES*SITEMAP_PAGE_SIZE+1}:{status:'ok',ids:['<unsafe>']}};
 assert.equal((await call(createHandler({env:ENV,store:invalid}),'view=sitemap-index')).statusCode,503);
 assert.equal((await call(createHandler({env:ENV,store:invalid}),'view=sitemap-page&page=1')).statusCode,503);
});

test('robots points to old static and new index; routes preserve existing store routes',async()=>{
 const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
 const [robots,config,existing,dev]=await Promise.all(['site/robots.txt','vercel.json','site/sitemap.xml','scripts/dev.mjs'].map(read));
 assert.match(robots,/^Sitemap: https:\/\/www\.lookhereai\.com\/sitemap\.xml\s*$/m);
 assert.match(robots,/^Sitemap: https:\/\/www\.lookhereai\.com\/sitemap-stores\.xml\s*$/m);
 assert.ok(existing.includes('<loc>https://www.lookhereai.com/</loc>'));assert.ok(existing.includes('<loc>https://www.lookhereai.com/stores</loc>'));
 const rewrites=JSON.parse(config).rewrites;
 assert.ok(rewrites.some(r=>r.source==='/sitemap-stores.xml'&&r.destination==='/api/stores?view=sitemap-index'));
 assert.ok(rewrites.some(r=>r.source==='/sitemaps/stores/:page'&&r.destination==='/api/stores?view=sitemap-page&page=:page'));
 assert.ok(rewrites.some(r=>r.source==='/stores/:id'&&r.destination==='/api/stores?view=page&id=:id'));
 assert.ok(dev.includes("url.pathname === '/sitemap-stores.xml'"));
});
