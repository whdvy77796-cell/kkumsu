// OpenRouter를 거쳐 Claude를 부른다. 키: OPENROUTER_API_KEY
import { HttpError } from './guard.mjs';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
export const REPAIR_MODEL = 'anthropic/claude-haiku-5.5';

// 응답에 비용(usage.cost)이 없을 때 쓰는 단가 (달러/100만 토큰)
const RATES = {
  'anthropic/claude-sonnet-5.5': { in: 2, out: 10 },
  'anthropic/claude-haiku-5.5': { in: 0.1, out: 0.5 },
};

export class AiError extends HttpError {
  constructor(status, code, message, { charged = 'no', detail } = {}) {
    super(status, code, message);
    this.charged = charged; // 'no' | 'unknown'
    this.detail = detail;
  }
}

export function costMicro(model, usage) {
  if (Number.isFinite(usage?.cost) && usage.cost >= 0) return Math.ceil(usage.cost * 1e6);
  const r = RATES[model] || { in: 5, out: 25 };
  const inTok = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const outTok = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const searches = usage?.server_tool_use_details?.web_search_requests ?? 0;
  return Math.ceil(inTok * r.in + outTok * r.out + searches * 10000);
}

export async function chat({
  env,
  fetcher = fetch,
  model = DEFAULT_MODEL,
  system,
  user,
  tools,
  maxToolCalls,
  maxTokens = 3000,
  responseFormat,
  reasoningEffort = 'low',
  timeoutMs = 60000,
}) {
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new AiError(503, 'AI_CONFIG', 'AI 연결 설정이 아직 안 됐어요.');
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    provider: { data_collection: 'deny' },
    usage: { include: true },
  };
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort, exclude: true };
  if (tools) {
    body.tools = tools;
    if (maxToolCalls) body.max_tool_calls = maxToolCalls;
  }
  if (responseFormat) body.response_format = responseFormat;

  let res;
  try {
    res = await fetcher(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.MAECHUL_SITE_URL || 'https://www.kkumsu.com',
        'X-Title': 'Maechul AI',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // 연결이 끊기거나 시간이 지나면 제공자가 이미 처리했을 수도 있다.
    throw new AiError(504, 'AI_TIMEOUT', 'AI 응답이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.', { charged: 'unknown' });
  }
  const raw = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 아래에서 처리 */ }
  if (!res.ok || !data || data.error) {
    const detail = String(data?.error?.message || raw || '').slice(0, 300);
    console.error('[maechul] openrouter error', res.status, detail);
    if (res.status === 402) throw new AiError(503, 'AI_CREDIT', 'AI 이용 크레딧이 부족해요. 운영자에게 알려주세요.', { detail });
    if (res.status === 429) throw new AiError(503, 'AI_BUSY', 'AI 사용량이 몰렸어요. 잠시 후 다시 시도해 주세요.', { detail });
    throw new AiError(502, 'AI_PROVIDER', 'AI가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', { detail, status: res.status });
  }
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  let text = msg.content;
  if (Array.isArray(text)) text = text.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  const usage = data.usage || {};
  return {
    text: typeof text === 'string' ? text : '',
    annotations: Array.isArray(msg.annotations) ? msg.annotations : [],
    usage,
    finish: choice.finish_reason || null,
    model: data.model || model,
    provider: data.provider || null,
    costMicro: costMicro(model, usage),
  };
}

// 모델이 JSON 앞뒤에 설명이나 코드블록 표시를 붙여도 꺼내 읽는다.
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch { /* 계속 */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* 계속 */ }
  }
  return null;
}
