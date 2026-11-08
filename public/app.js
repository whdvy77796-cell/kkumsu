// 매출올려드림 AI · 상호명·주소 → AI 가게 찾기 → 맞는지 확인 → 맞춤 설문 10문항
const view = document.getElementById('view');
const navbar = document.getElementById('navbar');
const navbarInner = document.getElementById('navbarInner');
const storeName = document.getElementById('storeName');
const toastEl = document.getElementById('toast');

// ───────── 화면 도우미
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  return append(el, children);
}
function clear(el) { el.replaceChildren(); return el; }
// 화면 본문을 통째로 바꾼다 (null·false는 건너뜀)
function show(...kids) { return append(clear(view), kids); }
let toastTimer;
function toast(msg, ms = 2800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
function setNavbar(...items) {
  const list = items.flat().filter(Boolean);
  append(clear(navbarInner), list);
  navbar.hidden = !list.length;
}
const btn = (label, onclick, primary = false) => h('button', { class: primary ? 'btn primary' : 'btn', type: 'button', onclick }, label);

// ───────── 상태 (이 브라우저에만 저장)
const KEY = 'maechul.v2';
const LIKERT = [[1, '전혀 그렇지 않다'], [2, '그렇지 않다'], [3, '보통이다'], [4, '그렇다'], [5, '매우 그렇다']];
let S = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* 저장 공간이 없으면 화면 상태만 유지 */ }
}
function chosenStore() {
  return Number.isInteger(S.chosen) && S.chosen >= 0 ? S.search?.result?.candidates?.[S.chosen] || null : null;
}

// ───────── 서버 호출
async function post(path, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 아래에서 처리 */ }
    if (!res.ok || !data) {
      const err = new Error(data?.error || `요청이 실패했어요. (${res.status})`);
      err.code = data?.code || `HTTP_${res.status}`;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('응답이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.');
      err.code = 'TIMEOUT';
      throw err;
    }
    if (e instanceof TypeError) {
      const err = new Error('인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
      err.code = 'NETWORK';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ───────── 화면 이동
let navSeq = 0;
function route() {
  navSeq++;
  const hash = location.hash || '#/';
  if (hash === '#/find') renderFind();
  else if (hash === '#/survey') renderSurvey();
  else if (hash === '#/done') renderDone();
  else renderHome();
}
window.addEventListener('hashchange', () => {
  route();
  window.scrollTo(0, 0);
});

function startTimer(el, tipEl, tips) {
  const started = Date.now();
  return setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    el.textContent = `${s}초`;
    if (tipEl) tipEl.textContent = tips[Math.floor(s / 10) % tips.length];
  }, 1000);
}

function showError(e, retry) {
  const stop = ['IP_QUOTA', 'DAILY_BUDGET', 'AI_CREDIT', 'AI_CONFIG', 'STORE_CONFIG', 'ORIGIN', 'NAME', 'ADDRESS', 'STORE'].includes(e.code);
  show(
    h('div', { class: 'card warn' },
      h('h2', null, '잠시 문제가 생겼어요'),
      h('p', null, e.message || '잠시 후 다시 시도해 주세요.'),
      h('p', { class: 'tiny muted' }, `오류 코드: ${e.code || '알 수 없음'}`)),
  );
  setNavbar(btn('처음으로', () => { location.hash = '#/'; }), stop ? null : btn('다시 시도', retry, true));
}

