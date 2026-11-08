// 매출올려드림 AI · 상호명·주소 → AI 가게 찾기 → 맞는지 확인 → 가게 상황에 맞춘 인터뷰
import {
  PAGES, PROBLEMS, STATUS_LABEL, COST_RECORD_TIP,
  buildCtx, visiblePages, isAnswered, splitCheck, parseNum, resolve,
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
const btn = (label, onclick, primary = false) => h('button', { class: primary ? 'btn primary' : 'btn', type: 'button', onclick }, label);
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

  const started = Number.isInteger(S.chosen) && S.answers && Object.keys(S.answers).length;
  const resume = started
    ? h('div', { class: 'card note' },
        h('b', null, S.doneAt ? '지난 진단 답변이 있어요' : '진행 중인 진단이 있어요'),
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
        h('li', null, h('b', null, '가게 인터뷰 '), h('span', { class: 'muted small' }, '가장 큰 고민과 운영 방식에 맞춰 질문이 달라져요. AI가 찾은 정보는 미리 채워 두고, 모르는 건 "잘 모름"을 누르면 돼요.')))),
    h('div', { class: 'card note small' },
      h('b', null, '입력한 정보는 이렇게 쓰여요'),
      h('ul', { class: 'note-list' },
        h('li', null, '상호명과 주소는 가게 정보를 찾기 위해 OpenRouter를 거쳐 AI(Anthropic Claude)에 전달돼요.'),
        h('li', null, '같은 가게를 다시 찾을 때를 위해, 찾은 공개 정보는 서버에 3일 동안 임시 보관돼요.'),
        h('li', null, '인터뷰 답변은 서버로 보내지 않고 이 브라우저에만 저장돼요.'))),
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
function optionLabel(options, value) {
  return (options || []).find((o) => o.v === value)?.label ?? value;
}
function answerText(q, a, c) {
  if (!a) return '-';
  if (a.s === 'unknown') return q.unknownLabel || STATUS_LABEL.unknown;
  if (a.s === 'na') return q.naLabel || STATUS_LABEL.na;
  const v = a.v;
  const approx = a.s === 'approx' ? ' (대략)' : '';
  const money = (x, unit) => (parseNum(x) === null ? null : `${fmt(parseNum(x))}${unit ? ` ${unit}` : ''}`);
  switch (q.type) {
    case 'choice': {
      const val = v?.value ?? v;
      const label = optionLabel(resolve(q.options, c), val);
      return v?.detail ? `${label} (${v.detail})` : label;
    }
    case 'multi': return (v || []).join(', ');
    case 'text': return v;
    case 'number': return `${v} ${q.unit || ''}${approx}`;
    case 'money': return `${money(v, q.unit) || '-'}${approx}`;
    case 'group':
      return q.fields.filter((f) => !f.when || f.when(c, v)).map((f) => {
        const x = v?.[f.key];
        if (x == null || x === '' || (Array.isArray(x) && !x.length)) return null;
        const t = f.type === 'choice' ? optionLabel(f.options, x) : f.type === 'multi' ? x.join(', ') : f.type === 'money' ? money(x, f.unit) : f.type === 'number' ? `${x} ${f.unit || ''}` : x;
        return `${f.short || resolve(f.label, c)}: ${t}`;
      }).filter(Boolean).join(' · ') + approx;
    case 'split': {
      const names = { hall: '홀', takeout: '포장', delivery: '배달' };
      return Object.keys(names).filter((k) => v?.[k]?.on).map((k) => (parseNum(v[k].pct) !== null ? `${names[k]} ${v[k].pct}%` : names[k])).join(' · ') + approx;
    }
    case 'rows':
      return (v || []).map((r, i) => {
        const parts = q.columns.map((col) => {
          const x = r?.[col.key];
          if (x == null || String(x).trim() === '') return null;
          return col.type === 'text' ? x : `${col.type === 'money' ? fmt(parseNum(x) ?? x) : x}${col.unit ? ` ${col.unit}` : ''}`;
        }).filter(Boolean);
        return parts.length ? `${q.rowLabels[i]} ${parts.join(' ')}` : null;
      }).filter(Boolean).join(' / ') + approx;
    case 'costs': {
      const items = resolve(q.items, c);
      return items.map((it) => (parseNum(v?.[it.key]) !== null ? `${it.label} ${money(v[it.key], q.unit)}` : null)).filter(Boolean).join(' · ') + approx;
    }
    case 'channels':
      return q.items.map((it) => (String(v?.[it.key] || '').trim() ? `${it.label}: ${v[it.key]}` : null)).filter(Boolean).join(' · ');
    case 'reviews': {
      const praise = [...(v?.praise || []), v?.praiseText].filter((x) => String(x || '').trim());
      const bad = [...(v?.complaints || []), v?.complaintsText].filter((x) => String(x || '').trim());
      return [praise.length ? `칭찬: ${praise.join(', ')}` : null, bad.length ? `불평: ${bad.join(', ')}` : null].filter(Boolean).join(' / ');
    }
    case 'menucost': {
      if (v?.know === 'unknown') {
        const items = (v.items || []).filter((x) => x?.name).map((x) => [x.name, money(x.price, '원'), x.size, x.use ? `1회 ${x.use}` : null].filter(Boolean).join(' '));
        return `잘 몰라요${items.length ? ` → ${items.join(' / ')}` : ''}`;
      }
      const inc = (v?.includes || []).length ? ` (${v.includes.join('·')} 포함)` : '';
      return `${v?.know === 'approx' ? '대략 ' : ''}${money(v?.amount, '원') || '-'}${inc}`;
    }
    default: return String(v ?? '');
  }
}

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
  show(
    h('div', { class: 'card' },
      h('h2', null, '인터뷰를 마쳤어요'),
      h('p', null, `${name}에 대한 질문 ${total}개에 답해 주셨어요.${problem ? ` 가장 큰 고민은 "${problem}"예요.` : ''}`),
      h('p', { class: 'small muted', style: { margin: 0 } }, '답변은 이 브라우저에만 저장돼 있어요.')),
    sols.length
      ? [
          h('h3', { class: 'section-title' }, `맞춤 솔루션 ${sols.length}개`),
          h('p', { class: 'small muted' }, '답변에서 바로 확인된 것부터 정리했어요. ★★★ 우선 개선 · ★★ 이번 주 실행 · ★ 조건부 실험'),
          sols.map(solutionCard),
        ]
      : h('div', { class: 'card note small' }, '지금 답변에서는 바로 고칠 기본 문제가 보이지 않았어요.'),
    h('details', { class: 'card all-answers' },
      h('summary', null, `내 답변 전체 보기 (${total}개)`),
      pages.map((p) => h('div', { class: 'answer-group' },
        h('h3', null, resolve(p.title, c)),
        h('ul', { class: 'answers' }, p.questions.map((q) => h('li', null,
          h('span', { class: 'a-q' }, resolve(q.title, c)),
          h('span', { class: 'a-v' }, answerText(q, getA(q.id), c)))))))),
    h('div', { class: 'card note small' },
      h('b', null, '다음 단계 '),
      '지금 솔루션은 기본 서비스·손님 앞 기본·반찬과 잔반·비용 기록을 먼저 다뤄요. 나머지 답변과 AI가 찾은 공개 정보를 함께 분석하는 핵심 진단과 실행 계획을 준비하고 있어요.'),
  );
  setNavbar(
    btn('답변 고치기', () => { S.pageId = PAGES[0].id; S.doneAt = null; save(); location.hash = '#/survey'; }),
    btn('처음부터 다시', () => { S = {}; save(); location.hash = '#/'; }, true),
  );
}
route();
