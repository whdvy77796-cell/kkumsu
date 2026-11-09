// 매출올려드림 AI · 상호명·주소 → AI 가게 찾기 → 맞는지 확인 → 가게 상황에 맞춘 인터뷰
import {
  PAGES, PROBLEMS, STATUS_LABEL, COST_RECORD_TIP,
  buildCtx, visiblePages, isAnswered, splitCheck, parseNum, resolve, answerText,
} from './questions.js';
import { buildSolutions, LEVEL } from './solutions.js';

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
// 앞으로 가는 주요 버튼에는 화살표(→)를 붙인다 (모양만, 글자는 그대로)
const GO_LABELS = ['다음', 'AI 보고서 만들기', '보고서 보기', '진행 상황 보기'];
const btn = (label, onclick, primary = false) => h('button', { class: primary ? (GO_LABELS.includes(label) ? 'btn primary go' : 'btn primary') : 'btn', type: 'button', onclick }, label);
const fmt = (n) => Number(n).toLocaleString('ko-KR');

// ───────── 상태 (이 브라우저에만 저장)
const KEY = 'maechul.v3';
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
  // 화면마다 넓이·배치를 다르게 하려고 body에 화면 이름을 남긴다 (home·find·survey·done·report)
  document.body.dataset.page = ({ '#/find': 'find', '#/survey': 'survey', '#/done': 'done', '#/report': 'report' })[hash] || 'home';
  if (hash === '#/find') renderFind();
  else if (hash === '#/survey') renderSurvey();
  else if (hash === '#/done') renderDone();
  else if (hash === '#/report') renderReport();
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

  const started = Number.isInteger(S.chosen) && S.answers && Object.keys(S.answers).length;
  const resume = started
    ? h('div', { class: 'card note resume' },
        h('b', null, S.doneAt ? '지난 진단 답변이 있어요' : '진행 중인 진단이 있어요'),
        h('p', { class: 'small', style: { margin: '4px 0 8px' } }, chosenStore()?.name || S.name),
        h('a', { class: 'btn small', href: S.doneAt ? '#/done' : '#/survey' }, S.doneAt ? '답변 보기' : '이어서 답하기'),
        S.doneAt && S.report?.data ? h('a', { class: 'btn small', href: '#/report', style: { marginLeft: '6px' } }, '보고서 보기') : null)
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
    h('div', { class: 'card steps-card' },
      h('h2', null, '이렇게 진행돼요'),
      h('ol', { class: 'steps-list' },
        h('li', null, h('b', null, '상호명·주소 입력 '), h('span', { class: 'muted small' }, '지금 이 화면')),
        h('li', null, h('b', null, 'AI가 가게 정보 찾기 '), h('span', { class: 'muted small' }, '지도·리뷰·SNS 등 인터넷 공개 정보 (30초~1분)')),
        h('li', null, h('b', null, '우리 가게가 맞는지 확인 '), h('span', { class: 'muted small' }, '아니면 다시 입력')),
        h('li', null, h('b', null, '가게 인터뷰 '), h('span', { class: 'muted small' }, '가장 큰 고민과 운영 방식에 맞춰 질문이 달라져요. AI가 찾은 정보는 미리 채워 두고, 모르는 건 "잘 모름"을 누르면 돼요.')),
        h('li', null, h('b', null, 'AI 진단 보고서 '), h('span', { class: 'muted small' }, '원할 때만, 동의 후에 만들어요. AI가 카카오맵·네이버·구글·블로그를 직접 찾아보고 답변과 합쳐 진단·솔루션·실행 계획을 만들어요 (2~4분)')))),
    h('div', { class: 'card note small privacy-card' },
      h('b', null, '입력한 정보는 이렇게 쓰여요'),
      h('ul', { class: 'note-list' },
        h('li', null, '상호명과 주소는 가게 정보를 찾기 위해 OpenRouter를 거쳐 AI(Anthropic Claude)에 전달돼요.'),
        h('li', null, '같은 가게를 다시 찾을 때를 위해, 찾은 공개 정보는 서버에 3일 동안 임시 보관돼요.'),
        h('li', null, '인터뷰 답변은 이 브라우저에 저장돼요. AI 진단 보고서를 만들 때만, 사장님이 동의하면 OpenRouter를 거쳐 AI(Anthropic Claude)에 전달돼요.'),
        h('li', null, '만든 보고서는 같은 답변으로 다시 열 때를 위해 서버에 하루 동안 보관했다가 자동으로 지워요.'))),
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
const TONE = { good: '좋음', bad: '아쉬움', mixed: '엇갈림' };

function servicesText(sv) {
  if (!sv) return null;
  const on = [sv.hall ? '홀' : null, sv.takeout ? '포장' : null, sv.delivery ? '배달' : null].filter(Boolean);
  const extra = sv.reservation ? ' · 예약 가능' : '';
  return on.length ? on.join(' · ') + extra : null;
}

