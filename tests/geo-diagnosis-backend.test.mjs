import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../api/geo-diagnosis.js';
import { SCAN_ROWS, unknownTechnicalScan, confirmedPriorities, buildBusiness, addressesMatch } from '../lib/geo-diagnosis.mjs';
import { MemoryStore, kstDay } from '../lib/guard.mjs';

const ENV = { OPENROUTER_API_KEY: 'test-not-real-key', SESSION_SECRET: 'test-secret', VERCEL: '1', VERCEL_ENV: 'preview' };
const INPUT = { consent: true, name: '예시상사', address: '서울 중구 예시로 15' };
const WEBSITE = 'https://example.org/';
const candidate = (overrides = {}) => ({ name: INPUT.name, address: INPUT.address, category: '생활용품 소매업', matchLevel: 'high', hours: '09:00~18:00', priceRange: '품목별 상이', phone: '02-123-4567', services: { reservation: true }, menu: [{ name: '생활용품', price: '미확인' }], ...overrides });
const raw = (overrides = {}) => ({ candidates: [candidate()], sources: [{title:'예시상사 서울 중구',url:WEBSITE}], ...overrides });
function provider(data) {
  return new Response(JSON.stringify({ model:'test-model', choices:[{message:{content:JSON.stringify(data), annotations:[]}}], usage:{cost:0.02,server_tool_use_details:{web_search_requests:1}} }), {status:200});
}
function setup({ data = raw(), env = ENV, scan, fetcher, now, researcher = async () => ({ suggestedQuestions: [], competitors: [], researchNotice: 'AI 추가 분석 테스트 생략' }) } = {}) {
  const calls = [], scans = [], store = new MemoryStore();
  const h = createHandler({ env, store, now, researcher, fetcher: fetcher || (async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    calls.push(JSON.parse(options.body)); return provider(data);
  }), scanTechnical: async (url, options) => { scans.push({url,options}); return scan ? scan(url,options) : scanFixture(); } });
  return { h, store, calls, scans };
}
async function invoke(h, body = INPUT, headers = {}, method = 'POST', parsed = false) {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]);
  r.method = method; r.headers = { host:'app.example', origin:'https://app.example', 'content-type':'application/json', 'x-forwarded-for':'203.0.113.7', ...headers };
  if (parsed) r.body = body;
  const res = { setHeader(){}, end(s){this.body=s;} };
  await h(r,res);
  return { status:res.statusCode, body:JSON.parse(res.body) };
}
function scanFixture(overrides = {}) {
  return { targetUrl:WEBSITE, items:SCAN_ROWS.map(({key,label})=>({key,label,status:'unknown',evidence:'아직 미확인',improvement:'문제 확정 안 함',sourceUrl:WEBSITE,...overrides[key]})), warnings:[] };
}
const budget = () => 'maechul:v1:budget:' + kstDay();

test('consent, contact extras, origin, method, parsed body size and URL syntax fail before network', async () => {
  const {h,calls,scans} = setup();
  for (const body of [ {...INPUT,consent:false}, {...INPUT,consent:'true'}, {...INPUT,name:'x'.repeat(61)}, {...INPUT,address:17}, {...INPUT,email:'a@b.com'}, {...INPUT,phone:'01012345678'}, {...INPUT,photos:[]}, {...INPUT,website:null}, {...INPUT,website:'https://example.org/?token=secret'}, {...INPUT,website:'https://example.org/#fragment'}, {...INPUT,website:'https://example.org/?p=2'}, ...['http://127.0.0.1/','http://2130706433/','http://[::1]/','http://169.254.169.254/','http://foo.local/','https://u:pass@example.org/','ftp://example.org/','http://example.org:8000/'].map(website=>({...INPUT,website})) ]) {
    assert.equal((await invoke(h,body)).status,400,JSON.stringify(body));
  }
  assert.equal((await invoke(h,INPUT,{origin:'https://evil.example'})).status,403);
  assert.equal((await invoke(h,INPUT,{},'GET')).status,405);
  assert.equal((await invoke(h,INPUT,{'content-type':'text/plain'})).status,415);
  assert.equal((await invoke(h,{...INPUT,name:'x'.repeat(9000)},{'content-length':'0'},'POST',true)).status,413);
  assert.equal(calls.length,0); assert.equal(scans.length,0);
});

