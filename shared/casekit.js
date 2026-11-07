// 서버와 브라우저 체험판이 함께 쓰는 진단 기록 처리 함수 (외부 모듈 없음)

export function cleanProfile(p) {
  const s = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
  const ch = (p && p.channels) || {};
  return {
    name: s(p?.name, 80), address: s(p?.address, 200), biz: p?.biz === 'cafe' ? 'cafe' : 'restaurant', sub: s(p?.sub, 40),
    concerns: Array.isArray(p?.concerns) ? p.concerns.filter((x) => typeof x === 'string').slice(0, 9) : [],
    channels: Object.fromEntries(['place', 'insta', 'blog', 'threads', 'home', 'deliveryApp'].map((k) => [k, s(ch[k], 300)])),
  };
}

export function emptyData(profile = {}) {
  return { profile: cleanProfile(profile), answers: {}, attachments: [], external: { entries: [], quotes: [] }, settings: {} };
}

// 저장 요청 정리: 첨부 목록은 서버가 관리하고 사장님 확인 상태·메모만 반영
export function sanitizeData(incoming, current) {
  const d = incoming && typeof incoming === 'object' ? incoming : {};
  const out = {
    profile: cleanProfile(d.profile || current.profile),
    answers: d.answers && typeof d.answers === 'object' ? d.answers : current.answers,
    external: d.external && typeof d.external === 'object' ? { entries: (d.external.entries || []).slice(0, 200), quotes: (d.external.quotes || []).slice(0, 200) } : current.external,
    settings: d.settings && typeof d.settings === 'object' ? {
      deepAll: !!d.settings.deepAll,
      planDone: Object.fromEntries(Object.entries(d.settings.planDone || {}).filter(([k, v]) => typeof k === 'string' && v === true).slice(0, 300).map(([k]) => [k.slice(0, 300), true])),
    } : current.settings,
    attachments: (current.attachments || []).map((f) => {
      const inc = (d.attachments || []).find((x) => x && x.id === f.id);
      if (!inc) return f;
      return { ...f, note: typeof inc.note === 'string' ? inc.note.slice(0, 1000) : f.note, confirmed: !!inc.confirmed, extractApplied: !!inc.extractApplied };
    }),
  };
  if (current.sample) out.sample = true;
  return out;
}

export function summarize(report, inputVersion) {
  const c = report.calc;
  const r = (k) => c.ratios.find((x) => x.key === k)?.value ?? null;
  return {
    at: report.generatedAt, inputVersion, sig: report.inputSig,
    sales: c.sales.monthly ?? null, profitLow: c.profit.low ?? null, profitHigh: c.profit.high ?? null, profitKind: c.profit.kind,
    hourly: c.ownerHourly ? Math.round(c.ownerHourly.high) : null, food: r('food'), labor: r('labor'),
    missing: c.missingCosts.length, top: report.top.map((id) => report.solutions.find((s) => s.id === id)?.title),
  };
}

export function diffSummary(a, b) {
  if (!a) return [];
  const out = [];
  const money = (n) => (n == null ? '미입력' : `${Math.round(n / 10000).toLocaleString('ko-KR')}만 원`);
  const pct = (n) => (n == null ? '미입력' : `${(n * 100).toFixed(1)}%`);
  if (a.sales !== b.sales) out.push(`월매출: ${money(a.sales)} → ${money(b.sales)}`);
  if (a.profitHigh !== b.profitHigh || a.profitLow !== b.profitLow) out.push(`남는 금액: ${money(a.profitHigh)} → ${money(b.profitHigh)}`);
  if (a.missing !== b.missing) out.push(`빠진 비용 항목: ${a.missing}개 → ${b.missing}개`);
  if (a.food !== b.food) out.push(`식재료 구매 비율: ${pct(a.food)} → ${pct(b.food)}`);
  if (a.labor !== b.labor) out.push(`직원 인건비율: ${pct(a.labor)} → ${pct(b.labor)}`);
  if (a.hourly !== b.hourly) out.push(`사장님 시간당 소득(최대): ${a.hourly == null ? '미계산' : a.hourly.toLocaleString('ko-KR') + '원'} → ${b.hourly == null ? '미계산' : b.hourly.toLocaleString('ko-KR') + '원'}`);
  if (JSON.stringify(a.top) !== JSON.stringify(b.top)) out.push(`우선 해결 순서가 바뀌었어요: ${b.top.join(' / ')}`);
  return out;
}

// 확장자가 아니라 파일 내용으로 형식 확인 (Uint8Array)
export function sniffFile(bytes, name) {
  const ascii = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  const eq = (arr) => arr.every((v, i) => bytes[i] === v);
  if (eq([0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', type: 'image' };
  if (eq([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', type: 'image' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', type: 'image' };
  if (ascii(0, 4) === 'GIF8') return { mime: 'image/gif', type: 'image' };
  if (ascii(4, 8) === 'ftyp' && /hei[cfx]|mif1|msf1/.test(ascii(8, 12))) return { mime: 'image/heic', type: 'image' };
  if (ascii(0, 5) === '%PDF-') return { mime: 'application/pdf', type: 'pdf' };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && /\.xlsx$/i.test(name)) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', type: 'xlsx' };
  const sample = bytes.subarray(0, 4096);
  if (!sample.includes(0) && /\.(csv|txt|tsv)$/i.test(name)) return { mime: 'text/csv', type: 'csv' };
  return null;
}

export const EXTRACT_NOTE = {
  xlsx: '엑셀 파일은 아직 자동으로 읽지 못해요. 엑셀에서 "CSV로 저장"한 파일을 올리면 숫자를 읽을 수 있어요.',
  other: '자동 판독(AI)이 연결되지 않은 데모예요. 사진 속 내용은 분석에 자동으로 쓰지 않아요. 필요한 숫자는 직접 옮겨 적어 주세요.',
};
