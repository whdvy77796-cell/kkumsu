// 소개 페이지의 첫 단계. 기존 매출 진단 상태(maechul.v3)는 읽거나 수정하지 않는다.
const PAGE_KEY = 'yeogibwa.page.start.v1';

export function makePageStart({ h, show, setNavbar, btn, post, storeName }) {
  let state = load();
  let busy = false;

  function load() {
    try {
      const v = JSON.parse(sessionStorage.getItem(PAGE_KEY) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  }
  function save() {
    try { sessionStorage.setItem(PAGE_KEY, JSON.stringify(state)); } catch { /* 현재 탭 메모리로 계속 */ }
  }
  function home() { location.hash = '#/'; }
  function safeLink(value) {
    try {
      const u = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return null;
      if (/(^|\.)(localhost|local|internal|home\.arpa)$/i.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return null;
      return u.href;
    } catch { return null; }
  }
  function dateLabel(value) {
    const d = new Date(value || '');
    return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '조회 시각 확인 불가';
  }
  function showLoading() {
    storeName.textContent = state.name || '';
    show(h('div', { class: 'card loading' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('h2', null, '가게 정보를 찾고 있어요'),
      h('p', null, h('b', null, state.name), h('br'), h('span', { class: 'muted' }, state.address)),
      h('p', { class: 'small muted' }, '동의하신 상호명과 주소로 공개된 가게 정보와 특징을 살펴보고 있어요. 보통 30초~1분 정도 걸려요.'),
      h('p', { class: 'tiny muted' }, '요청을 중복해서 보내지 않아요.')));
    setNavbar(btn('처음으로', home));
  }
  function showInterrupted(message) {
    storeName.textContent = state.name || '';
    show(h('div', { class: 'card warn' },
      h('h2', null, '가게 정보를 확인하지 못했어요'),
      h('p', null, message || '조회 결과를 확인하지 못했어요. 요청은 이미 처리됐을 수도 있으며 자동으로 다시 보내지 않았어요.'),
      h('p', { class: 'small muted' }, '상호와 주소를 확인하고 원하실 때 다시 시작해 주세요.')));
    setNavbar(btn('다시 입력', home, true));
  }
  async function begin(name, address) {
    if (busy) return;
    busy = true;
    state = { name, address, status: 'pending' };
    save();
    location.hash = '#/page-search';
    showLoading();
    try {
      const result = await post('/api/page-search', { name, address, consent: true }, 190000);
      state = { name, address, status: 'result', result };
      save();
      if (location.hash === '#/page-search') showResults();
    } catch (err) {
      state = { name, address, status: 'error' };
      save();
      const uncertain = ['TIMEOUT', 'NETWORK'].includes(err.code);
      const message = uncertain
        ? '응답을 확인하지 못했어요. 요청은 이미 처리됐을 수 있으며 자동으로 다시 보내지 않았어요.'
        : (err.message || '조회 중 문제가 생겼어요. 자동으로 다시 보내지 않았어요.');
      if (location.hash === '#/page-search') showInterrupted(message);
    } finally { busy = false; }
  }
  function sourceCard(result) {
    const links = (Array.isArray(result.sources) ? result.sources : [])
      .map((s) => ({ title: s?.title || '참고 링크', url: safeLink(s?.url), origin: s?.origin }))
      .filter((s) => s.url);
    if (!links.length) return null;
    return h('div', { class: 'card note' },
      h('h3', null, 'AI가 제시한 참고 링크'),
      h('p', { class: 'small muted' }, '링크의 내용과 해당 가게 정보가 맞는지 직접 확인해 주세요.'),
      h('ol', { class: 'sources' }, links.map((s) => h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title), h('span', { class: 'tiny muted' }, s.origin === 'provider_annotation' ? ' · 제공자 인용' : s.origin === 'mock' ? ' · 모의 링크' : ' · AI 제시 링크')))));
  }
  function candidateCard(c, index, confirmed = false) {
    const rows = [
      ['주소', c?.address], ['업종', c?.category], ['영업시간', c?.hours], ['전화', c?.phone],
      ['가격대', c?.priceRange],
    ].filter(([, value]) => typeof value === 'string' && value.trim());
    const menu = (Array.isArray(c?.menu) ? c.menu : []).filter((m) => m?.name);
    const features = (Array.isArray(c?.features) ? c.features : []).filter(Boolean);
    const strengths = (Array.isArray(c?.strengths) ? c.strengths : []).filter(Boolean);
    return h('div', { class: 'card cand page-candidate' },
      h('h3', null, c?.name || '상호 확인 필요'),
      h('p', { class: 'small muted' }, '입력한 가게가 맞는지 상호와 주소를 직접 확인해 주세요.'),
      rows.length ? h('div', { class: 'kv' }, rows.map(([label, value]) => h('div', null, h('span', null, label), h('b', null, value)))) : h('p', { class: 'small muted' }, '확인할 수 있는 상세 정보가 부족해요.'),
      menu.length ? [h('div', { class: 'sub-title' }, '대표 메뉴·상품'), h('div', { class: 'menu-chips' }, menu.map((m) => h('span', null, m.name, m.price ? h('small', null, m.price) : null)))] : null,
      features.length ? [h('div', { class: 'sub-title' }, 'AI가 정리한 가게 특징'), h('ul', { class: 'plain-list' }, features.map((f) => h('li', null, f)))] : null,
      strengths.length ? [h('div', { class: 'sub-title' }, '공개 정보에서 살펴볼 강점'), h('ul', { class: 'plain-list' }, strengths.map((s) => h('li', null, s)))] : null,
      !features.length && !strengths.length ? h('p', { class: 'small muted' }, '가게의 특징은 공개 정보에서 충분히 확인하지 못했어요.') : null,
      !confirmed ? h('button', { class: 'btn primary block page-choose', type: 'button', onclick: () => choose(index) }, '이 가게가 맞아요') : null);
  }
  function choose(index) {
    const candidates = Array.isArray(state.result?.candidates) ? state.result.candidates : [];
    if (!Number.isInteger(index) || !candidates[index]) return;
    state.confirmedIndex = index;
    state.status = 'confirmed';
    save();
    location.hash = '#/page-confirmed';
  }
  function showResults() {
    const result = state.result || {};
    const evidence = result.webEvidence?.status || 'unverified';
    if (evidence === 'unverified') {
      showInterrupted('AI의 웹 검색 실행 여부를 확인하지 못해 가게 정보를 표시하지 않았어요. 실제로 가게 정보가 없다는 뜻은 아니며, 자동 재시도하지 않았어요.');
      return;
    }
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const cached = result.cached ? '저장된 조회 결과' : '이번 조회 결과';
    const evidenceNote = evidence === 'mock' ? '테스트용 모의 데이터예요. 실제 인터넷 검색 결과가 아니에요.'
      : evidence === 'citation_only' ? '참고 링크는 제공됐지만 웹 검색 실행 횟수는 확인되지 않았어요. 링크와 내용을 직접 확인해 주세요.'
      : 'AI가 공개 검색 내용을 정리했어요. 정보가 틀리거나 오래됐을 수 있으니 직접 확인해 주세요.';
    storeName.textContent = state.name || '';
    if (!candidates.length) {
      show(h('div', { class: 'card' }, h('h2', null, '일치하는 가게를 확인하지 못했어요'),
        h('p', null, '이번 조회에서 가게를 확인하지 못했어요. 실제로 정보가 없다는 뜻은 아니에요.'),
        h('p', { class: 'small muted' }, `${cached} · ${dateLabel(result.searchedAt)}`),
        h('p', { class: 'small muted' }, evidenceNote)), sourceCard(result));
      setNavbar(btn('다시 입력', home, true));
      return;
    }
    show(h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, '가게 정보 확인'), h('span', { class: 'tiny muted' }, `${cached} · ${dateLabel(result.searchedAt)}`)),
      h('h2', null, candidates.length > 1 ? '이 중에 우리 가게가 있나요?' : '이 가게가 맞나요?'),
      h('p', { class: 'small muted' }, evidenceNote),
      candidates.map((c, i) => candidateCard(c, i)), sourceCard(result));
    setNavbar(btn('다시 입력', home));
  }
  function renderSearch() {
    if (busy) { showLoading(); return; }
    if (state.status === 'result' && state.result) { showResults(); return; }
    if (state.status === 'confirmed' && state.result) { showResults(); return; }
    if (state.status === 'pending') { showInterrupted('이전 요청의 결과를 확인하지 못했어요. 요청은 이미 처리됐을 수 있으며 자동으로 다시 보내지 않았어요.'); return; }
    showInterrupted();
  }
  function renderConfirmed() {
    const chosen = state.result?.candidates?.[state.confirmedIndex];
    if (!chosen) { location.hash = '#/'; return; }
    storeName.textContent = chosen.name || state.name || '';
    show(h('div', { class: 'card note' },
      h('h2', null, '가게를 확인했어요'),
      h('p', null, '선택하신 가게의 공개 정보와 특징을 모아 두었어요.'),
      h('p', { class: 'small muted' }, '가게가 맞는지 확인하신 단계예요. 영업시간·메뉴·특징의 정확성은 아직 별도로 확인이 필요해요.')),
      candidateCard(chosen, state.confirmedIndex, true),
      sourceCard(state.result),
      h('div', { class: 'card page-next-note' }, h('h3', null, '다음 단계는 준비 중이에요'),
        h('p', null, '가게에 맞는 질문과 소개 페이지 제작·수정·공개 기능을 차례대로 준비하고 있어요.'),
        h('p', { class: 'small muted' }, '지금은 가게 정보 확인까지만 이용할 수 있어요.')));
    setNavbar(btn('다른 가게 확인', () => { location.hash = '#/page-search'; }), btn('처음으로', home, true));
  }
  return { begin, renderSearch, renderConfirmed, info: () => ({ name: state.name || '', address: state.address || '', status: state.status || '' }), busy: () => busy };
}
