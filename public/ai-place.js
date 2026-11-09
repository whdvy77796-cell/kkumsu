/*
 * AI 가게 소개 페이지: 서버 호출 없이 브라우저에서만 작동하는 독립 시안.
 * Usage: const instance = mountAiPlace(container, { onBack });
 * Call instance.destroy() before the host removes/replaces the mounted view.
 */
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
let mountSequence = 0;

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
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
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Mount a private, local-only survey and website draft.
 * @param {Element} container Element to own the module; its children are replaced.
 * @param {{onBack?: () => void}} options onBack is called after cleanup, if supplied.
 * @returns {{destroy: () => void}} Releases local photo object URLs and removes the view.
 */
export function mountAiPlace(container, options = {}) {
  if (!container || typeof container.replaceChildren !== 'function') {
    throw new TypeError('mountAiPlace requires a container element');
  }
  const instanceId = `ap-${++mountSequence}`;
  const root = element('section', { class: 'ap-root', 'aria-label': 'AI 가게 소개 시안 만들기' });
  const data = {
    name: '', address: '', category: '', area: '', keywords: '', highlight: '',
    menu: '', hours: '', parking: '', reservations: '', contact: '',
    faq: [{ question: '', answer: '' }], photos: [], rights: false,
  };
  const steps = [
    { label: '가게 기본 정보', short: '기본 정보' },
    { label: '검색어와 소개', short: '검색과 소개' },
    { label: '이용 정보와 FAQ', short: '이용 정보' },
    { label: '사진과 확인', short: '사진' },
    { label: '완성 시안', short: '시안 보기' },
  ];
  let step = 0;
  let error = '';
  let destroyed = false;
  let focusAfterRender = false;

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const photo of data.photos) URL.revokeObjectURL(photo.url);
    data.photos = [];
    root.remove();
  }
  function go(next) {
    if (destroyed) return;
    step = next;
    error = '';
    focusAfterRender = true;
    render();
  }
  function valueField(key, label, settings = {}) {
    const id = `${instanceId}-${key}`;
    const labelNode = element('label', { class: 'ap-field', for: id });
    const top = element('span', { class: 'ap-label' }, label,
      settings.required ? element('span', { class: 'ap-required' }, '필수') : element('span', { class: 'ap-optional' }, '선택'));
    const attrs = {
      id, name: key, placeholder: settings.placeholder || '', maxlength: settings.maxlength || 400,
      value: data[key], required: Boolean(settings.required),
      on: { input: (event) => { data[key] = event.currentTarget.value; } },
    };
    const input = settings.multiline
      ? element('textarea', { ...attrs, rows: settings.rows || 3 })
      : element('input', { ...attrs, type: 'text', autocomplete: 'off' });
    labelNode.append(top, input);
    if (settings.hint) labelNode.append(element('span', { class: 'ap-hint' }, settings.hint));
    return labelNode;
  }
  function heading(kicker, title, subtitle) {
    return element('div', { class: 'ap-section-head' },
      element('span', { class: 'ap-kicker' }, kicker),
      element('h2', { class: 'ap-section-title', tabindex: '-1' }, title),
      element('p', { class: 'ap-section-subtitle' }, subtitle));
  }
  function basics() {
    return [heading('STEP 01', '어떤 가게를 소개할까요?', '가게를 찾는 분이 알아볼 수 있도록 기본 정보를 알려주세요.'),
      element('div', { class: 'ap-fields' },
        valueField('name', '가게 이름', { required: true, placeholder: '예: 오늘의 빵집', maxlength: 100 }),
        valueField('address', '가게 주소', { required: true, placeholder: '예: 서울시 마포구 ○○로 12', maxlength: 200 }),
        element('div', { class: 'ap-field-grid' },
          valueField('category', '업종', { required: true, placeholder: '예: 카페, 네일숍, 학원', maxlength: 80 }),
          valueField('area', '주로 이용하는 지역', { placeholder: '예: 망원동, 마포구', maxlength: 150,
            hint: '방문 또는 서비스 가능 지역을 적어주세요.' }))),
      element('div', { class: 'ap-inline-note' }, element('span', { class: 'ap-note-mark', 'aria-hidden': 'true' }, 'i'),
        element('p', {}, '주소는 공개 시안에 표시될 수 있어요. 공개해도 되는 가게 주소만 입력해 주세요.'))];
  }
  function story() {
    return [heading('STEP 02', '가게의 매력을 들려주세요', '직접 알려주신 내용만 소개 시안에 담아요.'),
      element('div', { class: 'ap-fields' },
        valueField('keywords', '찾고 싶은 검색어', { placeholder: '예: 망원동 수제 빵, 비건 베이커리', maxlength: 300,
          hint: '쉼표로 구분해 적어주세요. 시안 편집 참고용이며 노출 결과를 보장하지 않아요.' }),
        valueField('highlight', '꼭 소개하고 싶은 점', { multiline: true, rows: 5, maxlength: 800,
          placeholder: '예: 매일 아침 직접 반죽하고, 계절 재료로 빵을 만들어요.',
          hint: '실제 가게에 해당하는 내용만 자유롭게 적어주세요.' })),
      element('div', { class: 'ap-tip-card' },
        element('span', { class: 'ap-tip-icon', 'aria-hidden': 'true' }, '✦'),
        element('div', {}, element('strong', {}, '이렇게 적으면 좋아요'),
          element('p', {}, '가게의 특징이나 고객에게 알리고 싶은 점을 사장님의 말로 적어주세요. 없는 사실을 자동으로 만들어 넣지 않아요.')))];
  }
  function faqField(index, key, label, placeholder) {
    const id = `${instanceId}-faq-${index}-${key}`;
    const attrs = {
      id, maxlength: key === 'question' ? 180 : 600,
      placeholder, value: data.faq[index][key],
      on: { input: (event) => { data.faq[index][key] = event.currentTarget.value; } },
    };
    return element('label', { class: 'ap-field ap-faq-field', for: id },
      element('span', { class: 'ap-label' }, label),
      key === 'answer' ? element('textarea', { ...attrs, rows: 2 }) : element('input', { ...attrs, type: 'text' }));
  }
  function facts() {
    const faqRows = data.faq.map((entry, index) => element('div', { class: 'ap-faq-editor' },
      element('div', { class: 'ap-faq-top' }, element('strong', {}, `질문 ${index + 1}`),
        data.faq.length > 1 ? button('삭제', 'ap-text-button', () => { data.faq.splice(index, 1); render(); }) : null),
      faqField(index, 'question', '질문', '예: 예약이 필요한가요?'),
      faqField(index, 'answer', '답변', '고객에게 안내할 실제 답변을 적어주세요.')));
    return [heading('STEP 03', '방문 전 궁금한 정보를 알려주세요', '적은 항목만 시안에 표시해요. 운영 정보는 언제든 수정할 수 있어요.'),
      element('div', { class: 'ap-fields' },
        valueField('menu', '메뉴 · 서비스와 가격', { multiline: true, rows: 3, maxlength: 1000,
          placeholder: '예: 아메리카노 4,500원\n크루아상 3,800원' }),
        element('div', { class: 'ap-field-grid' },
          valueField('hours', '영업시간 · 휴무', { multiline: true, rows: 3, maxlength: 400, placeholder: '예: 화~일 10:00~19:00\n월요일 휴무' }),
          valueField('parking', '주차 안내', { multiline: true, rows: 3, maxlength: 400, placeholder: '예: 매장 앞 2대 주차 가능' })),
        element('div', { class: 'ap-field-grid' },
          valueField('reservations', '예약 안내', { multiline: true, rows: 2, maxlength: 400, placeholder: '예: 전화로 예약 가능' }),
          valueField('contact', '공개 연락처', { maxlength: 150, placeholder: '예: 02-000-0000',
            hint: '외부에 공개해도 되는 연락처만 적어주세요.' }))),
      element('div', { class: 'ap-faq-heading' }, element('div', {}, element('h3', {}, '자주 묻는 질문'),
        element('p', {}, '선택 항목이에요. 질문과 답변을 함께 적어주세요.'))),
      element('div', { class: 'ap-faq-list' }, faqRows),
      data.faq.length < 4 ? button('+ 질문 추가하기', 'ap-add-button', () => { data.faq.push({ question: '', answer: '' }); render(); }) : null];
  }
  function addPhotos(files) {
    error = '';
    const incoming = Array.from(files || []);
    if (!incoming.length) return;
    if (data.photos.length + incoming.length > MAX_PHOTOS) error = `사진은 최대 ${MAX_PHOTOS}장까지 선택할 수 있어요.`;
    else if (incoming.some((f) => !PHOTO_TYPES.has(f.type))) error = 'JPG, PNG, WebP 사진만 선택해 주세요.';
    else if (incoming.some((f) => f.size === 0 || f.size > MAX_PHOTO_BYTES)) error = '사진은 한 장당 5MB 이하의 파일만 선택할 수 있어요.';
    else if (data.photos.reduce((sum, p) => sum + p.file.size, 0) + incoming.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) error = '선택한 사진의 전체 크기는 12MB 이하여야 해요.';
    if (!error) {
      data.rights = false; // A changed photo selection needs a fresh rights confirmation.
      for (const file of incoming) data.photos.push({ file, url: URL.createObjectURL(file) });
    }
    render();
  }
  function photos() {
    const inputId = `${instanceId}-photos`;
    const consentId = `${instanceId}-rights`;
    return [heading('STEP 04', '가게 사진을 더해볼까요?', '사진 없이도 시안을 볼 수 있어요. 선택한 사진은 이 브라우저에서만 사용해요.'),
      element('label', { class: 'ap-upload', for: inputId },
        element('span', { class: 'ap-upload-icon', 'aria-hidden': 'true' }, '+'),
        element('strong', {}, '가게 사진 선택하기'),
        element('span', {}, 'JPG · PNG · WebP / 최대 4장'),
        element('small', {}, '한 장당 5MB 이하, 전체 12MB 이하')),
      element('input', { id: inputId, class: 'ap-file-input', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true,
        on: { change: (event) => addPhotos(event.currentTarget.files) } }),
      data.photos.length ? element('div', { class: 'ap-photo-grid' }, data.photos.map((photo, index) =>
        element('div', { class: 'ap-photo-item' },
          element('img', { src: photo.url, alt: `선택한 사진 ${index + 1}` }),
          button('사진 삭제', 'ap-photo-remove', () => {
            URL.revokeObjectURL(photo.url); data.photos.splice(index, 1); data.rights = false; render();
          }, { 'aria-label': `선택한 사진 ${index + 1} 삭제` }),
          element('span', { class: 'ap-photo-name' }, photo.file.name)))) : null,
      element('label', { class: 'ap-consent', for: consentId },
        element('input', { id: consentId, type: 'checkbox', checked: data.rights,
          on: { change: (event) => { data.rights = event.currentTarget.checked; } } }),
        element('span', {}, element('strong', {}, '사진을 사용할 권리가 있어요'),
          element('small', {}, '직접 촬영했거나 사용 허락을 받은 사진만 선택했습니다. 사진이 있을 때 확인해 주세요.'))),
      element('div', { class: 'ap-privacy' }, element('strong', {}, '개인정보와 권리를 지켜주세요'),
        element('p', {}, '타인의 얼굴·연락처 등 개인정보나 허락받지 않은 저작물은 넣지 마세요. 이 모듈은 입력 내용과 사진을 서버로 보내거나 저장하지 않아요. 새로고침하거나 나가면 내용이 사라져요.'))];
  }
  function button(label, className, action, attrs = {}) {
    return element('button', { type: 'button', class: className, ...attrs, on: { click: action } }, label);
  }
  function validate() {
    if (step === 0) {
      const missing = [['name', '가게 이름'], ['address', '가게 주소'], ['category', '업종']].find(([key]) => !data[key].trim());
      if (missing) { error = `${missing[1]}을(를) 입력해 주세요.`; return false; }
    }
    if (step === 2 && data.faq.some((entry) => Boolean(entry.question.trim()) !== Boolean(entry.answer.trim()))) {
      error = 'FAQ는 질문과 답변을 함께 적거나 둘 다 비워 주세요.'; return false;
    }
    if (step === 3 && data.photos.length && !data.rights) {
      error = '선택한 사진의 사용 권리 확인에 체크해 주세요.'; return false;
    }
    error = ''; return true;
  }
  function infoRow(label, value) {
    return element('div', { class: 'ap-preview-row' }, element('dt', {}, label), element('dd', {}, value));
  }
  function showDraft() {
    const photo = data.photos[0];
    const factsFilled = [data.hours, data.parking, data.reservations, data.contact].some((v) => v.trim());
    const faq = data.faq.filter((entry) => entry.question.trim() && entry.answer.trim());
    const extras = data.photos.slice(1);
    return [heading('YOUR PREVIEW', '우리 가게 소개 시안', '입력한 답변으로 자동 구성한 비공개 시안이에요. AI 모델은 호출하지 않으며, 정보는 언제든 수정할 수 있어요.'),
      element('div', { class: 'ap-preview-tools' },
        element('div', {}, element('span', { class: 'ap-live-dot', 'aria-hidden': 'true' }),
          element('strong', {}, '내 브라우저에서만 보이는 시안'),
          element('small', {}, '공개된 웹사이트가 아니에요')),
        button('정보 수정', 'ap-edit-button', () => go(0))),
      element('div', { class: 'ap-browser' },
        element('div', { class: 'ap-browser-bar' },
          element('div', { class: 'ap-browser-dots', 'aria-hidden': 'true' }, element('i'), element('i'), element('i')),
          element('span', {}, 'PRIVATE PREVIEW · 비공개 시안')),
        element('article', { class: 'ap-site' },
          element('div', { class: `ap-site-cover${photo ? ' has-photo' : ''}` },
            photo ? element('img', { src: photo.url, alt: '가게 대표 사진' }) : element('div', { class: 'ap-cover-art', 'aria-hidden': 'true' },
              element('span', {}, 'YOUR'), element('span', {}, 'PLACE'), element('i')),
            element('span', { class: 'ap-cover-badge' }, '가게 소개 시안')),
          element('div', { class: 'ap-site-content' },
            element('div', { class: 'ap-site-intro' },
              element('span', { class: 'ap-category' }, data.category.trim()),
              element('h3', {}, data.name.trim()),
              element('p', { class: 'ap-site-address' }, data.address.trim()),
              data.highlight.trim() ? element('p', { class: 'ap-site-highlight' }, data.highlight.trim()) : null),
            data.area.trim() ? element('section', { class: 'ap-site-section' }, element('h4', {}, '이용 지역'), element('p', { class: 'ap-preline' }, data.area.trim())) : null,
            data.menu.trim() ? element('section', { class: 'ap-site-section' }, element('h4', {}, '메뉴 · 서비스와 가격'), element('p', { class: 'ap-preline' }, data.menu.trim())) : null,
            factsFilled ? element('section', { class: 'ap-site-section' }, element('h4', {}, '방문 안내'),
              element('dl', { class: 'ap-preview-facts' },
                data.hours.trim() ? infoRow('영업시간', data.hours.trim()) : null,
                data.parking.trim() ? infoRow('주차', data.parking.trim()) : null,
                data.reservations.trim() ? infoRow('예약', data.reservations.trim()) : null,
                data.contact.trim() ? infoRow('연락처', data.contact.trim()) : null)) : null,
            extras.length ? element('section', { class: 'ap-site-section' }, element('h4', {}, '가게 사진'),
              element('div', { class: 'ap-site-gallery' }, extras.map((p, index) => element('img', { src: p.url, alt: `가게 사진 ${index + 2}` })))) : null,
            faq.length ? element('section', { class: 'ap-site-section' }, element('h4', {}, '자주 묻는 질문'),
              element('div', { class: 'ap-site-faq' }, faq.map((item) =>
                element('div', {}, element('strong', {}, 'Q. ', item.question.trim()), element('p', { class: 'ap-preline' }, item.answer.trim()))))) : null,
            element('div', { class: 'ap-site-footer' }, '이 화면은 입력한 정보로 만든 비공개 디자인 시안입니다.')))),
      element('div', { class: 'ap-preview-summary' },
        element('div', {}, element('strong', {}, '시안에 반영된 정보'), element('p', {}, '표시 내용이 정확한지 한 번 더 확인해 주세요.')),
        element('div', { class: 'ap-edit-links' },
          button('기본 정보 수정', 'ap-text-button', () => go(0)),
          button('소개 수정', 'ap-text-button', () => go(1)),
          button('이용 정보 수정', 'ap-text-button', () => go(2)),
          button('사진 수정', 'ap-text-button', () => go(3))),
        data.keywords.trim() ? element('p', { class: 'ap-keywords' }, element('strong', {}, '입력한 검색어 · 편집 참고용'), element('span', {}, data.keywords.trim())) : null),
      element('div', { class: 'ap-final-note' }, element('strong', {}, '정식 제작 예정가 29,000원'),
        element('span', {}, '정식 공개와 결제는 준비 중이에요. AI 읽기·색인 자동 확인도 아직 제공하지 않아요. 이 화면에서 결제하거나 공개할 수 없어요.'))];
  }
  function render() {
    if (destroyed) return;
    const back = typeof options.onBack === 'function' ? button('← 돌아가기', 'ap-back-link', () => { destroy(); options.onBack(); }) : null;
    const progress = element('div', { class: 'ap-progress', role: 'progressbar', 'aria-label': '시안 만들기 진행률',
      'aria-valuemin': '1', 'aria-valuemax': String(steps.length), 'aria-valuenow': String(step + 1),
      'aria-valuetext': `${steps.length}단계 중 ${step + 1}단계, ${steps[step].label}` },
      element('span', { class: 'ap-progress-fill', style: `width:${((step + 1) / steps.length) * 100}%` }));
    const content = [basics, story, facts, photos, showDraft][step]();
    const alert = element('div', { class: 'ap-error', role: 'alert', 'aria-live': 'assertive', ...(error ? {} : { hidden: true }) }, error);
    const next = step < 4 ? button(step === 3 ? '비공개 시안 보기' : '다음 단계', 'ap-button ap-button-primary', () => {
      if (validate()) go(step + 1); else { render(); root.querySelector('.ap-error')?.focus(); }
    }) : null;
    alert.setAttribute('tabindex', '-1');
    const previous = step > 0 ? button('이전', 'ap-button ap-button-secondary', () => go(step - 1)) : null;
    root.replaceChildren(
      element('header', { class: 'ap-header' },
        element('div', { class: 'ap-brand' }, element('span', { class: 'ap-brand-mark', 'aria-hidden': 'true' }, 'A'),
          element('div', {}, element('strong', {}, 'AI 가게 소개'), element('small', {}, 'by 매출올려드림 AI'))),
        element('div', { class: 'ap-header-actions' }, element('span', { class: 'ap-private-pill' }, '비공개 시안'), back)),
      element('div', { class: 'ap-hero' },
        element('div', {}, element('p', { class: 'ap-eyebrow' }, 'FOR YOUR BUSINESS'),
          element('h1', {}, '우리 가게를 소개하는', element('br'), '한 장의 페이지'),
          element('p', { class: 'ap-hero-description' }, '입력한 답변으로 자동 구성한 비공개 시안이에요. AI 모델은 호출하지 않아요.')),
        element('div', { class: 'ap-price-box' }, element('span', {}, '정식 제작 예정가'),
          element('strong', {}, '29,000', element('small', {}, '원')),
          element('p', {}, '정식 공개 · 결제 준비 중'))),
      element('div', { class: 'ap-layout' },
        element('aside', { class: 'ap-sidebar', 'aria-label': '작성 단계' },
          element('div', { class: 'ap-sidebar-label' }, '시안 만들기'),
          element('ol', { class: 'ap-step-list' }, steps.map((item, index) =>
            element('li', { class: `${index === step ? 'is-current' : ''}${index < step ? ' is-done' : ''}`, ...(index === step ? { 'aria-current': 'step' } : {}) },
              element('span', { class: 'ap-step-number' }, String(index + 1).padStart(2, '0')),
              element('span', {}, item.short)))),
          element('div', { class: 'ap-sidebar-note' }, '입력한 정보와 사진은', element('br'), '이 브라우저 안에서만 사용해요.')),
        element('div', { class: 'ap-card' },
          element('div', { class: 'ap-progress-label' }, element('span', {}, steps[step].label), element('strong', {}, `${step + 1} / ${steps.length}`)),
          progress, content, alert,
          step < 4 ? element('div', { class: 'ap-actions' }, previous, next) : element('div', { class: 'ap-actions ap-actions-last' }, previous))));
    container.replaceChildren(root);
    if (focusAfterRender) {
      root.querySelector('.ap-section-title')?.focus({ preventScroll: true });
      root.scrollIntoView({ block: 'start', behavior: 'auto' });
      focusAfterRender = false;
    }
  }
  render();
  return { destroy };
}
