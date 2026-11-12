// Shared fail-closed configuration checks for both AI access routes.
// A different URL alone does not prove two endpoints use different backing DBs.
export function strictStartedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z') ? ms : null;
}
export function validAiProjectId(value) {
  return typeof value === 'string' && /^prj_[A-Za-z0-9]{8,100}$/.test(value);
}
export function validDedicatedRedis(env) {
  try {
    if (typeof env?.YB_AI_ACCESS_REDIS_URL !== 'string' || typeof env.YB_AI_ACCESS_REDIS_TOKEN !== 'string' || !env.YB_AI_ACCESS_REDIS_TOKEN.trim()) return false;
    const url = new URL(env.YB_AI_ACCESS_REDIS_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 2048) return false;
    const canonical = (v) => { try { return new URL(v).href.replace(/\/+$/, ''); } catch { return null; } };
    const endpoint = canonical(url.href);
    return ![env.KV_REST_API_URL, env.UPSTASH_REDIS_REST_URL].filter(Boolean).some(v => canonical(v) === endpoint);
  } catch { return false; }
}