// ───────── 1. 첫 화면: 상호명·주소
function renderHome() {
  storeName.textContent = '';
  let nameIn;
  let addrIn;
  const hint = h('div', { class: 'hint', role: 'alert' },
    S.rejected ? '상호명이나 주소를 조금 더 자세히 적어 주세요. 지점명이나 도로명 주소를 넣으면 더 정확해요.' : '');
  const go = () => {
    const name = nameIn.value.trim().replace(/\s+/g, ' ');
    const address = addrIn.value.trim().replace(/\s+/g, ' ');
    if (!name) { hint.textContent = '상호명을 입력해 주세요.'; nameIn.focus(); return; }
    if (address.length < 4) { hint.textContent = '주소를 입력해 주세요. 동·도로명까지 적으면 더 정확해요.'; addrIn.focus(); return; }
    const same = S.name === name && S.address === address;
    if (same && S.search?.result && !S.rejected) { location.hash = '#/find'; return; }
    S = { name, address, refresh: same && !!S.rejected };
    save();
    location.hash = '#/find';
  };
  nameIn = h('input', { type: 'text', name: 'name', value: S.name || '', maxlength: 60, placeholder: '예: 골목분식', autocomplete: 'organization', enterkeyhint: 'next' });
  addrIn = h('input', { type: 'text', name: 'address', value: S.address || '', maxlength: 120, placeholder: '예: 서울 마포구 망원로 12', autocomplete: 'street-address', enterkeyhint: 'go' });
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addrIn.focus(); } });
  addrIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } });

  const resume = S.survey && S.name
    ? h('div', { class: 'card note' },
        h('b', null, S.doneAt ? '지난 설문 답변이 있어요' : '진행 중인 설문이 있어요'),
        h('p', { class: 'small', style: { margin: '4px 0 8px' } }, chosenStore()?.name || S.name),
        h('a', { class: 'btn small', href: S.doneAt ? '#/done' : '#/survey' }, S.doneAt ? '답변 보기' : '이어서 답하기'))
    : null;

  show(
    h('section', { class: 'hero' },
      h('h1', null, '우리 가게, 매출이 달라질 방법을 찾다!'),
      h('h2', { class: 'hero-sub' }, '우리 가게, 어디를 바꾸면 더 잘될까요?'),
      h('p', { class: 'hero-desc' }, '직접 가게를 운영한 5년의 경험과 실제 컨설팅 노하우를 담았습니다.'),
      h('p', { class: 'hero-trust' }, '가게에 대한 질문에 답하면, 수익 구조부터 메뉴·마케팅·운영까지 분석해 맞춤 보고서와 실행 전략을 제안합니다.')),
    resume,
    h('form', { class: 'card', id: 'startCard', novalidate: true, onsubmit: (e) => { e.preventDefault(); go(); } },
      h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, '첫 질문')),
      h('h2', null, '가게 이름과 주소를 알려주세요'),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, '상호명'), nameIn),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, '주소'), addrIn),
      h('p', { class: 'small muted' }, '다음을 누르면 AI(Claude)가 상호명과 주소로 인터넷에 공개된 가게 정보를 찾아요. 30초~1분쯤 걸려요.'),
      hint),
    h('div', { class: 'card' },
      h('h2', null, '이렇게 진행돼요'),
      h('ol', { class: 'steps-list' },
        h('li', null, h('b', null, '상호명·주소 입력 '), h('span', { class: 'muted small' }, '지금 이 화면')),
        h('li', null, h('b', null, 'AI가 가게 정보 찾기 '), h('span', { class: 'muted small' }, '지도·리뷰·SNS 등 인터넷 공개 정보 (30초~1분)')),
        h('li', null, h('b', null, '우리 가게가 맞는지 확인 '), h('span', { class: 'muted small' }, '아니면 다시 입력')),
        h('li', null, h('b', null, '맞춤 질문 10개 '), h('span', { class: 'muted small' }, '"전혀 그렇지 않다"부터 "매우 그렇다"까지 골라 답하기')))),
    h('div', { class: 'card note small' },
      h('b', null, '입력한 정보는 이렇게 쓰여요'),
      h('ul', { class: 'note-list' },
        h('li', null, '상호명과 주소는 가게 정보를 찾기 위해 OpenRouter를 거쳐 AI(Anthropic Claude)에 전달돼요.'),
        h('li', null, '같은 가게를 다시 찾을 때를 위해, 찾은 공개 정보는 서버에 3일 동안 임시 보관돼요.'),
        h('li', null, '설문 답변은 서버로 보내지 않고 이 브라우저에만 저장돼요.'))),
  );
  setNavbar(btn('다음', go, true));
}

// ───────── 2. AI 가게 찾기 → 맞는지 확인
const FIND_TIPS = [
  '지도, 리뷰, SNS에 올라온 정보를 살펴보고 있어요.',
  '같은 이름의 다른 가게와 헷갈리지 않게 주소를 맞춰 보고 있어요.',
  '메뉴와 가격, 손님 후기를 정리하고 있어요.',
  '거의 다 됐어요. 조금만 기다려 주세요.',
];

