import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PaymentService} from '../lib/payments.mjs';
import {MockRedis} from './mock-redis.mjs';
// Synthetic fixtures only: no network, no real user documents.
const now=()=>Date.parse('2026-11-07T10:00:00Z');
const service=()=>new PaymentService({secret:'test-session-secret-at-least-thirty-two-chars',origin:'https://example.test',redisURL:'https://redis.test',redisToken:'mock',env:{PAYMENT_MODE:'disabled'}},new MockRedis(now),{now});
const cp=s=>Array.from(s);
// Visible part is exactly 70 percent of the code points, so the lock boundary is deterministic.
function build(visibleText,hiddenText){const k=Math.max(Math.ceil(cp(visibleText).length/70),Math.ceil(cp(hiddenText).length/30)),pad=(s,n)=>s+'ㅇ'.repeat(n-cp(s).length);const V=pad(visibleText,70*k),H=pad(hiddenText,30*k);const body=V+H;assert.equal(Math.floor(cp(body).length*.7),cp(V).length);return {body,V,H};}
const report=()=>({overview:'안전한 전체 진단입니다.',strengths:[{quote:'가상의 안전한 근거',comment:'구체적인 행동이 드러납니다.'}],improvements:[{priority:'high',problem:'과정 설명이 짧습니다.',suggestion:'행동 순서를 밝혀 보세요.'}],questions:[]});
const change=(o={})=>({category:'wording',before:'비공개원문표현알파',after:'공개된수정표현하나',reason:'문장을 간결하게 정리했습니다.',...o});
function stored({visible,hidden,changes,version='continuous-v3',analysis=true}){const {body}=build(visible,hidden);return {source:'ai',product:'revision',sections:[{id:'p1',heading:'x',text:body}],quality:{checks:[]},revision:{previewVersion:version,lengthMode:'characters',limit:null,originalLength:100,revisedLength:cp(body).length,inlineEditRanges:[],...(analysis?{deepAnalysis:report()}:{}),changes,diagnosis:[],warnings:[]}};}
async function preview(data,full=false){const p=service(),out=await p.saveGeneratedResult('synthetic-owner',randomUUID(),data);if(!full)return {out,p};const rec=await p.resultRecord(out.resultId);return {out:p.projection(rec,true),p};}
const VIS='😀😀 가상 시작입니다. 공개된수정표현하나가 있습니다. 다음 문장입니다. ';
const HID=' 숨겨진수정표현둘이 뒤에 있습니다. 끝 비공개수정문장은절대공개금지입니다.';