function candidateCard(c, i, many) {
  const rows = [
    ['주소', c.address], ['업종', c.category], ['운영 기간', c.openedYear], ['위치', c.floor], ['전화', c.phone], ['영업시간', c.hours],
    ['판매 방식', servicesText(c.services)], ['가격대', c.priceRange], ['평점', c.rating], ['리뷰', c.reviewCount],
  ].filter(([, v]) => v);
  const section = (title, items) => (items?.length ? [h('div', { class: 'sub-title' }, title), h('ul', { class: 'plain-list' }, items.map((s) => h('li', null, s)))] : null);
  return h('div', { class: 'card cand' },
    h('h3', null, c.name),
    h('span', { class: `match ${c.matchLevel || 'low'}` }, MATCH[c.matchLevel] || MATCH.low),
    rows.length ? h('div', { class: 'kv' }, rows.map(([k, v]) => h('div', null, h('span', null, k), h('b', null, v)))) : null,
    c.menu?.length
      ? [h('div', { class: 'sub-title' }, '대표 메뉴'), h('div', { class: 'menu-chips' }, c.menu.map((m) => h('span', null, m.name, m.price ? h('small', null, m.price) : null)))]
      : null,
    c.reviewThemes?.length
      ? [h('div', { class: 'sub-title' }, '리뷰 경향'), h('div', { class: 'theme-chips' }, c.reviewThemes.map((t) => h('span', { class: `tone-${t.tone}`, title: t.note || '' }, `${t.theme} ${TONE[t.tone] || ''}`)))]
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
  S.answers = {};
  S.pageId = PAGES[0].id;
  S.doneAt = null;
  save();
  location.hash = '#/survey';
}
function reject() {
  S.rejected = true;
  S.search = null;
  delete S.chosen;
  S.answers = {};
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
    setNavbar(btn('다시 입력', reject), btn('정보 없이 인터뷰하기', () => choose(-1), true));
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

// ───────── 3. 가게 인터뷰
function getA(id) { return S.answers?.[id]; }
function setA(q, patch, c) {
  const prev = S.answers[q.id] || { s: 'ok' };
  const next = { ...prev, ...patch, pre: false };
  if ('v' in patch && (prev.s === 'unknown' || prev.s === 'na')) next.s = 'ok';
  if ('v' in patch && next.s === 'ok' && q.autoApprox?.(c)) next.s = 'approx';
  S.answers[q.id] = next;
  save();
}

function applyPrefill(questions, c) {
  let changed = false;
  for (const q of questions) {
    if (S.answers[q.id] || !q.prefill) continue;
    const v = q.prefill(c);
    if (v != null) {
      S.answers[q.id] = { s: 'ok', v, pre: true };
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

function currentPages(store) {
  const pages = visiblePages(S, store);
  let idx = pages.findIndex((p) => p.id === S.pageId);
  if (idx < 0) {
    const order = PAGES.map((p) => p.id);
    const old = order.indexOf(S.pageId);
    idx = pages.findIndex((p) => order.indexOf(p.id) > old);
    if (idx < 0) idx = pages.length - 1;
    S.pageId = pages[idx]?.id;
  }
  return { pages, idx };
}

function renderSurvey() {
  if (!S.name || !Number.isInteger(S.chosen)) { location.replace('#/'); return; }
  S.answers = S.answers || {};
  const store = chosenStore();
  storeName.textContent = store?.name || S.name;
  drawPage(store, false);
}

function drawPage(store, keepScroll) {
  const y = window.scrollY;
  let { pages, idx } = currentPages(store);
  if (applyPrefill(pages[idx].questions, buildCtx(S, store))) ({ pages, idx } = currentPages(store));
  const page = pages[idx];
  const c = buildCtx(S, store);
  const all = pages.flatMap((p) => p.questions);
  const answered = all.filter((q) => isAnswered(q, getA(q.id), c)).length;
  const firstNo = pages.slice(0, idx).reduce((n, p) => n + p.questions.length, 0);
  const shownIds = page.questions.map((q) => q.id).join(',');

  // 답이 바뀌면 같은 화면의 질문 구성이 달라졌는지 확인한다 (분기 질문)
  const refresh = (force) => {
    const next = currentPages(store);
    const ids = next.pages[next.idx]?.questions.map((q) => q.id).join(',');
    if (force || ids !== shownIds || next.pages.length !== pages.length) drawPage(store, true);
    else updateProgress();
  };
  const progressText = h('span', { class: 'navcount' });
  const bar = h('i');
  const updateProgress = () => {
    const now = currentPages(store);
    const cc = buildCtx(S, store);
    const list = now.pages.flatMap((p) => p.questions);
    const done = list.filter((q) => isAnswered(q, getA(q.id), cc)).length;
    progressText.textContent = `${done}/${list.length}`;
    bar.style.width = `${Math.round((done / Math.max(1, list.length)) * 100)}%`;
  };

  const cards = [];
  page.questions.forEach((q, i) => {
    cards.push(questionCard(q, firstNo + i + 1, c, store, refresh));
    if (q.id === 'b_know' && getA('b_know')?.v === 'unknown') cards.push(tipCard(COST_RECORD_TIP));
  });

  show(
    h('div', { class: 'page-head' },
      h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, `${idx + 1}단계 / ${pages.length}`), h('span', { class: 'tiny muted' }, `질문 ${all.length}개 중 ${answered}개 답함`)),
      h('h2', null, resolve(page.title, c)),
      h('p', { class: 'small muted' }, page.desc),
      h('div', { class: 'bar' }, bar)),
    idx === 0 && store
      ? h('div', { class: 'card note small' }, 'AI가 찾은 정보로 업종·채널·판매 방식·메뉴 등을 미리 채워 두었어요. 맞으면 그대로 두고, 틀린 곳만 고쳐 주세요.')
      : null,
    cards,
  );
  updateProgress();

  const next = () => {
    const cc = buildCtx(S, store);
    const missing = page.questions.filter((q) => !isAnswered(q, getA(q.id), cc));
    if (missing.length) {
      for (const q of missing) document.getElementById(`q-${q.id}`)?.classList.add('missing');
      document.getElementById(`q-${missing[0].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`아직 답하지 않은 질문이 ${missing.length}개 있어요. 모르면 "잘 모름"을 눌러 주세요.`, 3500);
      return;
    }
    const now = currentPages(store);
    if (now.idx >= now.pages.length - 1) {
      S.doneAt = new Date().toISOString();
      save();
      location.hash = '#/done';
      return;
    }
    S.pageId = now.pages[now.idx + 1].id;
    save();
    drawPage(store, false);
    window.scrollTo(0, 0);
  };
  const prev = () => {
    const now = currentPages(store);
    if (now.idx === 0) { location.hash = '#/find'; return; }
    S.pageId = now.pages[now.idx - 1].id;
    save();
    drawPage(store, false);
    window.scrollTo(0, 0);
  };
  setNavbar(btn('이전', prev), progressText, btn(idx === pages.length - 1 ? '완료' : '다음', next, true));
  if (keepScroll) window.scrollTo(0, y);
}

function tipCard(tip) {
  return h('div', { class: 'card tip' },
    h('div', { class: 'tip-head' }, h('span', { class: 'stars' }, tip.stars), h('b', null, tip.title)),
    h('p', { class: 'small', style: { margin: 0 } }, tip.body));
}

// 질문 카드 하나
function questionCard(q, no, c, store, refresh) {
  const card = h('div', { class: 'card qcard', id: `q-${q.id}` });
  const paint = () => {
    const cc = buildCtx(S, store);
    const a = getA(q.id);
    clear(card);
    card.classList.toggle('skipped', a?.s === 'unknown' || a?.s === 'na');
    const body = h('div', { class: 'qbody' });
    const statusRow = h('div', { class: 'status-row' });
    const syncStatus = () => {
      const s = getA(q.id)?.s;
      for (const b of statusRow.children) b.classList.toggle('on', b.dataset.s === s);
      card.classList.toggle('skipped', s === 'unknown' || s === 'na');
    };
    const onValue = (v, opts = {}) => {
      setA(q, { v }, buildCtx(S, store));
      card.classList.remove('missing', 'skipped');
      syncStatus();
      if (opts.repaint) paint();
      if (opts.check !== false) refresh(false);
    };
    renderInput(q, getA(q.id), cc, store, body, onValue);
    for (const s of q.allow || []) {
      const label = s === 'na' ? q.naLabel || STATUS_LABEL.na : s === 'unknown' ? q.unknownLabel || STATUS_LABEL.unknown : '대략 입력';
      statusRow.append(h('button', {
        type: 'button', class: 'status-btn', 'data-s': s,
        onclick: () => {
          const cur = getA(q.id) || { s: 'ok' };
          S.answers[q.id] = { ...cur, s: cur.s === s ? 'ok' : s, pre: false };
          save();
          card.classList.remove('missing');
          syncStatus();
          refresh(false);
        },
      }, label));
    }
    append(card, [
      h('div', { class: 'qno' }, `질문 ${no}${a?.pre ? ' · AI가 미리 채움' : ''}`),
      h('p', { class: 'qtext' }, resolve(q.title, cc)),
      q.hint ? (() => { const t = resolve(q.hint, cc); return t ? h('p', { class: 'ai-hint' }, t) : null; })() : null,
      q.help ? h('p', { class: 'help' }, q.help) : null,
      body,
      statusRow.children.length ? statusRow : null,
      q.why ? h('details', { class: 'why' }, h('summary', null, '왜 묻나요?'), h('p', null, q.why)) : null,
    ]);
    syncStatus();
  };
  paint();
  return card;
}

// ───────── 입력 칸
function choiceButtons(options, current, onPick, { multi = false, compact = false } = {}) {
  const wrap = h('div', { class: compact ? 'pills' : 'opts' });
  const sel = multi ? new Set(current || []) : current;
  for (const o of options) {
    const on = multi ? sel.has(o.v) : sel === o.v;
    wrap.append(h('button', {
      type: 'button', class: `${compact ? 'pill' : 'opt'}${on ? ' on' : ''}`, 'aria-pressed': String(on),
      onclick: () => {
        if (multi) {
          const set = new Set(current || []);
          if (set.has(o.v)) set.delete(o.v); else set.add(o.v);
          onPick([...set]);
        } else onPick(o.v);
      },
    }, o.label, o.desc ? h('small', null, o.desc) : null));
  }
  return wrap;
}

function numberInput(value, unit, onInput, { placeholder, money = false } = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', value: value ?? '', placeholder: placeholder || '' });
  const preview = h('span', { class: 'num-preview' });
  const paintPreview = () => {
    const n = parseNum(input.value);
    preview.textContent = money && n !== null && n >= 1000 ? fmt(n) : '';
  };
  input.addEventListener('input', () => { paintPreview(); onInput(input.value, false); });
  input.addEventListener('change', () => onInput(input.value, true));
  paintPreview();
  return h('div', { class: 'unit-input' }, input, unit ? h('span', { class: 'unit' }, unit) : null, preview);
}

function textInput(value, onInput, { placeholder, long = false } = {}) {
  const el = h(long ? 'textarea' : 'input', long ? { rows: 3, placeholder: placeholder || '' } : { type: 'text', placeholder: placeholder || '' });
  el.value = value ?? '';
  el.addEventListener('input', () => onInput(el.value, false));
  el.addEventListener('change', () => onInput(el.value, true));
  return el;
}

function renderInput(q, a, c, store, body, onValue) {
  const v = a?.v;
  const typing = (val, done) => onValue(val, { check: done });
  switch (q.type) {
    case 'choice': {
      body.append(choiceButtons(resolve(q.options, c), v?.value ?? v, (x) => {
        if (q.detail) onValue({ value: x, detail: v?.detail || '' }, { repaint: true });
        else onValue(x, { repaint: true });
      }));
      if (q.detail) {
        body.append(textInput(v?.detail || '', (t, done) => {
          const cur = getA(q.id)?.v;
          onValue({ value: cur?.value ?? null, detail: t }, { check: done });
        }, { placeholder: q.detail.placeholder }));
      }
      return;
    }
    case 'multi':
      body.append(choiceButtons(resolve(q.options, c), v, (x) => onValue(x, { repaint: true }), { multi: true, compact: true }));
      return;
    case 'text':
      body.append(textInput(v, typing, { placeholder: q.placeholder, long: q.long }));
      return;
    case 'number':
    case 'money':
      body.append(numberInput(v, q.unit, typing, { money: q.type === 'money' }));
      return;
    case 'group': {
      const cur = { ...(v || {}) };
      for (const f of q.fields) {
        if (f.when && !f.when(c, cur)) continue;
        const set = (x, opts) => { const nv = { ...(getA(q.id)?.v || {}), [f.key]: x }; onValue(nv, opts); };
        let control;
        if (f.type === 'choice') control = choiceButtons(f.options, cur[f.key], (x) => set(x, { repaint: true }), { compact: true });
        else if (f.type === 'multi') control = choiceButtons(f.options, cur[f.key], (x) => set(x, { repaint: true }), { multi: true, compact: true });
        else if (f.type === 'number' || f.type === 'money') control = numberInput(cur[f.key], f.unit, (x, done) => set(x, { check: done }), { money: f.type === 'money' });
        else control = textInput(cur[f.key], (x, done) => set(x, { check: done }), { placeholder: f.placeholder });
        body.append(h('div', { class: 'field-block' }, h('div', { class: 'field-label' }, resolve(f.label, c), f.optional ? h('small', null, ' (선택)') : null), control));
      }
      return;
    }
    case 'split': {
      const cur = v || { hall: { on: true, pct: '' }, takeout: { on: false, pct: '' }, delivery: { on: false, pct: '' } };
      const msg = h('p', { class: 'split-msg' });
      const paintMsg = () => {
        const chk = splitCheck(getA(q.id)?.v || cur, getA(q.id)?.s);
        msg.textContent = chk.ok ? (chk.sum ? `합계 ${chk.sum}%` : '') : chk.msg;
        msg.classList.toggle('bad', !chk.ok);
      };
      for (const [k, label] of [['hall', '홀 (매장 식사)'], ['takeout', '포장'], ['delivery', '배달']]) {
        const row = cur[k] || { on: false, pct: '' };
        const toggle = h('button', {
          type: 'button', class: `pill${row.on ? ' on' : ''}`, 'aria-pressed': String(!!row.on),
          onclick: () => {
            const nv = JSON.parse(JSON.stringify(getA(q.id)?.v || cur));
            nv[k] = { ...(nv[k] || {}), on: !nv[k]?.on };
            onValue(nv, { repaint: true });
          },
        }, label);
        const pct = numberInput(row.pct, '%', (x, done) => {
          const nv = JSON.parse(JSON.stringify(getA(q.id)?.v || cur));
          nv[k] = { ...(nv[k] || { on: true }), pct: x };
          onValue(nv, { check: done });
          paintMsg();
        }, { placeholder: '비중' });
        if (!row.on) pct.classList.add('off');
        body.append(h('div', { class: 'split-row' }, toggle, pct));
      }
      body.append(msg);
      paintMsg();
      return;
    }
    case 'rows': {
      const n = q.rowLabels.length;
      const rows = Array.from({ length: n }, (_, i) => ({ ...((v || [])[i] || {}) }));
      rows.forEach((row, i) => {
        const line = h('div', { class: `row-line cols-${q.columns.length}` }, h('div', { class: 'row-label' }, q.rowLabels[i]));
        for (const col of q.columns) {
          const set = (x, done) => {
            const nv = Array.from({ length: n }, (_, j) => ({ ...((getA(q.id)?.v || [])[j] || {}) }));
            nv[i][col.key] = x;
            onValue(nv, { check: done });
          };
          const control = col.type === 'text'
            ? textInput(row[col.key], set, { placeholder: col.placeholder || col.label })
            : numberInput(row[col.key], col.unit, set, { placeholder: col.placeholder || col.label, money: col.type === 'money' });
          line.append(h('label', { class: `cell cell-${col.type}` }, h('span', { class: 'cell-label' }, col.label), control));
        }
        body.append(line);
      });
      return;
    }
    case 'costs':
    case 'channels': {
      const items = q.type === 'costs' ? resolve(q.items, c) : q.items;
      const cur = { ...(v || {}) };
      for (const it of items) {
        const set = (x, done) => onValue({ ...(getA(q.id)?.v || {}), [it.key]: x }, { check: done });
        const control = q.type === 'costs'
          ? numberInput(cur[it.key], q.unit, set, { money: true })
          : textInput(cur[it.key], set, { placeholder: it.placeholder });
        body.append(h('label', { class: 'item-line' }, h('span', { class: 'item-label' }, it.label), control));
      }
      return;
    }
    case 'reviews': {
      const cur = { praise: [], complaints: [], praiseText: '', complaintsText: '', ...(v || {}) };
      const side = (key, textKey, title, found, placeholder) => {
        const set = (patch, opts) => onValue({ ...cur, ...(getA(q.id)?.v || {}), ...patch }, opts);
        return h('div', { class: 'field-block' },
          h('div', { class: 'field-label' }, title),
          found.length ? choiceButtons(found.map((x) => ({ v: x, label: x })), cur[key], (x) => set({ [key]: x }, { repaint: true }), { multi: true, compact: true }) : null,
          textInput(cur[textKey], (t, done) => set({ [textKey]: t }, { check: done }), { placeholder }));
      };
      body.append(
        side('praise', 'praiseText', '자주 듣는 칭찬', store?.strengths || [], found(store?.strengths) ? '빠진 칭찬이 있으면 적어 주세요' : '예: 국물이 진하다, 양이 많다'),
        side('complaints', 'complaintsText', '자주 듣는 불평', store?.weaknesses || [], found(store?.weaknesses) ? '빠진 불평이 있으면 적어 주세요' : '예: 점심에 오래 기다린다'),
      );
      return;
    }
    case 'menucost': {
      const cur = { know: null, amount: '', includes: [], items: [], ...(v || {}) };
      const set = (patch, opts) => onValue({ ...cur, ...(getA(q.id)?.v || {}), ...patch }, opts);
      body.append(choiceButtons([
        { v: 'known', label: '알고 있어요' }, { v: 'approx', label: '대략 알아요' }, { v: 'unknown', label: '잘 몰라요' },
      ], cur.know, (x) => set({ know: x }, { repaint: true }), { compact: true }));
      if (cur.know === 'known' || cur.know === 'approx') {
        body.append(
          h('div', { class: 'field-block' }, h('div', { class: 'field-label' }, `${c.unit} 재료비`), numberInput(cur.amount, '원', (x, done) => set({ amount: x }, { check: done }), { money: true })),
          h('div', { class: 'field-block' }, h('div', { class: 'field-label' }, '그 금액에 포함된 것'),
            choiceButtons(['반찬', '소스', '고명·토핑', '포장재', '포함 안 됨'].map((x) => ({ v: x, label: x })), cur.includes, (x) => set({ includes: x }, { repaint: true }), { multi: true, compact: true })),
        );
      } else if (cur.know === 'unknown') {
        body.append(h('p', { class: 'help' }, `${c.menuName}에 들어가는 주재료 3가지를 아는 만큼만 적어 주세요. 모르면 비워 두셔도 돼요. 재료별로 나눠서 원가를 추정해요.`));
        for (let i = 0; i < 3; i++) {
          const it = cur.items[i] || {};
          const setItem = (key) => (x, done) => {
            const items = Array.from({ length: 3 }, (_, j) => ({ ...((getA(q.id)?.v?.items || [])[j] || {}) }));
            items[i][key] = x;
            set({ items }, { check: done });
          };
          body.append(h('div', { class: 'row-line cols-4' },
            h('div', { class: 'row-label' }, `재료 ${i + 1}`),
            h('label', { class: 'cell cell-text' }, h('span', { class: 'cell-label' }, '재료'), textInput(it.name, setItem('name'), { placeholder: '예: 소고기' })),
            h('label', { class: 'cell cell-money' }, h('span', { class: 'cell-label' }, '구매가격'), numberInput(it.price, '원', setItem('price'), { money: true })),
            h('label', { class: 'cell cell-text' }, h('span', { class: 'cell-label' }, '구매 용량'), textInput(it.size, setItem('size'), { placeholder: '예: 1kg' })),
            h('label', { class: 'cell cell-text' }, h('span', { class: 'cell-label' }, `${c.unit} 사용량`), textInput(it.use, setItem('use'), { placeholder: '예: 150g' }))));
        }
      }
      return;
    }
    default:
      body.append(h('p', { class: 'muted' }, '지원하지 않는 질문 형식이에요.'));
  }
}
const found = (list) => Array.isArray(list) && list.length > 0;

// ───────── 4. 완료: 답변 정리
function solutionCard(sol) {
  return h('div', { class: `card sol sol-${sol.stars}` },
    h('div', { class: 'sol-head' },
      h('span', { class: 'stars' }, sol.stars ? '★'.repeat(sol.stars) : '확인 필요'),
      h('span', { class: 'sol-level' }, LEVEL[sol.stars]),
      h('span', { class: 'sol-area' }, sol.area)),
    h('h3', null, sol.title),
    h('p', { class: 'sol-row' }, h('b', null, '발견한 문제 '), sol.problem),
    sol.evidence.length ? h('p', { class: 'sol-row small muted' }, h('b', null, '확인 근거 '), `사장님 답변 · ${sol.evidence.join(' · ')}`) : null,
    h('div', { class: 'sub-title' }, '이렇게 해보세요'),
    h('ol', { class: 'sol-steps' }, sol.actions.map((x) => h('li', null, x))),
    sol.cost ? h('p', { class: 'sol-row small' }, h('b', null, '비용과 기간 '), sol.cost) : null,
    h('p', { class: 'sol-row small' }, h('b', null, '확인 지표 '), sol.metric));
}

function renderDone() {
  if (!S.doneAt || !Number.isInteger(S.chosen)) { location.replace(Number.isInteger(S.chosen) ? '#/survey' : '#/'); return; }
  const store = chosenStore();
  const name = store?.name || S.name;
  storeName.textContent = name;
  const c = buildCtx(S, store);
  const pages = visiblePages(S, store);
  const total = pages.reduce((n, p) => n + p.questions.length, 0);
  const problem = PROBLEMS.find((p) => p.v === (getA('a_problem')?.v?.value ?? getA('a_problem')?.v))?.label;
  const sols = buildSolutions(S, store);
  const cta = reportCta();
  show(
    h('div', { class: 'card' },
      h('h2', null, '인터뷰를 마쳤어요'),
      h('p', null, `${name}에 대한 질문 ${total}개에 답해 주셨어요.${problem ? ` 가장 큰 고민은 "${problem}"예요.` : ''}`),
      h('p', { class: 'small muted', style: { margin: 0 } }, '답변은 이 브라우저에 저장돼 있어요. AI 보고서를 만들 때만 동의를 받고 보내요.')),
    cta.el,
    sols.length
      ? [
          h('h3', { class: 'section-title' }, `바로 확인된 솔루션 ${sols.length}개`),
          h('p', { class: 'small muted' }, '답변에서 바로 확인된 것부터 정리했어요. AI 보고서는 이 내용과 나머지 답변·공개 정보를 함께 분석해요. ★★★ 우선 개선 · ★★ 이번 주 실행 · ★ 조건부 실험'),
          sols.map(solutionCard),
        ]
      : h('div', { class: 'card note small' }, '지금 답변에서는 바로 고칠 기본 문제가 보이지 않았어요. AI 보고서에서 나머지 답변과 공개 정보를 함께 분석해요.'),
    h('details', { class: 'card all-answers' },
      h('summary', null, `내 답변 전체 보기 (${total}개)`),
      pages.map((p) => h('div', { class: 'answer-group' },
        h('h3', null, resolve(p.title, c)),
        h('ul', { class: 'answers' }, p.questions.map((q) => h('li', null,
          h('span', { class: 'a-q' }, resolve(q.title, c)),
          h('span', { class: 'a-v' }, answerText(q, getA(q.id), c)))))))),
    h('p', { class: 'small', style: { textAlign: 'center' } },
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        if (!confirm('지금까지의 답변과 보고서를 지우고 처음부터 시작할까요?')) return;
        S = {}; save(); location.hash = '#/';
      } }, '처음부터 다시')),
  );
  setNavbar(
    btn('답변 고치기', () => { S.pageId = PAGES[0].id; S.doneAt = null; save(); location.hash = '#/survey'; }),
    btn(cta.label, cta.go, true),
  );
}

// ───────── 5. AI 진단 보고서 (동의 후 답변 전송 → /api/report)
// 답변이 바뀌었는지 알아보는 간단한 지문
function answersKey() {
  const s = JSON.stringify({ c: S.chosen, n: S.name, a: S.address, x: S.answers || {}, p: S.pasted || '' });
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length}-${x.toString(36)}`;
}
// 보고서 형식 버전 (서버 lib/report.mjs 의 REPORT_VERSION 과 같게). 예전 형식 보고서는 다시 만들 수 있게 한다.
const REPORT_V = 2;
const reportOutdated = () => !!S.report?.data && S.report.key === answersKey() && (S.report.data.v || 1) < REPORT_V;
const reportFresh = () => !!S.report?.data && S.report.key === answersKey() && (S.report.data.v || 1) >= REPORT_V;
let reportJob = null; // { key, started, done, error, promise }

// 같은 작업을 이미 하는 중이면(새로고침·두 번 누름) 끝날 때까지 기다렸다가 받아온다.
async function postPatiently(path, body, job) {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await post(path, body, 295000);
      job.waiting = false;
      return data;
    } catch (e) {
      if (e.code === 'BUSY' && attempt < 24) {
        job.waiting = true;
        await new Promise((r) => setTimeout(r, 12000));
        body.refresh = false;
        continue;
      }
      throw e;
    }
  }
}

function startReport({ refresh = false } = {}) {
  const key = answersKey();
  if (reportJob && !reportJob.done && reportJob.key === key) return reportJob;
  const store = chosenStore();
  const job = { key, started: Date.now(), done: false, error: null, stage: 'research' };
  job.promise = (async () => {
    // 1) AI가 상호명·주소로 인터넷을 직접 조사 (같은 가게는 3일 동안 저장된 결과를 씀, 답변은 보내지 않음)
    job.research = await postPatiently('/api/research', { name: S.name, address: S.address, store }, job);
    job.stage = 'report';
    job.stageAt = Date.now();
    // 2) 조사 결과 + 답변 + 서버 계산값을 합쳐 보고서
    const data = await postPatiently('/api/report', { name: S.name, address: S.address, store, answers: S.answers, refresh }, job);
    S.report = { key, data };
    save();
    return data;
  })();
  job.promise.then(
    () => { job.done = true; },
    (e) => { job.done = true; job.error = e; },
  ).finally(() => {
    if (location.hash === '#/report' || location.hash === '#/done') route();
  });
  reportJob = job;
  return job;
}

function reportCta() {
  if (reportFresh()) {
    const go = () => { location.hash = '#/report'; };
    return {
      label: '보고서 보기', go,
      el: h('div', { class: 'card report-cta ready' },
        h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, 'AI 진단 보고서')),
        h('h2', null, '보고서가 준비돼 있어요'),
        S.report.data.report?.oneLine ? h('p', null, S.report.data.report.oneLine) : null,
        h('button', { class: 'btn primary block', type: 'button', onclick: go }, '보고서 보기')),
    };
  }
  if (reportJob && !reportJob.done && reportJob.key === answersKey()) {
    const go = () => { location.hash = '#/report'; };
    return {
      label: '진행 상황 보기', go,
      el: h('div', { class: 'card report-cta' },
        h('h2', null, '보고서를 만드는 중이에요'),
        h('p', { class: 'small' }, '인터넷 조사와 보고서 작성까지 보통 2~4분 걸려요.'),
        h('button', { class: 'btn primary block', type: 'button', onclick: go }, '진행 상황 보기')),
    };
  }
  const old = !!S.report?.data;
  const outdated = reportOutdated();
  const agree = h('input', { type: 'checkbox', id: 'agreeAi' });
  const make = h('button', { class: 'btn primary block', type: 'button', disabled: true }, outdated ? '새 형식으로 다시 만들기' : old ? '바뀐 답변으로 다시 만들기' : 'AI 진단 보고서 만들기');
  const el = h('div', { class: 'card report-cta', id: 'reportCta' },
    h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, 'AI 진단 보고서')),
    h('h2', null, outdated ? '보고서가 더 자세해졌어요' : old ? '답변이 바뀌었어요' : '이제 AI가 진단 보고서를 만들어 드려요'),
    h('p', null, outdated
      ? '이제 개선안이 8~10개로 늘고, 인터넷 조사에서 찾은 개선점이 더해져요. 새 형식으로 다시 만들 수 있어요.'
      : old
        ? '바뀐 답변으로 보고서를 다시 만들 수 있어요.'
        : 'AI가 상호명과 주소로 카카오맵·네이버·구글·블로그·리뷰 사이트를 직접 찾아보고, 사장님 답변과 합쳐서 진단과 개선안 8~10개를 만들어요.'),
    h('ol', { class: 'cta-steps small' },
      h('li', null, h('b', null, '인터넷 조사 '), '검색 결과·블로그 후기·리뷰 사이트에서 평점, 리뷰 수, 반복되는 칭찬과 불만, 주변 가게, 플랫폼마다 다른 정보를 찾아요.'),
      h('li', null, h('b', null, '보고서 작성 '), '조사 결과와 답변, 서버가 계산한 숫자를 합쳐 한 줄 진단·핵심 수치·우선순위 개선안·실행 계획을 만들어요.')),
    h('ul', { class: 'note-list small' },
      h('li', null, '인터넷 조사에는 상호명·주소와 앞서 찾은 공개 정보만 써요.'),
      h('li', null, '보고서를 만들려면 인터뷰 답변을 OpenRouter를 거쳐 AI(Anthropic Claude)에 보내야 해요.'),
      h('li', null, '같은 내용으로 다시 열 때 비용이 들지 않도록, 보고서는 하루, 인터넷 조사 결과는 3일 동안 서버에 보관했다가 자동으로 지워요.'),
      h('li', null, '보통 2~4분 걸려요.')),
    h('label', { class: 'consent' }, agree, h('span', null, '위 내용을 확인했고, 보고서를 만들기 위해 답변을 AI에 보내는 데 동의해요.')),
    make,
    old ? h('p', { class: 'small', style: { margin: '10px 0 0' } }, h('a', { href: '#/report' }, outdated ? '예전 형식 보고서 보기' : '이전 답변으로 만든 보고서 보기')) : null);
  const go = () => {
    if (!agree.checked) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      agree.focus();
      toast('보고서를 만들려면 먼저 동의에 체크해 주세요.');
      return;
    }
    S.reportConsentAt = new Date().toISOString();
    save();
    startReport();
    location.hash = '#/report';
  };
  agree.addEventListener('change', () => { make.disabled = !agree.checked; });
  make.addEventListener('click', go);
  return { label: old ? '보고서 다시 만들기' : 'AI 보고서 만들기', go, el };
}

