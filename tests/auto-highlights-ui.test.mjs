import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makePageStart } from '../public/page-start.js';
import { validHighlightLines, syncHighlights, matchingHighlights, translationSourceHash, highlightNumbers } from '../public/page-translations.js';
import { normalizeHighlightLines, highlightNumbers as serverHighlightNumbers } from '../lib/store-highlights.mjs';
import { sourceHash } from '../lib/store-translations.mjs';
const source = () => ({ name: '테스트 가게', address: '서울 마포구 테스트로 12', headline: '차와 함께', intro: '따뜻한 차를 제공합니다.', sections: [{ heading: '메뉴', body: '차 5,000원' }], faqs: [] });
const lines = () => [
 { ko: '차와 함께', en: 'With tea', zh: '与茶相伴', ja: 'お茶と一緒に' },
 { ko: '따뜻한 차를 제공합니다.', en: 'We serve warm tea.', zh: '提供热茶。', ja: '温かいお茶を提供します。' },
 { ko: '차 5,000원', en: 'Tea 5,000 won', zh: '茶 5,000韩元', ja: 'お茶 5,000ウォン' }
];
const response=()=>({draft:{headline:{text:source().headline},intro:{text:source().intro},sections:source().sections,faqs:[],keywords:[]}, highlights:lines()});
function setup(result=response(), mutate=()=>{}) {
 const s=source(),calls=[];
 const initial={status:'confirmed',confirmedIndex:0,result:{candidates:[s]},pageDraft:{store:{name:s.name,address:s.address},answers:{offer:'따뜻한 차'},businessDetails:{phone:'02-1234-5678',hours:'',menu:''}}};
 mutate(initial);
 let stored=JSON.stringify(initial),rendered=[];
 globalThis.sessionStorage={getItem:()=>stored,setItem:(_,v)=>{stored=v;}};
 globalThis.location={hash:'#/page-questions'};
 const h=(tag,attrs,...children)=>({tag,attrs:attrs||{},children:children.flat(Infinity).filter(x=>x!=null&&x!==false),focus(){}});
 const flow=makePageStart({h,show:(...n)=>{rendered=n;},setNavbar:()=>{},btn:(label,onclick)=>h('button',{onclick},label),post:async(url,p)=>{calls.push({url,p:structuredClone(p)});return url==='/api/page-draft'?result:{id:p.id};},storeName:{}});
 const walk=(nodes,p)=>{for(const n of nodes){if(n&&typeof n==='object'){if(p(n))return n;const v=walk(n.children||[],p);if(v)return v;}}};
 const find=p=>walk(rendered,p),node=id=>{const n=find(n=>n.attrs.id===id);assert.ok(n,id);return n;};
 const text=n=>typeof n==='object'?(n.textContent??n.children.map(text).join(' ')):String(n);
 return {flow,calls,find,node,state:()=>JSON.parse(stored),all:()=>rendered.map(text).join(' '),input:(id,value)=>node(id).attrs.oninput({target:{value}}),
 generate(){flow.renderQuestions();node('page-draft-consent').attrs.onchange({target:{checked:true}});return find(n=>n.tag==='form').attrs.onsubmit({preventDefault(){}});},
 publish(){node('publish-password').value='password123';node('publish-password-again').value='password123';node('publish-consent').checked=true;return find(n=>n.tag==='form').attrs.onsubmit({preventDefault(){}});}};
}
test('one draft request creates three language previews and publishes without translation review',async()=>{
 const c=setup();c.flow.renderQuestions();assert.match(c.all(),/같은 AI 요청/);assert.match(c.all(),/중국어 간체/);
 await c.generate();assert.equal(c.calls.length,1);assert.equal(c.state().pageDraft.autoHighlights.status,'ready');
 for(const id of ['translation-consent','translation-generate','publish-translation-review'])assert.equal(c.find(n=>n.attrs.id===id),undefined);
 assert.match(c.all(),/With tea/);assert.match(c.all(),/한국어 원문이 우선/);
 c.flow.renderPublish();await c.publish();assert.equal(c.calls.length,2);
 const data=c.calls[1].p.data;assert.equal(data.highlights.sourceHash,sourceHash(data));assert.equal(data.sections.at(-1).heading,'가게 이용 정보');assert.equal(data.highlights.lines.length,3);
});
test('optional or invalid highlights preserve Korean and never retry',async()=>{
 for(const highlights of [undefined,[],{},lines().slice(0,2),lines().map(r=>({...r,en:'한국어'}))]) {
 const c=setup({...response(),highlights});await c.generate();assert.equal(c.state().pageDraft.draft.headline.text,source().headline);assert.equal(c.state().pageDraft.status,'ready');assert.equal(c.calls.length,1);
 c.flow.renderPreview();c.flow.renderPublish();await c.publish();assert.equal(c.calls.length,2);assert.equal(c.calls[1].p.data.highlights,undefined);
 }
});
test('guards reject off-source excerpts, duplicate, unknown keys, numeric inventions, links, language errors and local facts',()=>{
 assert.equal(validHighlightLines(lines(),source()),true);
 for(const change of [r=>r.ko='없는 소개',r=>r.extra='x',r=>r.en='Tea 24 hours',r=>r.en='https://example.com',r=>r.en='Free parking',r=>r.zh='English only',r=>r.ja='한국어',r=>r.en='Tea\u202e',r=>r.en='x'.repeat(401),r=>r.ko='가'.repeat(201)]) {
 const bad=lines();change(bad[0]);assert.equal(validHighlightLines(bad,source()),false);
 }
 const duplicate=lines();duplicate[1]=duplicate[0];assert.equal(validHighlightLines(duplicate,source()),false);
});
test('public Korean edits invalidate cached highlights and stale lines never publish',async()=>{
 for(const [id,value] of [['page-edit-intro','바뀐 소개'],['page-edit-store-name','다른 이름'],['page-business-phone','02-1111-2222'],['page-business-hours','매일'],['page-business-menu','커피']]) {
 const c=setup();await c.generate();if(id.startsWith('page-business'))c.flow.renderQuestions();else c.flow.renderEdit();c.input(id,value);
 assert.equal(c.state().pageDraft.autoHighlights.status,'stale');c.flow.renderPreview();assert.match(c.all(),/바뀌어/);assert.doesNotMatch(c.all(),/With tea/);
 c.flow.renderPublish();await c.publish();assert.equal(c.calls[1].p.data.highlights,undefined);
 }
 const d={autoHighlights:{status:'ready',fingerprint:JSON.stringify(source()),highlights:{sourceHash:'a'.repeat(64),lines:lines()}}};syncHighlights(d,{...source(),intro:'다른 소개'});syncHighlights(d,source());assert.equal(matchingHighlights(d,source()),null);
});
test('edits during async hash cannot attach old highlights even after revert',async()=>{
 const desc=Object.getOwnPropertyDescriptor(globalThis,'crypto');let finish,started;const began=new Promise(r=>started=r);
 try{
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:(...args)=>new Promise(r=>{finish=()=>r(webcrypto.subtle.digest(...args));started();})}}});
 const c=setup();const pending=c.generate();await began;c.input('page-business-hours','매일');c.input('page-business-hours','');finish();await pending;
 assert.equal(c.state().pageDraft.autoHighlights.status,'stale');assert.equal(c.state().pageDraft.autoHighlights.highlights,undefined);
 }finally{if(desc)Object.defineProperty(globalThis,'crypto',desc);else delete globalThis.crypto;}
});
test('publication rejects a persisted tampered source hash',async()=>{
 const c=setup(response(),s=>{s.pageDraft.businessDetails={phone:'',hours:'',menu:''};s.pageDraft.draft=response().draft;s.pageDraft.autoHighlights={status:'ready',fingerprint:JSON.stringify(source()),highlights:{sourceHash:'0'.repeat(64),lines:lines()}};});
 c.flow.renderPublish();await c.publish();assert.equal(c.calls.length,1);assert.equal(c.calls[0].p.data.highlights,undefined);
});
test('canonical digest ignores translation containers but binds all Korean fields',async()=>{
 const s=source();assert.equal(await translationSourceHash({...s,highlights:{ignored:true}},webcrypto),sourceHash(s));
 assert.notEqual(await translationSourceHash({...s,faqs:[{question:'예약?',answer:'문의'}]},webcrypto),sourceHash(s));
});

