// 숫자·단위 표시 도우미 (브라우저와 서버 공용)

export const WEEKS_PER_MONTH = 365 / 7 / 12; // 약 4.345주

export function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

export function fmtWon(n) {
  if (!isNum(n)) return '미입력';
  return `${Math.round(n).toLocaleString('ko-KR')}원`;
}

// 1만 원 이상은 '만 원' 단위로 줄여서 표시
export function fmtMan(n, digits = 1) {
  if (!isNum(n)) return '미입력';
  const abs = Math.abs(n);
  if (abs >= 100000000) {
    const eok = n / 100000000;
    return `${eok.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}억 원`;
  }
  if (abs >= 10000) {
    return `${(n / 10000).toLocaleString('ko-KR', { maximumFractionDigits: digits })}만 원`;
  }
  return fmtWon(n);
}

export function fmtPct(x, digits = 1) {
  if (!isNum(x)) return '미입력';
  return `${(x * 100).toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: 0 })}%`;
}

export function fmtNum(n, unit = '', digits = 1) {
  if (!isNum(n)) return '미입력';
  return `${n.toLocaleString('ko-KR', { maximumFractionDigits: digits })}${unit}`;
}

export function round(n, step = 1) {
  return Math.round(n / step) * step;
}

export function sum(arr) {
  return arr.reduce((a, b) => a + (isNum(b) ? b : 0), 0);
}

export function median(arr) {
  const v = arr.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function todayISO() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysBetween(isoA, isoB) {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (!isNum(a) || !isNum(b)) return null;
  return Math.round((b - a) / 86400000);
}

// 문자열 정규화(비교용): 공백·괄호·대소문자 무시
export function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[\s()\[\]{}·.,_\-/]/g, '');
}

// 규격 문자열 해석: "1kg", "500g*20", "1.5L", "500ml x 12", "30개입", "30구", "10kg 2개"
export function parseSpec(str) {
  if (!str) return null;
  const s = String(str).replace(/\s+/g, '').toLowerCase();
  const unitMap = { g: 'g', kg: 'kg', ml: 'ml', l: 'L', '개': '개', '구': '개', '입': '개', ea: '개', '팩': '개', '봉': '개', '마리': '개' };
  const m = s.match(/(\d+(?:\.\d+)?)(kg|g|ml|l|개|구|입|ea|팩|봉|마리)(?:입)?(?:[x*×](\d+)(?:개|입|팩|봉|ea)?)?/);
  if (!m) return null;
  const size = parseFloat(m[1]);
  const unit = unitMap[m[2]];
  let count = m[3] ? parseInt(m[3], 10) : 1;
  if (!m[3]) {
    const extra = s.slice(m.index + m[0].length).match(/^(\d+)(개|입|팩|봉|ea)/);
    if (extra) count = parseInt(extra[1], 10);
  }
  return { size, unit, count };
}

// 단위 → (차원, 기준단위 배수)
export const UNIT_INFO = {
  g: { dim: 'mass', factor: 1, label: 'g' },
  kg: { dim: 'mass', factor: 1000, label: 'kg' },
  ml: { dim: 'volume', factor: 1, label: 'ml' },
  L: { dim: 'volume', factor: 1000, label: 'L' },
  '개': { dim: 'count', factor: 1, label: '개' },
};

export const DIM_LABEL = { mass: '1kg당', volume: '1L당', count: '1개당' };
export const DIM_DISPLAY_FACTOR = { mass: 1000, volume: 1000, count: 1 };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