const RESEARCH_TIPS = [
  '상호명과 주소로 카카오맵·네이버·구글 검색 결과를 찾고 있어요.',
  '블로그 후기와 리뷰 사이트 글을 직접 열어 읽고 있어요.',
  '반복되는 칭찬과 불만을 맛·가격·양·대기·친절·위생·화장실·주차로 나누고 있어요.',
  '주변 같은 업종 가게와 가격대를 살펴보고 있어요.',
  '플랫폼마다 영업시간·가격이 같은지 확인하고 있어요.',
  '조사 결과를 정리하고 있어요. 조금만 기다려 주세요.',
];
const REPORT_TIPS = [
  '조사 결과와 답변을 함께 읽고 있어요.',
  '매출·비용 계산값을 확인하고 있어요.',
  '가장 중요한 문제와 바로 할 일을 고르고 있어요.',
  '우선순위 솔루션을 정리하고 있어요.',
  '실행 계획과 확인 지표를 정리하고 있어요.',
  '거의 다 됐어요. 조금만 기다려 주세요.',
];

function renderReport() {
  if (!S.doneAt || !Number.isInteger(S.chosen)) { location.replace(Number.isInteger(S.chosen) ? '#/survey' : '#/'); return; }
  storeName.textContent = chosenStore()?.name || S.name;
  const job = reportJob;
  if (job && !job.done) return reportLoading(job);
  if (job && job.error && job.key === answersKey() && !reportFresh()) return reportError(job.error);
  if (!S.report?.data) { location.replace('#/done'); return; }
  drawReport(S.report.data, !reportFresh());
}

