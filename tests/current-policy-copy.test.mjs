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

test('승인된 유료 조건은 출시 예정으로 안내하고 실제 결제를 부인한다', () => {
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

test('결제가 꺼진 현재 베타 샘플 보고서는 잠기지 않고 유료 판매로 오해시키지 않는다', () => {
  const sample = app.slice(app.indexOf('async function renderSample('), app.indexOf('// ───────── 이용약관'));
  assert.ok(sample.includes("PAY.mode === 'off'"));
  assert.ok(sample.includes("if (betaFreeSample) sampleView = 'paid'"));
  assert.ok(sample.includes('betaFreeSample ? null'));
  assert.ok(sample.includes('현재 베타에서는 실제 결제 없이 전체 보고서와 PDF 저장을 무료로 이용'));
});

test('승인된 상품 조건은 출시 예정으로 표시하고 미확정 제안으로 남기지 않는다', () => {
  for (const x of ['출시 예정 가격: 처음 유료로 구매하는 100명까지 3,900원', '출시 예정 서비스 기간: 유료 게시일부터 1년', '청약철회와 환불, 출시 예정 조건']) assert.ok(policy.includes(x), x);
  assert.doesNotMatch(policy, /제안 조건|가격\(제안\)|서비스 기간\(제안\)/);
});
