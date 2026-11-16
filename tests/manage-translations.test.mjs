import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManageTranslations, effectiveTranslationSource } from '../public/manage-translations.js';
import { translationSourceHash } from '../public/page-translations.js';
const base = () => ({ name:'합성 가게', address:'서울 합성 12', headline:'커피', intro:'가격 3000원', sections:[], faqs:[] });
const h = (tag,attrs,...children) => ({tag,attrs:attrs || {},children:children.flat(Infinity),checked:false,handlers:{},addEventListener(n,f){this.handlers[n]=f;},replaceChildren(...kids){this.children=kids.flat(Infinity);}});
const btn = (text,onclick) => h('button',{onclick},text);
function find(n,key) { if(n?.attrs?.[key]) return n; for(const c of n?.children || []) { const x=find(c,key); if(x)return x; } }
const approve = (panel,key) => { const x=find(panel,key); x.checked=true; x.handlers.change(); };
const response = async source => ({translations:{sourceHash:await translationSourceHash(source),en:structuredClone(source),ja:structuredClone(source),zh:structuredClone(source)}});
function setup(post) { let source=base(), calls=0, time=0; const ui=makeManageTranslations({h,btn,post:async(p,b)=>{calls++;assert.equal(p,'/api/store-translate');assert.equal(b.consent,true);return post(b.data);},readSource:()=>source,now:()=>time}); const panel=ui.render(); return {ui,panel,get calls(){return calls;},set source(x){source=x;},advance(){time+=30001;}}; }
test('consent, three previews, explicit review, no automatic save',async()=>{
 const x=setup(response); await x.ui.request(); assert.equal(x.calls,0);
 approve(x.panel,'data-translation-consent'); await x.ui.request(); assert.equal(x.calls,1);
 assert.equal((await x.ui.attach(base())).translations,undefined);
 approve(x.panel,'data-translation-reviewed'); const data=await x.ui.attach(base()); assert.ok(data.translations.en); assert.ok(data.translations.ja);assert.ok(data.translations.zh);assert.equal(x.calls,1);
});
test('edits during request including edit/revert discard response',async()=>{
 let resolve; const x=setup(source=>new Promise(r=>{resolve=async()=>r(await response(source));})); approve(x.panel,'data-translation-consent');const pending=x.ui.request(); while(!resolve) await new Promise(r=>setTimeout(r,1));
 x.ui.invalidate(); await resolve();await pending; approve(x.panel,'data-translation-reviewed');assert.equal((await x.ui.attach(base())).translations,undefined);
});
test('hash mismatch and failures do not retry or replace Korean',async()=>{
 const x=setup(async source=>{const r=await response(source);r.translations.sourceHash='0'.repeat(64);return r;});approve(x.panel,'data-translation-consent');await x.ui.request();approve(x.panel,'data-translation-reviewed');assert.deepEqual(await x.ui.attach(base()),base());assert.equal(x.calls,1);
 const y=setup(async()=>{throw Error('timeout');});approve(y.panel,'data-translation-consent');await y.ui.request();assert.equal(y.calls,1);assert.deepEqual(await y.ui.attach(base()),base());
});
test('changed fingerprint prevents reviewed upload even without input event',async()=>{
 const x=setup(response);approve(x.panel,'data-translation-consent');await x.ui.request();approve(x.panel,'data-translation-reviewed');x.source={...base(),name:'다른 가게'};await assert.rejects(x.ui.attach(base()),/원문/);
});
test('cost protection blocks repeated requests and caps three',async()=>{
 const x=setup(response);approve(x.panel,'data-translation-consent');await x.ui.request();await x.ui.request();assert.equal(x.calls,1);for(let i=0;i<4;i++){x.advance();await x.ui.request();}assert.equal(x.calls,3);
});
test('preserved situations participate in source hash and explicit reviewed update',async()=>{
 const original={...base(),situations:[{question:'비 오는 날?',answer:'실내 2석'}]};const source=effectiveTranslationSource(base(),original);assert.deepEqual(source.situations,original.situations);assert.notEqual(await translationSourceHash(source),await translationSourceHash(base()));
 const x=setup(response);x.source=source;approve(x.panel,'data-translation-consent');await x.ui.request();approve(x.panel,'data-translation-reviewed');const outgoing=await x.ui.attach(base());assert.deepEqual(outgoing.situations,original.situations);assert.equal(outgoing.translations.sourceHash,await translationSourceHash(outgoing));
 assert.deepEqual(effectiveTranslationSource({...base(),situations:[]},original).situations,[]);
});
test('missing situation translations cannot be reviewed',async()=>{
 const x=setup(async source=>{const r=await response(source);delete r.translations.en.situations;return r;});x.source={...base(),situations:[{question:'질문',answer:'답'}]};approve(x.panel,'data-translation-consent');await x.ui.request();approve(x.panel,'data-translation-reviewed');assert.equal((await x.ui.attach(base())).translations,undefined);
});