async function renderFind() {
  if (!S.name || !S.address) { location.replace('#/'); return; }
  storeName.textContent = S.name;
  if (S.search?.result) { showResult(S.search.result); return; }
  const seq = navSeq;
  const elapsed = h('span', { class: 'elapsed' }, '0초');
  const tip = h('p', { class: 'small muted' }, FIND_TIPS[0]);
  show(
    h('div', { class: 'card loading' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('h2', null, '가게 정보를 찾고 있어요'),
      h('p', null, h('b', null, S.name), h('br'), h('span', { class: 'muted' }, S.address)),
      h('p', { class: 'small' }, '인터넷에서 공개 정보를 찾는 중이에요. 보통 30초~1분 걸려요. ', elapsed),
      tip),
  );
  setNavbar(btn('그만 찾고 다시 입력', () => { location.hash = '#/'; }));
  const timer = startTimer(elapsed, tip, FIND_TIPS);
  try {
    const result = await post('/api/store-search', { name: S.name, address: S.address, refresh: !!S.refresh }, 190000);
    if (seq !== navSeq) return;
    S.search = { result };
    S.refresh = false;
    S.rejected = false;
    save();
    showResult(result);
  } catch (e) {
    if (seq !== navSeq) return;
    showError(e, () => route());
  } finally {
    clearInterval(timer);
  }
}

const MATCH = { high: '입력한 주소와 일치', medium: '비슷해요 · 확인 필요', low: '다른 가게일 수 있어요' };

function candidateCard(c, i, many) {
  const rows = [['주소', c.address], ['업종', c.category], ['전화', c.phone], ['영업시간', c.hours], ['가격대', c.priceRange], ['평점', c.rating], ['리뷰', c.reviewCount]]
    .filter(([, v]) => v);
  const section = (title, items) => (items?.length ? [h('div', { class: 'sub-title' }, title), h('ul', { class: 'plain-list' }, items.map((s) => h('li', null, s)))] : null);
  return h('div', { class: 'card cand' },
    h('h3', null, c.name),
    h('span', { class: `match ${c.matchLevel || 'low'}` }, MATCH[c.matchLevel] || MATCH.low),
    rows.length ? h('div', { class: 'kv' }, rows.map(([k, v]) => h('div', null, h('span', null, k), h('b', null, v)))) : null,
    c.menu?.length
      ? [h('div', { class: 'sub-title' }, '대표 메뉴'), h('div', { class: 'menu-chips' }, c.menu.map((m) => h('span', null, m.name, m.price ? h('small', null, m.price) : null)))]
      : null,
    section('손님들이 좋게 말하는 점', c.strengths),
    section('아쉽다는 의견', c.weaknesses),
    section('특징', c.features),
    c.channels?.length
      ? [h('div', { class: 'sub-title' }, '온라인 채널'), h('div', { class: 'links' }, c.channels.map((ch) => h('a', { href: ch.url, target: '_blank', rel: 'noopener noreferrer' }, ch.type)))]
      : null,
    c.matchReason ? h('p', { class: 'reason' }, `판단 근거: ${c.matchReason}`) : null,
    many ? h('div', { class: 'btn-row' }, h('button', { class: 'btn primary block', type: 'button', onclick: () => choose(i) }, '이 가게가 맞아요')) : null,
  );
}

function sourcesCard(r) {
  if (!r.sources?.length) return null;
  return h('div', { class: 'card note' },
    h('div', { class: 'sub-title', style: { marginTop: 0 } }, 'AI가 참고한 곳'),
    h('ol', { class: 'sources' }, r.sources.map((s) => h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title)))));
}

function choose(i) {
  S.chosen = i;
  S.survey = null;
  S.answers = {};
  S.doneAt = null;
  save();
  location.hash = '#/survey';
}
function reject() {
  S.rejected = true;
  S.search = null;
  delete S.chosen;
  save();
  location.hash = '#/';
}

function showResult(r) {
  const cands = r.candidates || [];
  if (!cands.length) {
    show(
      h('div', { class: 'card' },
        h('h2', null, '가게 정보를 찾지 못했어요'),
        h('p', null, r.notFoundReason || '인터넷에서 이 가게의 공개 정보를 찾지 못했어요.'),
        h('p', { class: 'small muted' }, '간판에 적힌 상호명 그대로, 지점명이나 도로명 주소를 넣으면 찾을 가능성이 높아요. 새로 연 가게라면 정보가 없을 수도 있어요.')),
      sourcesCard(r),
    );
    setNavbar(btn('다시 입력', reject), btn('정보 없이 질문 받기', () => choose(-1), true));
    return;
  }
  const many = cands.length > 1;
  show(
    h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, 'AI가 찾은 가게'), r.cached ? h('span', { class: 'tiny muted' }, '최근에 찾은 결과') : null),
    h('h2', null, many ? '이 중에 우리 가게가 있나요?' : '이 가게가 맞나요?'),
    h('p', { class: 'small muted' }, 'AI가 인터넷 공개 정보로 정리한 내용이에요. 틀리거나 오래된 정보가 있을 수 있어요.'),
    cands.map((c, i) => candidateCard(c, i, many)),
    sourcesCard(r),
  );
  setNavbar(btn(many ? '모두 아니에요' : '아니에요', reject), many ? null : btn('네, 맞아요', () => choose(0), true));
}