test('missing website returns all nine unknown rows, no automatic AI-site crawl or scores', async () => {
  const {h,calls,scans} = setup({data:raw({ candidates:[candidate({channels:[{type:'official',url:'https://never-crawl.example/'}]})], score:99, priorities:[{problem:'invented'}] })});
  const r = await invoke(h);
  assert.equal(r.status,200); assert.equal(scans.length,0); assert.equal(calls.length,1);
  assert.deepEqual(r.body.technicalScan.items.map(x=>x.key),SCAN_ROWS.map(x=>x.key));
  assert.ok(r.body.technicalScan.items.every(x=>x.status==='unknown'));
  assert.equal(r.body.technicalScan.targetUrl,null);
  assert.deepEqual(r.body.priorities,[]); assert.equal(r.body.suggestedQuestions.length,0);
  assert.match(r.body.notice,/AI 추가 분석 테스트 생략/);
  assert.match(r.body.business.description,/미검증 검색 단서/);
  assert.deepEqual(r.body.business.priceHoursBooking,{price:'품목별 상이',hours:'09:00~18:00',booking:'예약 가능이라는 미검증 검색 단서'});
  assert.equal(r.body.business.serviceArea,null);
  assert.doesNotMatch(JSON.stringify(r.body),/"score"|"total"|test-not-real-key|test-secret|invented/);
});

test('ambiguous/low/other-address candidates do not expose business details', async () => {
  for (const candidates of [[candidate({matchLevel:'medium'})],[candidate({address:'서울 중구 다른로 17'})],[candidate({name:'예시상사 지점'})],[candidate(),candidate()],[]]) {
    const b = buildBusiness(raw({candidates}),INPUT);
    assert.equal(b.category,null); assert.equal(b.priceHoursBooking.hours,null); assert.deepEqual(b.offerings,[]); assert.deepEqual(b.sources,[]);
    assert.equal(b.name,INPUT.name); assert.equal(b.address,INPUT.address);
  }
});

test('scanner evidence including contact fields is preserved exactly, never changed by model', async () => {
  const scan = scanFixture({mainFacts:{status:'present',evidence:'전화 02-123-4567, 이메일 help@example.org, 주소 서울 중구 예시로 15 확인'},noindex:{status:'present',evidence:'meta robots noindex'},robots:{status:'blocked',evidence:'User-agent ExampleBot; Disallow /private'},accessibility:{status:'blocked',evidence:'HTTP 403'}});
  const {h,scans} = setup({scan:async()=>scan, data:raw({technicalScan:{items:[{key:'noindex',status:'absent'}]},priorities:[{problem:'매출 부족'}]})});
  const r = await invoke(h,{...INPUT,website:WEBSITE});
  assert.equal(r.status,200); assert.deepEqual(r.body.technicalScan,scan); assert.equal(scans.length,1);
  assert.equal(r.body.priorities.length,3); assert.match(r.body.priorities[1].problem,/ExampleBot/);
  assert.doesNotMatch(JSON.stringify(r.body.priorities),/매출 부족/);
});

test('unknown/absent does not become invented negative, noindex absence is not negative', () => {
  const scan = scanFixture(Object.fromEntries(SCAN_ROWS.map(({key})=>[key,{status:'absent'}])));
  assert.deepEqual(confirmedPriorities(scan),[]);
  assert.deepEqual(confirmedPriorities(unknownTechnicalScan(null,'미검사')),[]);
});

test('fictional competitors and model-authored citations are excluded', async () => {
  const {h} = setup({data:raw({competitors:[{name:'허구상사',region:'서울 중구',source:{title:'허구상사 서울 중구',url:'https://fiction.example/'}}]})});
  const r = await invoke(h); assert.deepEqual(r.body.competitors,[]);
  assert.doesNotMatch(JSON.stringify(r.body),/허구상사|fiction.example/);
});

test('scanner failure gives honest nine-row partial report, cached failure prevents repeated scanning', async () => {
  const {h,scans,calls} = setup({scan:async()=>{throw Error('secret credential not for client');}});
  const a = await invoke(h,{...INPUT,website:WEBSITE});
  const b = await invoke(h,{...INPUT,website:WEBSITE});
  assert.equal(a.status,200); assert.ok(a.body.technicalScan.items.every(x=>x.status==='unknown'));
  assert.equal(scans.length,1); assert.equal(calls.length,1); assert.deepEqual(a.body.technicalScan,b.body.technicalScan);
  assert.doesNotMatch(JSON.stringify(a.body),/secret credential/);
});