test('visible note exposes only code-point offsets, category and filtered reason',async()=>{
 const {out}=await preview(stored({visible:VIS,hidden:HID,changes:[change()]}));
 assert.equal(out.revisionNotes.length,1);const n=out.revisionNotes[0];assert.deepEqual(Object.keys(n).sort(),['category','end','id','reason','start']);
 const shown=out.sections[0].segments[0].text;assert.equal(cp(shown).slice(n.start,n.end).join(''),'공개된수정표현하나');
 const expected=cp(VIS).findIndex((_,i)=>cp(VIS).slice(i,i+9).join('')==='공개된수정표현하나');assert.equal(n.start,expected);
 assert.ok(shown.indexOf('공개된수정표현하나')>n.start,'UTF-16 index differs from code point index because of emoji');
 assert.deepEqual(out.noteSummary,{shown:1,withheld:0});
 const json=JSON.stringify(out);assert.ok(!json.includes('비공개원문표현알파'),'private before text never ships');assert.ok(!json.includes('숨겨진수정표현둘'));assert.ok(!('changes' in out));assert.equal(json.includes('scoreCard'),false);
});
test('notes entirely beyond the 70 percent boundary are withheld',async()=>{
 const {out}=await preview(stored({visible:VIS,hidden:HID,changes:[change(),change({after:'숨겨진수정표현둘',reason:'숨은 문장을 정리했습니다.'})]}));
 assert.equal(out.revisionNotes.length,1);assert.deepEqual(out.noteSummary,{shown:1,withheld:1});assert.ok(!JSON.stringify(out).includes('숨겨진수정표현둘'));assert.ok(!JSON.stringify(out).includes('숨은 문장을 정리'));
});
test('a note crossing the visible boundary is withheld entirely',async()=>{
 const visible='가나다라 경계를넘는수정',hidden='표현은여기까지입니다 그리고 이어집니다';
 const {body,V}=build(visible,hidden);const tail=cp(V).slice(-3).join('')+cp(body).slice(cp(V).length,cp(V).length+4).join('');assert.ok(cp(tail).length===7);
 const {out}=await preview(stored({visible,hidden,changes:[change({after:tail,reason:'경계 문장을 고쳤습니다.'})]}));
 assert.equal(out.revisionNotes.length,0);assert.deepEqual(out.noteSummary,{shown:0,withheld:1});
});
test('reasons that overlap hidden text, source text or revised text are rejected',async()=>{
 const reasons=['수정은 비공개수정문장은절대공개금지입니다 때문입니다.','숨겨진수정표현둘이 뒤에 있습니다','비공개원문표현알파를 바꿨습니다','공개된수정표현하나로 바꿨습니다'];
 for(const reason of reasons){const {out}=await preview(stored({visible:VIS,hidden:HID,changes:[change({reason})]}));assert.equal(out.revisionNotes.length,0,reason);assert.ok(!JSON.stringify(out).includes('절대공개금지'));assert.ok(!JSON.stringify(out).includes('비공개원문표현알파'));}
 const short=await preview(stored({visible:VIS,hidden:'끝 안녕합니다. 진짜비밀.',changes:[change({reason:'진짜비밀 문장 때문입니다.'})]}));assert.equal(short.out.revisionNotes.length,0);
});
test('ambiguous or duplicated revised text never receives a guessed position',async()=>{
 const dup='중복된표현입니다',visible='가 '+dup+' 나 '+dup+' 다 ',hidden=' 끝';
 const a=await preview(stored({visible,hidden,changes:[change({after:dup})]}));assert.equal(a.out.revisionNotes.length,0);
 const hiddenDup=await preview(stored({visible:'가 '+dup+' 나',hidden:' '+dup+' 끝',changes:[change({after:dup})]}));assert.equal(hiddenDup.out.revisionNotes.length,0);
 const overlap=await preview(stored({visible:'가 ㅂㅂㅂㅂ 나',hidden:' 끝',changes:[change({after:'ㅂㅂㅂ'})]}));assert.equal(overlap.out.revisionNotes.length,0);
});
test('malformed change entries, categories, controls and overlaps are dropped safely',async()=>{
 const good=change();const bad=[null,'x',{...good,category:'fit'},{...good,after:''},{...good,after:'   '},{...good,before:''},{...good,reason:''},{...good,reason:'x'.repeat(161)},{...good,reason:'제어\u0000문자 이유'},{...good,after:42},{...good,after:'\ud800'}];
 for(const group of [bad.slice(0,6),bad.slice(6)]){const {out}=await preview(stored({visible:VIS,hidden:HID,changes:[...group,good,change({after:'공개된수정표현',reason:'겹치는 구간입니다.'})]}));
 assert.equal(out.revisionNotes.length,1);assert.equal(out.revisionNotes[0].reason,good.reason);}
 const many=await preview(stored({visible:VIS,hidden:HID,changes:Array.from({length:20},()=>good)}));assert.equal(many.out.revisionNotes.length,1,'only the first eight are considered; identical ones are one note');
});
test('older results and versions never receive notes',async()=>{
 for(const [version,changes] of [['continuous-v2',[change()]],['continuous-v3',[]],['simple-v1',[change()]],[undefined,[change()]]]){
  const d=stored({visible:VIS,hidden:HID,changes,version,analysis:false});if(version===undefined)delete d.revision.previewVersion;
  const {out}=await preview(d);assert.equal(out.revisionNotes,undefined);assert.equal(out.noteSummary,undefined);
  const {out:full}=await preview(d,true);assert.equal(full.revisionNotes,undefined);
 }
});
test('free analysis report remains filtered and has no score',async()=>{
 const d=stored({visible:VIS,hidden:HID,changes:[change()]});d.revision.deepAnalysis.strengths.push({quote:'비공개수정문장은절대공개금지입니다',comment:'비공개수정문장은절대공개금지입니다'});
 const {out}=await preview(d);assert.equal(out.analysisReport.strengths.length,1);assert.ok(!JSON.stringify(out).includes('절대공개금지'));assert.equal(JSON.stringify(out).includes('scoreCard'),false);assert.equal(out.previewLayout,'continuous-v2');
 const locked=out.sections[0].segments.filter(s=>s.kind==='locked');assert.ok(locked.length&&locked.every(s=>!('text' in s)));
});
test('paid path keeps only valid unique notes and never invents notes',async()=>{
 const {out}=await preview(stored({visible:VIS,hidden:HID,changes:[change(),change({after:'숨겨진수정표현둘',reason:'뒤 문장을 정리했습니다.',category:'logic'}),change({after:'ㅇ',reason:'모호한 문자.'}),change({after:'없는표현입니다',reason:'본문에 없음.'})]}),true);
 assert.equal(out.access,'full');assert.equal(out.revisionNotes.length,2);assert.deepEqual(out.noteSummary,{shown:2,withheld:2});
 assert.equal(cp(out.sections[0].text).slice(out.revisionNotes[1].start,out.revisionNotes[1].end).join(''),'숨겨진수정표현둘');
});
test('preview is stable on repeated reads and ignores injected top-level fields',async()=>{
 const d=stored({visible:VIS,hidden:HID,changes:[change()]});d.revisionNotes=[{start:0,end:5,category:'logic',reason:'가짜'}];const {out,p}=await preview(d);assert.equal(out.revisionNotes.length,1);assert.notEqual(out.revisionNotes[0].reason,'가짜');assert.deepEqual(await p.getPublicResult('synthetic-owner',out.resultId),out);
});
test('XSS-looking reason is data only on the server',async()=>{
 const {out}=await preview(stored({visible:VIS,hidden:HID,changes:[change({reason:'<img src=x onerror=alert(1)> 정리'})]}));assert.equal(out.revisionNotes[0].reason,'<img src=x onerror=alert(1)> 정리');
});

