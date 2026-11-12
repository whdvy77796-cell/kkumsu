// AI·검색 봇 접근 현황 패널. 브라우저 ESM 모듈. innerHTML 없이 h()와 텍스트 노드만 쓴다.
// 서버가 준 숫자만 보여 주며, 응답이 계약과 다르면 "확인할 수 없음"으로 처리한다(없는 0을 만들지 않음).
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const STATES = ['not_started', 'active', 'limited', 'unavailable'];
const PROVIDERS = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };
const PURPOSES = { search: '검색 답변용', training: '학습용', user: '사용자 요청 대행', search_engine: '검색엔진' };
const nf = new Intl.NumberFormat('ko-KR');

const isCount = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isPair = (p) => !!p && typeof p === 'object' && !Array.isArray(p) && isCount(p.verified) && isCount(p.unverified);
const isDateStr = (s) => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));

// 계약 검사. 통과하면 정리된 객체, 아니면 null.
export function parseAiAccess(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!STATES.includes(data.state)) return null;
  const out = { state: data.state, since: null, collectionStartedAt: null, updatedAt: null, lifetime: null, last7Days: null, breakdown: [] };
  for (const k of ['since', 'collectionStartedAt', 'updatedAt']) {
    const v = data[k];
    if (v == null) continue;
    if (!isDateStr(v)) return null;
    out[k] = v;
  }
  if (data.state === 'not_started' || data.state === 'unavailable') return out;
  if (!isPair(data.lifetime)) return null;
  out.lifetime = { verified: data.lifetime.verified, unverified: data.lifetime.unverified };
  if (data.last7Days != null) {
    if (!isPair(data.last7Days)) return null;
    out.last7Days = { verified: data.last7Days.verified, unverified: data.last7Days.unverified };
  }
  if (data.breakdown != null) {
    if (!Array.isArray(data.breakdown) || data.breakdown.length > 50) return null;
    for (const r of data.breakdown) {
      if (!r || typeof r !== 'object' || !Object.hasOwn(PROVIDERS, r.provider) || !Object.hasOwn(PURPOSES, r.purpose) || !isCount(r.verified) || !isCount(r.unverified)) return null;
      out.breakdown.push({ provider: r.provider, purpose: r.purpose, verified: r.verified, unverified: r.unverified });
    }
  }
  return out;
}

