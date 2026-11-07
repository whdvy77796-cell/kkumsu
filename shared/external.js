// 외부(공개) 정보: 출처·확인 날짜·가게명/주소 일치 여부를 기록하고, 사장님 답변과 대조한다.
// 자동 검색이 연결되지 않은 데모에서는 사람이 확인해 입력한 항목만 사용한다.
import { norm, fmtWon, isNum, daysBetween, todayISO } from './format.js';

export const SOURCE_LABEL = {
  place: '네이버 플레이스', insta: '인스타그램', blog: '블로그', threads: '스레드', home: '가게 홈페이지',
  app: '배달앱 가게 페이지', kamis: '공개 식재료 시세', shop: '온라인 판매처', vendor: '납품 견적', visit: '직접 방문', other: '기타',
};

export const OWN_FIELDS = [
  { v: 'hours', label: '영업시간' },
  { v: 'closed', label: '휴무일' },
  { v: 'menu_price', label: '메뉴 가격' },
  { v: 'signature', label: '대표 메뉴' },
  { v: 'reservation', label: '예약·주문 방법' },
];

export const CHANNEL_FIELDS = [
  { key: 'place', label: '네이버 플레이스 주소' },
  { key: 'insta', label: '인스타그램 주소' },
  { key: 'blog', label: '블로그 주소' },
  { key: 'threads', label: '스레드 주소' },
  { key: 'home', label: '홈페이지 주소' },
  { key: 'deliveryApp', label: '배달앱 가게 이름' },
];

const DAYS = ['월', '화', '수', '목', '금', '토', '일'];

function parseRange(s) {
  const m = String(s || '').match(/(\d{1,2})[:시]?(\d{2})?\s*[~\-–]\s*(\d{1,2})[:시]?(\d{2})?/);
  if (!m) return null;
  const f = (h, mm) => `${String(+h).padStart(2, '0')}:${mm || '00'}`;
  return { open: f(m[1], m[2]), close: f(m[3], m[4]) };
}

function parseDays(s) {
  const t = String(s || '');
  if (/연중무휴|휴무\s*없/.test(t)) return [];
  return DAYS.filter((d) => t.includes(d));
}

export function entryUsable(e) {
  return !!(e && e.nameMatch && e.addrMatch);
}

export function isStale(dateISO, days = 30) {
  const d = daysBetween(dateISO, todayISO());
  return d === null ? true : d > days;
}

// 사장님 답변과 공개 정보의 차이 → 재확인 질문
export function publicInfoChecks(data) {
  const out = [];
  const entries = (data?.external?.entries || []).filter((e) => e.kind === 'own' && entryUsable(e));
  const hours = data?.answers?.b_hours?.v;
  const menus = data?.answers?.m_list?.v || [];
  for (const e of entries) {
    const src = `${SOURCE_LABEL[e.source] || '공개 페이지'}${e.observedAt ? ` (${e.observedAt} 확인)` : ''}`;
    if (e.field === 'hours' && hours && hours.open && hours.close) {
      const r = parseRange(e.value);
      if (r && (r.open !== hours.open || r.close !== hours.close)) {
        out.push(mk(e, ['b_hours'], `${e.value}|${hours.open}-${hours.close}`, '공개된 영업시간이 답변과 달라요',
          `${src}에는 영업시간이 ${r.open}~${r.close}로 되어 있는데, 답변은 ${hours.open}~${hours.close}예요.`));
      }
    }
    if (e.field === 'closed' && hours && Array.isArray(hours.closed)) {
      const pub = parseDays(e.value).sort().join('');
      const mine = [...hours.closed].sort().join('');
      if (pub !== mine) {
        out.push(mk(e, ['b_hours'], `${e.value}|${mine}`, '공개된 휴무일이 답변과 달라요',
          `${src}에는 휴무일이 "${e.value}"로 되어 있는데, 답변은 ${hours.closed.length ? hours.closed.join('·') + '요일' : '휴무 없음'}이에요.`));
      }
    }
    if (e.field === 'menu_price' && e.menuName && isNum(+e.price)) {
      const m = menus.find((x) => norm(x.name) === norm(e.menuName));
      if (m && isNum(+m.price) && +m.price !== +e.price) {
        out.push(mk(e, ['m_list'], `${e.price}|${m.price}`, `공개된 "${e.menuName}" 가격이 답변과 달라요`,
          `${src}에는 ${e.menuName} 가격이 ${fmtWon(+e.price)}인데, 답변한 현재 가격은 ${fmtWon(+m.price)}이에요.`));
      }
      if (!m) {
        out.push(mk(e, ['m_list'], `${e.menuName}|none`, `공개 페이지에 있는 "${e.menuName}"이(가) 현재 메뉴 목록에 없어요`,
          `${src}에는 ${e.menuName}(${fmtWon(+e.price)})이 있는데, 답변한 메뉴 목록에는 없어요. 판매를 중단한 메뉴인가요?`));
      }
    }
    if (e.field === 'signature' && e.value) {
      const sig = menus.filter((x) => x.role === 'signature').map((x) => norm(x.name));
      if (sig.length && !sig.includes(norm(e.value))) {
        out.push(mk(e, ['m_list'], `${e.value}|${sig.join(',')}`, '공개된 대표 메뉴가 지금과 달라요',
          `${src}에는 대표 메뉴가 "${e.value}"(으)로 소개되어 있어요. 답변에서 대표 메뉴로 표시한 메뉴: ${menus.filter((x) => x.role === 'signature').map((x) => x.name).join(', ')}.`));
      }
    }
  }
  return out;
}