function reportLoading(job) {
  const title = h('h2', null, '');
  const step = h('div', { class: 'stage-bar' }, h('span', { class: 'on' }, '1 인터넷 조사'), h('span', null, '2 보고서 작성'));
  const elapsed = h('span', { class: 'elapsed' }, '0초');
  const tip = h('p', { class: 'small muted' }, RESEARCH_TIPS[0]);
  const found = h('p', { class: 'small', hidden: true });
  show(
    h('div', { class: 'card loading' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      step,
      title,
      h('p', { class: 'small' }, '보통 2~4분 걸려요. ', elapsed),
      tip,
      found,
      h('p', { class: 'tiny muted', style: { margin: 0 } }, '이 창을 열어 두면 끝나는 대로 보여드려요. 같은 내용으로 다시 요청하면, 이미 만든 조사·보고서는 추가 비용 없이 받아요.')),
  );
  setNavbar(btn('완료 화면으로', () => { location.hash = '#/done'; }));
  const paint = () => {
    const s = Math.round((Date.now() - job.started) / 1000);
    elapsed.textContent = s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
    const researching = job.stage === 'research';
    title.textContent = researching ? 'AI가 인터넷에서 우리 가게를 조사하고 있어요' : '조사 결과와 답변을 합쳐 보고서를 쓰고 있어요';
    step.children[0].className = researching ? 'on' : 'done';
    step.children[1].className = researching ? '' : 'on';
    const t = Math.round((Date.now() - (researching ? job.started : job.stageAt)) / 1000);
    const tips = researching ? RESEARCH_TIPS : REPORT_TIPS;
    tip.textContent = job.waiting ? '같은 내용으로 이미 진행 중인 작업을 기다리고 있어요.' : tips[Math.min(tips.length - 1, Math.floor(t / 15))];
    const rs = job.research;
    if (rs && found.hidden) {
      found.hidden = false;
      found.textContent = `인터넷 조사 완료: 출처 ${rs.sources?.length || 0}곳 · 읽은 후기·글 ${rs.reviewsChecked || 0}개${rs.cached ? ' (저장된 조사 결과)' : ''}`;
    }
  };
  paint();
  const timer = setInterval(() => {
    if (!elapsed.isConnected) { clearInterval(timer); return; }
    paint();
  }, 1000);
}

function reportError(e) {
  const stop = ['IP_QUOTA', 'DAILY_BUDGET', 'AI_CREDIT', 'AI_CONFIG', 'STORE_CONFIG', 'ORIGIN', 'NAME', 'ANSWERS'].includes(e.code);
  show(
    h('div', { class: 'card warn' },
      h('h2', null, '보고서를 만들지 못했어요'),
      h('p', null, e.message || '잠시 후 다시 시도해 주세요.'),
      h('p', { class: 'tiny muted' }, `오류 코드: ${e.code || '알 수 없음'}`)),
  );
  setNavbar(
    btn('완료 화면으로', () => { reportJob = null; location.hash = '#/done'; }),
    stop ? null : btn('다시 시도', () => { reportJob = null; startReport(); route(); }, true),
  );
}

const EV_TAG = { '답변': 'ans', '계산': 'calc', '공개 정보': 'pub', '붙여 넣은 리뷰': 'paste', '참고 통계': 'ref', '추정': 'est' };
function evItem(text) {
  const m = /^\[(답변|계산|공개 정보|붙여 넣은 리뷰|참고 통계|추정)\]\s*/.exec(text);
  return h('li', null, m ? h('span', { class: `ev-tag ev-${EV_TAG[m[1]]}` }, m[1]) : null, m ? text.slice(m[0].length) : text);
}
const KIND_CLASS = { '답변': 'ans', '계산': 'calc', '추정': 'est' };

function aiSolutionCard(sol) {
  const fromWeb = sol.evidence.some((e) => e.startsWith('[공개 정보]'));
  return h('div', { class: `card sol sol-${sol.stars}` },
    h('div', { class: 'sol-head' },
      sol.stars ? h('span', { class: 'stars' }, '★'.repeat(sol.stars)) : null,
      h('span', { class: 'sol-level' }, LEVEL[sol.stars]),
      h('span', { class: 'sol-area' }, sol.area),
      fromWeb ? h('span', { class: 'sol-web' }, '인터넷 조사 반영') : null),
    h('h3', null, sol.title),
    sol.problem ? h('p', { class: 'sol-row' }, h('b', null, '발견한 문제 '), sol.problem) : null,
    sol.evidence.length ? [h('div', { class: 'sub-title' }, '확인 근거'), h('ul', { class: 'ev-list' }, sol.evidence.map(evItem))] : null,
    h('div', { class: 'sub-title' }, '실행 방법'),
    h('ol', { class: 'sol-steps' }, sol.actions.map((x) => h('li', null, x))),
    sol.effect ? h('p', { class: 'sol-row sol-effect' }, h('b', null, '기대 효과 '), sol.effect) : null,
    h('dl', { class: 'sol-meta' },
      sol.owner ? [h('dt', null, '담당'), h('dd', null, sol.owner)] : null,
      sol.cost ? [h('dt', null, '비용과 기간'), h('dd', null, sol.cost)] : null,
      sol.supplies ? [h('dt', null, '준비물'), h('dd', null, sol.supplies)] : null,
      sol.metric ? [h('dt', null, '확인 지표'), h('dd', null, sol.metric)] : null));
}

// ───────── 보고서를 PDF 파일로 저장 (인쇄 창 없이 바로 내려받기)
// 화면에 보이는 보고서를 A4 폭으로 복제해 블록(카드)별로 그림으로 찍고, 카드가 쪽 사이에서 잘리지 않게 배치한다.
// 라이브러리(html2canvas·jsPDF, MIT)는 /vendor 에 두고 저장할 때만 불러온다.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`불러오지 못함: ${src}`));
    document.head.append(s);
  });
}
async function ensurePdfLibs() {
  if (!window.html2canvas) await loadScript('/vendor/html2canvas.min.js');
  if (!window.jspdf?.jsPDF) await loadScript('/vendor/jspdf.umd.min.js');
  if (!window.html2canvas || !window.jspdf?.jsPDF) throw new Error('PDF 도구를 불러오지 못했어요.');
}
// 긴 카드를 나눌 때 글줄 가운데가 잘리지 않도록, 안쪽 요소들의 아래쪽 경계를 자를 곳 후보로 쓴다.
function cutPoints(el) {
  const top = el.getBoundingClientRect().top;
  const pts = new Set();
  el.querySelectorAll('*').forEach((n) => {
    const r = n.getBoundingClientRect();
    if (r.height > 0) pts.add(Math.round(r.bottom - top));
  });
  return [...pts].sort((x, y) => x - y);
}
function pdfFileName(data) {
  const name = String(data.store?.name || S.name || '가게').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const d = new Date(data.createdAt || Date.now());
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');
  return `매출올려드림_${name}_진단보고서_${ymd}.pdf`;
}
let pdfBusy = false;
async function saveReportPdf(data, button) {
  if (pdfBusy) return;
  pdfBusy = true;
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = '저장 중…'; }
  if (/KAKAOTALK/i.test(navigator.userAgent)) toast('카카오톡 안에서는 파일 저장이 안 될 수 있어요. 안 되면 오른쪽 위 메뉴에서 다른 브라우저로 열어 주세요.', 6000);
  else toast('PDF 파일을 만들고 있어요. 잠시만 기다려 주세요.', 8000);
  const box = h('div', { class: 'pdf-render' });
  try {
    await ensurePdfLibs();
    const logo = document.querySelector('.logo img')?.getAttribute('src') || '/logo.png';
    box.append(h('div', { class: 'pdf-brand' }, h('img', { src: logo, alt: '매출올려드림 AI' })));
    for (const child of view.children) {
      if (child.classList.contains('no-print') || child.classList.contains('warn') && child.querySelector('a[href="#/done"]')) continue;
      // 개선안 묶음은 카드마다 따로 배치해야 쪽 사이에서 잘리지 않는다
      if (child.classList.contains('sol-list')) { for (const c of child.children) box.append(c.cloneNode(true)); continue; }
      box.append(child.cloneNode(true));
    }
    box.querySelectorAll('details').forEach((d) => { d.open = true; });
    box.querySelectorAll('details.sources-box > summary').forEach((s) => { s.replaceWith(h('div', { class: 'sub-title' }, '출처')); });
    document.body.append(box);
    // 목록 번호·글머리표는 그림 도구가 그리지 못할 때가 있어 글자로 바꿔 넣는다
    box.querySelectorAll('ol, ul').forEach((list) => {
      if (getComputedStyle(list).listStyleType === 'none') return;
      const ordered = list.tagName === 'OL';
      list.classList.add('pdf-list');
      [...list.children].forEach((li, i) => {
        if (li.tagName !== 'LI') return;
        const body = h('span', { class: 'pdf-li' });
        while (li.firstChild) body.append(li.firstChild);
        li.append(h('span', { class: 'pdf-mark' }, ordered ? `${i + 1}.` : '•'), body);
      });
    });
    await Promise.all([...box.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
    // 그림으로 찍을 때는 보고서 상자만 복제한다. 화면의 다른 부분과, 브라우저 확장 프로그램이 페이지에 붙인
    // 위젯(안쪽 CSS가 제목 굵기·목록 번호를 지워 버림)은 빼야 PDF가 화면과 같게 나온다.
    const skipForPdf = (el) => (el.parentElement === document.body && el !== box)
      || (el.parentElement === document.documentElement && el !== document.head && el !== document.body);    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const PW = 210; const PH = 297; const M = 10; const W = PW - M * 2; const BOTTOM = PH - 12; const GAP = 3;
    let y = M;
    const place = (canvas, sy, sh) => {
      const part = document.createElement('canvas');
      part.width = canvas.width;
      part.height = sh;
      const ctx = part.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, part.width, part.height);
      ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
      const hmm = (sh * W) / canvas.width;
      doc.addImage(part.toDataURL('image/jpeg', 0.86), 'JPEG', M, y, W, hmm, undefined, 'FAST');
      y += hmm + GAP;
    };
    for (const block of [...box.children]) {
      const canvas = await window.html2canvas(block, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true, windowWidth: 1024, ignoreElements: skipForPdf });
      if (!canvas.width || !canvas.height) continue;
      const pxPerMm = canvas.width / W;
      const hmm = canvas.height / pxPerMm;
      const room = BOTTOM - y;
      if (hmm <= room) { place(canvas, 0, canvas.height); continue; }
      if (hmm <= BOTTOM - M && room < (BOTTOM - M) * 0.4) {
        // 남은 자리가 적으면 카드를 통째로 다음 쪽에서 시작
        doc.addPage(); y = M;
        place(canvas, 0, canvas.height);
        continue;
      }
      // 남은 자리가 넉넉하거나 한 쪽보다 긴 카드: 빈 공간이 생기지 않게 글줄 경계에서 나눠 이어 붙인다
      const scale = canvas.width / block.getBoundingClientRect().width;
      const cuts = cutPoints(block).map((c) => Math.round(c * scale));
      let sy = 0;
      while (sy < canvas.height) {
        if (BOTTOM - y < 25) { doc.addPage(); y = M; }
        const maxPx = Math.floor((BOTTOM - y) * pxPerMm);
        let end = Math.min(canvas.height, sy + maxPx);
        if (end < canvas.height) {
          const ok = cuts.filter((c) => c > sy + 60 && c <= end);
          if (ok.length) end = ok[ok.length - 1];
        }
        place(canvas, sy, end - sy);
        sy = end;
        if (sy < canvas.height) { doc.addPage(); y = M; }
      }
    }
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text('www.kkumsu.com', M, PH - 5);
      doc.text(`${i} / ${pages}`, PW - M, PH - 5, { align: 'right' });
    }
    doc.save(pdfFileName(data));
    toast('PDF 파일로 저장했어요. 내려받은 파일(다운로드)에서 열어 보세요.', 5000);
  } catch (e) {
    console.error('[pdf]', e);
    toast('저장하지 못했어요. 잠시 후 다시 눌러 주세요.', 5000);
  } finally {
    box.remove();
    pdfBusy = false;
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

// 인터넷 조사 결과 (문서 8장: 분석 기간·확인한 리뷰 수·출처·반복 여부 표시)
const TONE_KO = { good: '좋음', bad: '아쉬움', mixed: '엇갈림' };
const ST_CLASS = { '확인함': 'ok', '일부 확인': 'part', '확인 못 함': 'no' };
const extLink = (url, text) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);
function researchSection(rs, pv) {
  if (!rs) return null;
  let when = '';
  try { when = new Date(rs.searchedAt).toLocaleDateString('ko-KR', { dateStyle: 'long', timeZone: 'Asia/Seoul' }); } catch { /* 날짜 없음 */ }
  const sub = (t) => h('div', { class: 'sub-title' }, t);
  const ul = (items) => h('ul', { class: 'plain-list' }, items.map((x) => h('li', null, x)));
  return h('section', { class: 'card research' },
    h('h2', null, '인터넷에서 본 우리 가게'),
    h('p', { class: 'small muted' }, `AI가 ${when ? `${when}에 ` : ''}상호명·주소로 직접 검색하고 블로그·리뷰 글을 읽었어요. 분석 기간: ${rs.period || '확인 안 됨'} · 실제로 읽은 후기·글 ${rs.reviewsChecked || 0}개${rs.sponsored ? ` · 협찬 표시 글: ${rs.sponsored}` : ''}`),
    pv?.summary ? h('p', null, pv.summary) : null,
    rs.platforms?.length
      ? [sub('플랫폼별로 확인한 것'), h('table', { class: 'metrics plat' }, h('tbody', null, rs.platforms.map((p) => h('tr', null,
          h('th', null, p.url ? extLink(p.url, p.platform) : p.platform, p.checked || p.note ? h('small', null, [p.checked, p.note].filter(Boolean).join(' · ')) : null),
          h('td', null, h('b', null, [p.rating, p.reviewCount].filter(Boolean).join(' · ') || '-'), h('small', { class: `kind st-${ST_CLASS[p.status] || 'no'}` }, p.status))))))]
      : null,
    rs.themes?.length
      ? [sub('후기에서 나온 이야기'), h('ul', { class: 'theme-list' }, rs.themes.map((t) => h('li', null,
          h('div', { class: 'theme-head' }, h('span', { class: `tone tone-${t.tone}` }, `${t.theme} · ${TONE_KO[t.tone] || ''}`), h('span', { class: 'theme-meta' }, `글 ${t.count}개${t.repeated ? ' · 반복' : ''}`)),
          h('p', null, t.summary),
          t.examples?.length ? h('p', { class: 'tiny muted' }, t.examples.join(' / ')) : null)))]
      : null,
    pv?.keep?.length ? [sub('지켜야 할 강점'), ul(pv.keep)] : null,
    pv?.gaps?.length ? [sub('사장님 답변과 다른 점'), ul(pv.gaps)] : null,
    rs.infoIssues?.length ? [sub('플랫폼마다 다른 정보'), ul(rs.infoIssues)] : null,
    rs.area || rs.competitors?.length
      ? [sub('주변 상권과 경쟁점'), rs.area ? h('p', { class: 'small' }, rs.area) : null,
          rs.competitors?.length ? ul(rs.competitors.map((c) => [c.name, c.category && `(${c.category})`, c.priceRange, c.note && `- ${c.note}`].filter(Boolean).join(' '))) : null]
      : null,
    rs.limits?.length ? [sub('확인하지 못한 것'), ul(rs.limits)] : null,
    rs.sources?.length
      ? h('details', { class: 'sources-box' }, h('summary', null, `출처 ${rs.sources.length}곳 보기`),
          h('ol', { class: 'sources' }, rs.sources.map((s) => h('li', null, extLink(s.url, s.title),
            s.platform || s.date ? h('span', { class: 'muted' }, ` (${[s.platform, s.date].filter(Boolean).join(', ')})`) : null))))
      : null);
}
// 인쇄할 때는 출처 목록을 펼쳐서 함께 찍는다
window.addEventListener('beforeprint', () => { document.querySelectorAll('details.sources-box').forEach((d) => { d.open = true; }); });