// ---------- browser rendering with a minimal DOM ----------
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/render\(\);await checkStatus\(\);if\(S.callback\)await confirmPayment\(\);\s*$/,'');
class Mock {constructor(tag='div'){this.tagName=tag;this.children=[];this.attrs={};this.className='';this._text='';}set textContent(x){this._text=String(x);this.children=[];}get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}setAttribute(k,v){this.attrs[k]=String(v);}append(...x){this.children.push(...x);}addEventListener(){}querySelector(){return null;}querySelectorAll(){return [];}focus(){}replaceChildren(...x){this.children=x;}}
function fixture(){const document=new Mock(),roots={app:new Mock(),dialog:new Mock(),announce:new Mock()};document.querySelector=q=>roots[q.slice(1)]||null;document.createElement=t=>new Mock(t);document.createTextNode=t=>{const n=new Mock('text');n.textContent=t;return n;};document.body=new Mock('body');const ctx=vm.createContext({document,Node:Mock,location:{pathname:'/',search:''},window:{addEventListener(){},scrollTo(){}},URL,URLSearchParams,AbortController,TextEncoder,setTimeout,clearTimeout,navigator:{},crypto:{},Blob,fetch(){throw Error('network forbidden')},console});vm.runInContext(source,ctx);return code=>vm.runInContext(code,ctx);}
const nodes=n=>[n,...n.children.flatMap(nodes)];
const previewState=(notes,summary,text='😀😀 가상 문장입니다. 수정된 부분 입니다.',marks='[[3,5]]')=>`S.result={product:'revision',access:'preview',previewLayout:'continuous-v2',analysisReport:null,revisionNotes:${JSON.stringify(notes)},noteSummary:${JSON.stringify(summary)},sections:[{heading:'x',segments:[{kind:'visible',text:${JSON.stringify(text)},marks:${marks}},{kind:'locked',lines:3}]}],purchase:{ready:false},privacy:{}}`;
test('notes are paired with their exact code-point segment and rendered as text nodes',()=>{
 const r=fixture();r(previewState([{id:'n1',start:3,end:11,category:'wording',reason:'<img src=x onerror=alert(1)> 이유'}],{shown:1,withheld:0}));
 const page=r('resultPage()'),all=nodes(page);
 const seg=all.find(x=>x.className==='why-seg');assert.ok(seg);assert.equal(seg.textContent,'가상 문장입니다');
 const chip=all.find(x=>x.className==='why-chip');assert.equal(chip.tagName,'button');assert.equal(chip.attrs.type,'button');assert.ok(chip.attrs['aria-label'].includes('수정 이유 1번'));assert.equal(chip.attrs['aria-describedby'],'why-note-0');
 const li=all.find(x=>x.className==='why-note');assert.equal(li.attrs.id,'why-note-0');assert.equal(li.attrs.tabindex,'-1');assert.ok(li.textContent.includes('<img src=x onerror=alert(1)> 이유'));
 assert.equal(all.filter(x=>['img','script'].includes(x.tagName)).length,0);
 assert.ok(all.some(x=>x.className==='inline-edit'));assert.ok(page.textContent.includes('나머지 수정본은 잠겨'));
});
test('invalid, overlapping or out-of-range notes are all ignored instead of mislabeling text',()=>{
 const bad=[[{start:0,end:99,category:'wording',reason:'x'}],[{start:3,end:6,category:'logic',reason:'a'},{start:5,end:8,category:'logic',reason:'b'}],[{start:3,end:6,category:'fit',reason:'a'}],[{start:3,end:6,category:'logic',reason:''}],[{start:3,end:6,category:'logic',reason:'x'.repeat(161)}],'x',[{start:-1,end:2,category:'logic',reason:'a'}],[{start:1.5,end:3,category:'logic',reason:'a'}]];
 for(const notes of bad){const r=fixture();r(previewState(notes,{shown:1,withheld:0}));const all=nodes(r('resultPage()'));assert.equal(all.filter(x=>x.className==='why-chip').length,0,JSON.stringify(notes));}
});
test('older and note-less results show no notes and make no note claims',()=>{
 const r=fixture();r(previewState(undefined,undefined));const text=r('resultPage()').textContent;assert.ok(!text.includes('수정 이유'));assert.ok(!text.includes('번호를 누르면'));
 const old=fixture();old("S.result={product:'revision',access:'full',revision:{previewVersion:'continuous-v2',inlineEditRanges:[[0,2]]},revisionNotes:[{start:0,end:2,category:'logic',reason:'가짜'}],sections:[{id:'p1',heading:'x',text:'가상의 전체 수정문입니다.'}],privacy:{autoDeleteOnDelivery:true}}");
 const fullNodes=nodes(old('resultPage()'));assert.ok(fullNodes.some(x=>x.className==='inline-edit'));
});
test('withheld notes and deletion-only results are described without claiming identical text',()=>{
 const r=fixture();r(previewState([],{shown:0,withheld:2},'가상 문장입니다.','[]'));const text=r('resultPage()').textContent;assert.ok(text.includes('수정 이유 2개는 잠긴 구간'));assert.ok(text.includes('표시할 추가·변경 문자가 없어요'));
 const f=fixture();f("S.result={product:'revision',access:'full',revision:{previewVersion:'continuous-v3',inlineEditRanges:[]},revisionNotes:[],noteSummary:{shown:0,withheld:1},sections:[{id:'p1',heading:'x',text:'가상 전체문장.'}],privacy:{autoDeleteOnDelivery:true}}");const t=f('resultPage()').textContent;assert.ok(t.includes('표시할 추가·변경 문자가 없어요'));assert.ok(t.includes('수정 이유 1개는 위치나 내용을 확인하지 못해'));
});
test('full result annotates unicode text and keeps copy/export text untouched',()=>{
 const r=fixture();r("S.result={product:'revision',access:'full',revision:{previewVersion:'continuous-v3',inlineEditRanges:[[2,4]]},revisionNotes:[{id:'n1',start:3,end:5,category:'evidence',reason:'근거를 덧붙임'}],noteSummary:{shown:1,withheld:0},sections:[{id:'p1',heading:'x',text:'😀😀가나다라'}],privacy:{autoDeleteOnDelivery:true}}");
 const all=nodes(r('resultPage()'));assert.equal(all.find(x=>x.className==='why-seg').textContent,'나다');assert.equal(r('fullText(false)'),'😀😀가나다라');assert.ok(all.some(x=>x.className==='why-note'&&x.textContent.includes('근거를 덧붙임')));
});
test('analysis cards separate quote, problem, importance and action without inventing fields',()=>{
 const r=fixture();r("S.result={product:'revision',access:'preview',previewLayout:'continuous-v2',analysisReport:{overview:'전체 진단',strengths:[{quote:'안전 근거',comment:'좋은 이유 설명'}],improvements:[{priority:'high',problem:'문제 설명',suggestion:'행동 제안'},{priority:'low',quote:'<b>x</b>',problem:'다른 문제',suggestion:'다른 제안'}],questions:[{question:'확인 질문입니다'}],filtered:true},sections:[{heading:'x',segments:[{kind:'visible',text:'가상',marks:[]},{kind:'locked',lines:2}]}],purchase:{ready:false},privacy:{}}");
 const page=r('resultPage()'),t=page.textContent;for(const s of ['글 속 근거','좋은 이유','아쉬운 점','중요도 높음','중요도 낮음','이렇게 고쳐 보세요','스스로 답해 볼 질문','근거 문장은 표시하지 않았어요'])assert.ok(t.includes(s),s);
 assert.ok(!t.includes('점수'));assert.equal(nodes(page).filter(x=>x.tagName==='b').length,0);
});

