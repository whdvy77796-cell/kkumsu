import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeData, renderStore, requestScope, storeKeys, hashPassword } from '../lib/stores.mjs';
import { sourceHash } from '../lib/store-translations.mjs';
import { highlightNumbers, normalizeHighlightLines, normalizeHighlights, getCurrentHighlights } from '../lib/store-highlights.mjs';
import { MemoryStore, RedisStore, ownerReplacement, rawObjectMembers } from '../lib/guard.mjs';
import { createHandler } from '../api/stores.js';
const id='h'.repeat(22), password='synthetic-password';
const base={name:'합성 가게',address:'서울 합성로 12',headline:'차분한 공간',intro:'좌석 20개입니다. 가격은 1,000원입니다.',sections:[{heading:'방문 안내',body:'오전 9시부터 오후 6시까지입니다.'}],faqs:[]};
const lines=[{ko:'차분한 공간',en:'A calm & "quiet" space',zh:'安静的空间',ja:'落ち着いた空間'},{ko:'좌석 20개입니다.',en:'There are 20 seats.',zh:'设有20个座位。',ja:'座席は20席です。'},{ko:'가격은 1,000원입니다.',en:'The price is 1000 won.',zh:'价格为1000韩元。',ja:'価格は1000ウォンです。'}];
const bundle=(source=base)=>({sourceHash:sourceHash(source),lines:structuredClone(lines)});
const data=()=>({...structuredClone(base),highlights:bundle()});
const scope=requestScope({headers:{host:'localhost:3199'}},{}),keys=storeKeys(scope,id);
const render=d=>renderStore(scope,{id,data:d});
const passwordHash=await hashPassword(password);
const member=(raw,key)=>{const m=rawObjectMembers(raw).members.get(key);return m?raw.slice(m.first,m.last):undefined;};
function fixture(){const now=Date.now(),st=new MemoryStore(),raw=JSON.stringify({id,data:data(),password:passwordHash,revision:'a'.repeat(32),createdAt:now-1000,updatedAt:now-1000,hidden:false,expiresAt:now+3600000});st.kv.set(keys[0],raw);st.kv.set(keys[1],new Map([[id,now-1000]]));st.publicExpiry=new Map([[keys[0],now+3600000]]);return {now,st,raw};}
const payload=(f,d=data())=>({now:f.now,updatedAt:f.now,expectedRaw:f.raw,expected:'a'.repeat(32),revision:'b'.repeat(32),data:d});

test('highlights normalize without mutation and share full Korean digest, including optional fields',()=>{
 const input=data(),before=structuredClone(input);assert.deepEqual(normalizeData(input),input);assert.deepEqual(input,before);
 assert.equal(sourceHash(input),sourceHash(base));assert.equal(sourceHash({...input,translations:{invalid:true}}),sourceHash(base));
 assert.deepEqual(normalizeHighlightLines(lines,base),lines);assert.deepEqual(getCurrentHighlights(input),input.highlights);
 assert.notEqual(sourceHash({...base,faqs:[{question:'질문',answer:'답변'}]}),sourceHash(base));
 assert.notEqual(sourceHash({...base,situations:[]}),sourceHash(base));
 const fourth={ko:base.sections[0].body,en:'Open from 9 to 6.',zh:'从9点至6点营业。',ja:'9時から6時まで営業。'};
 assert.equal(normalizeHighlights({...bundle(),lines:[...lines,fourth]},base).lines.length,4);
});
const badCases=[
 ['null',d=>d.highlights=null],['extra key',d=>d.highlights.extra=true],['hash',d=>d.highlights.sourceHash='0'.repeat(64)],['source change',d=>d.name+='수정'],
 ['two lines',d=>d.highlights.lines.pop()],['five lines',d=>d.highlights.lines.push(lines[0],lines[1])],['missing language',d=>delete d.highlights.lines[0].ja],['extra field',d=>d.highlights.lines[0].fr='non'],
 ['not exact excerpt',d=>d.highlights.lines[0].ko='편안한 공간'],['FAQ not source',d=>{d.faqs=[{question:'질문',answer:'특별한 답변'}];d.highlights=bundle(d);d.highlights.lines[0].ko='특별한 답변';}],
 ['duplicate',d=>d.highlights.lines[2]=d.highlights.lines[0]],['Unicode minus',d=>d.highlights.lines[1].en='There are −20 seats.'],['fullwidth plus',d=>d.highlights.lines[1].en='There are ＋20 seats.'],['number changed',d=>d.highlights.lines[1].en='There are 21 seats.'],['number dropped',d=>d.highlights.lines[1].ja='座席があります。'],['unicode number',d=>d.highlights.lines[1].zh='有２０个座位。'],
 ['wrong script en',d=>d.highlights.lines[0].en='한국어'],['wrong script zh',d=>d.highlights.lines[0].zh='English'],['wrong script ja',d=>d.highlights.lines[0].ja='한국어'],
 ...['<script>bad</script>','https://evil.invalid','evil.invalid/path','[click](/x)','hello\nworld','hello\u202eworld','x'.repeat(401)].map(v=>['unsafe '+v,d=>d.highlights.lines[0].en=v])
];
for(const [name,mutate]of badCases)test('reject incoming and hide stored '+name,()=>{const d=data();mutate(d);assert.throws(()=>normalizeData(d),{code:'FIELDS'});assert.equal(getCurrentHighlights(d),null);const {highlights,...original}=d;assert.equal(render(d),render(original));});