// ───────── 3. 맞춤 설문 10문항
async function renderSurvey() {
  if (!S.name || !Number.isInteger(S.chosen)) { location.replace('#/'); return; }
  const store = chosenStore();
  storeName.textContent = store?.name || S.name;
  if (!S.survey) {
    const seq = navSeq;
    const elapsed = h('span', { class: 'elapsed' }, '0초');
    show(
      h('div', { class: 'card loading' },
        h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        h('h2', null, '맞춤 질문을 만들고 있어요'),
        h('p', { class: 'small' }, '찾은 정보를 바탕으로 우리 가게에 맞는 질문 10개를 고르는 중이에요. 보통 10~30초 걸려요. ', elapsed)),
    );
    setNavbar(btn('이전', () => { location.hash = '#/find'; }));
    const timer = startTimer(elapsed);
    try {
      const survey = await post('/api/survey', { name: S.name, address: S.address, store }, 100000);
      if (seq !== navSeq) return;
      S.survey = survey;
      S.answers = {};
      save();
    } catch (e) {
      if (seq !== navSeq) return;
      showError(e, () => route());
      return;
    } finally {
      clearInterval(timer);
    }
  }
  showSurvey();
}

function showSurvey() {
  const sv = S.survey;
  const answers = (S.answers = S.answers || {});
  const total = sv.questions.length;
  const count = h('span', { class: 'navcount', 'aria-live': 'polite' });
  const update = () => { count.textContent = `${sv.questions.filter((q) => answers[q.id]).length}/${total}`; };

  const cards = sv.questions.map((q, i) => {
    const card = h('div', { class: 'card survey-q', id: `sq-${q.id}` });
    const group = h('div', { class: 'likert', role: 'group', 'aria-labelledby': `qt-${q.id}` });
    const buttons = LIKERT.map(([v, label]) => {
      const b = h('button', { type: 'button', class: answers[q.id] === v ? 'on' : '', 'aria-pressed': String(answers[q.id] === v) }, label);
      b.addEventListener('click', () => {
        answers[q.id] = v;
        save();
        for (const x of buttons) {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        }
        card.classList.remove('missing');
        update();
      });
      return b;
    });
    append(group, buttons);
    return append(card, [
      h('div', { class: 'qno' }, `${i + 1} / ${total}${q.area ? ` · ${q.area}` : ''}`),
      h('p', { class: 'qtext', id: `qt-${q.id}` }, q.text),
      group,
      q.why ? h('p', { class: 'why' }, q.why) : null,
    ]);
  });

  const finish = () => {
    const missing = sv.questions.filter((q) => !answers[q.id]);
    if (missing.length) {
      for (const q of missing) document.getElementById(`sq-${q.id}`)?.classList.add('missing');
      document.getElementById(`sq-${missing[0].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`아직 답하지 않은 문항이 ${missing.length}개 있어요.`);
      return;
    }
    S.doneAt = new Date().toISOString();
    save();
    location.hash = '#/done';
  };

  show(
    sv.insights?.length
      ? h('div', { class: 'card' },
          h('h2', null, 'AI가 살펴본 우리 가게'),
          h('ul', { class: 'insights' }, sv.insights.map((it) => h('li', null, it.title ? h('b', null, it.title) : null, it.detail))))
      : null,
    h('div', { class: 'card note' },
      h('h2', null, `맞춤 질문 ${total}개`),
      h('p', { class: 'small', style: { margin: 0 } }, '아래 문장이 우리 가게에 얼마나 맞는지 골라 주세요. 정답은 없어요. 지금 상황 그대로 답해 주시면 돼요.')),
    cards,
  );
  update();
  setNavbar(btn('이전', () => { location.hash = '#/find'; }), count, btn('제출하기', finish, true));
}

// ───────── 4. 완료
function renderDone() {
  const sv = S.survey;
  if (!sv || !S.doneAt) { location.replace(sv ? '#/survey' : '#/'); return; }
  const name = chosenStore()?.name || S.name;
  storeName.textContent = name;
  const label = (v) => LIKERT.find(([x]) => x === v)?.[1] || '-';
  show(
    h('div', { class: 'card' },
      h('h2', null, '설문을 마쳤어요'),
      h('p', null, `${name}에 대한 답변 ${sv.questions.length}개를 받았어요.`),
      h('p', { class: 'small muted', style: { margin: 0 } }, '답변은 이 브라우저에만 저장돼 있어요.')),
    h('div', { class: 'card' },
      h('h3', null, '내 답변'),
      h('ul', { class: 'answers' }, sv.questions.map((q, i) => h('li', null, h('span', null, `${i + 1}. ${q.text}`), h('span', { class: 'pick' }, label(S.answers?.[q.id])))))),
    h('div', { class: 'card note small' },
      h('b', null, '다음 단계 '),
      '이 답변과 AI가 찾은 정보를 바탕으로 맞춤 분석 보고서를 만드는 기능을 준비하고 있어요.'),
  );
  setNavbar(btn('답변 고치기', () => { location.hash = '#/survey'; }), btn('처음부터 다시', () => { S = {}; save(); location.hash = '#/'; }, true));
}

route();