test('publication hash await cannot save a Korean edit made after submit',async()=>{
 const c=setup();await c.generate();
 // Retain an edit callback, as navigation can happen while the digest is pending.
 c.flow.renderEdit();const change=c.node('page-edit-intro').attrs.oninput;
 c.flow.renderPublish();
 const desc=Object.getOwnPropertyDescriptor(globalThis,'crypto');let finish,started;const began=new Promise(r=>started=r);
 try {
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto),subtle:{digest:(...args)=>new Promise(r=>{finish=()=>r(webcrypto.subtle.digest(...args));started();})}}});
 const pending=c.publish();await began;
 c.flow.renderEdit();c.input('page-edit-intro','공개 도중 바꾼 소개');finish();await pending;
 assert.equal(c.calls.length,1);assert.equal(c.state().pageDraft.publishAttempt,undefined);assert.equal(c.state().pageDraft.autoHighlights.status,'stale');
 }finally{if(desc)Object.defineProperty(globalThis,'crypto',desc);else delete globalThis.crypto;}
});
test('unavailable crypto preserves generated Korean without retry',async()=>{
 const desc=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 try {Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});const c=setup();await c.generate();assert.equal(c.state().pageDraft.status,'ready');assert.equal(c.state().pageDraft.autoHighlights.status,'error');assert.equal(c.calls.length,1);assert.equal(c.state().pageDraft.draft.intro.text,source().intro);}
 finally{if(desc)Object.defineProperty(globalThis,'crypto',desc);else delete globalThis.crypto;}
});

