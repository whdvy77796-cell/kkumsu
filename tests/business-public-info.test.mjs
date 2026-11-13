import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BUSINESS, businessReady } from '../public/business.js';
import { payConfig } from '../lib/pay.mjs';

test('등록증과 공정위 조회에 맞는 사업자 정보와 문의처를 사용한다', () => {
  assert.deepEqual({
    name: BUSINESS.name,
    owner: BUSINESS.owner,
    bizNo: BUSINESS.bizNo,
    mailOrderNo: BUSINESS.mailOrderNo,
    address: BUSINESS.address,
    phone: BUSINESS.phone,
    email: BUSINESS.email,
    privacyEmail: BUSINESS.privacyEmail,
  }, {
    name: '유즈풀쇼핑몰',
    owner: '임종표',
    bizNo: '587-17-01601',
    mailOrderNo: '2022-대구중구-0208',
    address: '대구광역시 중구 달구벌대로447길 34-35, 101호(삼덕동3가)',
    phone: '010-2995-8439',
    email: 'lookhereai@yahoo.com',
    privacyEmail: 'lookhereai@yahoo.com',
  });
  assert.equal(businessReady(), true);
});

test('사업자 정보만 채워도 운영 환경의 테스트 키로 결제가 켜지지 않는다', () => {
  const production = {
    VERCEL: '1',
    VERCEL_ENV: 'production',
    TOSS_CLIENT_KEY: 'test_ck_example',
    TOSS_SECRET_KEY: 'test_sk_example',
  };
  const cfg = payConfig(production);
  assert.equal(cfg.mode, 'off');
  assert.equal(cfg.reason, 'test_keys_in_production');
  assert.equal(payConfig({ ...production, MAECHUL_PAYWALL: 'off' }).mode, 'off');
});

test('홈페이지 바닥글과 개인정보처리방침이 동일한 사업자 정보와 문의처를 참조한다', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /businessReady\(\)/);
  for (const field of ['name', 'owner', 'bizNo', 'mailOrderNo', 'address', 'phone', 'email']) {
    assert.ok(app.includes(`B.${field}`), `footer missing ${field}`);
  }
  assert.ok(app.includes("biz('privacyEmail')"));
  assert.ok(app.includes("biz('privacyEmail', biz('email'))"));
});
