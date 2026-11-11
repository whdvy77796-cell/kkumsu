import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDiagnosisStart } from '../public/diagnosis-start.js';
import { readFile } from 'node:fs/promises';

function harness(existing = {}) {
  const state={rendered:[],nav:[],begins:[],confirms:0,allow:false};
  const h=(tag,attrs,...children)=>({tag,attrs:attrs||{},children:children.flat(Infinity).filter(x=>x!=null&&x!==false),value:attrs?.value||'',checked:false,focus(){this.focused=true},textContent:''});
  const flow=makeDiagnosisStart({h,show:(...x)=>{state.rendered=x.flat(Infinity)},setNavbar:(...x)=>{state.nav=x},btn:(label,onclick)=>h('button',{onclick},label),storeName:{textContent:'old'},getState:()=>existing,begin:(...v)=>state.begins.push(v),confirmOverwrite:()=>{state.confirms++;return state.allow}});
  const find=(pred)=>{function walk(n){if(!n||typeof n!=='object')return null;if(pred(n))return n;for(const c of n.children||[]){const r=walk(c);if(r)return r}return null}for(const r of state.rendered){const v=walk(r);if(v)return v}return null};
  flow.render();
  return {state,find,name:find(n=>n.attrs?.name==='diagnosisName'),address:find(n=>n.attrs?.name==='diagnosisAddress'),consent:find(n=>n.attrs?.id==='diagnosisSearchConsent'),submit:find(n=>n.tag==='button'&&n.children.includes('동의하고 가게 찾기'))};
}

test('diagnosis entry validates fields and explicit consent before beginning',()=>{
  const x=harness();x.submit.attrs.onclick();assert.equal(x.state.begins.length,0);assert.ok(x.name.focused);
  x.name.value='카페';x.address.value='서울';x.submit.attrs.onclick();assert.equal(x.state.begins.length,0);assert.ok(x.address.focused);
  x.address.value='서울 마포구 연습로 12';x.submit.attrs.onclick();assert.equal(x.state.begins.length,0);assert.ok(x.consent.focused);
  x.consent.checked=true;x.name.value='  연습   가게  ';x.submit.attrs.onclick();assert.deepEqual(x.state.begins,[['연습 가게','서울 마포구 연습로 12']]);assert.equal(x.state.confirms,0);
});

test('an existing diagnosis is not replaced unless its owner confirms',()=>{
  const prior={name:'기존 가게',answers:{q1:{v:'보존'}}};const copy=structuredClone(prior);const x=harness(prior);
  x.name.value='새 가게';x.address.value='서울 마포구 연습로 12';x.consent.checked=true;x.submit.attrs.onclick();
  assert.equal(x.state.confirms,1);assert.equal(x.state.begins.length,0);assert.deepEqual(prior,copy);
  x.state.allow=true;x.submit.attrs.onclick();assert.equal(x.state.confirms,2);assert.deepEqual(x.state.begins,[['새 가게','서울 마포구 연습로 12']]);
});

test('homepage route, protected retry and legacy storage remain integrated',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(app,/const KEY = 'maechul\.v3'/);assert.match(app,/href: '#\/diagnosis-start'/);
  assert.match(app,/hash === '#\/diagnosis-start'\) diagnosisStartFlow\.render\(\)/);
  assert.match(app,/S\.findProtected && !diagnosisFindAuthorized/);
  assert.match(app,/자동으로 다시 보내지 않았어요/);assert.match(app,/findProtected: true/);
  assert.match(app,/진단 검색 이어보기/);assert.match(app,/S\.findProtected \|\| Object\.keys\(S\.answers\)\.length/);
});