test('finite Korean quantity tokens exactly match server, including conservative unsupported cases',()=>{
 const cases=[['두 명',['2']],['세 개',['3']],['한 시간',['1']],['두 명과 한 시간',['2','1']],['두 명과 3개',['2','3']],['20명과 두 시간',['20','2']],['스무 명',['20']],['한두 명',null],['두세 명',null],['열두 명',null],['두 명 정도',null],['두 명은 불가',null],['두 명이 아닙니다',null],['두 명은 안 됩니다',null],['약 두 명',null],['- 두 명',null],['두 명과 - 3개',null],['주차 불가',[]],['-2명',['-2']],['+2명',['+2']]];
 for(const [input,expected] of cases){assert.deepEqual(highlightNumbers(input),expected,input);assert.deepEqual(highlightNumbers(input),serverHighlightNumbers(input),input);}
});
test('Korean two people to numeric foreign quantities is accepted by UI and server',()=>{
 for(const [ko,en,zh,ja] of [['두 명이 방문할 수 있어요.','2 people can visit.','2人可以到访。','2人で訪問できます。'],['세 개를 제공해요.','We provide 3 items.','提供3个。','3個提供します。'],['한 시간 이용해요.','Use for 1 hour.','使用1小时。','1時間利用します。'],['두 명과 한 시간','2 people and 1 hour','2人和1小时','2人と1時間']]){
 const s={...source(),headline:ko};const value=lines();value[0]={ko,en,zh,ja};assert.equal(validHighlightLines(value,s),true,ko);assert.deepEqual(normalizeHighlightLines(value,s),value);
 }
});
test('quantity normalization does not permit altered values, order, lost signs, unicode or spaced signs',()=>{
 const ko='두 명과 3개';const s={...source(),headline:ko};
 for(const en of ['3 people and 2 items','2 people and 4 items','-2 people and 3 items','+2 people and 3 items','−2 people and 3 items','- 2 people and 3 items','２ people and 3 items']){
 const value=lines();value[0]={ko,en,zh:'2人和3个',ja:'2人と3個'};assert.equal(validHighlightLines(value,s),false,en);assert.throws(()=>normalizeHighlightLines(value,s),undefined,en);
 }
 for(const [ko,en] of [['-두 명','2 people'],['+두 명','2 people'],['두 명 정도','2 people'],['두 명은 불가','2 people'],['두 명이 아닙니다','2 people'],['두 명은 안 됩니다','2 people'],['한두 명','2 people'],['열두 명','12 people']]){
 const value=lines();value[0]={ko,en,zh:'2人',ja:'2人'};const s={...source(),headline:ko};assert.equal(validHighlightLines(value,s),false,ko);assert.throws(()=>normalizeHighlightLines(value,s),undefined,ko);
 }
});
