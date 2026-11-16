// Synthetic fixtures and injected transports only. Never contacts a live API/store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeStoreTools } from '../public/store-tools.js';
import { makeAccountUI } from '../public/account-ui.js';
const ID = 'abcdefghijklmnopqrstuv', OTHER = 'zyxwvutsrqponmlkjihgfe';
const R1 = 'a'.repeat(32), R2 = 'b'.repeat(32);
const base = () => ({ name:'합성 가게', address:'서울', headline:'커피', intro:'소개', sections:[], faqs:[], situations:[{question:'  기존 질문?  ',answer:'  원본 답변  '}] });
const full = () => ({ ...base(), translations:{sourceHash:'old-hash',en:{headline:'Legacy exact text'},status:'ready'} });
const highlights = () => ({ ...base(), highlights:{status:'ready',sourceHash:'old-hash',ko:['기존 요약'],en:['Legacy highlight']} });
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
// Container roots/arrays are traversable but are not DOM elements. Predicates
// only receive h()-created elements, each with its own attributes object.
const walk = (n,p) => {
  if (!n || typeof n !== 'object') return null;
  if (typeof n.tag === 'string' && n.attrs && typeof n.attrs === 'object' && p(n)) return n;
  const children = Array.isArray(n) ? n : Array.isArray(n.children) ? n.children : [];
  for (const child of children) { const found = walk(child,p); if (found) return found; }
  return null;
};
const allText = n => typeof n === 'string' ? n : !n || typeof n !== 'object' ? '' : [n.textContent || '',...(n.children || []).map(allText)].join(' ');
async function editor(kind, original, update, latest) {
  globalThis.location = {origin:'https://example.test',hash:kind==='account'?'#/my-stores/'+ID:'#/manage/'+ID};
  globalThis.window = {open(){}};
  const state={nodes:[],calls:[],reads:[]};
  const h=(tag,attrs,...children)=>({tag,attrs:attrs || {},children:children.flat(Infinity).filter(x=>x!==null && x!==undefined && x!==false),value:attrs?.value ?? '',checked:false,handlers:{},addEventListener(n,f){this.handlers[n]=f;},append(...n){this.children.push(...n);},replaceChildren(...n){this.children=n;},setAttribute(k,v){this.attrs[k]=v;}});
  const env={h,btn:(label,onclick)=>h('button',{onclick},label),show:(...n)=>{state.nodes=n.flat(Infinity);},setNavbar(){},storeName:{},confirmFn:()=>true,
    post:async(p,b)=>{state.calls.push({p,b});assert.ok(['/api/stores','/api/owner-stores'].includes(p),'no AI/translation endpoint');if(b.action==='auth')return {data:original};assert.equal(b.action,'update');return update ? update(b) : {ok:true,revision:R2,data:{...original,...b.data}};},
    fetcher:async p=>{state.reads.push(p);assert.match(p,/^\/api\/owner-stores\?op=read&/);return {ok:true,status:200,json:async()=>state.reads.length>1 && latest ? latest : {data:original,revision:R1}};}};
  const get=p=>walk({children:state.nodes},p), input=id=>get(x=>x.attrs.id===id);
  const click=label=>{const b=get(x=>x.tag==='button' && x.children.join('')===label);assert.ok(b,label);return b.attrs.onclick();};
  const ui=kind==='account'?makeAccountUI(env):makeStoreTools(env);
  if(kind==='account')await ui.renderAccountEdit(ID);else {ui.renderManage(ID);get(x=>x.attrs.type==='password').value='synthetic-only';await click('관리 시작');}
  const type=(field,value)=>{const el=input(kind==='account'?'acc-'+field:'f-'+field);assert.ok(el,'editable '+field);el.value=value;el.handlers.input();};
  const confirm=()=>{const el=input(kind==='account'?'acc-confirm':'verified');assert.ok(el,'save confirmation');el.checked=true;el.handlers.change();};
  const save=()=>click(kind==='account'?'변경사항 반영하기':'저장하기');
  return {state,ui,get,input,click,type,confirm,save,text:()=>allText({children:state.nodes})};
}
function noTranslationUI(e) {
  assert.equal(e.get(x=>Object.keys(x.attrs).some(k=>/translation-(consent|reviewed|panel)/.test(k))),null);
  assert.doesNotMatch(e.text(),/다국어 다시 번역|새 번역을 검토|번역에 사용한 한국어 원문|번역 생성 동의/);
  assert.equal(e.state.calls.filter(c=>c.b.action!=='auth').length,0,'entry does not generate or save');
}
for(const kind of ['password','account']) {
  test(kind+': full/highlights/mixed entry removes generation controls without mutating original',async()=>{
    for(const fixture of [full(),highlights(),{...full(),highlights:highlights().highlights},base()]) {
      const expected=structuredClone(fixture);freeze(fixture);
      const e=await editor(kind,fixture);noTranslationUI(e);assert.deepEqual(fixture,expected);
      if(fixture.translations || fixture.highlights) {
        assert.ok(e.get(x=>x.attrs['data-translation-warning']));assert.match(e.text(),/한국어 정보를 바꾸면 기존 .*공개 화면에서 자동으로 숨겨집니다/);
        if(fixture.highlights)assert.match(e.text(),/요약/);
      } else assert.equal(e.get(x=>x.attrs['data-translation-warning']),null);
    }
  });
  test(kind+': ordinary save omits derived data and preserves original translation/status',async()=>{
    const fixture={...full(),highlights:highlights().highlights};const expected=structuredClone(fixture);freeze(fixture);
    const e=await editor(kind,fixture);e.type('name','새 합성 이름');e.confirm();await e.save();
    const calls=e.state.calls.filter(c=>c.b.action==='update');assert.equal(calls.length,1);
    const b=calls[0].b;assert.equal(b.data.name,'새 합성 이름');assert.equal(b.consent,true);
    for(const key of ['translations','highlights','translationStatus','highlightsStatus'])assert.equal(Object.hasOwn(b.data,key),false);
    assert.deepEqual(fixture,expected);
    if(kind==='account'){assert.equal(b.expectedRevision,R1);assert.equal(Object.hasOwn(b.data,'situations'),false,'unchanged legacy questions omitted for server raw preservation');}
    else assert.deepEqual(b.data.situations,[{question:'기존 질문?',answer:'원본 답변'}],'existing password cleaning contract unchanged');
    assert.match(e.text(),/공개 화면에서 자동으로 숨겨집니다/);
  });
  test(kind+': in-flight edits survive save and require reconfirmation',async()=>{
    let release;const gate=new Promise(r=>{release=r;});const fixture=full();
    const e=await editor(kind,fixture,async b=>{await gate;return {revision:R2,data:{...fixture,...b.data}};});
    e.type('name','전송한 이름');e.confirm();const saving=e.save();assert.equal(e.state.calls.filter(c=>c.b.action==='update').length,1);
    e.type('name','저장 중 입력');release();await saving;
    assert.equal(e.input(kind==='account'?'acc-name':'f-name').value,'저장 중 입력');assert.equal(e.input(kind==='account'?'acc-confirm':'verified').checked,false);
    if(kind==='account')assert.equal(e.ui.isEditingDirty(),true);assert.match(e.text(),/저장.*새로/);
  });
}
test('account: conflict retains inputs, requires latest and consent, keeps CAS and omitted situations',async()=>{
  let attempt=0;const fixture=full();const e=await editor('account',fixture,async b=>{if(++attempt===1)throw Object.assign(new Error('conflict'),{status:409});return {revision:R1,data:{...fixture,...b.data}};},{data:fixture,revision:R2});
  e.type('name','내 입력');e.confirm();await e.save();assert.ok(e.get(x=>x.attrs['data-conflict']==='conflict'));assert.equal(e.input('acc-name').value,'내 입력');
  await e.save();assert.equal(attempt,1);await e.click('서버 최신 내용 불러와 비교하기');e.confirm();await e.save();assert.equal(attempt,1);
  const ow=e.input('acc-overwrite');ow.checked=true;ow.handlers.change();e.confirm();await e.save();assert.equal(attempt,2);
  assert.equal(e.state.calls[1].b.expectedRevision,R2);assert.equal(Object.hasOwn(e.state.calls[1].b.data,'situations'),false);assert.equal(Object.hasOwn(e.state.calls[1].b.data,'translations'),false);
});
test('account: late save cannot redraw another editor or clear its dirty input',async()=>{
  let release;const gate=new Promise(r=>{release=r;});const fixture=full();const e=await editor('account',fixture,async b=>{await gate;return {revision:R2,data:{...fixture,...b.data}};});
  e.type('name','전송');e.confirm();const saving=e.save();location.hash='#/my-stores/'+OTHER;await e.ui.renderAccountEdit(OTHER);e.type('name','다른 편집 입력');const nodes=e.state.nodes;release();await saving;
  assert.equal(e.state.nodes,nodes);assert.equal(e.ui.isEditingDirty(),true);assert.equal(e.input('acc-name').value,'다른 편집 입력');
});
test('both management modules have no generation import, endpoint, render or attach path',async()=>{
  for(const file of ['store-tools.js','account-ui.js']) {
    const code=await readFile(new URL('../public/'+file,import.meta.url),'utf8');
    assert.doesNotMatch(code,/makeManageTranslations|effectiveTranslationSource|store-translate|translation\.(render|attach|pending|hasReviewed)/);
  }
});
