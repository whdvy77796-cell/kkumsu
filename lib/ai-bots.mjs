import { isIP } from 'node:net';

// No request data is logged, retained in cache, or sent to a feed provider.
// This verifies membership in published networks, not the identity of a process.
// Callers must supply the numeric peer IP from a trusted proxy boundary, not an
// arbitrary X-Forwarded-For value. Mapped IPv6 deliberately fails closed.
export const LIMITS = Object.freeze({ uaLength: 2048, feedBytes: 524288,
  prefixes: 4096, timeoutMs: 3000, cacheMs: 6 * 60 * 60 * 1000, failureBackoffMs: 60 * 1000 });
export const FEED_URLS = Object.freeze({
  search: 'https://openai.com/searchbot.json',
  training: 'https://openai.com/gptbot.json',
  user: 'https://openai.com/chatgpt-user.json',
  anthropic: 'https://claude.com/crawling/bots.json',
  google: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
});
const definitions = [
  ['OAI-SearchBot', 'openai', 'search', FEED_URLS.search],
  ['GPTBot', 'openai', 'training', FEED_URLS.training],
  ['ChatGPT-User', 'openai', 'user', FEED_URLS.user],
  ['Claude-SearchBot', 'anthropic', 'search', FEED_URLS.anthropic],
  ['ClaudeBot', 'anthropic', 'training', FEED_URLS.anthropic],
  ['Claude-User', 'anthropic', 'user', FEED_URLS.anthropic],
  ['Googlebot', 'google', 'search_engine', FEED_URLS.google],
].map(([bot, provider, purpose, url]) => Object.freeze({ bot, provider, purpose, url,
  token: new RegExp('(?:^|[\\s(;])' + bot + '(?:/[0-9]+(?:\\.[0-9]+)*)?(?=$|[\\s;)])', 'i') }));
const allowedUrls = new Set(Object.values(FEED_URLS));
// Fetcher identity partitions cache: fixtures/untrusted fetchers cannot poison
// the default fetch cache. Only the five hard-coded URL keys can be inserted.
const caches = new WeakMap();

export function classifyUserAgent(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.length ||
      userAgent.length > LIMITS.uaLength || /[\x00-\x1f\x7f-\uffff]/.test(userAgent)) return null;
  const matches = definitions.filter(({ token }) => token.test(userAgent));
  if (matches.length !== 1) return null; // conflicting identities fail closed
  const { bot, provider, purpose } = matches[0];
  return { bot, provider, purpose };
}

function numericIp(input) {
  if (typeof input !== 'string' || input.length > 45 || !input.length ||
      input.includes('%')) return null;
  const family = isIP(input);
  if (family === 4) return { bits: 32, value: input.split('.').reduce((n, p) => (n << 8n) | BigInt(p), 0n) };
  if (family !== 6 || input.includes('.')) return null;
  const halves = input.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const value = words.reduce((n, p) => (n << 16n) | BigInt('0x' + p), 0n);
  if ((value >> 32n) === 65535n) return null; // ::ffff:0:0/96
  return { bits: 128, value };
}

export function parseCidr(input) {
  if (typeof input !== 'string' || input.length > 49) return null;
  const match = /^([^/]+)\/(0|[1-9][0-9]{0,2})$/.exec(input);
  if (!match) return null;
  const ip = numericIp(match[1]);
  const prefix = Number(match[2]);
  if (!ip || prefix > ip.bits) return null;
  const shift = BigInt(ip.bits - prefix);
  return Object.freeze({ bits: ip.bits, prefix, network: (ip.value >> shift) << shift });
}

export function cidrContains(cidr, ip) {
  const range = parseCidr(cidr);
  const address = numericIp(ip);
  return !!range && !!address && contains(range, address);
}
function contains(range, address) {
  const shift = BigInt(range.bits - range.prefix);
  return range.bits === address.bits && (address.value >> shift) === (range.network >> shift);
}

