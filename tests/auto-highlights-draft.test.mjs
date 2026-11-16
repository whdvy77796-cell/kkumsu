import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, makePageDraft, normalizeDraft, mergeCustomerQuestions, normalizeHighlights, validateDraftInput, inputEvidence, PAGE_DRAFT_SYSTEM } from '../api/page-draft.js';
import { MemoryStore } from '../lib/guard.mjs';
const body = { store: { name: '골목분식', address: '서울 마포구 망원로 12', verifiedFacts: ['주문 후 김밥을 만듭니다', '포장 가능합니다'] }, answers: { offer: '김밥 10,000원입니다.', difference: '주문 후 만드는 김밥', audience: '', visit: '포장 가능합니다', keywords: '' }, consent: true };
const input = validateDraftInput(body);
const lines = () => [
 {ko:'주문 후 만드는 김밥',en:'Gimbap made after ordering',zh:'下单后制作紫菜包饭',ja:'注文後に作るキンパ'},
 {ko:'김밥 10,000원입니다.',en:'Gimbap costs 10,000 won.',zh:'紫菜包饭售价10,000韩元。',ja:'キンパは10,000ウォンです。'},
 {ko:'포장 가능합니다.',en:'Takeout is available.',zh:'可以打包。',ja:'お持ち帰りできます。'},
];
const raw = () => ({headline:{text:'주문 후 만드는 김밥',evidence:['fact0']},intro:{text:'김밥 10,000원입니다.',evidence:['offer']},sections:[{heading:'김밥 소개',body:'포장 가능합니다.',evidence:['fact1']}],faqs:[],keywords:[],situations:[],highlights:lines()});
const draft = () => mergeCustomerQuestions(normalizeDraft(raw(),input),input);
const meter = () => ({cost:0,unknown:false,add(n){this.cost+=n},markUnknown(){this.unknown=true}});
async function run(content=raw()) {const calls=[];const m=meter();const result=await makePageDraft({env:{OPENROUTER_API_KEY:'fake-key'},input,meter:m,fetcher:async(url,opts)=>{calls.push({url,opts,body:JSON.parse(opts.body)});return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{cost:0.02}}),{status:200})}});return {result,calls,m};}
test('3 and 4 grounded rows accepted independently of Korean evidence validation',()=>{
 for(const count of [3,4]){const value=lines();if(count===4)value.push({ko:'김밥 소개',en:'Gimbap introduction',zh:'紫菜包饭介绍',ja:'キンパの紹介'});const result=normalizeHighlights(value,draft(),input);assert.equal(result.highlights.length,count);assert.match(result.highlightsNotice,/의미의 정확성을 보증하지/);}
});
test('optional highlights are all-or-nothing for count, schema, missing languages and duplicate Korean',()=>{
 const bad=[undefined,null,{},[],lines().slice(0,2),[...lines(),...lines()],lines().map((r,i)=>i===1?{...r,extra:'provider echo'}:r),lines().map((r,i)=>i===1?{ko:r.ko,en:r.en,zh:r.zh}:r),[lines()[0],lines()[0],lines()[2]]];
 for(const value of bad){const result=normalizeHighlights(value,draft(),input);assert.deepEqual(result.highlights,[]);assert.match(result.highlightsNotice,/한국어 초안은 유지/);}
});
test('one faulty language, markup, links, control or overlong row omits every translation',()=>{
 const mutations=[r=>r.en='한국어 English',r=>r.zh='Chinese text',r=>r.ja='English text',r=>r.en='<b>English</b>',r=>r.zh='可以打包。 https://evil.test',r=>r.en='Line\nEnglish',r=>r.en='English\u202e',r=>r.en='a'.repeat(401),r=>r.ko='가'.repeat(201)];
 for(const mutate of mutations){const value=lines();mutate(value[0]);assert.deepEqual(normalizeHighlights(value,draft(),input).highlights,[]);}
});
test('numeric tampering in any language fails closed, even when other rows are good',()=>{
 for(const lang of ['en','zh','ja'])for(const n of ['1000','100000','-10000','10,000 10,000','']){const value=lines();value[1][lang]=value[1][lang].replace('10,000',n);assert.deepEqual(normalizeHighlights(value,draft(),input).highlights,[],lang+':'+n);}
 const value=lines();for(const lang of ['en','zh','ja'])value[1][lang]=value[1][lang].replace('10,000','10000');assert.equal(normalizeHighlights(value,draft(),input).highlights.length,3);
});
test('Korean must be final surviving source excerpt, never FAQ, scenario or raw input only',async()=>{
 for(const ko of ['김밥은 저렴합니다.','김밥 10,000원 입니다.','골목분식']){const value=lines();value[0].ko=ko;assert.deepEqual(normalizeHighlights(value,draft(),input).highlights,[]);}
 const value=raw();value.sections.push({heading:'새로운 안내',body:'무료주차 가능합니다.',evidence:['offer']});value.highlights[0].ko='무료주차 가능합니다.';
 const {result}=await run(value);assert.equal(result.draft.sections.length,1);assert.deepEqual(result.highlights,[]);assert.equal(result.draft.omittedCount,1);
 const d=draft();d.faqs.push({question:'질문만 있는 문장',answer:'답변만 있는 문장'});d.situations.push({question:'상황에만 있는 문장',answer:'상황 답변'});
 for(const ko of ['질문만 있는 문장','답변만 있는 문장','상황에만 있는 문장','상황 답변']){const rows=lines();rows[0].ko=ko;assert.deepEqual(normalizeHighlights(rows,d,input).highlights,[]);}
});
test('one metered provider request carries only existing input and returns reviewed highlights',async()=>{
 const {result,calls,m}=await run();assert.equal(calls.length,1);assert.deepEqual(result.highlights,lines());assert.equal(m.cost,20000);assert.equal(m.unknown,false);
 const request=calls[0].body;assert.equal(request.max_tokens,4600);assert.equal(request.tools,undefined);assert.deepEqual(JSON.parse(request.messages.find(m=>m.role==='user').content),{inputData:inputEvidence(input)});assert.equal(request.provider.data_collection,'deny');assert.ok(calls[0].opts.signal);assert.equal(result.mock,false);assert.equal(result.cached,false);assert.match(PAGE_DRAFT_SYSTEM,/중국어 간체/);assert.match(PAGE_DRAFT_SYSTEM,/highlights/);
});
test('malformed or missing highlights preserve exact normalized Korean result with no retry',async()=>{
 for(const v of [undefined,null,[],lines().slice(0,2),lines().map((r,i)=>i===0?{...r,en:'<script>secret</script>'}:r)]){const content=raw();if(v===undefined)delete content.highlights;else content.highlights=v;const {result,calls}=await run(content);assert.equal(calls.length,1);assert.deepEqual(result.draft,draft());assert.deepEqual(result.highlights,[]);assert.match(result.highlightsNotice,/추가 AI 호출은 하지 않았/);assert.ok(!JSON.stringify(result).includes('secret'));}
});
test('invalid Korean schema remains an error and never gets repaired by valid highlights',async()=>{const content=raw();content.sections=null;await assert.rejects(run(content),e=>e.code==='AI_FORMAT');});
test('mock explicitly returns no translations and makes no provider call',async()=>{
 let calls=0;const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={host:'localhost:3000',origin:'http://localhost:3000','content-type':'application/json'};
 const res={setHeader(){},end(s){this.body=JSON.parse(s)}};await createHandler({env:{MOCK_AI:'1'},store:new MemoryStore(),fetcher:async()=>{calls++;throw Error('must not call')}})(req,res);
 assert.equal(res.statusCode,200);assert.equal(res.body.mock,true);assert.deepEqual(res.body.highlights,[]);assert.match(res.body.highlightsNotice,/모의 초안/);assert.equal(calls,0);
});