test('long report publishes only allowlisted truthful scope metadata',async()=>{const d=stored({visible:VIS,hidden:HID,changes:[change()]});d.revision.longChunked=true;d.revision.reportScope={method:'chunk_analysis_synthesis',partial:true,independentReview:true,chunksTotal:3,chunksAnalyzed:2,chunksPreserved:1,chunksUnanalyzed:0,itemsOmitted:4,notice:'비공개수정문장은절대공개금지입니다',privateSource:'비공개원문표현알파'};const {out}=await preview(d);assert.deepEqual(out.analysisReport.scope,{method:'chunk_analysis_synthesis',partial:true,independentReview:true,chunksTotal:3,chunksAnalyzed:2,chunksPreserved:1,chunksUnanalyzed:0,itemsOmitted:4});assert(!JSON.stringify(out).includes('절대공개금지'));assert(!JSON.stringify(out).includes('비공개원문표현알파'));});
test('inline note remains visible on desktop and mobile and does not modify copied text',()=>{const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');assert.match(css,/\.why-pop\{display:inline;position:static/);assert.match(css,/@media\(max-width:700px\)\{\.why-pop\{display:inline/);const r=fixture();r("S.result={product:'revision',access:'full',revision:{previewVersion:'continuous-v3',inlineEditRanges:[[0,2]]},revisionNotes:[{id:'n1',start:0,end:2,category:'logic',reason:'의미를 분명하게 했어요.'}],noteSummary:{shown:1,withheld:0},sections:[{id:'p1',heading:'x',text:'가상의 수정글입니다.'}],privacy:{autoDeleteOnDelivery:true}}");const result=r('resultPage()'),all=nodes(result);assert(all.some(n=>n.className==='why-pop'&&n.textContent.includes('의미를 분명하게')));assert.equal(r('fullText(false)'),'가상의 수정글입니다.');});
