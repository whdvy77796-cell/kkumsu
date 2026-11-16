import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHandler,validateTranslateInput,validateTranslations,sourceHash,TRANSLATE_LIMITS} from '../api/store-translate.js';
import {MemoryStore} from '../lib/guard.mjs';
const ENV={OPENROUTER_API_KEY:'not-real',SESSION_SECRET:'test',VERCEL:'1',VERCEL_ENV:'preview'};
const base={name:'테스트',address:'서울 종로구 12',headline:'식사 안내',intro:'가격 10,000원. 전화 02-123-4567',sections:[{heading:'이용 안내',body:'주차 불가'}],faqs:[{question:'예약 가능한가요?',answer:'예약 미확인'}]};
const clone=o=>JSON.parse(JSON.stringify(o));
const good=()=>Object.fromEntries(['en','ja','zh'].map(l=>[l,{...clone(base),headline:({en:'Dining information',ja:'お食事のご案内',zh:'用餐指南'})[l],intro:({en:'Price 10,000 KRW. Phone 02-123-4567',ja:'料金 10,000ウォン。電話 02-123-4567',zh:'价格 10,000韩元。电话 02-123-4567'})[l],sections:[{heading:({en:'Information',ja:'案内',zh:'指南'})[l],body:({en:'Parking unavailable',ja:'駐車不可',zh:'不可停车'})[l]}],faqs:[{question:({en:'Can I reserve?',ja:'予約できますか？',zh:'可以预约吗？'})[l],answer:({en:'Reservations unconfirmed',ja:'予約未確認',zh:'预约情况尚未确认'})[l]}]}]));
function reply(data=good(),usage={cost:0.02},finish='stop'){return new Response(JSON.stringify({choices:[{finish_reason:finish,message:{content:JSON.stringify(data)}}],usage}),{status:200});}
async function call(body={consent:true,data:base},deps={},headers={}){
 const req=Readable.from([]);req.method='POST';req.body=body;req.headers={host:'test.example',origin:'https://test.example','content-type':'application/json','x-vercel-forwarded-for':'203.0.113.1',...headers};
 const res={setHeader(){},end(s){this.body=JSON.parse(s);}};
 await createHandler({env:ENV,store:new MemoryStore(),fetcher:async()=>reply(),...deps})(req,res);return res;
}
for(const consent of [false,undefined,null,1,'true'])test('explicit consent required '+consent,async()=>{let called=0;const r=await call({consent,data:base},{fetcher:async()=>{called++;throw Error();}});assert.equal(r.statusCode,400);assert.equal(r.body.code,'CONSENT');assert.equal(called,0);});
test('exact source shape, URLs, empty rows and size rejected before calls',async()=>{
 const variants=[{...base,translations:{}},{...base,intro:'https://example.com'},{...base,intro:'<b>hello</b>'},{...base,faqs:[{question:'',answer:''}]},{...base,intro:'가'.repeat(4001)}];
 for(const data of variants){let calls=0;const r=await call({consent:true,data},{fetcher:async()=>{calls++;throw Error();}});assert.ok([400,413].includes(r.statusCode));assert.equal(calls,0);}
});
test('wrong origin and oversized preparsed body fail before provider',async()=>{assert.equal((await call(undefined,{}, {origin:'https://evil.example'})).statusCode,403);assert.equal((await call({consent:true,data:{...base,intro:'가'.repeat(18000)}})).statusCode,413);});
test('strict source hash ignores no fields and rejects supplied translations',()=>{assert.match(sourceHash(base),/^[a-f0-9]{64}$/);assert.throws(()=>validateTranslateInput({consent:true,data:{...base,translations:{}}}));});
test('reject missing languages, fields, added rows, names, HTML, URLs, changed digits',()=>{
 const mutations=[r=>delete r.zh,r=>delete r.en.intro,r=>r.ja.extra='x',r=>r.en.sections.push({...r.en.sections[0]}),r=>r.zh.name='other',r=>r.en.headline='<script>x</script>',r=>r.en.headline='example.com',r=>r.en.intro=r.en.intro.replace('10,000','11,000')];
 for(const mutate of mutations){const r=good();mutate(r);assert.throws(()=>validateTranslations(r,base));}
});
test('success gives exactly translations and never caches raw data',async()=>{const store=new MemoryStore();let calls=0;const r=await call(undefined,{store,fetcher:async()=>{calls++;return reply();}});assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.deepEqual(Object.keys(r.body),['translations']);assert.deepEqual(Object.keys(r.body.translations),['sourceHash','en','ja','zh']);assert.equal(r.body.translations.en.name,base.name);assert.equal(calls,1);assert.ok(!JSON.stringify([...store.kv]).includes(base.intro));assert.equal([...store.kv].find(([k])=>k.startsWith('maechul:v1:budget:'))[1],20000);});
test('duplicate success/failure lock prevents second paid call',async()=>{const store=new MemoryStore();let calls=0;const deps={store,fetcher:async()=>{calls++;throw Error('private provider error');}};const first=await call(undefined,deps),second=await call(undefined,deps);assert.equal(first.statusCode,504);assert.equal(second.statusCode,409);assert.equal(calls,1);assert.equal([...store.kv].find(([k])=>k.startsWith('maechul:storeTranslate:budget:'))[1],250000);assert.ok(!JSON.stringify(first.body).includes('private'));});
test('truncation or missing usage fails all languages without retries',async()=>{for(const response of [()=>reply(good(),{cost:0.02},'length'),()=>reply(good(),{})]){let calls=0;const r=await call(undefined,{fetcher:async()=>{calls++;return response();}});assert.equal(r.statusCode,502);assert.equal(calls,1);assert.equal(r.body.translations,undefined);}});
test('per IP hard limit, separate from existing pageDraft unlimited',async()=>{const store=new MemoryStore();let calls=0;for(let i=0;i<4;i++){const r=await call({consent:true,data:{...base,headline:'제목 '+i}},{store,fetcher:async()=>{calls++;return reply({}, {cost:0.001});}});assert.equal(r.statusCode,i===3?429:502);}assert.equal(calls,TRANSLATE_LIMITS.ipDaily);});
test('configured existing global budget respected',async()=>{const store=new MemoryStore();let calls=0;const r=await call(undefined,{env:{...ENV,MAECHUL_DAILY_BUDGET_USD:'0.05'},store,fetcher:async()=>{calls++;return reply();}});assert.equal(r.statusCode,429);assert.equal(calls,0);});
test('mock mode does not pretend Korean is translated',async()=>{let calls=0;const r=await call(undefined,{env:{MOCK_AI:'1'},fetcher:async()=>{calls++;return reply();}});assert.equal(r.body.code,'TRANSLATE_MOCK');assert.equal(calls,0);});