// 한국 시간(KST) 기준 날짜
export function formatDay(s) {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '';
  const d = new Date(t + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}

function formatMoment(s) {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '';
  const d = new Date(t + 9 * 3600 * 1000);
  return `${formatDay(s)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} (한국시간)`;
}

export function aiAccessUrl(kind, storeId) {
  if (kind === 'site') return '/api/ai-access?view=site';
  if (kind === 'store' && typeof storeId === 'string' && ID_RE.test(storeId)) return `/api/ai-access?view=store&id=${storeId}`;
  return null;
}

export function makeAiAccessPanel({ h, fetcher, kind, storeId } = {}) {
  const isStore = kind === 'store';
  const scopeName = isStore ? '이 가게 페이지' : '여기봐 공개 홈·가게 목록·가게 페이지';
  const url = aiAccessUrl(isStore ? 'store' : 'site', storeId);
  const titleId = `ai-access-title-${Math.random().toString(36).slice(2, 9)}`;
  const body = h('div', { class: 'ai-access-body', 'aria-live': 'polite', 'aria-busy': 'false' });
  const section = h('section', { class: `card ai-access ai-access-${isStore ? 'store' : 'site'}`, 'aria-labelledby': titleId },
    h('h3', { id: titleId, class: 'ai-access-title' }, isStore ? 'AI·검색 봇 접근 현황 (이 가게)' : 'AI·검색 봇 접근 현황 (여기봐 공개 페이지)'),
    body);
  let seq = 0;
  let loading = false;

  const setBody = (busy, ...kids) => {
    body.replaceChildren();
    body.setAttribute('aria-busy', busy ? 'true' : 'false');
    for (const k of kids.flat()) if (k != null && k !== false) body.append(k);
  };

  function notes(limited) {
    const items = [
      '봇 접근은 AI가 답변에서 이 내용을 인용하거나 추천했다는 뜻이 아니에요.',
      '성공적으로 응답한(GET) 요청만 세어요. 차단되거나 실패한 요청은 제외해요.',
      '‘확인된 봇’은 이름과 해당 업체가 공개한 IP 대역이 일치한 요청이에요. ‘미확인 봇 주장’은 이름은 같지만 IP 대역을 확인하지 못한 요청이에요.',
      '기록은 누락될 수 있어 전체 접근을 보장하지 않아요. 사람이 무엇을 질문했는지는 알 수 없고, 여기봐의 집계에는 접속자 IP를 따로 저장하거나 표시하지 않아요.',
    ];
    if (isStore) items.push('가게별 집계는 마지막 기록 수신 후 180일 동안 보관해요. 자동 삭제된 뒤에는 새 기록부터 다시 집계해요.');
    if (limited) items.unshift('일부 기록만 집계되어 아래 숫자는 최소치(하한)예요. 실제는 더 많을 수 있어요.');
    return h('ul', { class: 'ai-access-notes muted' }, items.map((t) => h('li', null, t)));
  }

  function stat(label, pair, limited) {
    const pre = limited ? '최소 ' : '';
    return h('div', { class: 'ai-access-stat' },
      h('dt', { class: 'ai-access-stat-label' }, label),
      h('dd', { class: 'ai-access-stat-body' },
        h('span', { class: 'ai-access-num' }, `${pre}${nf.format(pair.verified)}회`),
        h('span', { class: 'ai-access-sub' }, '확인된 봇'),
        h('span', { class: 'ai-access-num ai-access-num-alt' }, `${pre}${nf.format(pair.unverified)}회`),
        h('span', { class: 'ai-access-sub' }, '미확인 봇 주장')));
  }

  function breakdownTable(rows) {
    if (!rows.length) return null;
    return h('div', { class: 'ai-access-table-wrap', role: 'region', tabindex: '0', 'aria-label': '봇 종류별 접근 횟수 표' },
      h('table', { class: 'ai-access-table' },
        h('caption', { class: 'ai-access-caption' }, `${scopeName}의 봇 종류별 성공 응답 횟수`),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, '운영사'), h('th', { scope: 'col' }, '목적'),
          h('th', { scope: 'col', class: 'ai-access-r' }, '확인됨'), h('th', { scope: 'col', class: 'ai-access-r' }, '미확인'))),
        h('tbody', null, rows.map((r) => h('tr', null,
          h('th', { scope: 'row' }, PROVIDERS[r.provider]), h('td', null, PURPOSES[r.purpose]),
          h('td', { class: 'ai-access-r' }, nf.format(r.verified)), h('td', { class: 'ai-access-r' }, nf.format(r.unverified)))))));
  }

  const retryButton = () => h('button', { type: 'button', class: 'ai-access-btn', onclick: () => { load(); } }, '다시 시도');
  const refreshButton = () => h('button', { type: 'button', class: 'ai-access-btn ai-access-btn-quiet', onclick: () => { load(); } }, '새로고침');

  function renderUnavailable() {
    setBody(false,
      h('p', { class: 'ai-access-status', role: 'alert' }, '접근 현황을 지금은 확인할 수 없어요.'),
      h('p', { class: 'muted' }, '숫자를 확인하지 못했어요. 0회라는 뜻이 아니에요. 잠시 후 다시 시도해 주세요.'),
      retryButton());
  }

  function renderData(d) {
    if (d.state === 'not_started') {
      setBody(false,
        h('p', { class: 'ai-access-status' }, '아직 확인할 수 있는 AI·검색 봇 접근 기록이 없어요.'),
        h('p', { class: 'muted' }, '기록 수집이 준비 중이거나 아직 확인된 기록이 없어요. 과거 접근이 0회라는 뜻은 아니에요.'),
        d.collectionStartedAt ? h('p', { class: 'muted ai-access-dates' }, `수집 설정 기준: ${formatMoment(d.collectionStartedAt)}. 실제 연결 상태에 따라 누락될 수 있어요.`) : null,
        notes(false));
      return;
    }
    if (d.state === 'unavailable') { renderUnavailable(); return; }
    const limited = d.state === 'limited';
    const dates = [];
    if (d.collectionStartedAt) dates.push(`수집 설정 기준: ${formatMoment(d.collectionStartedAt)}`);
    if (d.since && d.lifetime.verified + d.lifetime.unverified > 0) dates.push(`첫 집계 기록: ${formatDay(d.since)}`);
    dates.push(d.updatedAt ? `마지막 갱신: ${formatDay(d.updatedAt)}` : '마지막 갱신 정보가 없어요');
    setBody(false,
      h('p', { class: 'ai-access-scope' }, `집계 범위: ${scopeName}`),
      limited ? h('p', { class: 'ai-access-badge', role: 'note' }, '일부 기록만 집계됨 · 최소치') : null,
      h('dl', { class: 'ai-access-stats' },
        stat('기록 시작 이후 누적', d.lifetime, limited),
        d.last7Days
          ? stat('최근 7일 (한국시간)', d.last7Days, limited)
          : h('div', { class: 'ai-access-stat' }, h('dt', { class: 'ai-access-stat-label' }, '최근 7일'), h('dd', { class: 'muted ai-access-none' }, '7일 전체를 확인할 기록이 아직 충분하지 않아요. 0회라는 뜻이 아니에요.'))),
      h('p', { class: 'muted ai-access-dates' }, dates.join(' · ')),
      breakdownTable(d.breakdown),
      notes(limited),
      refreshButton());
  }

  function renderLoading() {
    setBody(true, h('p', { class: 'ai-access-status', role: 'status' }, '접근 현황을 불러오는 중…'));
  }

  async function load() {
    if (loading) return;
    if (!url || typeof fetcher !== 'function') { renderUnavailable(); return; }
    loading = true;
    const mine = ++seq;
    renderLoading();
    let parsed = null;
    try {
      const res = await fetcher(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res && res.ok) parsed = parseAiAccess(await res.json());
    } catch { parsed = null; }
    loading = false;
    if (mine !== seq) return;
    if (parsed) renderData(parsed); else renderUnavailable();
  }

  function renderIdle() {
    setBody(false,
      h('p', { class: 'muted' }, '이 가게 페이지에 AI·검색 봇이 다녀갔는지 보려면 버튼을 눌러 주세요. 누르기 전에는 불러오지 않아요.'),
      h('button', { type: 'button', class: 'ai-access-btn', onclick: () => { load(); } }, '접근 현황 보기'));
  }

  if (isStore) {
    if (!url) renderUnavailable(); else renderIdle();
  } else {
    load();
  }
  return section;
}
