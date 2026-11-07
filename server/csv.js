// 매출 CSV(POS·카드사 내보내기) 읽기: 날짜·금액 열을 찾아 월별·요일별·시간대별로 묶는다.
// 추출 결과는 바로 분석에 쓰지 않고, 사장님이 확인·수정한 뒤에만 반영한다.

export function decodeText(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('euc-kr').decode(buf);
  }
  return text.replace(/^\uFEFF/, '');
}

export function parseCSV(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', '\t', ';'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

export function parseAmount(s) {
  if (s == null) return null;
  let t = String(s).replace(/[,\s원₩]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t === '' || t === '-') return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = parseFloat(t);
  return neg ? -n : n;
}

export function parseDateTime(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})[-./년\s]*(\d{1,2})[-./월\s]*(\d{1,2})일?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    m = t.match(/^(\d{4})(\d{2})(\d{2})(?:\s*(\d{2}):?(\d{2}))?/);
  }
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const hasTime = m[4] !== undefined;
  const date = new Date(y, mo - 1, d, hasTime ? +m[4] : 0, hasTime ? +m[5] : 0);
  if (date.getMonth() !== mo - 1) return null;
  return { date, month: `${y}-${String(mo).padStart(2, '0')}`, hasTime, hour: hasTime ? +m[4] : null };
}

const DATE_HEAD = /일자|날짜|거래일|결제일|판매일|일시|date|time|시간/i;
const AMOUNT_HEAD = /금액|매출|결제|합계|amount|total|판매가|실매출|price/i;
const AMOUNT_PREFER = /실결제|결제금액|실매출|매출액|합계금액|총액|총\s*결제|받은\s*금액/i;
const AMOUNT_AVOID = /할인|수수료|부가세|공급가|세액|팁|봉사료|포인트/;
const STATUS_HEAD = /상태|구분|취소|status|type/i;

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i];
    const texty = r.filter((c) => c && parseAmount(c) === null && !parseDateTime(c)).length;
    if (texty >= 2) return i;
  }
  return -1;
}

export function analyzeSalesCSV(buf, opts = {}) {
  const text = decodeText(buf);
  const rows = parseCSV(text);
  const warnings = [];
  if (rows.length < 2) return { ok: false, error: '표 형태의 내용을 찾지 못했어요. CSV로 저장한 파일인지 확인해 주세요.' };
  const h = findHeader(rows);
  const header = h >= 0 ? rows[h] : rows[0].map((_, i) => `열 ${i + 1}`);
  const body = rows.slice(h >= 0 ? h + 1 : 0).filter((r) => r.length >= 2);
  const sample = body.slice(0, 200);
  const score = (col, fn) => sample.filter((r) => fn(r[col])).length / Math.max(1, sample.length);
  const cols = header.map((name, i) => ({ i, name, dateRatio: score(i, (v) => !!parseDateTime(v)), numRatio: score(i, (v) => parseAmount(v) !== null) }));
  let dateCol = opts.dateCol ?? null;
  let amountCol = opts.amountCol ?? null;
  let statusCol = opts.statusCol ?? null;
  if (dateCol === null) {
    const c = cols.filter((x) => x.dateRatio >= 0.8).sort((a, b) => (DATE_HEAD.test(b.name) - DATE_HEAD.test(a.name)) || b.dateRatio - a.dateRatio)[0];
    dateCol = c ? c.i : null;
  }
  if (amountCol === null) {
    const c = cols.filter((x) => x.numRatio >= 0.8 && x.i !== dateCol && !AMOUNT_AVOID.test(x.name))
      .sort((a, b) => (AMOUNT_PREFER.test(b.name) - AMOUNT_PREFER.test(a.name)) || (AMOUNT_HEAD.test(b.name) - AMOUNT_HEAD.test(a.name)) || b.numRatio - a.numRatio)[0];
    amountCol = c ? c.i : null;
  }
  if (statusCol === null) {
    const c = cols.find((x) => STATUS_HEAD.test(x.name) && x.i !== dateCol && x.i !== amountCol && x.numRatio < 0.5);
    statusCol = c ? c.i : null;
  }
  const columns = cols.map((c) => ({ i: c.i, name: c.name }));
  if (dateCol === null || amountCol === null) {
    return { ok: false, columns, dateCol, amountCol, statusCol, rowCount: body.length, error: '날짜 열이나 금액 열을 자동으로 찾지 못했어요. 아래에서 직접 골라주세요.' };
  }
  const months = {};
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  const weekdayCount = [0, 0, 0, 0, 0, 0, 0];
  const hours = {};
  let used = 0;
  let excluded = 0;
  let bad = 0;
  let hasTime = false;
  let big = 0;
  for (const r of body) {
    const dt = parseDateTime(r[dateCol]);
    const amt = parseAmount(r[amountCol]);
    if (!dt || amt === null) { bad++; continue; }
    if (statusCol !== null && /취소|환불|cancel/i.test(r[statusCol] || '') && amt > 0) { excluded++; continue; }
    used++;
    if (amt >= 1000000) big++;
    months[dt.month] = months[dt.month] || { month: dt.month, total: 0, count: 0, days: new Set() };
    months[dt.month].total += amt;
    months[dt.month].count += 1;
    months[dt.month].days.add(dt.date.getDate());
    const wd = (dt.date.getDay() + 6) % 7; // 월=0
    weekday[wd] += amt;
    weekdayCount[wd] += 1;
    if (dt.hasTime) { hasTime = true; hours[dt.hour] = (hours[dt.hour] || 0) + amt; }
  }
  const monthList = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ month: m.month, total: Math.round(m.total), count: m.count, days: m.days.size }));
  if (bad) warnings.push(`날짜나 금액을 읽지 못한 줄 ${bad}개는 제외했어요.`);
  if (excluded) warnings.push(`취소·환불로 표시된 줄 ${excluded}개는 제외했어요.`);
  if (big) warnings.push(`한 줄 금액이 100만 원 이상인 줄이 ${big}개 있어요. 합계 줄이 섞여 있지 않은지 확인해 주세요.`);
  for (const m of monthList) if (m.days < 20) m.partial = true;
  const totals = monthList.filter((m) => !m.partial).map((m) => m.total).sort((a, b) => a - b);
  const med = totals.length ? totals[Math.floor(totals.length / 2)] : 0;
  for (const m of monthList) {
    if (m.partial) continue;
    if (med > 0 && (m.total > med * 3 || m.total < med / 3)) warnings.push(`${m.month} 합계가 다른 달과 크게 달라요. 금액 열이 맞는지 확인해 주세요.`);
  }
  if (monthList.some((m) => m.partial)) warnings.push('영업일 기록이 20일 미만인 달은 한 달 전체가 아닐 수 있어요 (표시됨).');
  warnings.push('줄 수를 결제 건수로 계산했어요. 메뉴마다 한 줄씩 나오는 파일이면 주문 건수와 달라요.');
  return {
    ok: true, columns, dateCol, amountCol, statusCol, rowCount: body.length, usedRows: used, excludedRows: excluded, badRows: bad,
    months: monthList, weekday: weekday.map(Math.round), weekdayCount, hours, hasTime, warnings,
  };
}