test('same-domain cooldown handles variants and cache preserves observation time and exact scan', async () => {
  let clock = Date.parse('2026-11-08T01:00:00Z');
  const {h,scans,calls} = setup({now:()=>clock});
  const a = await invoke(h,{...INPUT,website:WEBSITE});
  clock += 1000;
  const b = await invoke(h,{...INPUT,website:WEBSITE});
  const variant = await invoke(h,{...INPUT,website:WEBSITE+'different'});
  assert.equal(a.body.scannedAt,b.body.scannedAt); assert.deepEqual(a.body.technicalScan,b.body.technicalScan);
  assert.ok(variant.body.technicalScan.items.every(x=>x.status==='unknown'));
  assert.equal(scans.length,1); assert.equal(calls.length,1);
  clock += 300000; await invoke(h,{...INPUT,website:WEBSITE}); assert.equal(scans.length,2); assert.equal(calls.length,1);
});

test('existing shared quota/budget still deny before scanner with an injected non-AI research stub', async () => {
  const {h,calls,scans,store} = setup({env:{...ENV,MAECHUL_IP_DAILY_SEARCHES:'1'}});
  await invoke(h,{...INPUT,website:WEBSITE});
  assert.equal(store.kv.get(budget()),20000);
  const denied = await invoke(h,{...INPUT,name:'다른상사',website:WEBSITE});
  assert.equal(denied.status,429); assert.equal(denied.body.code,'IP_QUOTA'); assert.equal(calls.length,1); assert.equal(scans.length,1);
  const tight = setup({env:{...ENV,MAECHUL_DAILY_BUDGET_USD:'0.05'}});
  const noBudget = await invoke(tight.h,{...INPUT,website:WEBSITE});
  assert.equal(noBudget.status,429); assert.equal(tight.calls.length,0); assert.equal(tight.scans.length,0);
});

test('provider transport failure is not retried, reservation retained, secrets never sent to client', async () => {
  let calls = 0;
  const {h,store,scans} = setup({fetcher:async()=>{calls++; throw Error('upstream secret-token');}});
  const result = await invoke(h,{...INPUT,website:WEBSITE});
  assert.equal(result.status,200); assert.equal(calls,1); assert.equal(scans.length,1);
  assert.equal(store.kv.get(budget()),350000); assert.equal(result.body.business.category,null);
  assert.match(result.body.notice,/검색에 실패/); assert.doesNotMatch(JSON.stringify(result.body),/secret-token/);
});


test('limited metropolitan aliases preserve exact address identity and menu price leads', () => {
  const b = buildBusiness(raw({candidates:[candidate({address:'서울특별시 중구 예시로 15',priceRange:null,menu:[{name:'용품',price:'1000원'}]})]}),INPUT);
  assert.equal(b.category,'생활용품 소매업'); assert.equal(b.priceHoursBooking.price,null);
  assert.match(b.offerings[0],/1000원.*미검증/);
  assert.equal(buildBusiness(raw({candidates:[candidate({address:'서울특별시 중구 예시로 16'})]}),INPUT).category,null);
});

test('only scanner-specific confirmed absence evidence supports optional improvements', () => {
  const scan = scanFixture({metadata:{status:'absent',evidence:'title: 없음; description: 없음'},structuredData:{status:'absent',evidence:'지원 JSON-LD에서 schema.org LocalBusiness/Organization 타입을 찾지 못함.'},sitemap:{status:'absent',evidence:'관례 경로 HTTP 404; 다른 사이트맵은 미확인.'},llmsTxt:{status:'absent',evidence:'/llms.txt HTTP 404'}});
  const p = confirmedPriorities(scan); assert.equal(p.length,3); assert.match(p[2].inconvenience,/다른 사이트맵/);
  assert.doesNotMatch(JSON.stringify(p),/llms/);
  scan.items.find(x=>x.key==='metadata').status='unknown'; assert.equal(confirmedPriorities(scan).length,2);
});

test('domain lock prevents concurrent requests from issuing a second scan', async () => {
  let resolveScan, startScan;
  const started = new Promise(resolve=>{startScan=resolve;});
  const {h,scans} = setup({scan:async()=>{startScan();return new Promise(resolve=>{resolveScan=resolve;});}});
  const first = invoke(h,{...INPUT,website:WEBSITE});
  await started;
  const second = await invoke(h,{...INPUT,website:WEBSITE+'other'});
  assert.equal(second.status,200); assert.ok(second.body.technicalScan.items.every(x=>x.status==='unknown')); assert.equal(scans.length,1);
  resolveScan(scanFixture()); assert.equal((await first).status,200);
});


