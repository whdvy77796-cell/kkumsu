import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeData, renderStore } from '../lib/stores.mjs';
import { normalizeSourceData, sourceHash, normalizeTranslations, getCurrentTranslations } from '../lib/store-translations.mjs';
const base={name:'테스트 & 가게',address:'서울 마포구 12',headline:'매장 2층 안내',intro:'가격은 1,000원입니다.',sections:[{heading:'안내 1',body:'좌석 20개입니다.'},{heading:'안내 2',body:'오전 9시부터 오후 6시까지입니다.'}],faqs:[{question:'가격 1개는?',answer:'1,000원입니다.'}],situations:[{question:'2명이 방문한다면?',answer:'2인석을 안내합니다.'}]};
const copy=value=>JSON.parse(JSON.stringify(value));
function bundle(source=base) {
 const korean=normalizeSourceData(source);
 const en={name:korean.name,address:korean.address,headline:'Floor 2 information',intro:'The price is 1000 won.',sections:[{heading:'Information 1',body:'There are 20 seats.'},{heading:'Information 2',body:'Open from 9 to 6.'}],faqs:[{question:'Price for 1 item?',answer:'It costs 1000 won.'}],...(Object.hasOwn(korean,'situations')?{situations:[{question:'Visiting with 2 people?',answer:'We offer seats for 2.'}]}:{})};
 const ja={...copy(en),headline:'2階のご案内',intro:'価格は1000ウォンです。'};
 const zh={...copy(en),headline:'2楼指南',intro:'价格为1000韩元。'};
 return {sourceHash:sourceHash(source),en,ja,zh};
}
const translated=()=>({...copy(base),translations:bundle()});
const scope={production:true},id='a'.repeat(22);
const render=data=>renderStore(scope,{id,data});
const jsonLd=html=>JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1]);

