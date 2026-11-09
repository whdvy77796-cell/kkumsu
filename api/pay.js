// GET  /api/pay                                     결제 설정(모드·가격·클라이언트 키: 공개 값만)
// POST /api/pay { action: 'view', rid, token }       보고서 다시 열기 (결제 전이면 잠긴 부분은 빼고 보냄)
// POST /api/pay { action: 'order', rid, token }      결제창을 열기 위한 주문 만들기 (금액은 서버가 정함)
// POST /api/pay { action: 'delete', rid, token }     서버에 보관된 보고서 지우기 (결제 기록은 법에 따라 남김)
// POST /api/pay { action: 'confirm', paymentKey, orderId, amount, rid?, token? }
//                                                     토스페이먼츠 결제 승인 → 맞춤 실행 패키지 열기
import { HttpError, send, sendError, readJson, checkOrigin, createStore } from '../lib/guard.mjs';
import {
  payConfig, publicPay, publicPayment, loadReport, tokenOk, tokenHash, newId, repKey, orderKey,
  RETENTION, ORDER_RE, tossCall,
} from '../lib/pay.mjs';
import { redactReport } from '../public/paywall.js';

const GONE = '보고서를 찾지 못했어요. 결제하지 않은 보고서는 7일, 결제한 보고서는 90일 동안 보관해요.';
const DENY = '이 보고서를 열 수 있는 링크가 아니에요. 보고서를 만든 브라우저에서 다시 열어 주세요.';

function present(rec, cfg, extra = {}) {
  const open = !!rec.paid || cfg.mode === 'off';
  const data = open ? rec.data : redactReport(rec.data);
  return { ...data, ...extra, paid: !!rec.paid, payment: publicPayment(rec.paid), pay: publicPay(cfg) };
}

async function view({ env, store, cfg, body }) {
  const rec = await loadReport(store, body.rid);
  if (!rec) throw new HttpError(404, 'REPORT_GONE', GONE);
  if (!tokenOk(rec, body.token, env)) throw new HttpError(403, 'REPORT_TOKEN', DENY);
  return present(rec, cfg, { rid: body.rid });
}

async function order({ env, store, cfg, body }) {
  if (cfg.mode === 'off') throw new HttpError(409, 'PAY_OFF', '지금은 결제를 받지 않아요.');
  const rec = await loadReport(store, body.rid);
  if (!rec) throw new HttpError(404, 'REPORT_GONE', GONE);
  if (!tokenOk(rec, body.token, env)) throw new HttpError(403, 'REPORT_TOKEN', DENY);
  if (rec.paid) return { paid: true };
  const orderId = `MO${Date.now().toString(36)}${newId(9)}`;
  await store.setJson(orderKey(orderId), {
    rid: body.rid, amount: cfg.amount, orderName: cfg.orderName, mode: cfg.mode, status: 'ready', createdAt: new Date().toISOString(),
  }, RETENTION.order);
  return { orderId, amount: cfg.amount, orderName: cfg.orderName, clientKey: cfg.clientKey, mode: cfg.mode };
}

async function remove({ env, store, body }) {
  const rec = await loadReport(store, body.rid);
  if (!rec) return { deleted: true };
  if (!tokenOk(rec, body.token, env)) throw new HttpError(403, 'REPORT_TOKEN', DENY);
  await store.del(repKey(body.rid));
  return { deleted: true };
}

