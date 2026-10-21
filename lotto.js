// Vercel 서버리스 함수: 로또 6/45 당첨번호 중계
//   GET /api/lotto?round=1246   → 해당 회차
//   GET /api/lotto?round=latest → 가장 최근 회차
// 응답: { round, date:"YYYY-MM-DD", numbers:[6개], bonus, source }
// 아직 결과가 없는 회차: 404 { error:"not_found", round }
//
// 데이터 출처
//   1순위) 동행복권 공식: https://www.dhlottery.co.kr/lt645/selectPstLt645Info.do
//          (예전 common.do?method=getLottoNumber 주소는 사이트 개편 후 JSON을 주지 않습니다)
//          전 회차를 한 번에 주므로, 받은 목록을 1시간 동안 메모리에 들고 회차를 골라 줍니다.
//   2순위) 공식 주소가 막히면 공개 JSON: https://smok95.github.io/lotto/results/{회차}.json
// 동행복권은 해외 IP를 막는 경우가 있어, vercel.json 에서 함수 지역을 서울(icn1)로 지정했습니다.

const OFFICIAL = "https://www.dhlottery.co.kr/lt645/selectPstLt645Info.do?srchLtEpsd=all";
const MIRROR = "https://smok95.github.io/lotto/results/";
const TTL = 60 * 60 * 1000; // 1시간

let memo = { at: 0, byRound: null, latest: 0 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const q = String(req.query.round || "latest");
  const wantLatest = q === "latest";
  const round = parseInt(q, 10);
  if (!wantLatest && !(round >= 1 && round <= 9999)) {
    return res.status(400).json({ error: "bad_round" });
  }

  // 1) 공식 데이터
  try {
    const table = await officialTable();
    const r = wantLatest ? table.latest : round;
    const d = table.byRound.get(r);
    if (d) return send(res, 200, d, 3600);
    if (r > table.latest) return send(res, 404, { error: "not_found", round: r }, 300);
  } catch (e) {
    console.error("official failed:", e.message);
  }

  // 2) 공개 JSON 예비 경로
  try {
    const url = MIRROR + (wantLatest ? "latest" : round) + ".json";
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.status === 404) return send(res, 404, { error: "not_found", round }, 300);
    if (!r.ok) throw new Error("mirror " + r.status);
    const j = await r.json();
    const d = {
      round: Number(j.draw_no),
      date: String(j.date).slice(0, 10),
      numbers: (j.numbers || []).map(Number).sort((a, b) => a - b),
      bonus: Number(j.bonus_no),
      source: "mirror",
    };
    if (valid(d)) return send(res, 200, d, 3600);
    throw new Error("mirror bad data");
  } catch (e) {
    console.error("mirror failed:", e.message);
  }

  return send(res, 502, { error: "upstream_unavailable" }, 0);
}

function send(res, status, body, maxAge) {
  // Vercel CDN이 1시간 캐시, 만료 후 10분은 이전 응답을 주면서 새로 받아 옵니다
  res.setHeader("Cache-Control", maxAge ? `public, s-maxage=${maxAge}, stale-while-revalidate=600` : "no-store");
  return res.status(status).json(body);
}

async function officialTable() {
  if (memo.byRound && Date.now() - memo.at < TTL) return memo;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(OFFICIAL, {
      signal: ctl.signal,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.dhlottery.co.kr/lt645/result",
        "User-Agent": "Mozilla/5.0 (compatible; kkumsu/1.0)",
      },
    });
    if (!r.ok) throw new Error("official " + r.status);
    const text = await r.text();
    const j = JSON.parse(text); // 대기열·차단 안내 HTML이면 여기서 실패합니다
    const list = (j && j.data && j.data.list) || [];
    const byRound = new Map();
    let latest = 0;
    for (const x of list) {
      const d = {
        round: Number(x.ltEpsd),
        date: fmtYmd(x.ltRflYmd),
        numbers: [x.tm1WnNo, x.tm2WnNo, x.tm3WnNo, x.tm4WnNo, x.tm5WnNo, x.tm6WnNo].map(Number).sort((a, b) => a - b),
        bonus: Number(x.bnsWnNo),
        source: "dhlottery",
      };
      if (valid(d)) { byRound.set(d.round, d); if (d.round > latest) latest = d.round; }
    }
    if (!latest) throw new Error("official empty");
    memo = { at: Date.now(), byRound, latest };
    return memo;
  } finally {
    clearTimeout(timer);
  }
}

function fmtYmd(s) {
  s = String(s || "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

function valid(d) {
  return d && Number.isInteger(d.round) && d.round > 0 &&
    Array.isArray(d.numbers) && d.numbers.length === 6 &&
    d.numbers.every(n => Number.isInteger(n) && n >= 1 && n <= 45) &&
    new Set(d.numbers).size === 6 &&
    Number.isInteger(d.bonus) && d.bonus >= 1 && d.bonus <= 45;
}