function mk(e, related, sig, title, message) {
  return {
    id: `chk_pub_${e.id}`, kind: 'public', related, sig, title, entryId: e.id,
    message: `${message} 지금 실제 정보가 답변과 같다면 "제 답변이 맞아요"를 눌러주세요. 온라인 정보 수정이 필요한 항목으로 보고서에 넣어요.`,
    confirmLabel: '제 답변이 맞아요 (온라인 정보가 예전 것)',
  };
}

// 확인된 공개 정보 불일치(사장님이 본인 답변이 맞다고 확인한 것)
export function confirmedMismatches(data) {
  return publicInfoChecks(data).filter((chk) => {
    const a = data?.answers?.[chk.id];
    return a && a.v === 'confirm' && a.sig === chk.sig;
  });
}

// 주변 가게 가격 비교: 같은 양·구성일 때만 '같은 조건 비교'
export function competitorComparisons(data) {
  const rows = data?.answers?.pr_competitors?.v || [];
  const menus = data?.answers?.m_list?.v || [];
  return rows.filter((r) => r.name && isNum(+r.price) && +r.price > 0).map((r) => {
    const mine = menus.find((m) => r.myMenu && norm(m.name) === norm(r.myMenu));
    const myPrice = mine && isNum(+mine.price) ? +mine.price : null;
    let level = 'reference';
    let reason = '';
    if (!myPrice) { level = 'none'; reason = '우리 가게 비교 메뉴의 가격 정보가 없어요'; }
    else if (!r.portion || !r.myPortion) { reason = '양·구성 정보가 없어 같은 조건인지 알 수 없어요'; }
    else if (norm(r.portion) !== norm(r.myPortion)) { reason = `양·구성이 달라요 (그 가게: ${r.portion} / 우리: ${r.myPortion})`; }
    else { level = 'same'; }
    if (level !== 'none' && (!r.date || r.source === 'hearsay')) {
      level = level === 'same' ? 'reference' : level;
      reason = [reason, !r.date ? '확인 날짜가 없어요' : '', r.source === 'hearsay' ? '들은 이야기라 직접 확인이 필요해요' : ''].filter(Boolean).join(' · ');
    }
    const diffPct = myPrice ? (myPrice - +r.price) / +r.price : null;
    return { name: r.name, distance: r.distance, menu: r.menu, theirPrice: +r.price, myMenu: r.myMenu, myPrice, diffPct, level, reason, source: r.source, date: r.date, diff: r.diff, portion: r.portion, myPortion: r.myPortion };
  });
}

// 리뷰에서 반복되는 내용(사람이 확인해 입력한 것만)
export function reviewThemes(data) {
  const entries = (data?.external?.entries || []).filter((e) => e.kind === 'review' && entryUsable(e));
  return {
    praise: entries.filter((e) => e.field === 'praise'),
    complaint: entries.filter((e) => e.field === 'complaint'),
  };
}

// 등록한 채널 중 확인 기록이 없는 곳
export function uncheckedChannels(data) {
  const ch = data?.profile?.channels || {};
  const entries = data?.external?.entries || [];
  const out = [];
  for (const [key, url] of Object.entries(ch)) {
    if (!url) continue;
    const src = key === 'deliveryApp' ? 'app' : key;
    const has = entries.some((e) => e.source === src && entryUsable(e));
    if (!has) out.push({ key, url, label: SOURCE_LABEL[src] || key });
  }
  return out;
}

export function excludedEntries(data) {
  return (data?.external?.entries || []).filter((e) => !entryUsable(e));
}