function decodeFeed(bytes) {
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!data || typeof data !== 'object' || !Array.isArray(data.prefixes) ||
      !data.prefixes.length || data.prefixes.length > LIMITS.prefixes) throw new Error('Invalid feed');
  return data.prefixes.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid prefix');
    const v4 = Object.hasOwn(entry, 'ipv4Prefix');
    const v6 = Object.hasOwn(entry, 'ipv6Prefix');
    if (v4 === v6) throw new Error('Invalid prefix');
    const range = parseCidr(entry[v4 ? 'ipv4Prefix' : 'ipv6Prefix']);
    if (!range || range.bits !== (v4 ? 32 : 128)) throw new Error('Invalid prefix');
    return range;
  });
}

async function download(url, fetcher) {
  if (!allowedUrls.has(url)) return null;
  const controller = new AbortController();
  let reader;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Feed timeout')); }, LIMITS.timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher(url, { method: 'GET', redirect: 'error',
        signal: controller.signal, credentials: 'omit', headers: { Accept: 'application/json' } });
      if (controller.signal.aborted) throw new Error('Feed timeout');
      if (!response || response.status !== 200 || response.redirected ||
          (response.url && response.url !== url) || !response.body?.getReader) throw new Error('Invalid response');
      const length = response.headers?.get('content-length');
      if (length != null && (!/^[0-9]+$/.test(length) || Number(length) > LIMITS.feedBytes)) throw new Error('Oversized feed');
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error('Feed timeout');
        if (done) break;
        if (!(value instanceof Uint8Array) || (size += value.byteLength) > LIMITS.feedBytes) throw new Error('Oversized feed');
        chunks.push(value.slice());
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return decodeFeed(bytes);
    })()]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
  }
}

function fresh(entry, now) {
  return entry.ranges && now >= entry.at && now - entry.at < LIMITS.cacheMs &&
    Date.now() >= entry.wallAt && Date.now() - entry.wallAt < LIMITS.cacheMs;
}
// Negative cache: a failed/stalled refresh suppresses further downloads for this
// fetcher+feed for failureBackoffMs. Bounds latency to one timeout per window.
// The backoff lasts until EITHER the monotonic clock or the caller clock shows the
// window elapsed; a rewound caller clock cannot shorten it (fails safe), and a
// rewound/odd monotonic reading ends it. Failures never produce usable ranges.
const mono = () => performance.now();
function backingOff(entry, now) {
  const f = entry.failure;
  if (!f) return false;
  const m = mono() - f.mono;
  const c = now - f.at; // negative (rewound caller clock) stays in backoff
  return m >= 0 && m < LIMITS.failureBackoffMs && c < LIMITS.failureBackoffMs;
}
async function rangesFor(url, fetcher, now) {
  if (!allowedUrls.has(url) || typeof fetcher !== 'function') return null;
  let cache = caches.get(fetcher);
  if (!cache) { cache = new Map(); caches.set(fetcher, cache); }
  let entry = cache.get(url);
  if (!entry) { entry = {}; cache.set(url, entry); }
  if (fresh(entry, now)) return entry.ranges;
  if (!entry.pending) {
    if (backingOff(entry, now)) return null;
    // Stale ranges are never used as a fallback after a failed refresh.
    entry.ranges = null;
    const started = mono();
    entry.pending = download(url, fetcher).then(ranges => {
      entry.ranges = ranges;
      if (ranges) {
        entry.failure = null;
        entry.at = now; // conservative: age from refresh start, not completion
        entry.wallAt = Date.now();
      } else {
        const end = mono();
        entry.failure = { at: now + Math.max(0, Math.floor(end - started)), mono: end };
      }
    }).finally(() => { entry.pending = null; });
  }
  await entry.pending;
  return fresh(entry, now) ? entry.ranges : null;
}
export async function identifyBot({ userAgent, clientIp, fetcher = fetch, now = Date.now() } = {}) {
  const identity = classifyUserAgent(userAgent);
  if (!identity) return null;
  const result = { ...identity, verification: 'unverified' };
  const address = numericIp(clientIp);
  if (!address || typeof now !== 'number' || !Number.isFinite(now) || now < 0) return result;
  const url = definitions.find(item => item.bot === identity.bot).url;
  const ranges = await rangesFor(url, fetcher, now);
  if (ranges?.some(range => contains(range, address))) result.verification = 'verified';
  return result;
}