test('integrated AI research receives real scan and may add validated results but cannot alter scan or confirmed priorities', async () => {
  const original = scanFixture({ noindex:{status:'present',evidence:'meta robots: noindex'} });
  let count = 0, seen;
  const research = async ({ business, technicalScan }) => {
    count++; seen = { business: structuredClone(business), technicalScan: structuredClone(technicalScan) };
    technicalScan.items.find(x=>x.key==='noindex').status='absent'; business.name='altered';
    return { suggestedQuestions:['질문 1?','질문 2?','질문 3?','질문 4?','질문 5?'], competitors:[], researchNotice:'AI가 생성한 예시 질문입니다.' };
  };
  const {h} = setup({ scan:async()=>original, researcher:research });
  const r = await invoke(h,{...INPUT,website:WEBSITE});
  assert.equal(r.status,200); assert.equal(count,1); assert.deepEqual(seen.technicalScan,original);
  assert.deepEqual(r.body.technicalScan,original); assert.equal(r.body.suggestedQuestions.length,5);
  assert.equal(r.body.priorities.length,1); assert.match(r.body.notice,/AI가 생성한 예시 질문/);
});

test('failed enrichment retains measured report and does not retry or fake AI results', async () => {
  let count=0; const original=scanFixture({noindex:{status:'present',evidence:'meta robots: noindex'}});
  const {h}=setup({scan:async()=>original,researcher:async()=>{count++;throw Error('private failure');}});
  const r=await invoke(h,{...INPUT,website:WEBSITE});
  assert.equal(r.status,200); assert.equal(count,1); assert.deepEqual(r.body.technicalScan,original);
  assert.deepEqual(r.body.suggestedQuestions,[]); assert.deepEqual(r.body.competitors,[]);
  assert.match(r.body.notice,/자동 재시도하지 않았으며/); assert.doesNotMatch(JSON.stringify(r.body),/private failure/);
});


test('specific robot disallow and exact homepage 404 are grounded issues', () => {
  const s=scanFixture({robots:{status:'present',evidence:'HTTP 200; 검사기 allow; Googlebot:disallow, Bingbot:allow'},accessibility:{status:'absent',evidence:'페이지 HTTP 404'}});
  const p=confirmedPriorities(s);assert.equal(p.length,2);assert.match(p[0].problem,/Googlebot:disallow/);assert.match(p[1].problem,/HTTP 404/);assert.match(p[0].inconvenience,/다른 봇이나 경로/);
});


test('road address permits only metropolitan aliases, commas and parenthesized parcel supplements', () => {
  const road = '대구 중구 동성로3길 32-13';
  for (const address of [
    '대구광역시 중구 동성로3길 32-13 (삼덕동1가 28-32)',
    '대구 중구 동성로3길 32-13, (삼덕동1가, 28-32)',
    ' 대구광역시  중구 동성로3길 32-13 (삼덕동1가 28-32번지) ',
  ]) {
    assert.equal(addressesMatch(road,address),true,address);
    assert.equal(addressesMatch(address,road),true,address);
    const input = {...INPUT,address:road};
    const business = buildBusiness(raw({candidates:[candidate({address})]}),input);
    assert.equal(business.category,'생활용품 소매업'); assert.equal(business.address,road);
    assert.match(business.description,/미검증 검색 단서/);
  }
});

test('road matching does not collapse different cities, streets, building numbers, parcels or branches', () => {
  const road = '대구 중구 동성로3길 32-13';
  for (const other of [
    '대구 중구 동성로3길 32-14 (삼덕동1가 28-32)',
    '대구 중구 동성로3길 32 (삼덕동1가 28-32)',
    '대구 중구 동성로3길 32-130 (삼덕동1가 28-32)',
    '대구 중구 동성로4길 32-13 (삼덕동1가 28-32)',
    '서울 중구 동성로3길 32-13 (삼덕동1가 28-32)',
    '대구 남구 동성로3길 32-13 (삼덕동1가 28-32)',
    '대구 중구 동성로3길 32-13 (동성로점)',
    '대구 중구 동성로3길 32-13 (삼덕동1가 28-32 동성로점)',
  ]) assert.equal(addressesMatch(road,other),false,other);
  assert.equal(addressesMatch(road+' (삼덕동1가 28-32)',road+' (삼덕동1가 28-33)'),false);
  assert.equal(addressesMatch(road+' 본점',road+' 지점'),false);
});