// Full UI integration: keep ordinary save timing and CAS/route contracts intact.
import { makeAccountUI } from '../public/account-ui.js';
const ID = 'abcdefghijklmnopqrstuv', OTHER = 'bbbbbbbbbbbbbbbbbbbbbb';
const R1 = 'a'.repeat(32), R2 = 'b'.repeat(32);
const uiWalk = (n, predicate) => { if (!n || typeof n !== 'object') return null; if (predicate(n)) return n; for (const child of n.children || []) { const found = uiWalk(child, predicate); if (found) return found; } return null; };
async function editor(original = base(), updater = async data => ({ revision:R2, data })) {
  globalThis.location = { origin:'https://example.test', hash:'#/my-stores/' + ID };
  globalThis.window = { open(){} };
  const state = { nodes:[], calls:[] };
  const hh = (tag,attrs,...children) => { const el=h(tag,attrs,...children);el.value=attrs?.value ?? '';return el; };
  const ui=makeAccountUI({ h:hh, btn:(text,onclick)=>hh('button',{onclick},text), show:(...nodes)=>{state.nodes=nodes.flat(Infinity);},setNavbar(){},storeName:{},confirmFn:()=>true,
    fetcher:async()=>({ok:true,status:200,json:async()=>({id:ID,data:structuredClone(original),revision:R1})}),
    post:async(p,b)=>{state.calls.push({p,b});return p==='/api/store-translate'?response(b.data):updater(b.data);}
  });
  await ui.renderAccountEdit(ID);
  const get=predicate=>uiWalk({children:state.nodes},predicate);
  const control=key=>get(x=>x.attrs?.[key]);
  const check=key=>{const x=control(key);x.checked=true;x.handlers.change();};
  const click=text=>get(x=>x.tag==='button' && x.children.join('')===text).attrs.onclick();
  const type=(id,value)=>{const x=get(x=>x.attrs?.id===id);x.value=value;x.handlers.input();};
  const confirm=()=>{const x=get(x=>x.attrs?.id==='acc-confirm');x.checked=true;x.handlers.change();};
  return {ui,state,get,control,check,click,type,confirm};
}
test('UI Korean-only save still starts synchronously and preserves in-flight typing',async()=>{
 let release; const gate=new Promise(r=>{release=r;});const e=await editor(base(),async data=>{await gate;return {revision:R2,data};});
 e.type('acc-name','먼저 보낸 이름');e.confirm();const saving=e.click('변경사항 반영하기');assert.equal(e.state.calls.length,1);e.type('acc-name','나중 입력');release();await saving;
 assert.equal(e.ui.isEditingDirty(),true);assert.equal(e.get(x=>x.attrs?.id==='acc-name').value,'나중 입력');assert.equal(e.state.calls[0].b.expectedRevision,R1);
});
const noTranslateUi = e => {
  assert.equal(e.get(x => x.tag === 'button' && /번역/.test(x.children.join(''))), null);
  assert.equal(e.control('data-translation-consent'), null); assert.equal(e.control('data-translation-reviewed'), null); assert.equal(e.control('data-manage-translations'), null);
};
const storeTranslateCalls = e => e.state.calls.filter(x => x.p === '/api/store-translate');
test('UI has no translate button, consent or review; save is one CAS update and never calls the translate API',async()=>{
 const original={...base(),situations:[{question:'합성 질문',answer:'좌석 2개'}],translations:{sourceHash:'x'.repeat(64),en:base()},highlights:{sourceHash:'y'.repeat(64),lines:[]}};const e=await editor(original);noTranslateUi(e);
 e.type('acc-name','새 이름');e.confirm();await e.click('변경사항 반영하기');
 assert.equal(e.state.calls.length,1);assert.equal(storeTranslateCalls(e).length,0);
 const call=e.state.calls[0];assert.equal(call.p,'/api/owner-stores');assert.equal(call.b.action,'update');assert.equal(call.b.expectedRevision,R1);assert.equal(call.b.data.name,'새 이름');
 assert.equal(Object.hasOwn(call.b.data,'translations'),false,'edit never uploads generated translations');assert.equal(Object.hasOwn(call.b.data,'highlights'),false,'edit never uploads highlights');
 assert.equal(Object.hasOwn(call.b.data,'situations'),false,'untouched preserved situations are not sent; the server keeps them');
});
test('UI Korean edit sends no translation request even for a page without stored translations, and keeps the original CAS revision',async()=>{
 const e=await editor();noTranslateUi(e);e.type('acc-intro','새 소개');e.confirm();await e.click('변경사항 반영하기');
 assert.equal(e.state.calls.length,1);assert.equal(storeTranslateCalls(e).length,0);assert.equal(e.state.calls[0].b.expectedRevision,R1);
});
test('UI navigation during an in-flight save never redraws the old editor or posts a second request',async()=>{
 let release;const gate=new Promise(r=>{release=r;});const e=await editor(base(),async data=>{await gate;return {revision:R2,data};});e.type('acc-name','먼저 보낸 이름');e.confirm();const saving=e.click('변경사항 반영하기');
 assert.equal(e.state.calls.length,1);location.hash='#/my-stores/'+OTHER;await e.ui.renderAccountEdit(OTHER);e.type('acc-name','새 편집기 입력');const shown=e.state.nodes;release();await saving;
 assert.equal(e.state.calls.length,1);assert.equal(e.state.nodes,shown);assert.equal(e.ui.isEditingDirty(),true);assert.equal(e.get(x=>x.attrs?.id==='acc-name').value,'새 편집기 입력');assert.equal(storeTranslateCalls(e).length,0);
});
test('UI late update response cannot clear another editor dirty state',async()=>{
 let release;const gate=new Promise(r=>{release=r;});const e=await editor(base(),async data=>{await gate;return {revision:R2,data};});e.confirm();const saving=e.click('변경사항 반영하기');
 while(e.state.calls.length<1) await new Promise(r=>setTimeout(r,1));location.hash='#/my-stores/'+OTHER;await e.ui.renderAccountEdit(OTHER);e.type('acc-name','새 입력');const shown=e.state.nodes;release();await saving;
 assert.equal(e.state.nodes,shown);assert.equal(e.ui.isEditingDirty(),true);assert.equal(e.get(x=>x.attrs?.id==='acc-name').value,'새 입력');
});