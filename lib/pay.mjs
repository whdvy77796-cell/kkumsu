// 유료 맞춤 실행 패키지 결제 (토스페이먼츠 결제창 · 서버 승인)
//
// 결제 모드 (토스페이먼츠 결제위젯 결제창형 키 gck/gsk 또는 결제창(구버전) 키 ck/sk 모두 지원)
//   off  : 결제를 받지 않는다. 보고서는 전부 보여 준다. (키가 없거나, 운영 사이트에 테스트 키, 사업자 정보 미입력)
//   test : 테스트 키(test_). 미리보기 사이트에서만. 실제로 돈이 나가지 않는다.
//   live : 라이브 키(live_) + 사업자 정보가 모두 있을 때만.
// 금액은 언제나 서버가 정한다(화면이 보낸 금액은 주문 금액과 같은지 확인만 한다).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, isProduction } from './guard.mjs';
import { BUSINESS, businessReady } from '../public/business.js';

export const PRODUCT = { name: '매출올려드림 맞춤 실행 패키지', amount: 9900, list: 19900 };

// 보관 기간(초)
export const RETENTION = {
  unpaid: 7 * 86400, // 결제 전 보고서: 7일 (무료로 보다가 결제할 수 있게)
  paid: 90 * 86400, // 결제한 보고서: 결제일로부터 90일 (다시 보기 링크)
  order: 86400, // 결제창을 연 주문: 하루
  demo: 86400, // 결제 과정 체험(샘플): 하루
  payment: 5 * 365 * 86400, // 결제 기록(주문번호·금액·일시·수단): 5년 (전자상거래법 대금결제·공급 기록)
};

const posInt = (v, d) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
};

export function payConfig(env, business = BUSINESS) {
  const amount = posInt(env.MAECHUL_PRICE, PRODUCT.amount);
  const list = Math.max(amount, posInt(env.MAECHUL_LIST_PRICE, PRODUCT.list));
  const base = { amount, list, orderName: PRODUCT.name };
  if (String(env.MAECHUL_PAYWALL || '').toLowerCase() === 'off') return { ...base, mode: 'off', reason: 'disabled' };
  const ck = String(env.TOSS_CLIENT_KEY || '').trim();
  const sk = String(env.TOSS_SECRET_KEY || '').trim();
  if (!ck || !sk) return { ...base, mode: 'off', reason: 'no_keys' };
  // 결제위젯(주문서형·결제창형) 키는 gck/gsk, 결제창(구버전) API 개별 연동 키는 ck/sk. 같은 종류끼리 짝이어야 한다.
  const kindOf = (k, c, s) => (new RegExp(`_${c}_`).test(k) ? 'widget' : new RegExp(`_${s}_`).test(k) ? 'api' : null);
  if (kindOf(ck, 'gck', 'ck') !== kindOf(sk, 'gsk', 'sk') || !kindOf(ck, 'gck', 'ck')) return { ...base, mode: 'off', reason: 'key_mismatch' };
  if (ck.startsWith('test_') && sk.startsWith('test_')) {
    // 운영 사이트에서 테스트 키로 결제를 열면 돈 없이 보고서가 열리므로 막는다
    if (isProduction(env) && env.MAECHUL_ALLOW_TEST_PAY !== '1') return { ...base, mode: 'off', reason: 'test_keys_in_production' };
    return { ...base, mode: 'test', clientKey: ck };
  }
  if (ck.startsWith('live_') && sk.startsWith('live_')) {
    if (!businessReady(business)) return { ...base, mode: 'off', reason: 'business_info' };
    return { ...base, mode: 'live', clientKey: ck };
  }
  return { ...base, mode: 'off', reason: 'key_mismatch' };
}

// 화면에 보내도 되는 값만 (클라이언트 키는 원래 공개용)
export const publicPay = ({ mode, amount, list, orderName, clientKey }) => ({ mode, amount, list, orderName, ...(mode === 'off' ? {} : { clientKey }) });

// ───────── 보고서 보관 (보고서 번호 rid + 본인 확인용 token)
export const newId = (bytes = 12) => randomBytes(bytes).toString('base64url');
export const RID_RE = /^[A-Za-z0-9_-]{16,32}$/;
export const ORDER_RE = /^MO[A-Za-z0-9_-]{10,40}$/;
export const repKey = (rid) => `maechul:v1:rep:${rid}`;
export const orderKey = (orderId) => `maechul:v1:order:${orderId}`;

const secretOf = (env) => env.SESSION_SECRET || env.OPENROUTER_API_KEY || 'maechul-dev-secret';
export const tokenHash = (token, env) => createHmac('sha256', secretOf(env)).update(`rt:${token}`).digest('hex');
export function tokenOk(rec, token, env) {
  if (!rec || typeof token !== 'string' || token.length < 16 || token.length > 100) return false;
  const h = Buffer.from(tokenHash(token, env));
  return (rec.tokens || []).some((t) => {
    const b = Buffer.from(String(t));
    return b.length === h.length && timingSafeEqual(b, h);
  });
}

export async function saveReport(store, env, data, ttl = RETENTION.unpaid) {
  const rid = newId(12); // 16자
  const token = newId(24); // 32자
  const { cached, ...clean } = data || {};
  const rec = { v: 1, createdAt: new Date().toISOString(), tokens: [tokenHash(token, env)], paid: null, data: clean };
  await store.setJson(repKey(rid), rec, ttl);
  return { rid, token };
}

export async function loadReport(store, rid) {
  if (typeof rid !== 'string' || !RID_RE.test(rid)) return null;
  return store.getJson(repKey(rid));
}

export const publicPayment = (p) => (p ? {
  orderId: p.orderId, amount: p.amount, approvedAt: p.approvedAt || null, method: p.method || null, receiptUrl: p.receiptUrl || null, test: !!p.test,
} : null);

// ───────── 토스페이먼츠 API (시크릿 키는 서버에서만)
const TOSS_API = 'https://api.tosspayments.com/v1';
export async function tossCall({ env, fetcher = fetch, method = 'POST', path, body, idempotencyKey }) {
  const auth = `Basic ${Buffer.from(`${String(env.TOSS_SECRET_KEY || '').trim()}:`).toString('base64')}`;
  let r;
  let data = null;
  try {
    r = await fetcher(TOSS_API + path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000),
    });
    try { data = await r.json(); } catch { data = null; }
  } catch {
    throw new HttpError(504, 'PAY_TIMEOUT', '결제 확인 응답이 늦어지고 있어요. 잠시 뒤 다시 확인해 주세요. 같은 결제는 두 번 빠져나가지 않아요.');
  }
  if (!r.ok) {
    const err = new HttpError(r.status >= 500 ? 502 : 400, 'PAY_FAILED', String(data?.message || '결제를 승인하지 못했어요.').slice(0, 200), { tossCode: data?.code || null });
    err.tossCode = data?.code || null;
    throw err;
  }
  return data || {};
}