// These guards reject obvious copies/missing scripts, not incorrect meanings.
const languageFailure=fn=>assert.throws(fn,err=>err.code==='TRANSLATE_LANGUAGE'&&err.status===502);
function mapPublicationText(data,fn){
 const d=clone(data);for(const k of ['headline','intro'])d[k]=fn(d[k]);
 for(const k of ['sections','faqs','situations'])if(d[k])d[k]=d[k].map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,fn(value)])));
 return d;
}
test('all three original copies rejected even when source contains all target scripts',()=>{
 const source={...clone(base),headline:'Cafe 漢字 식사 안내'};
 languageFailure(()=>validateTranslations(Object.fromEntries(['en','ja','zh'].map(lang=>[lang,clone(source)])),source));
});
for(const lang of ['en','ja','zh'])test('a single copied language fails the entire response: '+lang,async()=>{
 const data=good();data[lang]=clone(base);let calls=0;
 const r=await call(undefined,{fetcher:async()=>{calls++;return reply(data);}});
 assert.equal(r.statusCode,502);assert.equal(r.body.code,'TRANSLATE_LANGUAGE');assert.equal(r.body.translations,undefined);assert.equal(calls,1);
});
test('whitespace and NFC-only changes cannot disguise full copies',()=>{
 const source={...clone(base),headline:'Cafe 漢字 식사 안내'};
 const copied=mapPublicationText(source,s=>' \t'+s.normalize('NFD').replace(/ /g,'  \n')+'  ');
 const data=good();data.en=copied;
 languageFailure(()=>validateTranslations(data,source));
});
for(const lang of ['en','ja','zh'])test('changed Korean-only text fails minimum target script: '+lang,()=>{
 const data=good();data[lang]={...clone(base),headline:'새로운 식사 안내'};
 languageFailure(()=>validateTranslations(data,base));
});
test('target script is checked independently for each language',()=>{
 for(const [lang,other] of [['en','zh'],['ja','en'],['zh','en']]){
  const data=good();data[lang]=clone(data[other]);languageFailure(()=>validateTranslations(data,base));
 }
});
test('foreign-script identity fields and literal body mentions do not satisfy language guard',()=>{
 const source={...clone(base),name:'Cafe漢字',address:'Seoul漢字 12'};
 for(const lang of ['en','ja','zh']){
  const data=good();for(const value of Object.values(data)){value.name=source.name;value.address=source.address;}
  data[lang]={...clone(source),headline:'Cafe漢字 새로운 안내'};
  languageFailure(()=>validateTranslations(data,source));
 }
});
test('normal multilingual fixture passes without claiming semantic verification',()=>{
 const result=validateTranslations(good(),base);assert.equal(result.en.headline,'Dining information');assert.equal(result.zh.headline,'用餐指南');
});
test('valid Japanese kanji-only short text need not contain kana',()=>{
 const source={name:'가게',address:'서울 종로구',headline:'영업 안내',intro:'주차 불가',sections:[],faqs:[]};
 const data={en:{...clone(source),headline:'Business information',intro:'Parking unavailable'},ja:{...clone(source),headline:'営業案内',intro:'駐車不可'},zh:{...clone(source),headline:'营业指南',intro:'不可停车'}};
 assert.equal(validateTranslations(data,source).ja.intro,'駐車不可');
});
test('situations are included in the language-text comparison and script scope',()=>{
 const source={name:'가게',address:'서울 종로구',headline:'Cafe 漢字',intro:'Cafe 漢字',sections:[],faqs:[],situations:[{question:'예약?',answer:'미확인'}]};
 const data=Object.fromEntries(['en','ja','zh'].map(lang=>[lang,{...clone(source),situations:[({en:{question:'Reservation?',answer:'Unconfirmed'},ja:{question:'予約？',answer:'未確認'},zh:{question:'预约？',answer:'尚未确认'}})[lang]]}]));
 assert.equal(validateTranslations(data,source).en.situations[0].answer,'Unconfirmed');
});
