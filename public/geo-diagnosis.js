/*
 * Standalone public-information and website GEO diagnosis.
 * Host: load geo-diagnosis.css and import mountGeoDiagnosis.
 * mountGeoDiagnosis(container, { onBack?, request? }) -> { destroy() }.
 * request(payload) resolves to the API's parsed JSON object. Without an injected
 * request, an explicit, consented form submission makes one POST to the API.
 * destroy() detaches the view; it does not cancel an already-sent request.
 */
const mounts = new WeakMap();
let mountSequence = 0;

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = String(value);
    else if (name === 'value') node.value = String(value);
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Display supplied strings as-is, rather than rewriting the API's evidence.
function textOrUnknown(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '확인 불가';
}
function fieldValue(value) {
  if (!Array.isArray(value)) return element('span', { text: textOrUnknown(value) });
  if (!value.length) return element('span', { text: '확인 불가' });
  return element('ul', { class: 'gd-value-list' }, value.map(item => element('li', { text: textOrUnknown(item) })));
}
function safeUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return '';
    return parsed.href;
  } catch { return ''; }
}
function sourceLink(source, label = '출처') {
  const title = textOrUnknown(source?.title);
  const url = safeUrl(source?.url);
  if (!url) return element('span', { class: 'gd-source-missing', text: title === '확인 불가' ? label + ' 확인 불가' : label + ': ' + title + ' (주소 확인 불가)' });
  return element('a', { class: 'gd-source', href: url, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer', text: title === '확인 불가' ? label + ' 보기 (새 창)' : title + ' (새 창)' });
}
function section(id, number, title, description, ...children) {
  return element('section', { class: 'gd-section', 'aria-labelledby': id },
    element('div', { class: 'gd-section-head' },
      element('span', { class: 'gd-number', 'aria-hidden': 'true', text: number }),
      element('div', {}, element('h3', { id, text: title }), description ? element('p', { text: description }) : null)),
    ...children);
}
function empty(text = '확인 불가') { return element('p', { class: 'gd-empty', text }); }
function renderBusiness(business, id) {
  const data = business && typeof business === 'object' && !Array.isArray(business) ? business : {};
  const booking = data.priceHoursBooking && typeof data.priceHoursBooking === 'object' && !Array.isArray(data.priceHoursBooking) ? data.priceHoursBooking : {};
  const fields = [ ['상호', data.name], ['업종', data.category], ['주소', data.address], ['서비스 지역', data.serviceArea],
    ['상품·서비스', data.offerings], ['가격', booking.price], ['운영시간', booking.hours], ['예약', booking.booking], ['소개', data.description] ];
  const list = element('dl', { class: 'gd-details' }, fields.map(([label, value]) =>
    element('div', { class: 'gd-detail' }, element('dt', { text: label }), element('dd', {}, fieldValue(value)))));
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const sourceBlock = element('div', { class: 'gd-sources' }, element('strong', { text: '공개 정보 출처' }),
    sources.length ? element('ul', {}, sources.map(source => element('li', {}, sourceLink(source)))) : empty());
  return section(id, '01', '공개 정보 정리', '입력한 상호·주소와 미검증 공개 정보 검색 단서입니다. 검색 단서는 부정확하거나 같은 이름의 다른 업체 정보가 섞여 있을 수 있으니 출처에서 확인해 주세요.', list, sourceBlock);
}
function renderTechnical(scan, submittedWebsite, id) {
  const data = scan && typeof scan === 'object' && !Array.isArray(scan) ? scan : {};
  const items = Array.isArray(data.items) ? data.items : [];
  const body = element('div', { class: 'gd-tech-body' });
  if (!submittedWebsite) {
    body.append(element('p', { class: 'gd-note', text: items.length
      ? '공식 웹사이트를 입력하지 않아 해당 사이트 점검을 요청하지 않았습니다. 아래 항목과 상태는 서버가 반환한 내용입니다.'
      : '공식 웹사이트를 입력하지 않아 웹사이트를 점검하지 않았습니다.' }));
  } else if (!items.length) {
    body.append(element('p', { class: 'gd-note', text: '웹사이트를 입력했지만 점검 결과를 확인할 수 없습니다. 점검의 실제 수행 여부는 응답만으로 알 수 없습니다.' }));
  }
  if (data.targetUrl) body.append(element('p', { class: 'gd-target' }, element('strong', { text: '응답에 표시된 대상: ' }), sourceLink({ title: textOrUnknown(data.targetUrl), url: data.targetUrl }, '대상 주소')));
  if (items.length) {
    const meanings = { present: '해당 항목 확인', absent: '해당 항목 없음 또는 미발견', blocked: '접근이 차단되어 확인 불가', unknown: '확인 불가' };
    const table = element('table', { class: 'gd-table' },
      element('caption', { text: '웹사이트 점검 항목과 확인 결과, 근거 및 개선할 내용' }),
      element('thead', {}, element('tr', {}, ['점검 항목', '확인 결과', '근거', '개선할 내용'].map(label => element('th', { scope: 'col', text: label })))),
      element('tbody', {}, items.map(item => {
        const row = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
        return element('tr', {},
          element('th', { scope: 'row', text: textOrUnknown(row.label) }),
          element('td', {}, element('span', { class: 'gd-status-text', text: textOrUnknown(row.status) }),
            typeof row.status === 'string' && Object.hasOwn(meanings, row.status) ? element('span', { class: 'gd-status-meaning', text: meanings[row.status] }) : null),
          element('td', {}, element('span', { text: textOrUnknown(row.evidence) }), row.sourceUrl ? element('div', { class: 'gd-row-source' }, sourceLink({ title: '근거 출처', url: row.sourceUrl })) : null),
          element('td', { text: textOrUnknown(row.improvement) }));
      })));
    body.append(element('p', { class: 'gd-scroll-hint', text: '표를 좌우로 움직여 전체 내용을 확인할 수 있습니다.' }),
      element('div', { class: 'gd-table-wrap', tabindex: '0', role: 'region', 'aria-label': '웹사이트 점검 결과 표, 좌우로 스크롤 가능' }, table));
  } else if (submittedWebsite) body.append(empty());
  return section(id, '02', '공식 웹사이트 점검', '공개 정보 검색 단서와 별도로, 서버가 전달한 기술 점검 항목과 상태 원문을 보여드립니다. 각 항목의 근거를 함께 확인해 주세요.', body);
}
function renderQuestions(questions, id, notice, method) {
  const items = Array.isArray(questions) ? questions.slice(0, 5) : [];
  const isTemplate = method === 'template' || (typeof notice === 'string' && notice.includes('규칙 기반 템플릿'));
  const title = isTemplate ? '예상 질문' : 'AI가 제안한 예상 질문';
  const description = isTemplate ? '서버 안내에 따르면 규칙 기반으로 만든 예시이며, AI 생성 질문이나 실제 사용자 질문은 아닙니다.' : 'AI가 제안한 예시 질문으로, 실제 사용자 질문이나 AI의 답변 결과는 아닙니다.';
  return section(id, '03', title, description,
    items.length ? element('ol', { class: 'gd-questions' }, items.map(question => element('li', { text: textOrUnknown(question) }))) : empty());
}
function renderCompetitors(competitors, id) {
  const items = Array.isArray(competitors) ? competitors.slice(0, 3) : [];
  return section(id, '04', '비교할 업체', '비교 대상으로 제시된 업체입니다. 실제 AI 답변에서 추천되었다는 뜻은 아닙니다.',
    items.length ? element('ul', { class: 'gd-cards' }, items.map(item => {
      const data = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      return element('li', { class: 'gd-card' },
        element('div', { class: 'gd-card-title' }, element('h4', { text: textOrUnknown(data.name) }), element('span', { class: 'gd-region', text: textOrUnknown(data.region) })),
        element('p', {}, element('strong', { text: '비교 이유 ' }), element('span', { text: textOrUnknown(data.reason) })),
        element('div', { class: 'gd-card-source' }, sourceLink(data.source)));
    })) : empty());
}
function renderPriorities(priorities, id) {
  const items = Array.isArray(priorities) ? priorities.slice(0, 3) : [];
  return section(id, '05', '우선 개선할 과제', '전달된 문제와 불편, 실행 방안을 확인해 주세요.',
    items.length ? element('ol', { class: 'gd-priorities' }, items.map(item => {
      const data = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      return element('li', { class: 'gd-priority' }, element('h4', { text: textOrUnknown(data.problem) }),
        element('p', {}, element('strong', { text: '예상되는 불편 ' }), element('span', { text: textOrUnknown(data.inconvenience) })),
        element('p', {}, element('strong', { text: '실행 방안 ' }), element('span', { text: textOrUnknown(data.action) })));
    })) : empty());
}
function renderResults(data, submittedWebsite, prefix) {
  const heading = element('h2', { id: prefix + '-results-title', tabindex: '-1', text: '진단 결과' });
  const result = element('div', { class: 'gd-results', 'aria-labelledby': prefix + '-results-title' },
    element('div', { class: 'gd-results-intro' }, element('div', {}, element('p', { class: 'gd-kicker', text: 'DIAGNOSIS REPORT' }), heading,
      element('p', { text: '공개 정보의 정확성과 출처를 직접 확인해 주세요.' })),
      element('p', { class: 'gd-date' }, element('strong', { text: '기록된 시각 ' }), element('span', { text: textOrUnknown(data.scannedAt) }))),
    renderBusiness(data.business, prefix + '-business'), renderTechnical(data.technicalScan, submittedWebsite, prefix + '-technical'),
    renderQuestions(data.suggestedQuestions, prefix + '-questions', data.notice, data.suggestedQuestionsMethod), renderCompetitors(data.competitors, prefix + '-competitors'), renderPriorities(data.priorities, prefix + '-priorities'),
    element('aside', { class: 'gd-disclaimer', 'aria-label': '진단 결과 안내' },
      element('strong', { text: '결과를 활용하기 전 확인해 주세요' }),
      element('p', { text: textOrUnknown(data.notice) }),
      element('p', { text: '진단 결과는 참고 자료이며 부정확하거나 최신 정보와 다를 수 있습니다. 실제 AI 답변에 업체가 나타나는지와 그 내용은 별도 측정이 필요하며, 이 진단으로 보장할 수 없습니다.' })));
  return { result, heading };
}
const inputErrorMessages = Object.freeze({
  CONSENT_REQUIRED: '공개 정보 검색과 외부 AI 처리에 동의해 주세요.',
  BAD_INPUT: '상호명과 주소를 확인해 주세요.',
  UNEXPECTED_FIELD: '상호명, 주소와 선택한 홈페이지 주소만 입력해 주세요. 사진은 보낼 수 없습니다.',
  INPUT_LENGTH: '상호명 또는 주소가 너무 깁니다. 입력 내용을 줄여 주세요.',
  NAME: '상호명을 확인해 주세요.', ADDRESS: '가게 주소를 확인해 주세요.',
  WEBSITE: '인증 정보가 없는 공개 홈페이지 도메인 주소를 확인해 주세요. 주소의 쿼리 문자열과 # 부분은 제외해 주세요.',
  TOO_LARGE: '보낸 내용이 너무 깁니다. 입력 내용을 줄여 주세요.'
});
async function apiRequest(payload) {
  const response = await fetch('/api/geo-diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) {
    let code;
    if (response.status >= 400 && response.status < 500) {
      try { const body = await response.json(); code = body?.code; } catch { /* unrecognized error */ }
    }
    const failure = new Error('Diagnosis request failed');
    if (typeof code === 'string' && Object.hasOwn(inputErrorMessages, code)) failure.code = code;
    throw failure;
  }
  return response.json();
}

export function mountGeoDiagnosis(container, options = {}) {
  if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('A container element is required');
  if (!options || typeof options !== 'object') throw new TypeError('Options must be an object');
  if (options.request !== undefined && typeof options.request !== 'function') throw new TypeError('request must be a function');
  if (options.onBack !== undefined && typeof options.onBack !== 'function') throw new TypeError('onBack must be a function');
  mounts.get(container)?.destroy();
  const prefix = 'gd-' + (++mountSequence);
  const request = options.request || apiRequest;
  let pending = false;
  let destroyed = false;
  const name = element('input', { id: prefix + '-name', name: 'name', type: 'text', autocomplete: 'organization', maxlength: '60', required: true, placeholder: '예: 매출올려드림 카페' });
  const address = element('input', { id: prefix + '-address', name: 'address', type: 'text', autocomplete: 'street-address', maxlength: '120', required: true, placeholder: '예: 서울특별시 강남구 테헤란로 1' });
  const website = element('input', { id: prefix + '-website', name: 'website', type: 'url', inputmode: 'url', autocomplete: 'url', maxlength: '2048', placeholder: 'https://example.com', 'aria-describedby': prefix + '-website-help' });
  const consent = element('input', { id: prefix + '-consent', name: 'consent', type: 'checkbox', required: true, 'aria-describedby': prefix + '-consent-detail' });
  const error = element('div', { class: 'gd-error', role: 'alert', hidden: true });
  const status = element('div', { class: 'gd-live', role: 'status', 'aria-live': 'polite' });
  const submit = element('button', { class: 'gd-submit', type: 'submit', text: '진단 시작하기' });
  // This is a public-information analysis. No image input is requested or used.
  const fields = element('fieldset', { class: 'gd-fields' }, element('legend', { class: 'gd-sr-only', text: '가게 정보와 동의' }),
    element('div', { class: 'gd-form-grid' },
      element('div', { class: 'gd-field' }, element('label', { for: prefix + '-name' }, '상호명 ', element('span', { class: 'gd-required', text: '필수' })), name),
      element('div', { class: 'gd-field' }, element('label', { for: prefix + '-address' }, '가게 주소 ', element('span', { class: 'gd-required', text: '필수' })), address),
      element('div', { class: 'gd-field gd-field-wide' }, element('label', { for: prefix + '-website' }, '공식 웹사이트 ', element('span', { class: 'gd-optional', text: '선택' })), website,
        element('p', { id: prefix + '-website-help', class: 'gd-help', text: 'http:// 또는 https://부터 입력해 주세요. 입력하지 않으면 사이트는 점검하지 않습니다.' }))),
    element('div', { class: 'gd-consent' }, element('div', { class: 'gd-check' }, consent,
      element('label', { for: prefix + '-consent', text: '[필수] 공개 정보 검색과 외부 AI 전송 및 웹사이트 점검에 동의합니다.' })),
      element('p', { id: prefix + '-consent-detail', text: '상호명·주소와 검색 단서, 입력한 홈페이지 주소 및 기술 점검 결과가 AI 분석을 위해 OpenRouter와 Claude로 전달됩니다. 공개 정보 검색 시 일부 정보는 검색 제공업체에도 전달될 수 있습니다. 입력 정보 또는 검색 결과는 서비스 제공자나 검색 제공업체에 의해 캐시될 수 있으며, 진단 결과는 서버에 최대 3일 저장될 수 있습니다. 입력한 경우 해당 웹사이트를 점검합니다.' })),
    error, submit);
  const form = element('form', { class: 'gd-form', novalidate: true },
    element('div', { class: 'gd-form-head' }, element('p', { class: 'gd-kicker', text: 'START HERE' }), element('h2', { text: '가게 정보 입력' }), element('p', { text: '상호명과 주소만 입력해 주세요. 사진은 필요하지 않으며, 진단에 불필요한 개인정보는 입력하지 마세요.' })), fields, status);
  const results = element('div', { class: 'gd-results-mount' });
  const back = typeof options.onBack === 'function' ? element('button', { class: 'gd-back', type: 'button', text: '← 돌아가기' }) : null;
  const root = element('div', { class: 'gd-root' },
    element('div', { class: 'gd-topline' }, element('span', { class: 'gd-brand', text: '매출올려드림 AI' }), back),
    element('header', { class: 'gd-hero' }, element('div', { class: 'gd-hero-copy' },
      element('p', { class: 'gd-eyebrow', text: 'PUBLIC INFO + WEBSITE' }), element('h1', { text: '우리 가게, AI가 찾기 쉬울까요?' }),
      element('p', { text: '공개된 가게 정보와 웹사이트를 살펴보고, 더 명확하게 전달할 수 있는 부분을 확인해 보세요.' })),
      element('div', { class: 'gd-hero-aside', 'aria-hidden': 'true' }, element('span', { text: 'GEO' }), element('strong', { text: '공개 정보 진단' }), element('small', { text: '더 잘 전달되는 가게 정보' }))), form, results);
  container.replaceChildren(root);
  const setError = message => { error.textContent = message; error.hidden = !message; };
  async function onSubmit(event) {
    event.preventDefault();
    if (pending || destroyed) return;
    setError('');
    const businessName = name.value.trim(), businessAddress = address.value.trim(), submittedWebsite = website.value.trim();
    if (!businessName) { setError('상호명을 입력해 주세요.'); name.focus(); return; }
    if (!businessAddress) { setError('가게 주소를 입력해 주세요.'); address.focus(); return; }
    if (businessName.length > 60) { setError('상호명은 60자 이내로 입력해 주세요.'); name.focus(); return; }
    if (businessAddress.length > 120) { setError('주소는 120자 이내로 입력해 주세요.'); address.focus(); return; }
    if (submittedWebsite.length > 2048) { setError('홈페이지 주소는 2048자 이내로 입력해 주세요.'); website.focus(); return; }
    if (submittedWebsite && !safeUrl(submittedWebsite)) { setError('웹사이트 주소는 http:// 또는 https://로 시작하는 올바른 주소를 입력해 주세요.'); website.focus(); return; }
    if (!consent.checked) { setError('공개 정보 검색과 외부 AI 전송 및 웹사이트 점검에 동의해 주세요.'); consent.focus(); return; }
    const payload = { consent: true, name: businessName, address: businessAddress };
    if (submittedWebsite) payload.website = submittedWebsite;
    pending = true; fields.disabled = true; submit.textContent = '진단 중…';
    results.setAttribute('aria-busy', 'true'); results.replaceChildren();
    status.textContent = '진단 요청을 처리하고 있습니다. 화면을 떠나도 이미 전송된 요청이 중단된다고 보장할 수 없습니다.';
    try {
      const response = await request(payload);
      if (destroyed) return;
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid response');
      const rendered = renderResults(response, submittedWebsite, prefix);
      results.replaceChildren(rendered.result);
      status.textContent = '진단 결과가 준비되었습니다. 출처와 내용을 확인해 주세요.';
      rendered.heading.focus();
    } catch (failure) {
      if (destroyed) return;
      status.textContent = '';
      const safeCode = typeof failure?.code === 'string' && Object.hasOwn(inputErrorMessages, failure.code) ? failure.code : '';
      setError(safeCode ? inputErrorMessages[safeCode] + ' 입력 내용은 그대로 유지됩니다.' : '요청을 완료하지 못해 결과를 확인할 수 없습니다. 입력 내용은 그대로 유지됩니다. 서버나 외부 서비스가 이미 요청을 처리했거나 비용이 발생했을 수 있으며, 다시 시도하면 새 요청이 전송됩니다.');
    } finally {
      pending = false;
      if (!destroyed) { fields.disabled = false; submit.textContent = '진단 시작하기'; results.setAttribute('aria-busy', 'false'); }
    }
  }
  const onBack = () => { if (!destroyed && options.onBack) options.onBack(); };
  form.addEventListener('submit', onSubmit);
  if (back) back.addEventListener('click', onBack);
  const instance = { destroy() {
    if (destroyed) return;
    destroyed = true;
    form.removeEventListener('submit', onSubmit);
    if (back) back.removeEventListener('click', onBack);
    if (root.parentNode === container) root.remove();
    if (mounts.get(container) === instance) mounts.delete(container);
  } };
  mounts.set(container, instance);
  return instance;
}
