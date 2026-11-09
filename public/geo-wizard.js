/*
 * Independent, private GEO preview. The host must load geo-wizard.css.
 * mountGeoWizard(container, { onBack, search }) -> { destroy() }.
 * The host must call destroy() when navigating away or replacing the view.
 * search is an optional test seam: async (payload, { signal }) => API response.
 * Without it, exactly one POST is made per explicit search submission.
 */
const MAX_FILES = 4;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SEARCH_TIMEOUT = 180000;
const activeMounts = new WeakMap();
let sequence = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}
function clean(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function scalar(value, max = 500) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : clean(value, max);
}
function list(value, maxItems = 20) {
  return Array.isArray(value) ? value.slice(0, maxItems).map(v => clean(v, 300)).filter(Boolean) : [];
}
function safeUrl(value) {
  const raw = clean(value, 2048);
  if (!/^https?:\/\//i.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':') || !host.includes('.')) return '';
    return parsed.href;
  } catch { return ''; }
}
function normalizeCandidate(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const menu = Array.isArray(v.menu) ? v.menu.slice(0, 30).map(item => {
    if (!item || typeof item !== 'object') return '';
    const name = clean(item.name, 200), price = scalar(item.price, 100);
    return name ? (price ? `${name} · ${price}` : name) : '';
  }).filter(Boolean) : [];
  const channels = Array.isArray(v.channels) ? v.channels.slice(0, 6).map(ch => { const url = safeUrl(ch?.url); const type = clean(ch?.type, 30); return url ? [type, url].filter(Boolean).join(' ') : ''; }).filter(Boolean) : [];
  return {
    name: clean(v.name, 150), address: clean(v.address, 250), category: clean(v.category, 120),
    phone: scalar(v.phone, 100), hours: clean(v.hours, 500), menu,
    features: list(v.features), strengths: list(v.strengths), channels,
    matchLevel: scalar(v.matchLevel, 80), matchReason: clean(v.matchReason, 500),
  };
}
function normalizeResponse(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.candidates)) throw new Error('invalid response');
  const candidates = raw.candidates.slice(0, 20).map(normalizeCandidate);
  const sources = Array.isArray(raw.sources) ? raw.sources.slice(0, 30).map(s => ({
    title: clean(s?.title, 200), url: safeUrl(s?.url),
  })).filter(s => s.url) : [];
  return { candidates, sources, searchedAt: clean(raw.searchedAt, 80), cached: raw.cached === true,
    notFoundReason: clean(raw.notFoundReason, 500) };
}
async function defaultSearch(payload, { signal }) {
  const response = await fetch('/api/geo-search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(typeof result.error === 'string' ? result.error.slice(0, 200) : '검색 요청을 처리하지 못했어요.');
    error.expose = true; throw error;
  }
  return response.json();
}
function displayTime(value) {
  if (!value) return '확인할 수 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '확인할 수 없음';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(date) + ' (한국 시간)';
}
function regionOf(address) {
  const parts = address.split(/\s+/).map(s => s.replace(/[,()]/g, ''));
  const regions = parts.filter(s => s.length > 1 && (/(?:특별자치시|특별시|광역시|특별자치도|도|시|군|구|읍|면|동)$/.test(s) || /^(?:서울|부산|대구|인천|광주|대전|울산|세종|제주)$/.test(s)));
  return regions.slice(-2).join(' ');
}
function deriveKeywords(data) {
  const region = regionOf(data.address), name = clean(data.name), category = clean(data.category);
  const offerings = data.menu.split('\n').map(s => s.split(' · ')[0].trim()).filter(Boolean).slice(0, 3);
  const combinations = [name, region && category ? `${region} ${category}` : '',
    region && name ? `${region} ${name}` : '', ...offerings.map(o => region ? `${region} ${o}` : (name ? `${name} ${o}` : o))];
  return [...new Set(combinations.filter(Boolean))].slice(0, 6);
}
function makeDraft(c) {
  return { name: c.name, address: c.address, category: c.category, phone: c.phone, hours: c.hours,
    menu: c.menu.join('\n'), highlights: [...c.features, ...c.strengths].join('\n'), channels: c.channels.join('\n') };
}