test('hash is exactly normalized original JSON with original field order, optional presence and NFC',()=>{
 const raw={faqs:[],sections:[{heading:' ',body:' '}],intro:'  본문  ',headline:' 소개 ',address:' 서울 주소 ',name:' \u1100\u1161게 '};
 const expected={name:'가게',address:'서울 주소',headline:'소개',intro:'본문',sections:[],faqs:[]};
 assert.deepEqual(normalizeSourceData(raw),expected);
 assert.equal(sourceHash(raw),createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
 assert.equal(sourceHash({...raw,translations:{invalid:true}}),sourceHash(raw));
 assert.notEqual(sourceHash({...raw,situations:[]}),sourceHash(raw));
 assert.throws(()=>sourceHash({...raw,unknown:1}),{code:'FIELDS'});
 assert.deepEqual(normalizeData(raw),expected);
});

test('accepts exactly three complete languages, same names/addresses, commas, and normalization without mutation',()=>{
 const input=translated(),before=copy(input); input.translations.en.intro='  The price is 1,000 won.  ';
 const result=normalizeData(input);
 assert.equal(result.translations.en.intro,'The price is 1,000 won.');
 assert.equal(input.translations.en.intro,'  The price is 1,000 won.  ');
 assert.equal(result.translations.en.name,base.name); assert.equal(result.translations.en.address,base.address);
 assert.deepEqual(normalizeData(result),result);
 assert.deepEqual(normalizeTranslations(before.translations,base),before.translations);
 assert.deepEqual(getCurrentTranslations(before),before.translations);
});

test('rejects wrong hashes, missing or extra languages and fields, invalid types and pair shapes',()=>{
 const changes=[t=>t.sourceHash='0'.repeat(64),t=>t.sourceHash=t.sourceHash.toUpperCase(),t=>delete t.ja,t=>t.ko=copy(t.en),t=>t['zh-Hans']=copy(t.zh),t=>t.en=null,t=>t.en.extra='extra',t=>delete t.en.name,t=>t.en.intro=123,t=>t.en.sections={},t=>t.en.sections.pop(),t=>t.en.faqs.push(copy(t.en.faqs[0])),t=>t.en.sections[0].extra='x',t=>t.en.sections[0]={heading:'',body:''},t=>delete t.en.situations];
 for(const change of changes){const input=translated();change(input.translations);assert.throws(()=>normalizeData(input),{code:'FIELDS'});}
 for(const translations of [null,undefined,[],{},'invalid']) assert.throws(()=>normalizeData({...base,translations}),{code:'FIELDS'});
});

test('each corresponding field retains numeric facts including count, order, signs and decimals',()=>{
 const changes=[t=>t.en.name+=' 1',t=>t.en.address='Seoul 13',t=>t.en.headline='Floor 3',t=>t.en.intro='Price 1001 won',t=>t.en.intro='Price one thousand won',t=>t.en.intro='Price 1000 and 1000 won',t=>t.en.sections.reverse(),t=>t.en.sections[1].body='Open 6 to 9',t=>t.en.faqs[0].answer='Price 1000.5',t=>t.en.situations[0].question='Visiting 3 people?',t=>t.en.situations[0].answer='Seats for -2',t=>t.ja.intro='価格１０００ウォン',t=>t.zh.intro='价格1000韩元，另加²'];
 for(const change of changes){const input=translated();change(input.translations);assert.throws(()=>normalizeData(input),{code:'FIELDS'});}
});

test('all translated string fields reject markup, links, controls, and length overflow',()=>{
 const locations=[['name',60],['address',120],['headline',200],['intro',2000],['sections',0,'heading',200],['sections',0,'body',4000],['faqs',0,'question',300],['faqs',0,'answer',2000],['situations',0,'question',300],['situations',0,'answer',2000]];
 const attacks=['<b>x</b>','<script>alert(1)</script>','https://evil.test','ftp://evil.test','//evil.test','evil.test/path','mailto:evil@evil.test','[label](/target)','javascript:bad','data:text/html,bad','\u0000'];
 for(const loc of locations){const keys=loc.slice(0,-1),max=loc.at(-1);for(const attack of [...attacks,'x'.repeat(max+1),'']){const input=translated();let target=input.translations.en;for(const key of keys.slice(0,-1))target=target[key];target[keys.at(-1)]=attack;assert.throws(()=>normalizeData(input),{code:'FIELDS'});}}
});

test('optional situations exactly mirror source absence versus explicit empty; normalized blank pairs are removed first',()=>{
 const {situations,...legacy}=base;const t=bundle(legacy);
 assert.equal(Object.hasOwn(normalizeData({...legacy,translations:t}).translations.en,'situations'),false);
 t.en.situations=[];assert.throws(()=>normalizeData({...legacy,translations:t}),{code:'FIELDS'});
 const empty={...base,sections:[],faqs:[],situations:[]};const translations={sourceHash:sourceHash(empty)};
 for(const language of ['en','ja','zh']) translations[language]={...bundle()[language],sections:[],faqs:[],situations:[]};
 const raw={...empty,sections:[{heading:' ',body:' '}],translations};
 assert.deepEqual(normalizeData(raw).translations.en.sections,[]);
});

test('SSR preserves Korean JSON-LD, outputs en/ja/zh-Hans in order with warnings and escapes all values',()=>{
 const input=translated();input.translations.en.name='Store & "quoted"';
 input.translations.en.sections[0].heading='Info 1 & \'quoted\'';
 const html=render(input),original=render(base);
 assert.deepEqual(jsonLd(html),jsonLd(original));
 assert.ok(html.indexOf('lang="en"')>html.indexOf(base.intro));
 assert.ok(html.indexOf('lang="ja"')>html.indexOf('lang="en"'));
 assert.ok(html.indexOf('lang="zh-Hans"')>html.indexOf('lang="ja"'));
 assert.match(html,/Store &amp; &quot;quoted&quot;/);assert.match(html,/Info 1 &amp; &#39;quoted&#39;/);
 assert.match(html,/번역에는 오류가 있을 수 있으며 한국어 원문이 우선/);
 assert.match(html,/Korean original takes precedence/);assert.match(html,/韓国語の原文を優先/);assert.match(html,/请以韩语原文为准/);
 assert.equal((html.match(/public-store-translation/g)||[]).length,3);
 assert.ok(!JSON.stringify(jsonLd(html)).includes('Floor 2 information'));
});

test('legacy edits that preserve old translations hide translations only, without mutation or loss of Korean',()=>{
 const input=translated(),saved=copy(input.translations);
 for(const key of ['name','address','headline','intro']) {
  const edited={...input,[key]:input[key]+' 원문 수정'}; const {translations,...baseOnly}=edited;
  assert.equal(getCurrentTranslations(edited),null); assert.equal(render(edited),render(baseOnly));
 }
 const edited=copy(input);edited.sections[0].body='좌석 30개입니다.';
 assert.equal(getCurrentTranslations(edited),null); assert.ok(!render(edited).includes('public-store-translation'));
 assert.deepEqual(input.translations,saved);
 assert.throws(()=>normalizeData({...input,intro:'수정한 원문'}),{code:'FIELDS'},'explicit stale translations fail writes, not public Korean reads');
});

test('malformed stored translations are hidden without a Korean rendering failure or script execution',()=>{
 for(const translations of [null,{},bundle()]) {
  if(translations?.en) translations.en.intro='</article><script>alert(1)</script>';
  const input={...base,translations};assert.equal(getCurrentTranslations(input),null);assert.equal(render(input),render(base));
 }
 const dangerous={...base,name:'<img src=x onerror=bad()>',translations:bundle()};
 const html=render(dangerous);assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));
});

test('Redis cjson empty objects restore only known empty arrays at read time, without mutation',()=>{
 const source={...base,sections:[],faqs:[],situations:[]};
 const translations={sourceHash:sourceHash(source)};
 for(const language of ['en','ja','zh']) translations[language]={...bundle()[language],sections:[],faqs:[],situations:[]};
 const expected={...source,translations};
 const encoded=JSON.parse(JSON.stringify(expected,(_key,value)=>Array.isArray(value)&&value.length===0?{}:value));
 const before=copy(encoded);
 assert.deepEqual(getCurrentTranslations(encoded),translations);
 assert.deepEqual(encoded,before);
 const restoredKorean={...source,translations:encoded.translations};
 assert.equal(render(restoredKorean),render(expected));
 assert.throws(()=>normalizeData(restoredKorean),{code:'FIELDS'},'writes do not accept cjson object arrays');
 encoded.translations.en.sections={unexpected:true};assert.equal(getCurrentTranslations(encoded),null);
 const stale={...restoredKorean,intro:'가격이 바뀌었습니다.'};assert.equal(getCurrentTranslations(stale),null);
 assert.equal(render(stale),render({...source,intro:stale.intro}));
});