async function confirm({ env, fetcher, store, cfg, body }) {
  const { paymentKey, orderId } = body;
  const amount = Number(body.amount);
  if (typeof paymentKey !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(paymentKey) || typeof orderId !== 'string' || !ORDER_RE.test(orderId)) {
    throw new HttpError(400, 'PAY_PARAMS', '결제 정보가 올바르지 않아요.');
  }
  if (cfg.mode === 'off') throw new HttpError(409, 'PAY_OFF', '지금은 결제를 받지 않아요. 결제가 됐다면 고객센터로 알려 주세요.');
  const lockKey = `${orderKey(orderId)}:lock`;
  if (!(await store.lock(lockKey, 60))) throw new HttpError(409, 'BUSY', '결제를 확인하는 중이에요. 잠시 뒤 다시 확인해 주세요.');
  try {
    const ord = await store.getJson(orderKey(orderId));
    if (!ord) throw new HttpError(404, 'ORDER', '주문을 찾지 못했어요. 결제가 승인되지 않았으니 보고서 화면에서 다시 시도해 주세요.');
    const rec = await loadReport(store, ord.rid);
    // 보고서가 없으면 승인하지 않는다 (승인하지 않은 결제는 돈이 빠져나가지 않는다)
    if (!rec) throw new HttpError(404, 'REPORT_GONE', `${GONE} 결제는 승인하지 않았어요.`);
    let token = null;
    const tokenValid = tokenOk(rec, body.token, env);
    const issueToken = () => {
      if (tokenValid) return;
      token = newId(24);
      rec.tokens = [...(rec.tokens || []), tokenHash(token, env)].slice(-5);
    };

    if (ord.status === 'done') {
      // 새로고침 등으로 다시 온 경우: 같은 결제면 그대로 열어 준다
      if (ord.paymentKey !== paymentKey) throw new HttpError(409, 'ORDER_USED', '이미 다른 결제로 처리된 주문이에요.');
      issueToken();
      if (token) await store.setJson(repKey(ord.rid), rec, RETENTION.paid);
      return { ...present(rec, cfg, { rid: ord.rid }), ...(token ? { token } : {}) };
    }
    if (amount !== ord.amount) throw new HttpError(400, 'PAY_AMOUNT', '결제 금액이 주문 금액과 달라 승인하지 않았어요.');

    let p;
    try {
      p = await tossCall({ env, fetcher, path: '/payments/confirm', body: { paymentKey, orderId, amount: ord.amount }, idempotencyKey: `confirm-${orderId}` });
    } catch (err) {
      if (err.tossCode !== 'ALREADY_PROCESSED_PAYMENT') throw err;
      p = await tossCall({ env, fetcher, method: 'GET', path: `/payments/${encodeURIComponent(paymentKey)}` });
    }
    if (p?.status !== 'DONE' || p.orderId !== orderId || Number(p.totalAmount) !== ord.amount) {
      throw new HttpError(402, 'PAY_NOT_DONE', '결제가 완료되지 않았어요. 다시 시도해 주세요.');
    }
    const paid = {
      orderId,
      paymentKey,
      amount: ord.amount,
      approvedAt: p.approvedAt || new Date().toISOString(),
      method: p.easyPay?.provider ? `${p.method || '간편결제'}(${p.easyPay.provider})` : p.method || null,
      receiptUrl: p.receipt?.url || null,
      test: cfg.mode === 'test',
    };
    // 결제 기록은 5년 (주문번호·금액·일시·수단·결제 키·보고서 번호만, 보고서 내용은 넣지 않음)
    await store.setJson(orderKey(orderId), {
      ...ord, status: 'done', paymentKey, approvedAt: paid.approvedAt, method: paid.method, test: paid.test,
    }, RETENTION.payment);
    rec.paid = paid;
    issueToken();
    await store.setJson(repKey(ord.rid), rec, RETENTION.paid);
    console.log(`[maechul] paid order=${orderId} amount=${ord.amount} mode=${cfg.mode}`);
    return { ...present(rec, cfg, { rid: ord.rid }), ...(token ? { token } : {}) };
  } finally {
    await store.unlock(lockKey).catch(() => {});
  }
}

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    const env = deps.env || process.env;
    const fetcher = deps.fetcher || fetch;
    try {
      const cfg = payConfig(env, deps.business);
      if (req.method === 'GET') return send(res, 200, { ok: true, ...publicPay(cfg), reason: cfg.reason || null });
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        throw new HttpError(405, 'METHOD', '지원하지 않는 요청이에요.');
      }
      checkOrigin(req, env);
      const body = await readJson(req, 4000);
      const store = deps.store || createStore(env, fetcher);
      if (!store) throw new HttpError(503, 'STORE_CONFIG', '저장소 설정이 없어 잠시 멈췄어요.');
      const ctx = { env, fetcher, store, cfg, body: body || {} };
      if (ctx.body.action === 'view') return send(res, 200, await view(ctx));
      if (ctx.body.action === 'order') return send(res, 200, await order(ctx));
      if (ctx.body.action === 'confirm') return send(res, 200, await confirm(ctx));
      if (ctx.body.action === 'delete') return send(res, 200, await remove(ctx));
      throw new HttpError(400, 'ACTION', '알 수 없는 요청이에요.');
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export default createHandler();
