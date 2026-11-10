// 소개 페이지의 첫 단계. 기존 매출 진단 상태(maechul.v3)는 읽거나 수정하지 않는다.
const PAGE_KEY = 'yeogibwa.page.start.v1';

export function makePageStart({ h, show, setNavbar, btn, post, storeName }) {
  let state = load();
  let busy = false;
  let draftBusy = false;

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
  function hasDraftWork() {
    const d = state.pageDraft;
    return !!d && (!!d.draft || !!d.edit || (Array.isArray(d.store?.verifiedFacts) && d.store.verifiedFacts.length > 0) || Object.values(d.answers || {}).some(value => typeof value === 'string' && value.trim()));
  }
  function askBeforeDiscard(message) {
    return typeof globalThis.confirm === 'function' && globalThis.confirm(message);
  }
  async function begin(name, address) {
    if (busy || draftBusy) return;
    if (hasDraftWork() && !askBeforeDiscard('새 가게를 검색하면 이 탭에서 작성하던 가게 소개와 수정 내용이 지워져요. 계속할까요?')) return;
    if (state.status === 'uncertain' && name === state.name && address === state.address && !askBeforeDiscard('이전 검색이 이미 처리됐을 수 있어요. 같은 가게를 다시 검색하면 비용이 중복될 수 있어요. 새 요청을 보내시겠어요?')) return;
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
      const uncertain = ['TIMEOUT', 'NETWORK'].includes(err.code);
      state = { name, address, status: uncertain ? 'uncertain' : 'error' };
      save();
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
      h('p', { class: 'small muted' }, '링크가 열리지 않거나 해당 정보의 근거가 아닐 수 있어요. 내용을 직접 확인해 주세요.'),
      h('ol', { class: 'sources' }, links.map((s) => h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title), h('span', { class: 'tiny muted' }, s.origin === 'provider_annotation' ? ' · 제공자 인용' : s.origin === 'mock' ? ' · 모의 링크' : ' · AI 제시 링크')))));
  }
  function mapSignalSection(c) {
    // 이전 버전 결과는 지도별 조사를 하지 않았으므로 빈 결과로 단정하지 않는다.
    if (!Array.isArray(c?.mapSignals)) return null;
    const raw = c.mapSignals;
    const groups = [['google_maps', '구글 지도'], ['kakao_map', '카카오맵']];
    const clean = raw.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({
        platform: x.platform,
        text: x.text.trim().slice(0, 300),
        title: typeof x.sourceTitle === 'string' && x.sourceTitle.trim() ? x.sourceTitle.trim().slice(0, 120) : '',
        url: typeof x.sourceUrl === 'string' ? safeLink(x.sourceUrl) : null,
        kind: x.sourceKind === 'map_page' ? 'map_page' : 'third_party',
      })).filter((x) => x.url && x.platform === 'google_maps' && x.kind === 'third_party');
    const query = [state.name, state.address].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
    const mapSearch = (platform) => !query ? null : platform === 'google_maps'
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
      : `https://map.kakao.com/link/search/${encodeURIComponent(query)}`;
    return h('div', { class: 'map-signals' },
      h('div', { class: 'sub-title' }, '지도별 공개 검색 단서'),
      h('p', { class: 'small muted' }, '기존 AI의 공개 웹 검색에서 AI가 제시한 단서예요. 지도 공식 API의 직접 응답이나 검증된 사실이 아니에요. 잘못된 지점, 오래된 정보, 작동하지 않는 링크일 수 있으니 직접 확인해 주세요.'),
      h('p', { class: 'tiny muted' }, '직접 검색 링크를 누르면 입력하신 상호와 주소로 해당 지도에서 검색해요.'),
      groups.map(([platform, label]) => {
        const items = clean.filter((x) => x.platform === platform).slice(0, 5);
        return h('div', { class: 'map-signal-group', 'data-platform': platform },
          h('h4', null, label),
          platform === 'kakao_map'
            ? h('p', { class: 'small muted' }, '카카오맵의 후기와 상세정보는 지도에서 직접 확인해 주세요.')
            : items.length
              ? h('ul', { class: 'plain-list' }, items.map((x) => h('li', null,
                h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.text),
                h('span', { class: 'tiny muted' }, ' · ', x.title ? x.title + ' · ' : '', 'AI 제시 외부 링크'))))
              : h('p', { class: 'small muted' }, '이번 결과에서 단서를 받지 못했어요. 지도에 정보가 없다는 뜻은 아니에요.'),
          mapSearch(platform) ? h('a', { href: mapSearch(platform), target: '_blank', rel: 'noopener noreferrer', class: 'small' }, `${label}에서 직접 검색`) : null);
      }));
  }
  function webFeatureGroups(c) {
    // 새 결과(webFeatures 배열 존재)에서만 사용한다. 최대 8개, 안전한 링크와 내용이 있는 항목만.
    const items = (Array.isArray(c?.webFeatures) ? c.webFeatures : [])
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({
        text: x.text.trim().slice(0, 300),
        title: typeof x.sourceTitle === 'string' && x.sourceTitle.trim() ? x.sourceTitle.trim().slice(0, 120) : '참고 링크',
        url: typeof x.sourceUrl === 'string' ? safeLink(x.sourceUrl) : null,
        provider: x.origin === 'provider_annotation',
      })).filter((x) => x.url).slice(0, 8);
    const groups = [];
    for (const it of items) {
      let g = groups.find((x) => x.url === it.url && x.provider === it.provider);
      if (!g) { g = { url: it.url, title: it.title, provider: it.provider, texts: [] }; groups.push(g); }
      g.texts.push(it.text);
    }
    return groups;
  }
  function webFeatureSection(groups) {
    return h('div', { class: 'web-features' },
      h('div', { class: 'sub-title' }, 'AI가 웹에서 찾은 가게 특징'),
      h('p', { class: 'small muted' }, '각 링크는 참고자료예요. 링크가 해당 내용의 근거가 아닐 수 있으니 사실 여부를 직접 확인해 주세요.'),
      groups.map((g) => h('div', { class: 'web-feature-group' },
        h('a', { href: g.url, target: '_blank', rel: 'noopener noreferrer' }, g.title),
        h('span', { class: 'tiny muted' }, g.provider ? ' · 제공자 인용' : ' · AI 제시 링크', ' · 참고자료, 사실 확인 필요'),
        h('ul', { class: 'plain-list' }, g.texts.map((t) => h('li', null, t))))));
  }
  function directCheckSection() {
    const query = [state.name, state.address].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
    if (!query) return null;
    const q = encodeURIComponent(query);
    return h('div', { class: 'direct-check' },
      h('div', { class: 'sub-title' }, '직접 확인'),
      h('p', { class: 'tiny muted' }, '아래 링크를 누르면 입력하신 가게명과 주소가 해당 사이트(구글 웹 검색 또는 카카오맵)로 전달돼요. 누르기 전에는 전달되지 않아요. 구글 지도가 아닌 구글 웹 검색이에요.'),
      h('a', { href: `https://www.google.com/search?q=${q}`, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, '구글 웹 검색에서 직접 확인'),
      h('br'),
      h('a', { href: `https://map.kakao.com/link/search/${q}`, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, '카카오맵에서 직접 검색'));
  }
  function candidateCard(c, index, confirmed = false) {
    const rows = [
      ['주소', c?.address], ['업종', c?.category], ['영업시간', c?.hours], ['전화', c?.phone],
      ['가격대', c?.priceRange],
    ].filter(([, value]) => typeof value === 'string' && value.trim());
    const menu = (Array.isArray(c?.menu) ? c.menu : []).filter((m) => m?.name);
    const features = (Array.isArray(c?.features) ? c.features : []).filter(Boolean);
    const strengths = (Array.isArray(c?.strengths) ? c.strengths : []).filter(Boolean);
    const isNew = Array.isArray(c?.webFeatures);
    const wf = isNew ? webFeatureGroups(c) : [];
    const showLegacy = !wf.length;
    return h('div', { class: 'card cand page-candidate' },
      h('h3', null, c?.name || '상호 확인 필요'),
      h('p', { class: 'small muted' }, '입력한 가게가 맞는지 상호와 주소를 직접 확인해 주세요.'),
      rows.length ? h('div', { class: 'kv' }, rows.map(([label, value]) => h('div', null, h('span', null, label), h('b', null, value)))) : h('p', { class: 'small muted' }, '확인할 수 있는 상세 정보가 부족해요.'),
      menu.length ? [h('div', { class: 'sub-title' }, '대표 메뉴·상품'), h('div', { class: 'menu-chips' }, menu.map((m) => h('span', null, m.name, m.price ? h('small', null, m.price) : null)))] : null,
      wf.length ? webFeatureSection(wf) : null,
      showLegacy && features.length ? [h('div', { class: 'sub-title' }, isNew ? 'AI 요약 특징 (개별 출처가 연결되지 않은 AI 요약)' : 'AI가 정리한 가게 특징'), isNew ? h('p', { class: 'small muted' }, '개별 출처가 연결되지 않은 AI 요약이에요. 사실 여부를 직접 확인해 주세요.') : null, h('ul', { class: 'plain-list' }, features.map((f) => h('li', null, f)))] : null,
      showLegacy && strengths.length ? [h('div', { class: 'sub-title' }, isNew ? '살펴볼 강점 (개별 출처가 연결되지 않은 AI 요약)' : '공개 정보에서 살펴볼 강점'), isNew ? h('p', { class: 'small muted' }, '개별 출처가 연결되지 않은 AI 요약이에요. 사실 여부를 직접 확인해 주세요.') : null, h('ul', { class: 'plain-list' }, strengths.map((s) => h('li', null, s)))] : null,
      showLegacy && !features.length && !strengths.length ? h('p', { class: 'small muted' }, '가게의 특징은 공개 정보에서 충분히 확인하지 못했어요.') : null,
      isNew ? directCheckSection() : mapSignalSection(c),
      !confirmed ? h('button', { class: 'btn primary block page-choose', type: 'button', onclick: () => choose(index) }, '이 가게가 맞아요') : null);
  }
  function choose(index) {
    const candidates = Array.isArray(state.result?.candidates) ? state.result.candidates : [];
    if (!Number.isInteger(index) || !candidates[index]) return;
    if (state.confirmedIndex !== index && hasDraftWork() && !askBeforeDiscard('다른 가게를 선택하면 이 탭에서 작성하던 가게 소개와 수정 내용이 지워져요. 계속할까요?')) return;
    if (state.confirmedIndex !== index) delete state.pageDraft;
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
    if (state.result && state.status !== 'pending') { showResults(); return; }
    if (state.status === 'pending' || state.status === 'uncertain') { showInterrupted('이전 요청의 결과를 확인하지 못했어요. 요청은 이미 처리됐을 수 있으며 자동으로 다시 보내지 않았어요. 같은 가게를 다시 검색하면 비용이 중복될 수 있어요.'); return; }
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
      h('div', { class: 'card page-next-note' }, h('h3', null, '질문 5개로 소개 초안을 만들어요'),
        h('p', null, '대표 메뉴·서비스만 필수예요. 알고 계신 내용만 적어 주세요.'),
        h('p', { class: 'small muted' }, '비공개 미리보기만 제공해요. 결제·공개·QR 기능은 아직 없어요.'),
        h('button', { type: 'button', class: 'btn primary block', onclick: () => { location.hash = '#/page-questions'; } }, '질문 답하기')),
      candidateCard(chosen, state.confirmedIndex, true),
      sourceCard(state.result));
    setNavbar(btn('다른 가게 확인', () => { location.hash = '#/page-search'; }), btn('처음으로', home, true));
  }

  const QUESTION_FIELDS = [
    ['offer', '대표 메뉴·서비스', '무엇을 제공하나요? 확인된 메뉴나 서비스를 적어 주세요.', 500, true],
    ['difference', '우리 가게만의 차별점', '직접 확인할 수 있는 특징만 적어 주세요. 모르면 비워도 괜찮아요.', 500, false],
    ['audience', '어떤 손님/방문 상황', '어떤 손님이 어떤 상황에서 이용하면 좋을까요?', 500, false],
    ['visit', '방문 전에 알아둘 이용 정보', '확실히 아는 예약·주차·이용 방법 등을 적어 주세요. 모르는 가격·시간은 적지 마세요.', 500, false],
    ['keywords', '희망 검색어', '원하는 검색어예요. 사실 근거나 검색 노출 보장이 아니에요.', 300, false],
  ];
  const string = (v) => typeof v === 'string' ? v : '';
  function chosenStore() { return state.result?.candidates?.[state.confirmedIndex]; }
  function factOptions() {
    const c = chosenStore() || {};
    const raw = [...(Array.isArray(c.webFeatures) ? c.webFeatures.map(x => x?.text) : []),
      ...(Array.isArray(c.features) ? c.features : []), ...(Array.isArray(c.strengths) ? c.strengths : [])];
    return [...new Set(raw.filter(x => typeof x === 'string').map(x => x.trim()).filter(x => x && x.length <= 200))].slice(0, 8);
  }
  function ensurePageDraft() {
    const c = chosenStore();
    if (!c) { location.hash = '#/'; return null; }
    if (!state.pageDraft || typeof state.pageDraft !== 'object' || Array.isArray(state.pageDraft)) {
      state.pageDraft = { store: { name: string(c.name) || string(state.name), address: string(c.address) || string(state.address), verifiedFacts: [] }, answers: {}, status: 'idle' };
    }
    const d = state.pageDraft;
    d.store ||= { name: string(c.name), address: string(c.address), verifiedFacts: [] };
    d.answers ||= {};
    const available = factOptions();
    d.store.verifiedFacts = [...new Set((Array.isArray(d.store.verifiedFacts) ? d.store.verifiedFacts : []).filter(x => available.includes(x)))].slice(0, 8);
    for (const [key] of QUESTION_FIELDS) d.answers[key] = string(d.answers[key]);
    storeName.textContent = string(d.store.name);
    return d;
  }
  function privateNote() {
    return h('div', { class: 'card note page-private-note' },
      h('strong', null, '비공개 미리보기 · 아직 공개되지 않았어요'),
      h('p', { class: 'small' }, '결제·공개·QR 기능은 아직 없어요. 검색 노출 및 AI 학습·추천은 보장하지 않아요. 이 탭에서만 보는 미리보기이며 검색엔진이 수집할 공개 페이지가 아니에요.'),
      h('p', { class: 'small muted' }, 'AI 초안은 틀릴 수 있어요. 가격·시간, 빠진 부정 표현이나 조건을 비롯한 모든 내용을 직접 확인한 뒤 사용해 주세요. 확인되지 않은 정보는 채우지 마세요.'));
  }
  function field(id, label, value, max, oninput, options = {}) {
    return h('div', { class: 'page-field' },
      h('label', { for: id }, label, options.required ? ' (필수)' : ''),
      options.help ? h('p', { id: id + '-help', class: 'small muted' }, options.help) : null,
      h(options.multiline ? 'textarea' : 'input', { id, name: id, type: options.multiline ? null : 'text', value: string(value), maxlength: max, required: !!options.required,
        rows: options.multiline ? 3 : null, disabled: !!options.disabled, 'aria-describedby': options.help ? id + '-help' : null,
        oninput: e => { e.target.removeAttribute?.('aria-invalid'); oninput(e.target.value); } }));
  }
  function draftMessage(d) {
    if (d.status === 'pending') return draftBusy
      ? 'AI 초안을 만들고 있어요. 중복 요청하지 않아요. 답변은 이 탭에 임시저장되어 있어요.'
      : '이전 요청의 응답을 확인하지 못했어요. 이미 처리됐을 수도 있어요. 자동으로 다시 보내지 않았어요. 응답을 확인한 뒤 원하실 때만 다시 요청해 주세요.';
    return d.status === 'error' ? string(d.error) || '초안을 만들지 못했어요. 답변은 보존했어요. 자동 재시도하지 않았어요.' : '';
  }
  function questionHelp(key, fallback) {
    const category = string(chosenStore()?.category);
    const food = /카페|커피|음식|식당|분식|베이커리|제과|주점|한식|중식|일식|양식/.test(category);
    if (key === 'offer') return food ? '예: 대표 메뉴나 음료. 후보의 업종도 틀릴 수 있으니 실제 제공하는 것만 적어 주세요.' : '예: 대표 상품·서비스와 제공 방식. 업종이나 없는 내용은 추측하지 마세요.';
    if (key === 'difference' && food) return '예: 직접 확인한 맛이나 공간의 특징. 해당하는 내용만 적고 모르면 비워 두세요.';
    return fallback;
  }
  function applyEdits(d) {
    if (!d.edit) return;
    d.draft = cleanDraft(d.edit);
    if (d.editStore) { d.store.name = string(d.editStore.name); d.store.address = string(d.editStore.address); }
    delete d.edit; delete d.editStore;
    save();
  }
  function renderQuestions() {
    const d = ensurePageDraft(); if (!d) return;
    applyEdits(d);
    d.view = '#/page-questions'; save();
    let consent = false;
    const error = h('p', { id: 'page-draft-error', class: 'page-error', role: 'alert', 'aria-live': 'polite' });
    const existing = !!d.draft && !d.regenerate;
    const submit = h('button', { type: 'submit', class: 'btn primary block', disabled: draftBusy },
      draftBusy ? '초안 만드는 중…' : ['error', 'pending'].includes(d.status) ? '동의하고 다시 요청' : '동의하고 AI 초안 만들기');
    const form = h('form', { class: 'page-form', novalidate: true, onsubmit: e => { e.preventDefault(); return generateDraft(consent, error); } },
      h('h3', null, '가게 기본 정보'),
      field('page-store-name', '가게명', d.store.name, 60, value => { d.store.name = value; save(); }, { required: true, disabled: draftBusy }),
      field('page-store-address', '주소', d.store.address, 120, value => { d.store.address = value; save(); }, { required: true, disabled: draftBusy }),
      h('fieldset', { class: 'page-facts', disabled: draftBusy },
        h('legend', null, '사장님이 직접 확인한 특징만 선택 (최대 8개)'),
        h('p', { class: 'small muted' }, '아래 내용은 AI가 찾은 미확인 정보예요. 기본 선택은 없으며, 맞다고 직접 체크한 항목만 전송해요. 가게 선택은 특징 확인과 다릅니다.'),
        factOptions().map((fact, i) => h('label', { class: 'page-fact', for: 'page-fact-' + i },
          h('input', { id: 'page-fact-' + i, type: 'checkbox', checked: d.store.verifiedFacts.includes(fact), disabled: draftBusy,
            onchange: e => { d.store.verifiedFacts = e.target.checked ? [...new Set([...d.store.verifiedFacts, fact])].slice(0, 8) : d.store.verifiedFacts.filter(x => x !== fact); save(); } }), fact)),
        !factOptions().length ? h('p', { class: 'small muted' }, '선택할 특징이 없어요. 아래 질문에 직접 적어 주세요.') : null),
      h('h3', null, '질문 5개'),
      QUESTION_FIELDS.map(([key, label, help, max, required], i) => field('page-answer-' + key, (i + 1) + '. ' + label, d.answers[key], max,
        value => { d.answers[key] = value; save(); }, { required, help: questionHelp(key, help), multiline: true, disabled: draftBusy })),
      existing ? h('p', { class: 'card note' }, '이미 초안을 만들었어요. 답변 변경은 AI에 다시 전송하지 않아요. 초안의 문장은 내용 수정에서 직접 고쳐 주세요.') :
        h('div', { class: 'card note page-disclosure' },
          h('h3', null, 'AI 초안 생성을 위한 별도 전송 동의'),
          h('p', null, '전송 내용: 가게명·주소·직접 선택한 특징·위 5개 답변. 초안 생성 시 OpenRouter 및 연결된 AI 제공자에게 전송해요.'),
          h('p', { class: 'small' }, '답변과 편집 내용은 이 탭의 sessionStorage에 임시저장되며, 새로고침해도 유지돼요. 탭을 닫거나 저장 공간을 지우면 사라질 수 있어요. 외부로 전송된 정보에는 각 제공자의 보관정책이 적용돼요.'),
          h('p', { class: 'small' }, '연락처, 고객 정보 등 개인정보 입력은 자제해 주세요. 이 동의는 앞선 가게 검색 동의와 별도예요.'),
          h('label', { class: 'page-consent', for: 'page-draft-consent' },
            h('input', { id: 'page-draft-consent', type: 'checkbox', disabled: draftBusy, onchange: e => { e.target.removeAttribute?.('aria-invalid'); consent = !!e.target.checked; } }),
            '위 전송 내용과 보관 안내를 확인했고 AI 초안 생성을 위한 전송에 동의합니다.')),
      error,
      existing ? h('div', { class: 'page-actions' }, h('button', { class: 'btn primary block', type: 'button', onclick: () => { location.hash = '#/page-preview'; } }, '작성한 비공개 미리보기 보기'), h('button', { class: 'btn block', type: 'button', onclick: () => { d.regenerate = true; save(); renderQuestions(); } }, '답변으로 새 초안 만들기')) : [submit, d.draft && !draftBusy ? h('button', { class: 'btn block', type: 'button', onclick: () => { delete d.regenerate; d.status = 'ready'; d.view = '#/page-preview'; save(); location.hash = '#/page-preview'; } }, '기존 미리보기 보기') : null]);
    show(h('div', { class: 'page-questions' }, privateNote(), h('h2', null, '우리 가게를 알려 주세요'),
      h('p', { class: 'small muted' }, '대표 메뉴·서비스만 필수예요. 나머지는 모르면 비워 두세요. 희망 검색어는 사실 근거로 사용하지 않아요.'),
      draftMessage(d) ? h('p', { class: 'card warn page-draft-status', role: 'status', 'aria-live': 'polite' }, draftMessage(d)) : null, form));
    setNavbar(btn('가게 확인으로', () => { location.hash = '#/page-confirmed'; }), btn('처음으로', home));
  }
  async function generateDraft(consent, error) {
    if (draftBusy || busy) return;
    const d = ensurePageDraft(); if (!d || (d.draft && !d.regenerate)) return;
    const store = { name: string(d.store.name).trim(), address: string(d.store.address).trim(), verifiedFacts: [...d.store.verifiedFacts] };
    const answers = Object.fromEntries(QUESTION_FIELDS.map(([key]) => [key, string(d.answers[key]).trim()]));
    let message = '', focusId = '';
    if (!store.name || store.name.length > 60) { message = '가게명을 1~60자로 입력해 주세요.'; focusId = 'page-store-name'; }
    else if (store.address.length < 4 || store.address.length > 120) { message = '주소를 4~120자로 입력해 주세요.'; focusId = 'page-store-address'; }
    else if (answers.offer.length < 2) { message = '대표 메뉴·서비스를 2자 이상 입력해 주세요.'; focusId = 'page-answer-offer'; }
    else if (QUESTION_FIELDS.some(([key, , , max]) => answers[key].length > max)) { message = '답변은 각 500자, 희망 검색어는 300자 이내로 입력해 주세요.'; focusId = 'page-answer-offer'; }
    else if (!consent) { message = 'AI 초안 생성 전송에 별도로 동의해 주세요.'; focusId = 'page-draft-consent'; }
    if (message) {
      error.textContent = message;
      if (typeof document !== 'undefined') {
        const target = document.getElementById(focusId);
        if (target) { const ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean); if (!ids.includes('page-draft-error')) ids.push('page-draft-error'); target.setAttribute('aria-describedby', ids.join(' ')); target.setAttribute('aria-invalid', 'true'); target.focus(); }
      }
      return;
    }
    draftBusy = true; d.status = 'pending'; d.error = ''; d.view = '#/page-questions'; save(); renderQuestions();
    try {
      const result = await post('/api/page-draft', { store, answers, consent: true }, 190000);
      if (!result?.draft || typeof result.draft !== 'object' || Array.isArray(result.draft)) throw new Error('초안 응답을 확인하지 못했어요.');
      d.draft = cleanDraft(result.draft); d.createdAt = string(result.createdAt); d.cached = result.cached === true; d.mock = result.mock === true;
      d.status = 'ready'; d.view = '#/page-preview'; delete d.edit; delete d.editStore; delete d.regenerate; save();
      draftBusy = false;
      if (location.hash === '#/page-questions') { location.hash = '#/page-preview'; renderPreview(); }
    } catch (err) {
      d.status = 'error';
      d.error = ['TIMEOUT', 'NETWORK'].includes(err?.code)
        ? '응답을 확인하지 못했어요. 요청은 이미 처리됐을 수도 있어요. 답변은 보존했고 자동으로 다시 보내지 않았어요.'
        : '초안을 만들지 못했어요. ' + (string(err?.message) || '잠시 후 다시 시도해 주세요.') + ' 답변은 보존했고 자동 재시도하지 않았어요.';
      save();
    } finally {
      draftBusy = false;
      if (location.hash === '#/page-questions') renderQuestions();
    }
  }
  function cleanDraft(raw) {
    const obj = v => v && typeof v === 'object' && !Array.isArray(v);
    const evidence = v => Array.isArray(v) ? v.filter(x => typeof x === 'string') : typeof v === 'string' ? [v] : [];
    const item = (v, keys) => Object.fromEntries([...keys.map(key => [key, string(v?.[key])]), ['evidence', evidence(v?.evidence)]]);
    return { headline: obj(raw.headline) ? item(raw.headline, ['text']) : null, intro: obj(raw.intro) ? item(raw.intro, ['text']) : null,
      sections: (Array.isArray(raw.sections) ? raw.sections : []).filter(obj).map(v => item(v, ['heading', 'body'])),
      faqs: (Array.isArray(raw.faqs) ? raw.faqs : []).filter(obj).map(v => item(v, ['question', 'answer'])),
      keywords: (Array.isArray(raw.keywords) ? raw.keywords : []).filter(obj).map(v => item(v, ['text'])),
      omittedCount: Number.isSafeInteger(raw.omittedCount) && raw.omittedCount > 0 ? raw.omittedCount : 0 };
  }
  function omittedNote(draft) {
    return draft.omittedCount > 0 ? h('p', { class: 'card note page-omitted', role: 'status' }, '근거가 부족하거나 검증을 통과하지 못한 AI 항목 ' + draft.omittedCount + '개를 제외했어요. 빠진 내용은 사실을 확인한 뒤 직접 작성해 주세요.') : null;
  }
  function evidenceNote(item) {
    const labels = { name: '가게명', address: '가게 주소', offer: '대표 메뉴·서비스 답변', difference: '차별점 답변', audience: '손님·방문 상황 답변', visit: '이용 정보 답변', keywords: '희망 검색어' };
    const names = (Array.isArray(item?.evidence) ? item.evidence : []).map(id => labels[id] || (/^fact[0-7]$/.test(id) ? `직접 확인한 특징 ${Number(id.slice(4)) + 1}` : '입력 정보'));
    return names.length ? h('p', { class: 'tiny muted page-evidence' }, '처음 작성할 때 사용한 정보: ', names.join(', '), ' · 수정한 내용은 직접 확인해 주세요.') : null;
  }
  function needDraft() {
    const d = ensurePageDraft(); if (!d) return null;
    if (!d.draft) { location.hash = '#/page-questions'; renderQuestions(); return null; }
    return d;
  }
  function renderPreview() {
    const d = needDraft(); if (!d) return;
    if (draftBusy) { location.hash = '#/page-questions'; renderQuestions(); return; }
    applyEdits(d);
    d.view = '#/page-preview'; save();
    const draft = cleanDraft(d.draft);
    show(h('div', { class: 'page-preview' }, privateNote(), h('h2', null, '완성본 비공개 미리보기'),
      h('p', { class: 'small muted' }, d.mock ? '테스트용 모의 초안이에요. 실제 AI 생성 결과가 아니에요.' : 'AI가 작성하고 사장님이 확인·수정하는 초안이에요.'),
      h('p', { class: 'small muted' }, '편집·저장은 이 탭에만 반영돼요. 서버 전송이나 AI 재호출은 하지 않아요.'),
      omittedNote(draft),
      h('article', { class: 'card page-draft-content' },
        h('p', { class: 'small muted' }, string(d.store.name), ' · ', string(d.store.address)),
        draft.headline?.text ? h('h1', null, draft.headline.text) : null,
        draft.intro?.text ? h('p', { class: 'page-intro' }, draft.intro.text) : null,
        draft.sections.filter(x => x.heading || x.body).map(x => h('section', { class: 'page-preview-section' }, x.heading ? h('h2', null, x.heading) : null, x.body ? h('p', null, x.body) : null)),
        draft.faqs.some(x => x.question && x.answer) ? h('section', { class: 'page-preview-faq' }, h('h2', null, '자주 묻는 질문'), draft.faqs.filter(x => x.question && x.answer).map(x => h('div', null, h('h3', null, x.question), h('p', null, x.answer)))) : null),
      draft.keywords.some(x => x.text) ? h('aside', { class: 'card note page-keywords' }, h('h3', null, '확인할 키워드 제안'), h('p', { class: 'small muted' }, '희망 검색어는 사실 근거가 아니에요. 실제 가게와 맞는지 확인해 주세요. 소개 본문이나 공개 페이지의 확정 키워드·메타데이터로 반영되지 않았으며 검색 노출을 보장하지 않아요.'), draft.keywords.filter(x => x.text).map(x => h('span', null, x.text))) : null,
      h('div', { class: 'page-actions' }, h('button', { class: 'btn primary block', type: 'button', onclick: () => { location.hash = '#/page-edit'; } }, '내용 수정'))));
    setNavbar(btn('질문으로', () => { location.hash = '#/page-questions'; }), btn('처음으로', home));
  }
  function renderEdit() {
    const d = needDraft(); if (!d) return;
    if (draftBusy) { location.hash = '#/page-questions'; renderQuestions(); return; }
    d.view = '#/page-edit'; if (!d.edit) d.edit = cleanDraft(d.draft);
    if (!d.editStore) d.editStore = { name: string(d.store.name), address: string(d.store.address) }; save();
    const draft = d.edit;
    if (!draft.headline) draft.headline = { text: '', evidence: [] };
    if (!draft.intro) draft.intro = { text: '', evidence: [] };
    const editField = (id, label, item, key, max, multiline = false) => field(id, label, item[key], max, value => { item[key] = value; save(); }, { multiline });
    const add = (list, item, max) => { if (list.length < max) { list.push(item); save(); renderEdit(); } };
    const remove = (list, index) => { list.splice(index, 1); save(); renderEdit(); };
    show(h('div', { class: 'page-edit' }, privateNote(), h('h2', null, '소개 내용 수정'),
      h('p', { class: 'small muted' }, '입력 중 내용은 이 탭에 임시저장되며, 미리보기나 질문 화면으로 이동하면 자동 반영돼요. 서버 전송·AI 재호출은 없어요. 필요하면 질문에서 별도 동의 후 새 초안을 만들 수 있어요. 근거 표시는 최초 AI 작성 기준이며 수정 내용을 검증해 주지 않아요.'),
      omittedNote(draft),
      h('form', { class: 'page-form', onsubmit: e => { e.preventDefault(); applyEdits(d); d.status = 'ready'; d.view = '#/page-preview'; save(); location.hash = '#/page-preview'; renderPreview(); } },
        editField('page-edit-store-name', '가게명', d.editStore, 'name', 60),
        editField('page-edit-store-address', '주소', d.editStore, 'address', 120),
        draft.headline ? [editField('page-edit-headline', '제목', draft.headline, 'text', 200), evidenceNote(draft.headline)] : null,
        draft.intro ? [editField('page-edit-intro', '소개', draft.intro, 'text', 2000, true), evidenceNote(draft.intro)] : null,
        draft.sections.map((x, i) => h('fieldset', { class: 'page-edit-section' }, h('legend', null, '소개 섹션 ' + (i + 1)),
          editField('page-edit-section-' + i + '-heading', '섹션 제목', x, 'heading', 200), editField('page-edit-section-' + i + '-body', '섹션 내용', x, 'body', 4000, true), evidenceNote(x),
          h('button', { class: 'btn small', type: 'button', onclick: () => remove(draft.sections, i) }, '소개 섹션 삭제'))),
        h('button', { class: 'btn small', type: 'button', disabled: draft.sections.length >= 8, onclick: () => add(draft.sections, { heading: '', body: '', evidence: [] }, 8) }, '소개 섹션 추가'),
        draft.faqs.map((x, i) => h('fieldset', { class: 'page-edit-section' }, h('legend', null, 'FAQ ' + (i + 1)),
          editField('page-edit-faq-' + i + '-question', 'FAQ 질문', x, 'question', 300), editField('page-edit-faq-' + i + '-answer', 'FAQ 답변', x, 'answer', 2000, true), evidenceNote(x),
          h('button', { class: 'btn small', type: 'button', onclick: () => remove(draft.faqs, i) }, 'FAQ 삭제'))),
        h('button', { class: 'btn small', type: 'button', disabled: draft.faqs.length >= 8, onclick: () => add(draft.faqs, { question: '', answer: '', evidence: [] }, 8) }, 'FAQ 직접 추가'),
        draft.keywords.map((x, i) => h('div', { class: 'page-edit-section' }, editField('page-edit-keyword-' + i, '키워드 ' + (i + 1), x, 'text', 100), evidenceNote(x),
          h('button', { class: 'btn small', type: 'button', onclick: () => remove(draft.keywords, i) }, '키워드 삭제'))),
        h('button', { class: 'btn small', type: 'button', disabled: draft.keywords.length >= 12, onclick: () => add(draft.keywords, { text: '', evidence: [] }, 12) }, '키워드 추가'),
        h('p', { class: 'small muted' }, '확인한 정보만 직접 추가해 주세요. 빈 내용은 미리보기에서 숨겨져요.'),
        h('button', { class: 'btn primary block', type: 'submit' }, '이 탭에 저장하고 미리보기'))));
    setNavbar(btn('미리보기로', () => { location.hash = '#/page-preview'; }), btn('질문으로', () => { location.hash = '#/page-questions'; }));
  }

  return { begin, renderSearch, renderConfirmed, renderQuestions, renderPreview, renderEdit, info: () => ({ name: state.name || '', address: state.address || '', status: state.status || '', draftStatus: state.pageDraft?.status || '', resumeHash: state.pageDraft?.view || (state.status === 'confirmed' ? '#/page-confirmed' : '#/page-search') }), busy: () => busy || draftBusy };
}