test('numeric order, new digits, and non-ASCII numeric disguises are rejected',()=>{
 const d=draft();d.intro.text='김밥 10,000원, 떡볶이 5,000원입니다.';
 const row={ko:d.intro.text,en:'Gimbap 10000 won, tteokbokki 5000 won.',zh:'紫菜包饭10000韩元，炒年糕5000韩元。',ja:'キンパ10000ウォン、トッポッキ5000ウォンです。'};
 const valid=lines();valid[1]=row;assert.equal(normalizeHighlights(valid,d,input).highlights.length,3);
 for(const text of ['Gimbap 5000 won, tteokbokki 10000 won.','Gimbap １００００ won, tteokbokki 5000 won.','Gimbap 10000 won, tteokbokki 5000 won, 2 servings.']){const rows=lines();rows[1]={...row,en:text};assert.deepEqual(normalizeHighlights(rows,d,input).highlights,[]);}
});
test('provider echo errors do not leak submitted text or cause a second call',async()=>{
 let calls=0;const logs=[];const original=console.error;console.error=(...args)=>logs.push(args.join(' '));const m=meter();
 try{await assert.rejects(makePageDraft({env:{OPENROUTER_API_KEY:'fake-key'},input,meter:m,fetcher:async()=>{calls++;return new Response(JSON.stringify({error:{message:'private-provider-echo '+body.answers.offer},usage:{cost:0.01}}),{status:500})}}),e=>!e.message.includes('private-provider-echo')&&!e.message.includes(body.answers.offer));}
 finally{console.error=original;}
 assert.equal(calls,1);assert.equal(m.cost,10000);assert.ok(!logs.join('\n').includes('private-provider-echo'));assert.ok(!logs.join('\n').includes(body.answers.offer));
});