/**
 * @param {Element} container The host element; its contents are replaced.
 * @param {{onBack?: () => void, search?: (payload: object, options: {signal: AbortSignal}) => Promise<object>}} options
 * @returns {{destroy: () => void}} Remove the view, cancel an in-flight request, and revoke local photo URLs.
 */
export function mountGeoWizard(container, options = {}) {
  if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('mountGeoWizard requires a container');
  if (options.search !== undefined && typeof options.search !== 'function') throw new TypeError('search must be a function');
  activeMounts.get(container)?.();
  const id = `geo-${++sequence}`;
  const root = el('section', { class: 'geo-root', 'aria-label': '가게 소개와 GEO 준비 미리보기' });
  const state = {
    step: 0, name: '', address: '', consent: false, busy: false, error: '', result: null, resultQuery: null, resultId: 0,
    selected: -1, identity: false, committedKey: null, fallback: false, draft: null,
    photos: [], rights: false, editing: false,
  };
  let destroyed = false, controller = null, timer = null, generation = 0;
  const search = options.search || defaultSearch;
  const names = ['가게 찾기', '가게 확인', '사진 선택', '시안 미리보기'];
  function stopRequest() {
    generation++;
    if (timer) clearTimeout(timer);
    timer = null;
    if (controller) controller.abort();
    controller = null;
    state.busy = false;
  }
  function clearPhotos() {
    for (const photo of state.photos) URL.revokeObjectURL(photo.url);
    state.photos = [];
    state.rights = false;
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopRequest();
    clearPhotos();
    if (activeMounts.get(container) === destroy) activeMounts.delete(container);
    root.remove();
  }
  function go(step) {
    if (destroyed) return;
    state.step = step; state.error = ''; state.editing = false;
    render();
    root.querySelector('h2')?.focus();
  }
  function button(label, handler, kind = 'secondary', extra = {}) {
    return el('button', { type: 'button', class: `geo-btn geo-btn-${kind}`, on: { click: handler }, ...extra }, label);
  }
  function heading(kicker, title, subtitle) {
    return el('div', { class: 'geo-heading' }, el('span', { class: 'geo-kicker' }, kicker),
      el('h2', { tabindex: '-1' }, title), el('p', {}, subtitle));
  }
  function errorNode() { return state.error ? el('div', { class: 'geo-error', role: 'alert' }, state.error) : null; }
  function field(key, label, placeholder, max, multiline = false) {
    const inputId = `${id}-${key}`;
    const attrs = { id: inputId, name: key, placeholder, maxlength: max, value: state[key],
      on: { input: event => { state[key] = event.currentTarget.value; } } };
    const input = multiline ? el('textarea', { ...attrs, rows: 3 }) : el('input', { ...attrs, type: 'text', autocomplete: 'off' });
    return el('label', { class: 'geo-field', for: inputId }, el('span', { class: 'geo-field-label' }, label, el('b', {}, '필수')), input);
  }
  function consentBox(checked, change, title, description) {
    return el('label', { class: 'geo-consent' }, el('input', { type: 'checkbox', checked, on: { change } }),
      el('span', {}, el('strong', {}, title), el('small', {}, description)));
  }
  async function startSearch(event) {
    event?.preventDefault();
    if (state.busy || destroyed) return;
    const name = state.name.trim(), address = state.address.trim();
    if (!name || !address) { state.error = '가게 이름과 주소를 모두 입력해 주세요.'; render(); return; }
    if (address.length < 4) { state.error = '주소를 4자 이상 입력해 주세요.'; render(); return; }
    if (!state.consent) { state.error = '검색에 필요한 정보 전송에 동의해 주세요.'; render(); return; }
    const payload = { consent: true, name, address };
    state.error = ''; state.busy = true; state.consent = false;
    const token = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    timer = setTimeout(() => {
      if (destroyed || token !== generation) return;
      stopRequest(); state.error = '화면에서 검색 대기가 끝났어요. 서버의 AI 처리가 계속됐을 수 있으니 잠시 후 다시 확인해 주세요. 입력 내용은 그대로예요.'; render();
    }, SEARCH_TIMEOUT);
    render();
    try {
      const raw = await search(payload, { signal });
      if (destroyed || token !== generation) return;
      const result = normalizeResponse(raw);
      clearTimeout(timer); timer = null; controller = null; state.busy = false;
      state.result = result; state.resultQuery = { name, address }; state.resultId++; state.selected = -1;
      state.identity = false; state.fallback = false; state.step = 1; state.error = '';
      render(); root.querySelector('h2')?.focus();
    } catch (err) {
      if (destroyed || token !== generation) return;
      clearTimeout(timer); timer = null; controller = null; state.busy = false;
      state.error = (err?.expose && err.message ? err.message : '검색을 완료하지 못했어요. 인터넷 연결을 확인해 주세요.') + ' 입력 내용은 그대로예요.'; render();
    }
  }
  function cancelSearch() {
    stopRequest(); state.error = '화면에서 검색을 중단했어요. 서버의 AI 처리가 계속됐을 수 있어요. 입력 내용은 그대로예요.'; render();
  }
  function useEnteredInfoOnly() {
    const name = state.name.trim(), address = state.address.trim();
    if (!name || address.length < 4) { state.error = '가게 이름과 주소를 정확히 입력해 주세요.'; render(); return; }
    state.result = { candidates: [], sources: [], searchedAt: '', cached: false, failed: true,
      notFoundReason: 'AI 검색을 완료하지 못해 입력한 정보만 사용합니다.' };
    state.resultQuery = { name, address }; state.resultId++; state.selected = -1;
    state.identity = false; state.fallback = false; state.error = ''; state.step = 1; render();
  }
  function searchView() {
    const form = el('form', { class: 'geo-form', novalidate: true, on: { submit: startSearch } },
      heading('01 · START', '우리 가게부터 찾아볼게요', '상호명과 주소만 알려주세요. 검색 결과를 확인한 뒤 시안을 만듭니다.'),
      el('div', { class: 'geo-fields' },
        field('name', '가게 이름', '예: 오늘의 가게', 60),
        field('address', '가게 주소', '예: 서울시 마포구 ○○로 12', 120)),
      consentBox(state.consent, e => { state.consent = e.currentTarget.checked; }, '가게 정보 전송에 동의합니다 (필수)',
        '입력한 상호명과 주소가 OpenRouter, Claude 및 검색 제공업체에 전송되어 공개 정보 검색에 사용됩니다. 검색 결과는 서버에 최대 3일 보관될 수 있습니다. 사진은 전송하지 않습니다.'),
      el('div', { class: 'geo-note' }, el('span', { 'aria-hidden': 'true' }, 'i'), el('p', {},
        'AI가 공개 검색 결과에 나온 요약을 바탕으로 정리하므로 다른 지점의 정보가 섞이거나 현재와 다를 수 있어요. 원문 열람이나 사실 확인을 보장하지 않습니다.')),
      errorNode(),
      el('div', { class: 'geo-actions' },
        state.result && !state.busy ? button('이전 검색 결과 보기', () => go(1), 'secondary') : null,
        state.error && !state.busy ? button('검색 없이 입력 정보로 시안', useEnteredInfoOnly, 'secondary') : null,
        state.busy ? button('검색 취소', cancelSearch, 'secondary') : null,
        el('button', { type: 'submit', class: 'geo-btn geo-btn-primary', disabled: state.busy, 'aria-busy': state.busy ? 'true' : 'false' }, state.busy ? '검색 중...' : '동의하고 가게 찾기')),
      state.busy ? el('p', { class: 'geo-status', role: 'status' }, '검색 중입니다. 응답이 없으면 자동으로 중단되며, 직접 취소할 수도 있어요.') : null);
    return form;
  }
  function selectedCandidate() {
    if (!state.result) return null;
    if (state.selected === state.result.candidates.length) {
      return { name: state.resultQuery.name, address: state.resultQuery.address, category: '', phone: '', hours: '', menu: [], features: [], strengths: [], channels: [], matchLevel: '', matchReason: '' };
    }
    return state.result.candidates[state.selected] || null;
  }
  function selectCandidate(index) { state.selected = index; state.identity = false; state.error = ''; render(); }
  function confirmCandidate() {
    const candidate = selectedCandidate();
    if (!candidate) { state.error = '먼저 해당하는 가게를 선택해 주세요.'; render(); return; }
    if (!state.identity) { state.error = '선택한 가게와 지점이 본인 가게인지 확인해 주세요.'; render(); return; }
    const isFallback = state.selected === state.result.candidates.length;
    const key = `${state.resultId}:${state.selected}`;
    if (key !== state.committedKey) { clearPhotos(); state.draft = makeDraft({ ...candidate, address: candidate.address || state.resultQuery.address }); state.committedKey = key; }
    state.fallback = isFallback;
    go(2);
  }
  function candidateCard(candidate, index, fallback = false) {
    const chosen = state.selected === index;
    return el('button', { type: 'button', class: `geo-candidate${chosen ? ' is-selected' : ''}`, 'aria-pressed': chosen ? 'true' : 'false',
      on: { click: () => selectCandidate(index) } },
      el('span', { class: 'geo-candidate-radio', 'aria-hidden': 'true' }),
      el('span', { class: 'geo-candidate-body' },
        el('span', { class: 'geo-candidate-top' }, el('strong', {}, candidate.name || '이름 확인 필요'),
          el('span', { class: 'geo-tag' }, fallback ? '입력 정보만' : 'AI 검색 후보')),
        el('span', { class: 'geo-candidate-address' }, candidate.address || '주소 확인 필요'),
        candidate.category || candidate.phone ? el('span', { class: 'geo-candidate-meta' }, [candidate.category, candidate.phone].filter(Boolean).join(' · ')) : null,
        candidate.matchLevel ? el('span', { class: 'geo-match' }, `AI 응답 일치 표기: ${candidate.matchLevel} (검증 아님)`) : null,
        candidate.matchReason ? el('span', { class: 'geo-match' }, `AI 응답 설명: ${candidate.matchReason}`) : null));
  }
  function resultView() {
    const result = state.result;
    if (!result) return null;
    const fallbackCandidate = { name: state.resultQuery.name, address: state.resultQuery.address };
    const chosen = selectedCandidate();
    const chosenKey = chosen ? `${state.resultId}:${state.selected}` : '';
    return el('div', {},
      heading('02 · VERIFY', '어느 가게가 맞나요?', '이름이 비슷한 다른 지점일 수 있어요. 주소까지 확인하고 선택해 주세요.'),
      el('div', { class: 'geo-query' }, el('span', {}, '검색한 정보'), el('strong', {}, `${state.resultQuery.name} · ${state.resultQuery.address}`)),
      el('p', { class: 'geo-result-explainer' }, result.failed
        ? 'AI 검색을 완료하지 못했어요. 입력한 이름과 주소만으로 시안을 만들 수 있어요.'
        : result.candidates.length
          ? '아래는 검색 모델이 제시한 후보이며 실제 일치 여부는 확인되지 않았어요. 내 가게가 없으면 입력 정보만으로 진행할 수 있어요.'
          : '검색된 후보가 없어요. 원하시면 입력한 이름과 주소만으로 시안을 만들 수 있어요.'),
      !result.candidates.length && result.notFoundReason ? el('p', { class: 'geo-muted-box' }, `검색 응답: ${result.notFoundReason}`) : null,
      el('div', { class: 'geo-candidates', 'aria-label': '가게 후보' },
        result.candidates.map((candidate, index) => candidateCard(candidate, index)), candidateCard(fallbackCandidate, result.candidates.length, true)),
      chosen && state.committedKey && chosenKey !== state.committedKey && state.photos.length
        ? el('div', { class: 'geo-warning' }, '다른 가게를 확정하면 이전 가게의 선택 사진과 수정 내용이 지워집니다.') :
        chosen && state.committedKey && chosenKey !== state.committedKey ? el('div', { class: 'geo-warning' }, '다른 가게를 확정하면 이전 가게의 수정 내용이 지워집니다.') : null,
      consentBox(state.identity, e => { state.identity = e.currentTarget.checked; }, '선택한 가게와 주소가 제 가게가 맞습니다 (필수)',
        '직접 확인하는 단계이며 소유자 인증이나 검색 결과의 사실 검증은 아닙니다.'),
      el('p', { class: 'geo-small' }, `검색 응답 시각: ${displayTime(result.searchedAt)}${result.cached ? ' · 캐시된 응답' : ''}`),
      errorNode(), el('div', { class: 'geo-actions' }, button('다시 입력', () => go(0)), button('확인하고 계속', confirmCandidate, 'primary')));
  }
  function addPhotos(event) {
    const input = event.currentTarget;
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    if (state.photos.length + files.length > MAX_FILES) state.error = '사진은 최대 4장까지 선택할 수 있어요.';
    else if (files.some(file => !ACCEPTED_TYPES.has(file.type))) state.error = 'JPG, PNG, WebP 형식의 사진만 선택해 주세요.';
    else if (files.some(file => file.size <= 0 || file.size > MAX_FILE_BYTES)) state.error = '사진 한 장은 0보다 크고 5MB 이하여야 해요.';
    else if (state.photos.reduce((sum, photo) => sum + photo.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES)
      state.error = '선택한 사진의 전체 크기는 12MB 이하여야 해요.';
    else {
      const created = [];
      try {
        for (const file of files) created.push({ url: URL.createObjectURL(file), name: clean(file.name, 200) || '사진', size: file.size });
        state.photos.push(...created); state.rights = false; state.error = '';
      } catch {
        for (const photo of created) URL.revokeObjectURL(photo.url);
        state.error = '사진을 불러오지 못했어요. 다른 사진으로 다시 선택해 주세요.';
      }
    }
    render();
  }
  function removePhoto(index) {
    const [photo] = state.photos.splice(index, 1);
    if (photo) URL.revokeObjectURL(photo.url);
    state.rights = false; state.error = ''; render();
  }
  function showPreview() {
    if (state.photos.length && !state.rights) { state.error = '선택한 사진의 사용 권한을 확인해 주세요. 사진을 빼고 진행할 수도 있어요.'; render(); return; }
    go(3);
  }
  function photosView() {
    const fileId = `${id}-photos`;
    return el('div', {}, heading('03 · PHOTOS', '사진을 더할까요?', '선택 사항이에요. 사진 없이도 바로 시안을 볼 수 있습니다.'),
      el('label', { class: 'geo-upload', for: fileId }, el('span', { class: 'geo-upload-icon', 'aria-hidden': 'true' }, '+'),
        el('strong', {}, '가게 사진 선택하기'), el('span', {}, 'JPG, PNG, WebP · 최대 4장'), el('small', {}, '한 장당 최대 5MB, 전체 최대 12MB')),
      el('input', { id: fileId, class: 'geo-file', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, on: { change: addPhotos } }),
      state.photos.length ? el('div', { class: 'geo-photo-grid' }, state.photos.map((photo, index) =>
        el('div', { class: 'geo-photo' }, el('img', { src: photo.url, alt: `선택한 사진 ${index + 1}` }),
          button('삭제', () => removePhoto(index), 'remove', { 'aria-label': `사진 ${index + 1} 삭제` }),
          el('span', {}, photo.name)))) : el('p', { class: 'geo-photo-empty' }, '선택한 사진이 없어요.'),
      state.photos.length ? consentBox(state.rights, e => { state.rights = e.currentTarget.checked; }, '선택한 사진을 사용할 권리가 있습니다 (필수)',
        '직접 촬영했거나 필요한 사용 허락을 받았으며, 사진 속 인물 등의 권리도 확인했습니다. 사진을 바꾸면 다시 확인해야 해요.') : null,
      el('div', { class: 'geo-note' }, el('span', { 'aria-hidden': 'true' }, 'i'), el('p', {},
        '사진은 이 브라우저의 임시 Blob URL로만 표시하며 서버나 AI에 전송하지 않아요. AI가 사진 내용을 읽거나 분석하지 않습니다. 민감한 사진은 올리지 마세요.')),
      errorNode(), el('div', { class: 'geo-actions' }, button('가게 다시 확인', () => go(1)), button(state.photos.length ? '시안 만들기' : '사진 없이 시안 만들기', showPreview, 'primary')));
  }
  function draftField(key, label, multiline = false) {
    const fieldId = `${id}-edit-${key}`;
    const attrs = { id: fieldId, value: state.draft[key], maxlength: key === 'highlights' || key === 'menu' ? 3000 : 500,
      on: { input: event => { state.draft[key] = event.currentTarget.value; } } };
    return el('label', { class: 'geo-field', for: fieldId }, el('span', { class: 'geo-field-label' }, label, el('em', {}, '선택')),
      multiline ? el('textarea', { ...attrs, rows: 3 }) : el('input', { ...attrs, type: 'text' }));
  }
  function editPanel() {
    return el('div', { class: 'geo-editor' },
      el('div', { class: 'geo-panel-head' }, el('div', {}, el('span', { class: 'geo-kicker' }, 'EDIT'), el('h3', {}, '틀린 정보만 고쳐주세요'),
        el('p', {}, '모두 선택 사항입니다. 비워 두면 시안에서 해당 내용을 생략해요.'))),
      el('div', { class: 'geo-edit-grid' }, draftField('name', '가게 이름'), draftField('address', '주소'),
        draftField('category', '업종'), draftField('phone', '연락처'), draftField('hours', '영업시간', true),
        draftField('menu', '대표 상품 · 서비스 · 메뉴와 가격 (한 줄에 하나)', true), draftField('highlights', '참고 소개 (한 줄에 하나)', true),
        draftField('channels', '채널 (한 줄에 하나)', true)),
      el('div', { class: 'geo-actions' }, button('수정 내용 반영', () => { state.editing = false; render(); }, 'primary')));
  }
  function lineValues(value) { return value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 30); }
  function factRow(label, value) { return el('div', { class: 'geo-fact' }, el('dt', {}, label), el('dd', {}, value)); }
  function previewBusiness() {
    const d = state.draft, menu = lineValues(d.menu), highlights = lineValues(d.highlights), channels = lineValues(d.channels);
    const anyFacts = d.address.trim() || d.hours.trim() || d.phone.trim();
    const faq = [
      d.address.trim() ? ['어디에 있나요?', d.address.trim()] : null,
      d.hours.trim() ? ['영업시간은 어떻게 되나요?', d.hours.trim()] : null,
      d.phone.trim() ? ['문의할 연락처는 무엇인가요?', d.phone.trim()] : null,
      menu.length ? ['어떤 상품이나 서비스를 이용할 수 있나요?', menu.join(' · ')] : null,
    ].filter(Boolean);
    return el('section', { class: 'geo-site', 'aria-label': '가게 페이지 디자인 미리보기' },
      el('div', { class: 'geo-browser-bar' }, el('span', { class: 'geo-dots', 'aria-hidden': 'true' }, '● ● ●'), el('span', {}, 'PRIVATE PREVIEW')),
      el('div', { class: `geo-cover${state.photos.length ? ' has-photo' : ''}` },
        state.photos.length ? el('img', { src: state.photos[0].url, alt: '선택한 가게 사진 미리보기' }) :
          el('div', { class: 'geo-cover-type', 'aria-hidden': 'true' }, el('span', {}, 'YOUR'), el('span', {}, 'PLACE.')),
        el('span', { class: 'geo-cover-badge' }, '비공개 시안')),
      el('div', { class: 'geo-site-content' },
        d.category.trim() ? el('span', { class: 'geo-category' }, d.category.trim()) : null,
        el('h3', { class: 'geo-site-name' }, d.name.trim() || '가게 이름 확인 필요'),
        d.address.trim() ? el('p', { class: 'geo-site-address' }, d.address.trim()) : null,
        el('p', { class: 'geo-site-disclaimer' }, state.fallback ? '검색된 후보가 없어 입력하신 이름과 주소로 시작한 시안이에요. 직접 추가하거나 수정한 내용도 확인해 주세요.' : '입력하거나 검색·수정한 정보예요. 실제와 다를 수 있으니 공개 전 확인해 주세요.'),
        anyFacts ? el('section', { class: 'geo-site-section' }, el('h4', {}, '이용 정보 · 미검증'), el('dl', { class: 'geo-facts' },
          d.address.trim() ? factRow('주소', d.address.trim()) : null, d.hours.trim() ? factRow('영업시간', d.hours.trim()) : null,
          d.phone.trim() ? factRow('연락처', d.phone.trim()) : null)) : null,
        menu.length ? el('section', { class: 'geo-site-section' }, el('h4', {}, '대표 상품 · 서비스 · 메뉴 · 미검증'),
          el('ul', { class: 'geo-menu' }, menu.map(item => el('li', {}, item)))) : null,
        highlights.length || channels.length ? el('section', { class: 'geo-site-section' }, el('h4', {}, '참고 정보'),
          el('p', { class: 'geo-small' }, '검색 응답 또는 사용자 수정 내용 · 사실 확인 필요'),
          highlights.length ? el('ul', { class: 'geo-highlights' }, highlights.map(item => el('li', {}, item))) : null,
          channels.length ? el('p', { class: 'geo-channels' }, '채널: ', channels.join(' · ')) : null) : null,
        faq.length ? el('section', { class: 'geo-site-section' }, el('h4', {}, '질문과 답변 예시 · 확인 필요'),
          el('p', { class: 'geo-small' }, '입력하거나 검색한 정보를 바탕으로 구성한 예시예요. 실제 내용과 맞는지 확인해 주세요.'),
          el('div', { class: 'geo-faq' }, faq.map(([question, answer]) => el('div', { class: 'geo-faq-item' },
            el('strong', {}, 'Q. ', question), el('p', {}, answer))))) : null,
        state.photos.length > 1 ? el('section', { class: 'geo-site-section' }, el('h4', {}, '사진'),
          el('div', { class: 'geo-gallery' }, state.photos.slice(1).map((photo, index) => el('img', { src: photo.url, alt: `선택한 가게 사진 ${index + 2}` })))) : null,
        el('div', { class: 'geo-site-footer' }, 'PRIVATE DRAFT · 실제 웹페이지가 아닙니다')));
  }
  function readiness() {
    const d = state.draft, keywords = deriveKeywords(d);
    const hasPrice = lineValues(d.menu).some(line => /(?:\d[\d,]*(?:\.\d+)?\s*(?:원|krw)|₩\s*[\d,]+|[·:]\s*[\d,]+)\s*$/iu.test(line));
    const missing = [!d.name.trim() && '가게 이름', !d.address.trim() && '주소', !d.category.trim() && '업종',
      !d.menu.trim() && '대표 상품·서비스·메뉴', !hasPrice && '가격', !d.hours.trim() && '영업시간', !d.phone.trim() && '연락처',
      !/주차/.test(d.highlights) && '주차 안내(해당 시)', !/예약/.test(d.highlights) && '예약 안내(해당 시)'].filter(Boolean);
    const title = [d.name.trim(), regionOf(d.address), d.category.trim()].filter(Boolean).join(' | ');
    const description = [d.name.trim(), d.address.trim(), d.category.trim(), ...lineValues(d.menu).slice(0, 2)].filter(Boolean).join(' · ');
    const sources = state.result.sources;
    return el('aside', { class: 'geo-readiness' },
      el('div', { class: 'geo-panel-head' }, el('span', { class: 'geo-kicker' }, 'GEO READINESS'), el('h3', {}, 'AI 검색을 위한 준비'),
        el('p', {}, '현재 정보로 만든 초안이에요. AI의 읽기·색인 여부나 검색 노출은 확인하지 않았습니다.')),
      el('div', { class: 'geo-readiness-block' }, el('strong', {}, '제안 키워드'),
        el('p', {}, '이름, 주소의 지역, 업종, 대표 상품·서비스·메뉴를 조합한 예시입니다. 검색량·인기나 노출을 보장하지 않아요.'),
        keywords.length ? el('div', { class: 'geo-keywords' }, keywords.map(word => el('span', {}, word))) : el('span', { class: 'geo-empty' }, '조합할 정보가 없어요.')),
      el('div', { class: 'geo-readiness-block' }, el('strong', {}, '제안 페이지 제목'), el('p', { class: 'geo-proposal' }, title || '정보 확인 필요'),
        el('strong', {}, '제안 페이지 설명'), el('p', { class: 'geo-proposal' }, description || '정보 확인 필요')),
      el('div', { class: 'geo-readiness-block' }, el('strong', {}, '추가 확인이 필요한 정보'),
        missing.length ? el('div', { class: 'geo-missing' }, missing.map(item => el('span', {}, `${item} 미입력·미확인`))) : el('p', {}, '기본 항목이 비어 있지 않아요. 내용이 정확한지는 별도 확인이 필요해요.')),
      el('div', { class: 'geo-readiness-block' }, el('strong', {}, '검색 응답의 참고 링크'),
        el('p', {}, '모델 응답이 제시한 링크입니다. 링크의 실제 내용이나 각 정보와의 일치 여부는 검증되지 않았어요.'),
        sources.length ? el('ul', { class: 'geo-sources' }, sources.map(source => el('li', {},
          el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.title || source.url)))) : el('span', { class: 'geo-empty' }, '표시할 유효한 링크가 없어요.'),
        el('p', { class: 'geo-source-date' }, `검색 응답 시각: ${displayTime(state.result.searchedAt)}${state.result.cached ? ' · 캐시된 응답' : ''}`)));
  }
  function previewView() {
    return el('div', {}, heading('04 · PREVIEW', '가게 소개 시안이 완성됐어요', '검색 정보는 미검증 상태예요. 실제 가게 정보와 다르면 선택적으로 수정해 주세요.'),
      el('div', { class: 'geo-preview-alert' }, el('strong', {}, '비공개 미리보기 · 공개 전 사실 확인 필요'),
        el('span', {}, '29,000원 결제, 실제 게시, AI 읽기·색인 확인 기능은 구현되지 않았습니다. 요금은 청구되지 않고 페이지도 공개되지 않아요.')),
      state.fallback ? el('div', { class: 'geo-warning' }, state.result.failed ? 'AI 검색을 완료하지 못해 입력한 이름·주소만으로 시작한 대체 시안입니다. 업종, 상품, 서비스, 가격 등을 추측하지 않았어요.' : '선택한 입력 정보로만 시작한 대체 시안입니다. 업종, 상품, 서비스, 가격 등을 추측하지 않았어요. 직접 추가한 내용은 확인해 주세요.') : null,
      el('div', { class: 'geo-preview-toolbar' }, el('div', {}, el('strong', {}, '내 가게 페이지'), el('p', {}, '아래는 디자인 미리보기이며 인터넷에 게시되지 않아요.')),
        button(state.editing ? '수정 닫기' : '정보 간단 수정', () => { state.editing = !state.editing; render(); }, 'secondary', { 'aria-expanded': state.editing ? 'true' : 'false' })),
      state.editing ? editPanel() : null,
      el('div', { class: 'geo-preview-layout' }, previewBusiness(), readiness()),
      el('div', { class: 'geo-actions' }, button('사진 다시 선택', () => go(2)), button('가게 다시 확인', () => go(1))));
  }
  function render() {
    if (destroyed) return;
    const header = el('div', { class: 'geo-header' }, el('div', { class: 'geo-brand' },
      el('span', { class: 'geo-brand-mark', 'aria-hidden': 'true' }, 'G'), el('span', {}, el('strong', {}, '가게 GEO 시안'), el('small', {}, 'BUSINESS PREVIEW'))),
      el('div', { class: 'geo-header-right' }, el('span', { class: 'geo-private' }, '비공개 미리보기'),
        typeof options.onBack === 'function' ? button('나가기', () => { destroy(); options.onBack(); }, 'link') : null));
    const intro = el('div', { class: 'geo-hero' }, el('div', { class: 'geo-hero-copy' },
      el('span', { class: 'geo-eyebrow' }, 'MAKE YOUR PLACE EASY TO DISCOVER'),
      el('h1', {}, '우리 가게를 위한', el('br'), '첫 번째 GEO 시안'),
      el('p', {}, '가게를 찾고, 확인하고, 나만의 소개 화면을 미리 살펴보세요.')),
      el('div', { class: 'geo-hero-badge' }, el('span', {}, 'PRIVATE DRAFT'), el('strong', {}, '가볍게 시작'), el('small', {}, '게시와 결제 없이 미리보기')));
    const progress = el('ol', { class: 'geo-progress', 'aria-label': '진행 단계' }, names.map((name, index) =>
      el('li', { class: `${index === state.step ? 'is-current' : ''}${index < state.step ? ' is-done' : ''}`, 'aria-current': index === state.step ? 'step' : null },
        el('span', {}, String(index + 1).padStart(2, '0')), el('b', {}, name))));
    const views = [searchView, resultView, photosView, previewView];
    const card = el('div', { class: `geo-card${state.step === 3 ? ' geo-card-preview' : ''}` }, views[state.step]());
    const footer = el('p', { class: 'geo-privacy-footer' }, '새로고침하거나 나가면 시안과 선택 사진이 사라집니다. 브라우저에 영구 저장하지 않아요. 검색 시 입력 내용 중 동의한 가게 이름과 주소만 전송되며, 검색 결과는 서버에 최대 3일 보관될 수 있습니다.');
    root.replaceChildren(header, intro, progress, card, footer);
  }
  container.replaceChildren(root);
  activeMounts.set(container, destroy);
  render();
  return { destroy };
}