test('floors, units and building designators survive parcel cleanup and conflicting details reject', () => {
  const road = '대구 중구 동성로3길 32-13';
  assert.equal(addressesMatch(road+', 2층 201호',road+' (삼덕동1가 28-32), 2층 201호'),true);
  assert.equal(addressesMatch(road+' (2층) 201호',road+' (삼덕동1가 28-32), 2층 201호'),true);
  assert.equal(addressesMatch(road,road+' (삼덕동1가 28-32), 2층 201호'),true);
  assert.equal(addressesMatch(road+' 지하1층',road+' (삼덕동1가 28-32), B1층'),true);
  for (const [left,right] of [
    ['2층','3층'], ['2층 201호','2층 202호'], ['1동 201호','2동 201호'],
    ['지하1층','1층'], ['2층','(3층)'], ['2층','(삼덕동1가 28-32 3층)'],
    ['2층','2층 3층'], ['201호','201호 202호'],
  ]) assert.equal(addressesMatch(road+' '+left,road+' (삼덕동1가 28-32), '+right),false,left+' / '+right);
});

test('parcel-normalized matching still requires exactly one high candidate with exact business name', () => {
  const input = {...INPUT,address:'대구 중구 동성로3길 32-13'};
  const c = candidate({address:'대구광역시 중구 동성로3길 32-13 (삼덕동1가 28-32)'});
  for (const candidates of [[{...c,name:INPUT.name+' 동성로점'}],[{...c,matchLevel:'medium'}],[c,c]]) {
    const b = buildBusiness(raw({candidates}),input);
    assert.equal(b.category,null); assert.deepEqual(b.offerings,[]); assert.match(b.description,/확인하지 못해/);
  }
});

test('business summary is two useful sentences grounded only in input name/address and searched category/menu', () => {
  const b = buildBusiness(raw({candidates:[candidate({menu:[{name:'생활용품',price:'1000원'},{name:'청소도구',price:null}],strengths:['전국 최고'],features:['24시간'],rating:'5점',description:'검증 완료 업체'})]}),INPUT);
  assert.match(b.description,/서울 중구 예시로 15/); assert.match(b.description,/예시상사/);
  assert.match(b.description,/생활용품 소매업/); assert.match(b.description,/생활용품, 청소도구/);
  assert.match(b.description,/미검증 검색 단서/); assert.equal(b.description.split(/\.\s+|\.$/).filter(Boolean).length,2);
  assert.doesNotMatch(b.description,/전국 최고|24시간|5점|검증 완료|1000원|09:00/);
});

test('summary missing fields stay unknown, and unmatched business retains the original unavailable notice', () => {
  const missing = buildBusiness(raw({candidates:[candidate({category:null,menu:[]})]}),INPUT);
  assert.match(missing.description,/업종은 미확인/); assert.match(missing.description,/상품·서비스 항목은 미확인/);
  assert.match(missing.description,/미검증 검색 단서/);
  const unmatched = buildBusiness(raw({candidates:[candidate({address:'서울 중구 예시로 16'})]}),INPUT);
  assert.equal(unmatched.description,'사용자 입력 상호·주소입니다. 단일 업체의 일치를 충분히 확인하지 못해 검색 상세를 표시하지 않습니다.');
  assert.doesNotMatch(unmatched.description,/생활용품/);
});

test('endpoint preserves integrated researcher and scanner while supplying the grounded matched summary', async () => {
  const input = {...INPUT,address:'대구 중구 동성로3길 32-13',website:WEBSITE};
  const original = scanFixture(); let seen;
  const {h} = setup({data:raw({candidates:[candidate({address:'대구광역시 중구 동성로3길 32-13 (삼덕동1가 28-32)'})]}),scan:async()=>original,researcher:async({business})=>{seen=business;return {suggestedQuestions:['테스트 질문?'],competitors:[],researchNotice:'추가 연구 보존'};}});
  const result = await invoke(h,input);
  assert.equal(result.status,200); assert.equal(seen.category,'생활용품 소매업');
  assert.match(seen.description,/대구 중구 동성로3길 32-13/); assert.match(seen.description,/미검증 검색 단서/);
  assert.deepEqual(result.body.technicalScan,original); assert.deepEqual(result.body.suggestedQuestions,['테스트 질문?']);
  assert.match(result.body.notice,/추가 연구 보존/);
});
