import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeHomePricing } from '../public/home-pricing.js';
const h=(tag,attrs,...children)=>({tag,attrs:attrs||{},children:children.flat(Infinity).filter(x=>x!=null&&x!==false)});
const textOf=n=>n==null?'':typeof n==='object'?n.children.map(textOf).join(' '):String(n);
function all(n,p,out=[]){if(n&&typeof n==='object'){if(p(n))out.push(n);for(const c of n.children||[])all(c,p,out)}return out}
test('공개·QR·공유까지 무료이며 유료 가격 계획을 보여주지 않는다',()=>{const n=makeHomePricing(h,()=>{}),t=textOf(n);for(const s of ['무료','0원','결제 없이','가게 소개 페이지 공개','공개 주소와 QR 코드','SNS에 쓸 공유 문구','관리 비밀번호로 내용 수정·삭제','준비중','검색 노출과 AI 추천은 보장하지 않아요'])assert.ok(t.includes(s),s);assert.doesNotMatch(t,/3,900|유료 전환|유료 출시|정기결제|구매자/);});
test('무료 시작 버튼은 기존 동작을 사용한다',()=>{let count=0;const n=makeHomePricing(h,()=>count++);const b=all(n,x=>x.tag==='button')[0];assert.equal(b.attrs.type,'button');b.attrs.onclick();assert.equal(count,1)});
test('홈 가격 안내가 개인정보 카드 뒤에 있으며 단일 플랜 레이아웃이다',async()=>{const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/styles.css',import.meta.url),'utf8');const home=app.slice(app.indexOf('function renderHome()'),app.indexOf('// ───────── 2.'));assert.ok(home.indexOf('개인정보처리방침 자세히 보기')<home.indexOf('makeHomePricing(h, focusStart)'));assert.match(css,/\.pricing-plans \{[^}]*grid-template-columns: minmax\(0, 1fr\)/)});
