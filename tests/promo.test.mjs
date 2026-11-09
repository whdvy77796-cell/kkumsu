// 보고서 맨 아래 고정 안내(사장님이 직접 시작할 수 있는 매장 홍보 방법) 점검
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMO, PROMO_LINKS, PROMO_PROMPT } from '../public/promo.js';

test('항목 2개: 01 AI 콘텐츠 5단계, 02 리뷰노트 체험단 4단계', () => {
  assert.equal(PROMO.title, '사장님이 직접 시작할 수 있는 매장 홍보 방법');
  assert.deepEqual(PROMO.items.map((it) => [it.no, it.title, it.steps.length]), [
    ['01', 'AI로 인스타그램·스레드·블로그 콘텐츠 자동화하기', 5],
    ['02', '리뷰노트로 체험단 직접 모집하기', 4],
  ]);
  for (const it of PROMO.items) for (const s of it.steps) assert.ok(s.title && s.body, `${it.no} 단계 내용이 비었음`);
});

test('링크 4개는 모두 https 이고 정해진 자리에 붙는다', () => {
  const links = PROMO.items.flatMap((it) => [it.leadLink, it.noteLink, ...it.steps.map((s) => s.link)]).filter(Boolean);
  assert.deepEqual(links.map((l) => l.text), ['연결 방법', '반복 작업 설정', '리뷰노트 서비스 안내', '공정거래위원회 안내']);
  for (const l of links) assert.match(l.url, /^https:\/\/[^\s]+$/);
  assert.equal(new Set(Object.values(PROMO_LINKS)).size, 4);
});

test('요청 문장: 확인 못 한 수치는 추정하지 않고, 게시 전에 검토', () => {
  assert.equal(PROMO.items[0].prompt.text, PROMO_PROMPT);
  assert.equal(PROMO_PROMPT.split('\n').length, 4);
  assert.match(PROMO_PROMPT, /확인할 수 없는 수치는 추정하지 마\./);
  assert.match(PROMO_PROMPT, /게시 전에 검토할 수 있게 보여줘\./);
});

test('비용 안내와 협찬 표시 안내가 빠지지 않는다', () => {
  assert.equal(PROMO.items[0].cost, '무료 또는 구독 중인 AI 요금만 소모');
  assert.match(PROMO.items[0].note, /AI 구독·API 이용료가 발생할 수 있으며/);
  assert.match(PROMO.items[1].note, /유료 서비스 비용은 별도입니다/);
  assert.match(PROMO.items[1].note, /제목 또는 글의 첫 부분에 표시/);
});