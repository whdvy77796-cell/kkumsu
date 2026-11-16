import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePageStart } from '../public/page-start.js';
import { syncTranslations, matchingTranslations, validTranslations, normalizeTranslationSource, translationSourceHash } from '../public/page-translations.js';
import { sourceHash as serverSourceHash, normalizeSourceData } from '../lib/store-translations.mjs';
import { webcrypto } from 'node:crypto';
const source = () => ({ name: '테스트 가게', address: '서울 마포구 테스트로 12', headline: '차와 함께', intro: '따뜻한 차를 제공합니다.', sections: [{heading:'메뉴',body:'차 5,000원'}], faqs: [{question:'예약?',answer:'방문 전 문의'}] });
const result = data => ({translations:{sourceHash:serverSourceHash(data), ...Object.fromEntries(['en','ja','zh'].map(lang => [lang, {...structuredClone(data), headline:lang+' headline'}]))}});
function setup(post, mutate = () => {}) {
  const s = source();
  const initial = {status:'confirmed', confirmedIndex:0, result:{candidates:[s]}, pageDraft:{store:{name:s.name,address:s.address},answers:{},draft:{headline:{text:s.headline},intro:{text:s.intro},sections:s.sections,faqs:s.faqs,keywords:[]},businessDetails:{phone:'',hours:'',menu:''}}};
  mutate(initial);
  let stored=JSON.stringify(initial), rendered=[];
  globalThis.sessionStorage={getItem:()=>stored,setItem:(_,v)=>{stored=v;}};
  globalThis.location={hash:'#/page-preview'};
  const h=(tag,attrs,...children)=>({tag,attrs:attrs||{},children:children.flat(Infinity).filter(x=>x!=null&&x!==false),focus(){}});
  const args={h,show:(...nodes)=>{rendered=nodes;},setNavbar:()=>{},btn:(label,onclick)=>h('button',{onclick},label),post,storeName:{}};
  let flow=makePageStart(args);
  const walk=(nodes,p)=>{for(const n of nodes){if(n&&typeof n==='object'){if(p(n)) return n; const found=walk(n.children||[],p);if(found)return found;}}};
  const find=p=>walk(rendered,p);
  const node=id=>{const n=find(n=>n.attrs.id===id);assert.ok(n,id);return n;};
  const text=n=>typeof n==='object'?(n.textContent??n.children.map(text).join(' ')):String(n);
  return {get flow(){return flow;}, reload(){flow=makePageStart(args);}, node,find,text, all:()=>rendered.map(text).join(' '), state:()=>JSON.parse(stored),
    generate(){return node('translation-generate').attrs.onclick();}, consent(){node('translation-consent').checked=true;},
    input(id,value){node(id).attrs.oninput({target:{value}});},
    publish(){return find(n=>n.tag==='form').attrs.onsubmit({preventDefault(){}});},
    credentials(){node('publish-password').value='password123';node('publish-password-again').value='password123';node('publish-consent').checked=true;}};
}
test('explicit consent, only six Korean fields, one request and ordered previews',async()=>{
  const calls=[];let resolve;
  const c=setup((url,payload)=>{calls.push({url,payload});return new Promise(r=>resolve=r);});
  c.flow.renderPreview();await c.generate();assert.equal(calls.length,0);assert.match(c.all(),/OpenRouter/);assert.match(c.all(),/실제 비용/);
  c.consent();const pending=c.generate();await c.generate();assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/store-translate');assert.equal(calls[0].payload.consent,true);
  assert.deepEqual(Object.keys(calls[0].payload.data),['name','address','headline','intro','sections','faqs']);
  resolve(result(calls[0].payload.data));await pending;
  assert.equal(c.state().pageDraft.translation.status,'ready');
  const all=c.all();assert.ok(all.indexOf('en headline')<all.indexOf('ja headline'));assert.ok(all.indexOf('ja headline')<all.indexOf('zh headline'));
  assert.match(all,/한국어 원문이 우선/);
});
test('timeout preserves Korean draft, does not retry on reload, permits Korean-only publication',async()=>{
  let calls=0;const c=setup(async()=>{calls++;throw Object.assign(new Error('timeout'),{code:'TIMEOUT'});});
  const before=c.state().pageDraft.draft;c.flow.renderPreview();c.consent();await c.generate();
  assert.equal(c.state().pageDraft.draft.headline.text,before.headline.text);assert.equal(calls,1);assert.match(c.all(),/자동 재시도하지 않았어요/);
  c.reload();c.flow.renderPreview();assert.equal(calls,1);c.flow.renderPublish();assert.match(c.all(),/한국어로만 공개/);assert.equal(c.find(n=>n.attrs.id==='publish-translation-review'),undefined);
});
test('loaded pending request does not auto-resend',()=>{
  let calls=0;const c=setup(()=>calls++,s=>{const fingerprint=JSON.stringify(source());s.pageDraft.translation={status:'pending',fingerprint,requestFingerprint:fingerprint};});
  c.flow.renderPreview();assert.equal(calls,0);assert.match(c.all(),/이전 응답을 확인하지 못했어요/);
});
test('every Korean field and business information invalidates previously generated translations',async()=>{
  for(const [id,value] of [['page-edit-store-name','새 상호'],['page-edit-store-address','서울 다른 주소 12'],['page-edit-headline','새 제목'],['page-edit-intro','새 소개'],['page-edit-section-0-body','가격 6,000원'],['page-edit-faq-0-answer','예약 불가'],['page-business-phone','02-1234-5678'],['page-business-hours','매일 10시'],['page-business-menu','차 6,000원']]){
    const c=setup(async(_,p)=>result(p.data));c.flow.renderPreview();c.consent();await c.generate();
    if(id.startsWith('page-business'))c.flow.renderQuestions();else c.flow.renderEdit();c.input(id,value);
    assert.equal(c.state().pageDraft.translation.status,'stale',id);c.flow.renderPublish();assert.equal(c.find(n=>n.attrs.id==='publish-translation-review'),undefined,id);
  }
});
test('edit while translation request pending cannot attach a stale response, even after revert',async()=>{
  let resolve;const c=setup((_,p)=>new Promise(r=>resolve=()=>r(result(p.data))));c.flow.renderPreview();c.consent();const pending=c.generate();
  c.flow.renderEdit();c.input('page-edit-intro','changed');c.input('page-edit-intro',source().intro);resolve();await pending;
  assert.equal(c.state().pageDraft.translation.status,'stale');assert.equal(c.state().pageDraft.translation.translations,undefined);
});
test('separate translation review gates publication and uncertain retry preserves exact snapshot',async()=>{
  const calls=[];const c=setup(async(url,p)=>{calls.push({url,p:structuredClone(p)});if(url==='/api/store-translate')return result(p.data);throw Object.assign(new Error('timeout'),{code:'TIMEOUT'});});
  c.flow.renderPreview();c.consent();await c.generate();c.flow.renderPublish();c.credentials();await c.publish();
  assert.equal(calls.length,1);assert.match(c.all(),/번역까지 검토/);
  c.node('publish-translation-review').checked=true;await c.publish();assert.equal(calls.length,2);
  const original=calls[1].p.data;assert.ok(original.translations);assert.equal(c.state().pageDraft.publishAttempt.status,'uncertain');
  c.flow.renderEdit();c.input('page-edit-intro','Changed after uncertain publish');c.flow.renderPublish();c.credentials();c.node('publish-translation-review').checked=true;await c.publish();
  assert.deepEqual(calls[2].p.data,original);assert.equal(calls[2].p.id,calls[1].p.id);
});
test('8-section limit includes business section; oversized drafts never trigger paid translation',async()=>{
  let calls=0;const c=setup(()=>calls++,s=>{s.pageDraft.draft.sections=Array.from({length:8},(_,i)=>({heading:'항목'+i,body:'내용'}));s.pageDraft.businessDetails.phone='02-1234-5678';});
  c.flow.renderEdit();assert.equal(c.find(n=>n.tag==='button'&&c.text(n)==='소개 섹션 추가').attrs.disabled,true);
  c.flow.renderPreview();c.consent();await c.generate();assert.equal(calls,0);assert.match(c.all(),/최대 8개/);
});
test('partial translation responses rejected and mismatched fingerprint never included',()=>{
  const s=source(), good=result(s).translations;assert.equal(validTranslations(good,s),true);assert.equal(validTranslations({...good,ja:null},s),false);
  const d={translation:{status:'ready',fingerprint:JSON.stringify(s),requestFingerprint:'wrong',translations:good}};assert.equal(matchingTranslations(d,s),null);
  syncTranslations(d,{...s,intro:'changed'});assert.equal(d.translation.status,'stale');
});