function drawReport(data, stale) {
  const r = data.report || {};
  const when = (() => {
    try { return new Date(data.createdAt).toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Seoul' }); } catch { return ''; }
  })();
  const planCol = (title, items) => (items?.length ? h('div', { class: 'plan-col' }, h('h3', null, title), h('ul', null, items.map((x) => h('li', null, x)))) : null);
  const analysis = [['수익 구조', r.analysis?.profit], ['메뉴', r.analysis?.menu], ['고객 경험', r.analysis?.customer], ['어떻게 이어지나요', r.analysis?.connection]].filter(([, t]) => t);
  const b = data.bench;
  show(
    stale
      ? h('div', { class: 'card warn no-print' },
          h('b', null, reportOutdated() ? '보고서가 더 자세해졌어요. ' : '답변이 바뀌었어요. '),
          reportOutdated() ? '이 보고서는 예전 형식(개선안 4~6개)이에요. ' : '이 보고서는 바뀌기 전 답변으로 만든 거예요. ',
          h('a', { href: '#/done' }, reportOutdated() ? '새 형식으로 다시 만들기' : '바뀐 답변으로 다시 만들기'))
      : null,
    data.mock ? h('div', { class: 'card note small' }, '(모의 응답) 실제 AI가 아니라 화면 점검용으로 만든 보고서예요.') : null,
    h('div', { class: 'rep-head' },
      h('div', { class: 'rep-kicker' }, 'AI 진단 보고서 · 베타'),
      h('h1', { class: 'rep-title' }, `${data.store?.name || S.name} 진단 보고서`),
      h('p', { class: 'small muted' }, [when, data.store?.address].filter(Boolean).join(' · '))),

    h('section', { class: 'card rep-core' },
      h('div', { class: 'rep-label' }, '핵심 진단'),
      r.situation && r.situation !== '기타' ? h('span', { class: 'situation' }, r.situation) : null,
      h('p', { class: 'one-line' }, r.oneLine),
      r.situationMessage ? h('p', { class: 'small muted' }, r.situationMessage) : null,
      r.keyMetrics?.length
        ? h('div', { class: 'key-metrics' }, r.keyMetrics.map((m) => h('div', null,
            h('span', null, m.label), h('b', null, m.value), h('small', { class: `kind kind-${KIND_CLASS[m.kind] || 'calc'}` }, m.kind))))
        : null,
      h('div', { class: 'rep-block' },
        h('h3', null, '가장 중요한 문제'),
        h('p', { class: 'strong' }, r.topProblem?.title),
        r.topProblem?.evidence?.length ? h('ul', { class: 'ev-list' }, r.topProblem.evidence.map(evItem)) : null),
      h('div', { class: 'rep-block first-action' },
        h('h3', null, '지금 바로 할 일'),
        h('p', { class: 'strong' }, r.firstAction?.title),
        r.firstAction?.how ? h('p', { class: 'small', style: { margin: 0 } }, r.firstAction.how) : null)),

    r.urgent?.length
      ? h('section', { class: 'card warn' }, h('h3', null, '위생·안전: 먼저 확인하세요'), h('ul', null, r.urgent.map((x) => h('li', null, x))))
      : null,

    researchSection(data.research, r.publicView),

    data.metrics?.length
      ? h('section', { class: 'card' },
          h('h2', null, '숫자로 본 우리 가게'),
          h('p', { class: 'small muted' }, '사장님이 적은 숫자로 서버가 계산했어요. AI가 지어낸 숫자는 없어요.'),
          h('table', { class: 'metrics' }, h('tbody', null, data.metrics.map((m) => h('tr', null,
            h('th', null, m.label, m.note ? h('small', null, m.note) : null),
            h('td', null, h('b', null, m.value), h('small', { class: `kind kind-${KIND_CLASS[m.kind] || 'calc'}` }, m.kind)))))),
          data.cautions?.length ? h('ul', { class: 'note-list small' }, data.cautions.map((x) => h('li', null, x))) : null,
          b ? h('p', { class: 'tiny muted', style: { margin: '8px 0 0' } }, `참고: ${b.name} 평균 (매출 대비) 식재료비 ${b.food}% · 고용인 인건비 ${b.labor}% · 임차료 ${b.rent}% · 영업이익률 ${b.profit}% — ${b.source}`) : null)
      : data.cautions?.length
        ? h('section', { class: 'card note small' }, h('ul', { class: 'note-list' }, data.cautions.map((x) => h('li', null, x))))
        : null,

    analysis.length
      ? h('section', { class: 'card' },
          h('h2', null, '수익 구조·메뉴·고객 경험 연결 분석'),
          analysis.map(([t, x]) => h('div', { class: 'analysis-item' }, h('h3', null, t), h('p', { style: { margin: 0 } }, x))))
      : null,

    h('h2', { class: 'section-title' }, `우선 개선안 ${r.solutions?.length || 0}개`),
    h('p', { class: 'small muted' }, '★★★ 우선 개선 · ★★ 이번 주 실행 · ★ 조건부 실험 · 확인 필요. 근거 표시: 답변 = 사장님 답변, 계산 = 서버 계산, 공개 정보 = AI가 인터넷에서 찾은 정보, 추정 = AI의 판단. "인터넷 조사 반영"은 인터넷 후기·평판에서 찾은 개선점이에요.'),
    h('div', { class: 'sol-list' }, (r.solutions || []).map(aiSolutionCard)),

    h('section', { class: 'card' },
      h('h2', null, '실행 계획'),
      h('div', { class: 'plan-cols' },
        planCol('이번 주', r.plan?.thisWeek), planCol('2~3주 차', r.plan?.nextWeeks), planCol('한 달 안', r.plan?.thisMonth)),
      r.plan?.marketing ? h('div', { class: 'rep-block' }, h('h3', null, '마케팅 실행안'), h('p', { style: { margin: 0 } }, r.plan.marketing)) : null,
      r.plan?.budget ? h('div', { class: 'rep-block' }, h('h3', null, '예산'), h('p', { style: { margin: 0 } }, r.plan.budget)) : null,
      r.plan?.check ? h('div', { class: 'rep-block' }, h('h3', null, '성과 확인 방법'), h('p', { style: { margin: 0 } }, r.plan.check)) : null),

    r.needCheck?.length
      ? h('section', { class: 'card note' }, h('h3', null, '더 정확한 진단을 위해 확인할 것'), h('ul', { class: 'note-list' }, r.needCheck.map((x) => h('li', null, x))))
      : null,

    h('div', { class: 'card note rep-foot' },
      h('p', null, 'AI가 사장님 답변과 인터넷 공개 정보로 만든 진단이에요. 계산값은 사장님이 적은 숫자로 계산했고 추정이 섞여 있어요. 사진과 실제 장부는 보지 않았고, 카카오맵·네이버 플레이스·구글 지도 리뷰 본문은 자동으로 읽을 수 없어 검색 결과·블로그·리뷰 사이트에 나온 내용만 반영했어요. 중요한 결정 전에는 장부와 현장에서 꼭 확인해 주세요.'),
      data.truncated ? h('p', null, '보고서가 길어 끝부분이 잘렸을 수 있어요. 다시 만들면 나아질 수 있어요.') : null,
      h('p', { style: { margin: 0 } }, `만든 AI: ${data.model === 'mock' ? '모의 응답' : data.model || '-'}${data.cached ? ' · 저장된 보고서' : ''}`)),
    stale ? null : h('p', { class: 'small no-print', style: { textAlign: 'center' } },
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        if (!confirm('같은 답변으로 보고서를 새로 만들까요? 2~4분쯤 걸려요.')) return;
        startReport({ refresh: true });
        route();
      } }, '보고서 새로 만들기')),
  );
  const saveBtn = btn('저장하기', () => saveReportPdf(data, saveBtn), true);
  setNavbar(
    btn('완료 화면', () => { location.hash = '#/done'; }),
    saveBtn,
  );
}
route();
