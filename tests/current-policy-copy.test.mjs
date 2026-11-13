import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function renderPolicy(kind)');
const policy = app.slice(start, app.indexOf('// ───────── 바닥글', start));

test('정책 문서는 새 시행일과 서비스 식별 정보를 사용한다', () => {
  assert.match(policy, /const D = '2026년 11월 14일'/);
  assert.match(policy, /www\.lookhereai\.com/);
  assert.match(policy, /www\.kkumsu\.com/);
  assert.doesNotMatch(policy, /매출올려드림/);
});

test('유료 조건은 제안과 계획으로만 안내하고 실제 결제를 부인한다', () => {
  for (const x of ['3,900원', '100명', '1년', '자동 갱신', '7일', '실제 결제는 진행하지 않습니다', '삭제되거나 유료로 바뀌거나 청구되지 않습니다', '보장하지 않습니다']) {
    assert.ok(policy.includes(x), x);
  }
  assert.doesNotMatch(policy, /정가|할인 중|90일|결제가 승인되면 즉시/);
});

test('환불은 실제 지원 이메일을 쓰고 자발적 환불 뒤 게시를 종료한다', () => {
  assert.match(policy, /biz\('email'\)/);
  assert.match(policy, /자발적으로 환불을 받으면[^']*게시는 종료/);
});

test('개인정보처리방침은 토스페이먼츠를 향후 계획으로만 구분하고 기존 이메일 표현을 유지한다', () => {
  assert.match(policy, /토스페이먼츠\(주\)\(대한민국\): 향후/);
  assert.match(policy, /테스트 주문번호·금액 및 접속 정보가 전달될 수/);
  assert.match(policy, /개인정보를 전송하거나 처리를 위탁하지 않아요/);
  assert.match(policy, /OpenRouter/);
  assert.match(policy, /biz\('privacyEmail', biz\('email'\)\)/);
});

test('예정된 1년 상품에는 중도 해지와 일할 환불 및 처리 기준이 있다', () => {
  for (const v of ['7일이 지난 뒤에도', '해지 요청 접수 다음 날', '별도 위약금은 받지 않을 계획', '3영업일 이내', '법령상 더 유리한 기준']) assert.ok(policy.includes(v), v);
});