test('Web Crypto hash matches server NFC, trim, field ordering and empty pair normalization', async () => {
  const data = { faqs: [{ answer: '  ', question: '' }, { answer: '  문의  ', question: ' 예약? ' }], sections: [{body:'  ',heading:''}, {body:'  차 5,000원 ',heading:' 메뉴 '}], intro: ' 따뜻한 차를 제공합니다. ', headline: ' 차와 함께 ', address: ' 서울 마포구 테스트로 12 ', name: ' 카페 Cafe\u0301 ' };
  for (const input of [data, {...data,situations:[]}, {...data,situations:[{answer:' ',question:' '}]}, {...data,situations:[{answer:'둘이 방문',question:'둘이?'}]}, {...data,translations:{ignored:true}}]) {
    assert.deepEqual(normalizeTranslationSource(input), normalizeSourceData(input));
    assert.equal(await translationSourceHash(input, webcrypto), serverSourceHash(input));
  }
  assert.notEqual(await translationSourceHash(data,webcrypto), await translationSourceHash({...data,situations:[]},webcrypto));
  await assert.rejects(translationSourceHash({...data,faqs:[{question:'질문',answer:''}]},webcrypto));
  await assert.rejects(translationSourceHash({...data,situations:[{question:'example.com',answer:'주소'}]},webcrypto));
});
test('wrong hash fails safely: no ready preview, no translated publication, no retry', async () => {
  let calls=0;const c=setup(async(_,p)=>{calls++;const response=result(p.data);response.translations.sourceHash='0'.repeat(64);return response;});
  c.flow.renderPreview();const before=c.state().pageDraft.draft;c.consent();await c.generate();
  assert.equal(calls,1);assert.equal(c.state().pageDraft.translation.status,'error');
  assert.equal(c.state().pageDraft.translation.translations,undefined);
  assert.deepEqual(c.state().pageDraft.draft,before);assert.match(c.all(),/원문 검증에 실패/);assert.doesNotMatch(c.all(),/en headline/);
  c.flow.renderPublish();assert.equal(c.find(n=>n.attrs.id==='publish-translation-review'),undefined);assert.match(c.all(),/한국어로만 공개/);
  c.reload();c.flow.renderPreview();assert.equal(calls,1);
});
test('unavailable or rejected Web Crypto never marks translation ready', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  try {
    for(const provider of [undefined, {subtle:{}}, {subtle:{digest:async()=>{throw new Error('unsupported');}}}]) {
      Object.defineProperty(globalThis,'crypto',{configurable:true,value:provider});
      const c=setup(async(_,p)=>result(p.data));c.flow.renderPreview();c.consent();await c.generate();
      assert.equal(c.state().pageDraft.translation.status,'error');assert.equal(c.state().pageDraft.translation.translations,undefined);
      assert.match(c.all(),/안전한 번역 원문 검증/);assert.doesNotMatch(c.all(),/en headline/);
    }
  } finally {if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;}
});
test('editing during asynchronous digest verification discards successful old response', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');let finish,started;
  const began=new Promise(resolve=>{started=resolve;});
  try {
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:(...args)=>new Promise(resolve=>{finish=()=>resolve(webcrypto.subtle.digest(...args));started();})}}});
    const c=setup(async(_,p)=>result(p.data));c.flow.renderPreview();c.consent();const pending=c.generate();await began;
    c.flow.renderEdit();c.input('page-edit-intro','검증 도중 수정');finish();await pending;
    assert.equal(c.state().pageDraft.translation.status,'stale');assert.equal(c.state().pageDraft.translation.translations,undefined);
  } finally {if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;}
});