test('SSR escapes, renders 3 rows per language in en/zh-Hans/ja order below Korean, unchanged JSON-LD',()=>{
 const html=render(data()),plain=render(base),ld=s=>s.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1];
 assert.equal(ld(html),ld(plain));assert.ok(html.indexOf('lang="en"')>html.indexOf(base.intro));assert.ok(html.indexOf('lang="zh-Hans"')>html.indexOf('lang="en"'));assert.ok(html.indexOf('lang="ja"')>html.indexOf('lang="zh-Hans"'));
 assert.equal((html.match(/<li>/g)||[]).length,9);assert.match(html,/A calm &amp; &quot;quiet&quot; space/);assert.match(html,/한국어 원문이 우선/);assert.match(html,/Korean original takes precedence/);assert.match(html,/请以韩语原文为准/);assert.match(html,/韓国語の原文を優先/);
});
test('legacy translations unchanged with absent or invalid highlights',()=>{
 const translations={sourceHash:sourceHash(base),en:structuredClone(base),zh:structuredClone(base),ja:structuredClone(base)};
 const legacy={...base,translations};assert.equal(render({...legacy,highlights:null}),render(legacy));assert.equal((render(legacy).match(/public-store-translation/g)||[]).length,3);
 assert.equal((render({...data(),translations}).match(/public-store-translation/g)||[]).length,0);
});
test('cjson read repair is nonmutating and strict writes do not accept object arrays',()=>{
 const d=data();d.faqs={};const old=structuredClone(d);assert.deepEqual(getCurrentHighlights(d),bundle());assert.deepEqual(d,old);assert.throws(()=>normalizeData(d));
});
test('raw update preserves omitted malformed highlights, old translations and unknown bytes exactly',()=>{
 const f=fixture();const unusual='{ "future":900719925474099312345,"x":1,"x":2 }';
 f.raw=f.raw.replace('"data":{','"futureRecord":'+unusual+',"data":{"futureData":'+unusual+',"translations":'+unusual+',');
 const prior=member(member(f.raw,'data'),'highlights');f.raw=f.raw.replace(prior,unusual);
 const out=ownerReplacement(f.raw,'update',payload(f,{...base,intro:'수정한 한국어'}));
 for(const k of ['highlights','translations','futureData'])assert.equal(member(member(out,'data'),k),unusual);
 for(const k of ['password','createdAt','hidden','expiresAt','futureRecord'])assert.equal(member(out,k),member(f.raw,k));
 assert.equal(getCurrentHighlights(JSON.parse(out).data),null);
});
test('adapter cross-checks final retained source; omitted situations cannot produce misleading current hash',()=>{
 const f=fixture();f.raw=f.raw.replace('"faqs":[]','"faqs":[],"situations":[]');assert.throws(()=>ownerReplacement(f.raw,'update',payload(f)));
 const d={...data(),situations:[]};d.highlights.sourceHash=sourceHash(d);assert.deepEqual(JSON.parse(ownerReplacement(f.raw,'update',payload(f,d))).data.highlights,d.highlights);
});
test('memory CAS keeps complete winning bundle and TTL, rejects malformed without mutation',async()=>{
 const f=fixture(),expiry=f.st.publicExpiry.get(keys[0]);const a=payload(f),b={...payload(f),revision:'c'.repeat(32)};
 const results=await Promise.all([f.st.publicTransaction('update',keys,a),f.st.publicTransaction('update',keys,b)]);assert.deepEqual(results.map(r=>r.status),['ok','conflict']);assert.deepEqual(JSON.parse(f.st.kv.get(keys[0])).data.highlights,a.data.highlights);assert.equal(f.st.publicExpiry.get(keys[0]),expiry);
 for(const [,mutate]of badCases){const g=fixture(),d=data();mutate(d);const before=g.st.kv.get(keys[0]);assert.equal((await g.st.publicTransaction('update',keys,payload(g,d))).status,'blocked');assert.equal(g.st.kv.get(keys[0]),before);}
});
test('mock Redis receives raw CAS replacement, malformed highlights never reach EVAL',async()=>{
 const f=fixture(),calls=[];const redis=new RedisStore('https://offline.invalid','synthetic',async(_url,options)=>{const c=JSON.parse(options.body);calls.push(c);assert.equal(c[0],'EVAL');const p=JSON.parse(c.at(-1));assert.equal(p.expectedRaw,f.raw);assert.deepEqual(JSON.parse(p.replacementRaw).data.highlights,bundle());return new Response(JSON.stringify({result:JSON.stringify({status:'ok',recordRaw:p.replacementRaw})}));});
 assert.equal((await redis.publicTransaction('update',keys,payload(f))).status,'ok');const d=data();d.highlights.sourceHash='0'.repeat(64);assert.equal((await redis.publicTransaction('update',keys,payload(f,d))).status,'blocked');assert.equal(calls.length,1);
});
test('synthetic public HTTP update validates highlights before write',async()=>{
 for(const valid of [true,false]){const f=fixture(),d=data();if(!valid)d.highlights.sourceHash='0'.repeat(64);const handler=createHandler({store:f.st,env:{}}),req={method:'POST',url:'/api/stores',headers:{host:'localhost:3199',origin:'http://localhost:3199','content-type':'application/json'},body:{action:'update',id,password,consent:true,data:d},socket:{remoteAddress:'127.0.0.1'}},res={statusCode:200,setHeader(){},end(s){this.body=JSON.parse(s);}};await handler(req,res);assert.equal(res.statusCode,valid?200:400);if(valid)assert.deepEqual(res.body.data.highlights,d.highlights);else assert.equal(f.st.kv.get(keys[0]),f.raw);}
});

