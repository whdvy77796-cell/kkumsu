// POST /api/report  { name, address, store, answers, pasted?, refresh? }
// 사장님이 동의한 뒤 보낸 인터뷰 답변 + 서버 계산값 + AI가 인터넷에서 직접 조사한 공개 정보(/api/research)를 합쳐
// Claude가 진단 보고서와 맞춤 솔루션을 만든다. 숫자는 서버가 계산하고(lib/report-calc.mjs), AI는 그 값만 근거로 쓴다.
import { HttpError, send, sendError, readJson, checkOrigin, runMetered, hashKey, createStore } from '../lib/guard.mjs';
import { chat, extractJson, DEFAULT_MODEL, REPAIR_MODEL } from '../lib/ai.mjs';
import { REPORT_SYSTEM, REPORT_SCHEMA, REPORT_REPAIR_SYSTEM, REPORT_VERSION, validateReportInput, buildReportInput, normalizeReport, looksLikeReport } from '../lib/report.mjs';
import { computeMetrics } from '../lib/report-calc.mjs';
import { mockEnabled, mockReport, mockResearch } from '../lib/mock.mjs';
import { status } from './store-search.js';
import { getResearch } from './research.js';
import { payConfig, publicPay, saveReport } from '../lib/pay.mjs';
import { redactReport } from '../public/paywall.js';

// 만든 보고서는 보고서 번호(rid)로 7일 보관하고, 결제를 받는 중이면 잠긴 부분을 빼고 보낸다.
// rid·token 은 보고서를 만든 브라우저만 받는다(결제·다시 열기에 씀).
async function deliver(store, env, result) {
  const cfg = payConfig(env);
  if (!store) return { ...result, rid: null, paid: false, pay: publicPay({ ...cfg, mode: 'off' }) };
  const { rid, token } = await saveReport(store, env, result);
  const body = cfg.mode === 'off' ? result : redactReport(result);
  return { ...body, rid, token, paid: false, pay: publicPay(cfg) };
}

export async function makeReport({ env, fetcher, input, computed, research, meter }) {
  const model = env.MAECHUL_REPORT_MODEL || env.MAECHUL_AI_MODEL || DEFAULT_MODEL;
  let r;
  try {
    r = await chat({
      env,
      fetcher,
      model,
      system: REPORT_SYSTEM,
      user: buildReportInput(input, computed, research),
      maxTokens: 16000,
      reasoningEffort: 'low',
      timeoutMs: 200000,
    });
  } catch (err) {
    if (err.charged === 'unknown') meter.markUnknown();
    throw err;
  }
  meter.add(r.costMicro);
  let parsed = extractJson(r.text);
  if (!looksLikeReport(parsed)) {
    if (!r.text.trim()) throw new HttpError(502, 'AI_EMPTY', 'AI가 만든 보고서를 받지 못했어요. 다시 시도해 주세요.');
    // 형식이 어긋나면 저렴한 모델로 형식만 다시 맞춘다 (내용은 바꾸지 않음).
    let fix;
    try {
      fix = await chat({
        env,
        fetcher,
        model: env.MAECHUL_REPAIR_MODEL || REPAIR_MODEL,
        system: REPORT_REPAIR_SYSTEM,
        user: r.text.slice(0, 60000),
        maxTokens: 14000,
        reasoningEffort: null,
        responseFormat: { type: 'json_schema', json_schema: { name: 'store_report', strict: true, schema: REPORT_SCHEMA } },
        timeoutMs: 60000,
      });
    } catch (err) {
      if (err.charged === 'unknown') meter.markUnknown();
      throw err;
    }
    meter.add(fix.costMicro);
    parsed = extractJson(fix.text);
  }
  if (!looksLikeReport(parsed)) throw new HttpError(502, 'AI_FORMAT', 'AI가 만든 보고서를 정리하지 못했어요. 다시 시도해 주세요.');
  return {
    v: REPORT_VERSION,
    report: normalizeReport(parsed, computed.metrics, input),
    metrics: computed.metrics,
    cautions: computed.cautions,
    bench: computed.bench,
    research: publicResearch(research),
    pasted: !!input.pasted,
    store: { name: input.store?.name || input.name, address: input.store?.address || input.address },
    model: r.model,
    truncated: r.finish === 'length',
    createdAt: new Date().toISOString(),
  };
}

// 화면에 보여 줄 조사 결과 (내부 표시는 뺀다)
function publicResearch(rs) {
  if (!rs) return null;
  const { input, cached, ...rest } = rs;
  return rest;
}

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    const env = deps.env || process.env;
    const fetcher = deps.fetcher || fetch;
    try {
      if (req.method === 'GET') return send(res, 200, status(env));
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        throw new HttpError(405, 'METHOD', '지원하지 않는 요청이에요.');
      }
      checkOrigin(req, env);
      const input = validateReportInput(await readJson(req, 90000));
      const computed = computeMetrics({ answers: input.answers }, input.store);
      if (mockEnabled(env)) {
        const research = await mockResearch(input, 0);
        const mockStore = deps.store || createStore(env, fetcher);
        return send(res, 200, await deliver(mockStore, env, await mockReport(input, computed, deps.mockDelay, research)));
      }
      const store = deps.store || createStore(env, fetcher);
      // 1) 인터넷 조사: 화면이 먼저 /api/research 로 만들어 둔 결과를 쓰고, 없으면 여기서 조사한다.
      const research = await getResearch({
        env, fetcher, store, req,
        input: { name: input.name, address: input.address, store: input.store, refresh: false, engine: null },
      });
      // 2) 보고서
      const result = await runMetered({
        env,
        fetcher,
        store,
        req,
        kind: 'report',
        cacheKey: hashKey('report', `v${REPORT_VERSION}`, input.name, input.address, JSON.stringify(input.store), JSON.stringify(input.answers), input.pasted, research.searchedAt),
        refresh: input.refresh,
        lock: true,
        run: (meter) => makeReport({ env, fetcher, input, computed, research, meter }),
      });
      return send(res, 200, await deliver(store, env, result));
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export default createHandler();