// Finite native-Korean quantity normalization changes comparison only, never source text.
test('native Korean numeric quantities match explicit Arabic translations without changing digest or excerpt',()=>{
 const source={...base,headline:'두 명이 방문하는 공간',intro:'한 시간 머물며 세 잔을 주문합니다.',sections:[{heading:'안내',body:'가격은 1,000원입니다.'}]};
 const quantityLines=[
  {ko:'두 명이 방문하는 공간',en:'A space for 2 people',zh:'供2人到访的空间',ja:'2人で訪れる空間'},
  {ko:'한 시간 머물며 세 잔을 주문합니다.',en:'Stay for 1 hour and order 3 cups.',zh:'停留1小时并点3杯。',ja:'1時間滞在し3杯を注文します。'},
  {ko:'가격은 1,000원입니다.',en:'The price is 1000 won.',zh:'价格为1000韩元。',ja:'価格は1000ウォンです。'}
 ];
 const input={...source,highlights:{sourceHash:sourceHash(source),lines:quantityLines}},before=structuredClone(input);
 assert.deepEqual(normalizeData(input),input);assert.deepEqual(input,before);assert.equal(sourceHash(input),sourceHash(source));assert.deepEqual(getCurrentHighlights(input),input.highlights);
 for(const translated of ['A space for 3 people','A space for people','A space for -2 people','A space for +2 people','A space for 2.0 people','A space for 2 and 2 people']){
  const wrong=structuredClone(input);wrong.highlights.lines[0].en=translated;assert.throws(()=>normalizeData(wrong),{code:'FIELDS'});
 }
 const wrongOrder=structuredClone(input);wrongOrder.highlights.lines[1].en='Stay for 3 hours and order 1 cup.';assert.throws(()=>normalizeData(wrongOrder),{code:'FIELDS'});
});
test('finite native Korean forms, clear particles, adjacency, mixed digit facts and signs',()=>{
 const forms={한:1,하나:1,두:2,둘:2,세:3,셋:3,네:4,넷:4,다섯:5,여섯:6,일곱:7,여덟:8,아홉:9,열:10,스무:20,스물:20};
 for(const [word,n]of Object.entries(forms))for(const unit of ['명','인','개','시간','시','분','잔']) {
  assert.deepEqual(highlightNumbers(word+' '+unit),[String(n)]);
  assert.deepEqual(highlightNumbers(word+unit+'입니다.'),[String(n)]);
 }
 assert.deepEqual(highlightNumbers('두 명과 세 잔, 1,000원'),['2','3','1000']);
 assert.deepEqual(highlightNumbers('한 시간부터 두 시간까지'),['1','2']);
 assert.deepEqual(highlightNumbers('-두 명, +세 잔, -1.5'),['-2','+3','-1.5']);
 assert.deepEqual(highlightNumbers('주차 불가'),[]);
 assert.deepEqual(highlightNumbers('좌석 20개, 주차 불가'),['20']);
});
test('ambiguous quantities, unsupported compounds, negations and separated signs fail closed',()=>{
 for(const phrase of ['한두 명','두세 명','서너 명','대여섯 명','몇 명','여러 명','열두 명','스물한 명','두 명 정도','약 두 명','두 명 이상','두 명 이하','최대 두 명','두 명이 아닙니다','두 명은 안 됩니다','두 명은 불가','두 명은 없어요','두 명을 제외','마이너스 두 명','플러스 두 명','- 두 명','+ 두 명','한 분위기'])assert.equal(highlightNumbers(phrase),null,phrase);
 for(const phrase of ['두 명 정도','두 명이 아닙니다','열두 명']){
  const source={...base,headline:phrase};const rows=structuredClone(lines);rows[0]={ko:phrase,en:'For 2 people',zh:'供2人使用',ja:'2人向け'};
  assert.throws(()=>normalizeHighlightLines(rows,source),{code:'FIELDS'});
 }
});
