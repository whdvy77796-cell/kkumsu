// 매출올려드림 AI · 상호명·주소 → AI 가게 찾기 → 맞는지 확인 → 가게 상황에 맞춘 인터뷰
import {
  PAGES, PROBLEMS, STATUS_LABEL, COST_RECORD_TIP,
  buildCtx, visiblePages, isAnswered, splitCheck, parseNum, resolve, answerText,
} from './questions.js';
import { buildSolutions, LEVEL } from './solutions.js';
import { PROMO } from './promo.js';
import { PAY } from './pay-config.js';
import { redactReport, packageSize, FREE_SOLUTIONS } from './paywall.js';
import { BUSINESS, businessReady } from './business.js';
import { makePageStart } from './page-start.js';
import { makeStoreTools } from './store-tools.js';
import { makeDiagnosisStart } from './diagnosis-start.js';
import { makeHomeExample } from './home-example.js';
import { makeHomeExplainer } from './home-explainer.js';
import { makeHomePricing } from './home-pricing.js';
import { makeHomeFaq } from './home-faq.js';
import { makeHomeReadiness } from './home-readiness.js';
import { setupHomeLogo } from './logo-home.js';
import { makeAccountUI } from './account-ui.js';
import { allowOwnerHashChange } from './account-navigation.js';
import { makeAiAccessPanel } from './ai-access-ui.js';

const view = document.getElementById('view');
const navbar = document.getElementById('navbar');
const navbarInner = document.getElementById('navbarInner');
const storeName = document.getElementById('storeName');
const toastEl = document.getElementById('toast');
setupHomeLogo(document, window);

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
  document.body.classList.toggle('has-navbar', list.length > 0);
}
// 앞으로 가는 주요 버튼에는 화살표(→)를 붙인다 (모양만, 글자는 그대로)
const GO_LABELS = ['다음', 'AI 보고서 만들기', '보고서 보기', '진행 상황 보기', '무료 진단 시작', '무료로 페이지 만들기'];
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
      err.status = res.status;
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
  const linked = /^#\/r\/([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{16,100})$/.exec(hash);
  const policy = { '#/terms': 'terms', '#/privacy': 'privacy', '#/refund': 'refund' }[hash];
  const manage = /^#\/manage\/([A-Za-z0-9_-]{22})$/.exec(hash);
  const reportStore = /^#\/report-store\/([A-Za-z0-9_-]{22})$/.exec(hash);
  const ownerEdit = /^#\/my-stores\/([A-Za-z0-9_-]{22})$/.exec(hash);
  // 화면마다 넓이·배치를 다르게 하려고 body에 화면 이름을 남긴다.
  document.body.dataset.page = linked ? 'report' : policy ? 'policy' : (ownerEdit || hash === '#/my-stores') ? 'account' : ({ '#/find': 'find', '#/page-search': 'find', '#/page-confirmed': 'find', '#/page-questions': 'find', '#/page-preview': 'find', '#/page-edit': 'find', '#/survey': 'survey', '#/done': 'done', '#/report': 'report', '#/sample': 'report' })[hash] || 'home';
  if (linked) renderLinked(linked[1], linked[2]);
  else if (manage) storeTools.renderManage(manage[1]);
  else if (reportStore) storeTools.renderReport(reportStore[1]);
  else if (ownerEdit) { storeName.textContent = ''; accountUI.renderAccountEdit(ownerEdit[1]); }
  else if (hash === '#/my-stores') { storeName.textContent = ''; accountUI.renderDashboard(); }
  else if (policy) renderPolicy(policy);
  else if (hash === '#/sample') renderSample();
  else if (hash === '#/page-search') pageStartFlow.renderSearch();
  else if (hash === '#/page-confirmed') pageStartFlow.renderConfirmed();
  else if (hash === '#/page-questions') pageStartFlow.renderQuestions();
  else if (hash === '#/page-preview') pageStartFlow.renderPreview();
  else if (hash === '#/page-edit') pageStartFlow.renderEdit();
  else if (hash === '#/page-publish') pageStartFlow.renderPublish();
  else if (hash === '#/page-published') pageStartFlow.renderPublished();
  else if (hash === '#/diagnosis-start') diagnosisStartFlow.render();
  else if (hash === '#/find') renderFind();
  else if (hash === '#/survey') renderSurvey();
  else if (hash === '#/done') renderDone();
  else if (hash === '#/report') renderReport();
  else renderHome();
}
window.addEventListener('hashchange', (event) => {
  // 계정 편집의 미저장 내용은 뒤로 가기·로고·메뉴 이동 시 먼저 확인한다.
  if (!allowOwnerHashChange(event, accountUI, history)) return;
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

const storeTools = makeStoreTools({ h, show, setNavbar, btn, post, onDeleted: id => pageStartFlow.clearPublication(id), onUpdated: (id, data) => pageStartFlow.recordPublicationUpdate(id, data) });
const accountUI = makeAccountUI({ h, show, setNavbar, btn, post, fetcher: (url, options) => fetch(url, options), storeName,
  getDraftResume: () => { const info = pageStartFlow.info(); return info.draftStatus === 'ready' && /^#\/page-(preview|edit|publish)$/.test(info.resumeHash) ? info.resumeHash : ''; },
});
const pageStartFlow = makePageStart({ h, show, setNavbar, btn, post, storeName, onPublished: (id, data) => storeTools.renderPublished(id, data) });
let diagnosisFindAuthorized = false;
const diagnosisStartFlow = makeDiagnosisStart({
  h, show, setNavbar, btn, storeName,
  getState: () => S,
  confirmOverwrite: () => window.confirm('새 진단을 시작하면 이 브라우저의 기존 진단 답변과 결과가 지워집니다. 계속할까요?'),
  begin: (name, address) => {
    S = { name, address, answers: {}, findProtected: true };
    save();
    diagnosisFindAuthorized = true;
    location.hash = '#/find';
  },
});

// ───────── 1. 첫 화면: 상호명·주소
// 첫 화면의 '무료 진단 시작': 가게 입력 칸으로 이동해 바로 입력하게 한다
let wantStart = false;
function focusStart() {
  const card = document.getElementById('startCard');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => {
    const empty = [...card.querySelectorAll('input[type="text"]')].find((x) => !x.value.trim());
    (empty || card.querySelector('input[type="text"]'))?.focus({ preventScroll: true });
  }, 420);
}
function goStart() {
  if ((location.hash || '#/') === '#/') { focusStart(); return; }
  wantStart = true;
  location.hash = '#/';
}
// 무료와 유료의 차이 (설문을 시작하기 전에 안내)
function plansCard() {
  const off = PAY.mode === 'off';
  return h('section', { class: 'card plans-card', id: 'plans' },
    h('h2', null, '무료 진단과 맞춤 실행 패키지'),
    h('p', { class: 'small muted' }, '설문을 시작하기 전에 무엇이 무료이고 무엇이 유료인지 먼저 알려드려요.'),
    h('div', { class: 'plans' },
      h('div', { class: 'plan plan-free' },
        h('div', { class: 'plan-name' }, '무료 핵심 진단'),
        h('div', { class: 'price-tag' }, h('b', { class: 'price-now' }, '0원')),
        h('ul', { class: 'check-list' },
          h('li', null, '한 줄 진단과 핵심 숫자'),
          h('li', null, '가장 중요한 문제와 지금 바로 할 일'),
          h('li', null, '인터넷에서 본 우리 가게 (평점·후기·주변 경쟁점)'),
          h('li', null, '숫자로 본 우리 가게 (매출·비용·이익 계산)'),
          h('li', null, '우선 개선안 목록과 1순위 개선안 전체'))),
      h('div', { class: 'plan plan-paid' },
        h('div', { class: 'plan-name' }, '맞춤 실행 패키지', h('span', { class: 'plan-chip' }, '보고서 1건')),
        priceTag(),
        h('ul', { class: 'check-list' },
          h('li', null, '모든 개선안의 실행 방법·확인 근거·기대 효과'),
          h('li', null, '개선안마다 담당·비용과 기간·준비물·확인 지표'),
          h('li', null, '실행 계획과 수익 구조·메뉴·고객 경험 연결 분석'),
          h('li', null, 'PDF 저장 · 90일 다시 보기 링크 · 결제 영수증')))),
    h('p', { class: 'small plans-note' }, off
      ? '결제는 준비 중이에요. 준비가 끝나기 전에 만든 보고서는 실행 자료까지 전부 무료로 보여드려요.'
      : `무료 진단을 먼저 보고, 실행 패키지는 보고서 화면에서 원할 때만 결제해요. 토스페이먼츠 카드·간편결제.${PAY.mode === 'test' ? ' (지금은 테스트 결제 모드라 실제로 돈이 나가지 않아요.)' : ''}`),
    h('a', { class: 'btn small', href: '#/sample' }, '샘플 보고서로 미리 보기'));
}

function renderHome() {
  storeName.textContent = '';
  const existing = pageStartFlow.info();
  const hint = h('div', { class: 'hint', role: 'alert' }, '');
  const nameIn = h('input', { type: 'text', name: 'name', value: existing.name, maxlength: 60, placeholder: '예: 골목분식', autocomplete: 'organization', enterkeyhint: 'next' });
  const addrIn = h('input', { type: 'text', name: 'address', value: existing.address, maxlength: 120, placeholder: '예: 서울 마포구 망원로 12', autocomplete: 'street-address', enterkeyhint: 'go' });
  const consent = h('input', { type: 'checkbox', id: 'pageSearchConsent' });
  const go = () => {
    const name = nameIn.value.trim().replace(/\s+/g, ' ');
    const address = addrIn.value.trim().replace(/\s+/g, ' ');
    if (!name) { hint.textContent = '상호명을 입력해 주세요.'; nameIn.focus(); return; }
    if (address.length < 4) { hint.textContent = '주소를 입력해 주세요. 동·도로명까지 적으면 더 정확해요.'; addrIn.focus(); return; }
    if (!consent.checked) { hint.textContent = '가게 정보를 찾기 위한 외부 전송에 동의해 주세요.'; consent.focus(); return; }
    if (pageStartFlow.busy()) { hint.textContent = '진행 중인 요청 또는 확인되지 않은 공개 요청을 먼저 확인해 주세요.'; return; }
    hint.textContent = '';
    pageStartFlow.begin(name, address);
  };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addrIn.focus(); } });
  addrIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } });
  const pendingDiagnosis = S.findProtected && S.name && S.address && !Number.isInteger(S.chosen)
    ? h('div', { class: 'card note resume' }, h('b', null, '진단 가게 검색을 확인해 주세요'),
        h('p', { class: 'small', style: { margin: '4px 0 8px' } }, S.name),
        h('a', { class: 'btn small', href: '#/find' }, '진단 검색 이어보기')) : null;
  const pageSearchWarning = (existing.status === 'pending' && !pageStartFlow.busy()) || existing.status === 'uncertain'
    ? h('div', { class: 'card warn small' }, '이전 가게 조회가 이미 처리됐을 수 있어요. 자동 재시도하지 않았으며, 같은 가게를 다시 검색하면 비용이 중복될 수 있어요.') : null;

  show(
    h('section', { class: 'hero' },
      h('h1', null, 'AI 시대,', h('br'), '우리 가게가 ', h('span', { class: 'hero-highlight' }, "'추천'"), ' 되는 방법.'),
      h('h2', { class: 'hero-sub' }, '손님이 AI에게 물을 때,', h('br', { class: 'hero-break-mobile' }), ' 우리 가게도 ', h('span', { class: 'hero-highlight' }, '발견될 수 있도록'), '.'),
      h('p', { class: 'hero-intro' }, '손님이 물어볼 만한 질문과', h('br', { class: 'hero-break-mobile' }), ' 우리 가게가 그 답이 되는 이유를 담아,', h('br'), ' AI가 읽기 쉬운 ', h('span', { class: 'hero-highlight' }, '가게 소개 페이지'), '를 만들고 여기봐ai에 배포해 드려요.'),
      h('p', { class: 'hero-desc' }, '여기봐AI는 AI가 찾은 가게 정보와 사장님의 답변을 바탕으로 소개 페이지와 고객 예상 질문·답변을 만들어요. AI가 찾은 정보는 틀릴 수 있으니 내용을 직접 확인하고 수정한 뒤 공개해 주세요.'),
      h('div', { class: 'hero-actions' }, h('button', { class: 'btn primary go', type: 'button', onclick: focusStart }, '무료로 페이지 만들기')),
      h('p', { class: 'hero-note' }, '회원가입 없이 시작할 수 있어요'),
      h('p', { class: 'small muted page-stage-note' }, '베타 기간에는 공개와 QR·소개글을 무료로 이용할 수 있어요. 검색 노출과 AI 추천은 보장하지 않아요.')),
    h('section', { class: 'ai-access-intro', 'aria-label': 'AI와 검색엔진의 가게 정보 접근' },
      h('h2', { class: 'ai-access-intro-title' }, '손님은 ', h('span', { class: 'ai-access-intro-emphasis' }, '간판'), '을 보고,', h('br'), 'AI는 ', h('span', { class: 'ai-access-intro-emphasis' }, '여기봐AI'), '를 읽습니다'),
      h('p', { class: 'ai-access-intro-text' }, h('span', { class: 'ai-access-intro-emphasis' }, 'AI·검색 봇'), '이 등록된 ', h('span', { class: 'ai-access-intro-emphasis' }, '여기봐 AI 가게 페이지'), '에 접근할 수 있도록 설정되어 있어요.'),
      h('p', { class: 'ai-access-intro-caveat' }, '실제 접근 여부와 주기는 다를 수 있으며, AI 추천·인용은 보장하지 않아요.')),
    makeAiAccessPanel({ h, fetcher: (url, options) => fetch(url, options), kind: 'site' }),
    makeHomeReadiness(h),
    makeHomeExample(h),
    makeHomeExplainer(h, focusStart),
    pageSearchWarning, pendingDiagnosis,
    paidReportRecoveryCard(),
    h('form', { class: 'card', id: 'startCard', novalidate: true, onsubmit: (e) => { e.preventDefault(); go(); } },
      h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, '무료로 페이지 만들기')),
      h('h2', null, '가게 이름과 주소를 알려주세요'),
      h('p', { class: 'small muted start-intro' }, '몇 가지 질문에 답하면, 우리 가게의 특징을', h('br'), ' 고객과 AI가 이해하기 쉬운 소개 페이지로 만들어드립니다.'),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, '상호명'), nameIn),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, '주소'), addrIn),
      h('p', { class: 'small muted' }, '동의 후 AI가 인터넷에 공개된 가게 정보와 특징을 찾아요. 보통 30초~1분 정도 걸려요.'),
      h('label', { class: 'page-consent' }, consent,
        h('span', null, '상호명과 주소를 OpenRouter, 연결된 AI와 웹 검색 제공자에게 전송하는 데 동의합니다.')),
      h('p', { class: 'tiny muted page-consent-note' }, '조회 결과는 서버에 최대 3일, 이 브라우저 탭의 임시 저장소에 보관될 수 있어요. 사진이나 인터뷰 답변은 보내지 않아요.'),
      hint,
      h('button', { class: 'btn primary block go page-next-button', type: 'submit' }, '다음')),
    h('div', { class: 'card note small privacy-card' },
      h('b', null, '입력한 정보는 이렇게 쓰여요'),
      h('p', null, '동의하신 상호명과 주소로 공개 정보를 찾아요. 질문 답변과 확인한 정보를 AI에 보내 초안을 만들 때는 별도로 동의받아요. 초안은 비공개이며 AI가 정리한 내용은 사장님이 직접 확인해 주세요.'),
      h('p', { style: { margin: '8px 0 0' } }, h('a', { href: '#/privacy' }, '개인정보처리방침 자세히 보기'))),
    makeHomePricing(h, focusStart),
    makeHomeFaq(h),
  );
  setNavbar(btn('무료로 페이지 만들기', focusStart, true));
  if (wantStart) { wantStart = false; setTimeout(focusStart, 60); }
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
  if (S.findProtected && !diagnosisFindAuthorized) {
    const consent = h('input', { type: 'checkbox', id: 'diagnosisRetryConsent' });
    const hint = h('div', { class: 'hint', role: 'alert' }, '');
    const retry = () => {
      if (!consent.checked) { hint.textContent = '재검색을 위한 외부 전송에 동의해 주세요.'; return; }
      diagnosisFindAuthorized = true;
      route();
    };
    show(h('div', { class: 'card' },
      h('h2', null, '가게 검색을 다시 확인해 주세요'),
      h('p', null, '이전 검색이 이미 처리됐을 수 있어 자동으로 다시 보내지 않았어요. 다시 검색하면 크레딧이 중복 사용될 수 있어요.'),
      h('label', { class: 'page-consent' }, consent, h('span', null, '가게 이름과 주소를 OpenRouter, 연결된 AI와 웹 검색 제공자에게 다시 전송하는 데 동의합니다.')),
      hint, h('button', { class: 'btn primary', type: 'button', onclick: retry }, '동의하고 다시 검색')));
    setNavbar(btn('처음으로', () => { location.hash = '#/'; }));
    return;
  }
  diagnosisFindAuthorized = false;
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
      ? h('div', { class: 'card note small' }, 'AI가 찾은 정보로 업종·판매 방식·메뉴 등을 미리 채워 두었어요. 맞으면 그대로 두고, 틀린 곳만 고쳐 주세요.')
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
      // 앞 단계에 아직 답하지 않은 질문이 있으면(순서가 바뀌었거나 답에 따라 질문이 새로 생긴 경우) 그 단계로 먼저 보낸다
      const firstMissing = now.pages.findIndex((p) => p.questions.some((q) => !isAnswered(q, getA(q.id), cc)));
      if (firstMissing >= 0 && firstMissing < now.idx) {
        S.pageId = now.pages[firstMissing].id;
        save();
        drawPage(store, false);
        window.scrollTo(0, 0);
        toast('아직 답하지 않은 질문이 있는 단계로 왔어요. 이 단계를 마치면 끝나요.', 4000);
        return;
      }
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
      h('li', null, '보고서는 서버에 7일(맞춤 실행 패키지를 결제하면 결제일부터 90일), 인터넷 조사 결과는 3일 동안 보관했다가 자동으로 지워요.'),
      PAY.mode === 'off' ? null : h('li', null, h('b', null, '핵심 진단은 무료예요. '), `나머지 개선안의 실행 방법·실행 계획·PDF 저장은 보고서를 본 뒤 원할 때만 맞춤 실행 패키지(${won(PAY.amount)})로 열 수 있어요.`),
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
async function saveReportPdf(data, button, opts = {}) {
  // PDF 저장은 맞춤 실행 패키지에 포함 (잠긴 보고서는 저장하지 않는다)
  if (data?.locked) { toast('PDF 저장은 맞춤 실행 패키지에 포함돼요. 결제하면 바로 저장할 수 있어요.', 4000); focusPayCard(); return; }
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
    box.append(h('div', { class: 'pdf-brand' }, h('img', { src: logo, alt: '여기봐 AI' })));
    for (const child of view.children) {
      if (child.classList.contains('no-print') || child.classList.contains('warn') && child.querySelector('a[href="#/done"]')) continue;
      // 개선안 묶음은 카드마다 따로 배치해야 쪽 사이에서 잘리지 않는다
      if (child.classList.contains('sol-list')) { for (const c of child.children) box.append(c.cloneNode(true)); continue; }
      // 맨 아래 홍보 안내도 항목마다 나눠 배치한다 (제목은 첫 항목과 붙여서 제목만 쪽 끝에 남지 않게)
      if (child.classList.contains('promo')) {
        const intro = child.querySelector(':scope > .promo-intro');
        child.querySelectorAll(':scope > .promo-item').forEach((it, i) => {
          box.append(h('section', { class: 'promo' }, i === 0 && intro ? intro.cloneNode(true) : null, it.cloneNode(true)));
        });
        continue;
      }
      box.append(child.cloneNode(true));
    }
    box.querySelectorAll('details').forEach((d) => { d.open = true; });
    box.querySelectorAll('details.sources-box > summary').forEach((s) => { s.replaceWith(h('div', { class: 'sub-title' }, '출처')); });
    box.querySelectorAll('.no-print').forEach((n) => n.remove());
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
      || (el.parentElement === document.documentElement && el !== document.head && el !== document.body);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const PW = 210; const PH = 297; const M = 10; const W = PW - M * 2; const BOTTOM = PH - 12; const GAP = 3;
    let y = M;
    // 그림으로 들어가도 링크(출처·안내 링크)는 누를 수 있게, 링크 자리에 PDF 링크를 따로 붙인다
    const linkRects = (el) => {
      const top = el.getBoundingClientRect();
      return [...el.querySelectorAll('a[href]')]
        .filter((a) => /^https?:\/\//i.test(a.getAttribute('href') || ''))
        .flatMap((a) => [...a.getClientRects()].map((r) => ({ url: a.getAttribute('href'), x: r.left - top.left, y: r.top - top.top, w: r.width, h: r.height })));
    };
    // 자를 곳과 링크 자리는 그림 도구가 실제로 그리는 복제본(PC 폭 1024)에서 잰다. 휴대폰 화면 기준으로 재면 그림과 어긋난다.
    const measure = (el) => ({ width: el.getBoundingClientRect().width, cuts: cutPoints(el), links: linkRects(el) });
    const place = (canvas, sy, sh, links = [], scale = 1) => {
      const part = document.createElement('canvas');
      part.width = canvas.width;
      part.height = sh;
      const ctx = part.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, part.width, part.height);
      ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
      const hmm = (sh * W) / canvas.width;
      doc.addImage(part.toDataURL('image/jpeg', 0.86), 'JPEG', M, y, W, hmm, undefined, 'FAST');
      const mmPerPx = W / canvas.width;
      for (const l of links) {
        const t = l.y * scale;
        const b = (l.y + l.h) * scale;
        if (t < sy - 2 || b > sy + sh + 2) continue; // 이 조각 안에 온전히 들어간 링크만
        doc.link(M + l.x * scale * mmPerPx, y + Math.max(0, t - sy) * mmPerPx, l.w * scale * mmPerPx, (b - t) * mmPerPx, { url: l.url });
      }
      y += hmm + GAP;
    };
    for (const block of [...box.children]) {
      let geo = null;
      const canvas = await window.html2canvas(block, {
        scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true, windowWidth: 1024, ignoreElements: skipForPdf,
        onclone: (_doc, el) => { try { geo = measure(el); } catch { geo = null; } },
      });
      if (!canvas.width || !canvas.height) continue;
      if (!geo?.width) geo = measure(block);
      const scale = canvas.width / geo.width;
      const links = geo.links;
      const pxPerMm = canvas.width / W;
      const hmm = canvas.height / pxPerMm;
      const room = BOTTOM - y;
      if (hmm <= room) { place(canvas, 0, canvas.height, links, scale); continue; }
      if (hmm <= BOTTOM - M && room < (BOTTOM - M) * 0.4) {
        // 남은 자리가 적으면 카드를 통째로 다음 쪽에서 시작
        doc.addPage(); y = M;
        place(canvas, 0, canvas.height, links, scale);
        continue;
      }
      // 남은 자리가 넉넉하거나 한 쪽보다 긴 카드: 빈 공간이 생기지 않게 글줄 경계에서 나눠 이어 붙인다
      const cuts = geo.cuts.map((c) => Math.round(c * scale));
      let sy = 0;
      while (sy < canvas.height) {
        if (BOTTOM - y < 25) { doc.addPage(); y = M; }
        const maxPx = Math.floor((BOTTOM - y) * pxPerMm);
        let end = Math.min(canvas.height, sy + maxPx);
        if (end < canvas.height) {
          const ok = cuts.filter((c) => c > sy + 60 && c <= end);
          if (ok.length) end = ok[ok.length - 1];
        }
        place(canvas, sy, end - sy, links, scale);
        sy = end;
        if (sy < canvas.height) { doc.addPage(); y = M; }
      }
    }
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(opts.sample ? 'www.kkumsu.com - SAMPLE' : 'www.kkumsu.com', M, PH - 5);
      doc.text(`${i} / ${pages}`, PW - M, PH - 5, { align: 'right' });
    }
    doc.save(opts.fileName || pdfFileName(data));
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

// ───────── 보고서 맨 아래 고정 안내: 사장님이 직접 시작할 수 있는 매장 홍보 방법
// AI가 만드는 내용이 아니라 모든 보고서에 똑같이 붙는다. 문구·링크는 promo.js 에서 고친다.
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 아래 방법으로 다시 */ }
  const ta = h('textarea', { readonly: true, 'aria-hidden': 'true', style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
function promoSection() {
  const link = (l) => (l ? h('a', { class: 'promo-link', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.text) : null);
  const withLink = (text, l) => [text, l ? ' ' : null, link(l)];
  const item = (it) => {
    const prompt = it.prompt ? h('pre', { class: 'promo-prompt-text' }, it.prompt.text) : null;
    const copy = async () => {
      if (await copyText(it.prompt.text)) { toast('요청 문장을 복사했어요. AI 대화창에 붙여 넣고 [ ] 안을 채워 주세요.', 4000); return; }
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(prompt);
      sel.removeAllRanges();
      sel.addRange(range);
      toast('자동 복사가 안 돼서 문장을 선택해 두었어요. 길게 눌러 복사해 주세요.', 5000);
    };
    return h('div', { class: 'promo-item' },
      h('div', { class: 'promo-head' }, h('span', { class: 'promo-no' }, it.no), h('h3', null, it.title)),
      it.cost ? h('span', { class: 'promo-cost' }, it.cost) : null,
      h('p', { class: 'promo-lead' }, withLink(it.lead, it.leadLink)),
      h('ol', { class: 'promo-steps' }, it.steps.map((s, i) => h('li', null,
        h('span', { class: 'promo-step-no', 'aria-hidden': 'true' }, String(i + 1)),
        h('div', null, h('b', null, s.title), h('p', null, withLink(s.body, s.link)))))),
      prompt
        ? h('div', { class: 'promo-prompt' },
            h('div', { class: 'promo-prompt-head' }, h('b', null, it.prompt.title), h('button', { class: 'btn small no-print', type: 'button', onclick: copy }, '복사하기')),
            prompt)
        : null,
      it.note ? h('p', { class: 'promo-note' }, withLink(it.note, it.noteLink)) : null);
  };
  return h('section', { class: 'promo', 'aria-label': PROMO.title },
    h('div', { class: 'promo-intro' },
      h('div', { class: 'promo-kicker' }, PROMO.kicker),
      h('h2', null, PROMO.title),
      h('p', null, PROMO.lead)),
    PROMO.items.map(item));
}

// ───────── 무료 핵심 진단 / 유료 맞춤 실행 패키지 (잠금 규칙: paywall.js · 결제 설정: pay-config.js)
const won = (n) => `${fmt(n)}원`;
const salePct = () => (PAY.list > PAY.amount ? Math.floor(((PAY.list - PAY.amount) / PAY.list) * 100) : 0);
// 잠긴 자리에 흐리게 그릴 가짜 글자 (진짜 내용은 서버가 결제 전에는 보내지 않는다)
const FILLER = ['가게', '손님', '메뉴', '가격', '주문', '기록', '확인', '오픈', '마감', '직원', '사진', '리뷰', '답글', '안내', '계산', '재료', '원가', '비용', '시간', '이번 주', '한 달', '표시', '정리', '준비', '시작', '비교', '체크', '매출', '자리', '대기'];
function filler(seed, words = 9) {
  let x = (seed * 7919 + 104729) % 100003;
  const out = [];
  for (let i = 0; i < words; i++) {
    x = (x * 48271 + 11) % 2147483647;
    out.push(FILLER[x % FILLER.length]);
  }
  return `${out.join(' ')}.`;
}
function lockedLines(n, seed, numbered = false) {
  return h(numbered ? 'ol' : 'ul', { class: numbered ? 'sol-steps' : 'ev-list' },
    Array.from({ length: Math.max(1, n || 0) }, (_, i) => h('li', null, filler(seed + i, 6 + ((seed + i) % 6)))));
}
function lockedBox(label, ...kids) {
  return h('div', { class: 'locked' },
    h('div', { class: 'locked-blur', 'aria-hidden': 'true' }, kids),
    h('div', { class: 'locked-badge' }, h('span', { class: 'lock-icon', 'aria-hidden': 'true' }), h('span', null, label)));
}
function lockedSolutionCard(sol, i) {
  const L = sol.locked || {};
  const meta = ['담당', '비용과 기간', '준비물', '확인 지표'].slice(0, L.meta || 0);
  const seed = (i + 2) * 31;
  return h('div', { class: `card sol sol-${sol.stars} sol-locked` },
    h('div', { class: 'sol-head' },
      sol.stars ? h('span', { class: 'stars' }, '★'.repeat(sol.stars)) : null,
      h('span', { class: 'sol-level' }, LEVEL[sol.stars]),
      h('span', { class: 'sol-area' }, sol.area),
      sol.web ? h('span', { class: 'sol-web' }, '인터넷 조사 반영') : null),
    h('h3', null, sol.title),
    sol.problem ? h('p', { class: 'sol-row' }, h('b', null, '발견한 문제 '), sol.problem) : null,
    lockedBox(`실행 방법 ${L.actions || 0}단계${L.evidence ? ` · 근거 ${L.evidence}개` : ''}${meta.length ? ' · 담당·비용·지표' : ''} · 결제하면 열려요`,
      L.evidence ? [h('div', { class: 'sub-title' }, '확인 근거'), lockedLines(L.evidence, seed)] : null,
      h('div', { class: 'sub-title' }, '실행 방법'),
      lockedLines(L.actions, seed + 7, true),
      L.effect ? h('p', { class: 'sol-row sol-effect' }, h('b', null, '기대 효과 '), filler(seed + 19, 8)) : null,
      meta.length ? h('dl', { class: 'sol-meta' }, meta.map((t, k) => [h('dt', null, t), h('dd', null, filler(seed + 23 + k, 4))])) : null));
}
const ANALYSIS_LABEL = { profit: '수익 구조', menu: '메뉴', customer: '고객 경험', connection: '어떻게 이어지나요' };
function lockedAnalysis(keys) {
  if (!keys?.length) return null;
  return h('section', { class: 'card' },
    h('h2', null, '수익 구조·메뉴·고객 경험 연결 분석'),
    lockedBox(`연결 분석 ${keys.length}가지 · 결제하면 열려요`,
      keys.map((k, i) => h('div', { class: 'analysis-item' }, h('h3', null, ANALYSIS_LABEL[k] || k), h('p', { style: { margin: 0 } }, filler(i * 13 + 3, 22))))));
}
function lockedPlan(L = {}) {
  const col = (title, n, seed) => h('div', { class: 'plan-col' }, h('h3', null, title), h('ul', null, Array.from({ length: Math.max(1, n || 0) }, (_, i) => h('li', null, filler(seed + i, 5)))));
  const total = (L.thisWeek || 0) + (L.nextWeeks || 0) + (L.thisMonth || 0);
  const block = (on, title, seed) => (on ? h('div', { class: 'rep-block' }, h('h3', null, title), h('p', { style: { margin: 0 } }, filler(seed, 18))) : null);
  return h('section', { class: 'card' },
    h('h2', null, '실행 계획'),
    lockedBox(`실행 계획 ${total}개 항목 · 마케팅·예산·성과 확인 · 결제하면 열려요`,
      h('div', { class: 'plan-cols' }, col('이번 주', L.thisWeek, 101), col('2~3주 차', L.nextWeeks, 202), col('한 달 안', L.thisMonth, 303)),
      block(L.marketing, '마케팅 실행안', 404), block(L.budget, '예산', 505), block(L.check, '성과 확인 방법', 606)));
}

let payConsent = false;
function packageItems(data) {
  const z = packageSize(data);
  return [
    `개선안 ${z.solutions}개의 실행 방법 ${z.steps}단계와 확인 근거·기대 효과`,
    '개선안마다 담당·비용과 기간·준비물·확인 지표',
    `실행 계획 (이번 주·2~3주 차·한 달 안 ${z.planItems}개 항목, 마케팅·예산·성과 확인)`,
    '수익 구조·메뉴·고객 경험 연결 분석',
    'PDF 저장 (직원과 공유·인쇄)',
    '결제일부터 90일 동안 다시 보기 링크 · 결제 영수증',
  ];
}
function priceTag(big = false) {
  const pct = salePct();
  return h('div', { class: `price-tag${big ? ' big' : ''}` },
    pct ? h('s', { class: 'price-list' }, `정가 ${won(PAY.list)}`) : null,
    h('b', { class: 'price-now' }, won(PAY.amount)),
    pct ? h('span', { class: 'price-off' }, `${pct}% 할인 중`) : null);
}
function focusPayCard() {
  const card = document.getElementById('payCard');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}
function payCard(data, { sample = false } = {}) {
  const off = PAY.mode === 'off';
  const agree = h('input', { type: 'checkbox', class: 'pay-agree' });
  agree.checked = payConsent;
  agree.addEventListener('change', () => {
    payConsent = agree.checked;
    document.querySelectorAll('.pay-agree').forEach((x) => { x.checked = payConsent; });
  });
  const go = h('button', { class: `btn primary block pay-go${sample ? ' go' : ''}`, type: 'button' }, sample ? '우리 가게 무료 진단 시작' : `${won(PAY.amount)} 결제하고 전체 보기`);
  go.addEventListener('click', () => (sample ? goStart() : startPayment(data, go)));
  return h('section', { class: 'card paycard', id: sample ? null : 'payCard' },
    h('div', { class: 'paycard-kicker' }, sample ? '샘플 · 실제 보고서에서는 여기서 결제해요' : '맞춤 실행 패키지'),
    h('h2', null, '여기서부터는 바로 실행할 자료예요'),
    h('p', { class: 'small' }, '무료 진단에서 찾은 문제를 어떻게 고칠지, 누가·언제·얼마로·무엇을 확인하며 할지 정리했어요.'),
    h('ul', { class: 'check-list' }, packageItems(data).map((x) => h('li', null, x))),
    priceTag(true),
    PAY.mode === 'test' && !sample ? h('p', { class: 'test-pay' }, '테스트 결제 모드예요. 실제로 돈이 나가지 않아요.') : null,
    off && !sample ? h('p', { class: 'small muted' }, '결제는 준비 중이에요.') : null,
    sample || off ? null : h('label', { class: 'consent pay-consent' }, agree,
      h('span', null, '결제하면 바로 보고서가 열려 단순 변심 환불이 어려운 점을 확인했어요. 보고서가 열리지 않는 등의 오류는 환불해 드려요. ', h('a', { href: '#/refund' }, '환불 정책'))),
    off && !sample ? null : go,
    sample ? null : h('p', { class: 'tiny muted pay-fine' }, '토스페이먼츠 결제창에서 카드·간편결제로 결제해요. 카드 정보는 매출올려드림에 저장되지 않아요. ', h('a', { href: '#/terms' }, '이용약관')));
}
function payReminder(data) {
  const z = packageSize(data);
  return h('section', { class: 'card pay-reminder no-print' },
    h('p', { class: 'strong' }, `아직 잠긴 실행 자료: 개선안 ${z.solutions}개 · 실행 방법 ${z.steps}단계 · 실행 계획 · PDF 저장`),
    priceTag(),
    h('button', { class: 'btn primary block', type: 'button', onclick: focusPayCard }, '결제 안내 보기'));
}
function paidReportRecoveryLinks() {
  const links = [];
  // Include the legacy entry without replacing it; only exact rid/token duplicates collapse.
  for (const p of [S.paidReportLink, ...(Array.isArray(S.paidReportLinks) ? S.paidReportLinks : [])]) {
    if (p?.rid && p?.token && !links.some((x) => x.rid === p.rid && x.token === p.token)) links.push(p);
  }
  return links;
}
function paidReportRecoveryCard() {
  const links = paidReportRecoveryLinks();
  return links.length ? h('div', { class: 'card note' }, links.map((p, i) =>
    h('p', null, h('a', { class: 'btn small', href: `#/r/${p.rid}.${p.token}` },
      `결제한 보고서 다시 보기${links.length > 1 ? ` ${i + 1}` : ''}`)))) : null;
}
function paidCard(data) {
  const p = data.payment || {};
  let when = '';
  try { when = p.approvedAt ? new Date(p.approvedAt).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }) : ''; } catch { /* 날짜 없음 */ }
  const link = data.rid && data.token ? `${location.origin}/#/r/${data.rid}.${data.token}` : null;
  return h('div', { class: 'card paid-card no-print' },
    h('b', null, '맞춤 실행 패키지가 열렸어요'),
    h('p', { class: 'small', style: { margin: '4px 0 10px' } }, [p.amount ? `결제 ${won(p.amount)}` : null, when, p.test ? '테스트 결제(실제 청구 없음)' : null].filter(Boolean).join(' · ')),
    h('div', { class: 'btn-row' },
      link ? h('button', { class: 'btn small', type: 'button', onclick: async () => { toast((await copyText(link)) ? '다시 보기 링크를 복사했어요.' : link, 6000); } }, '다시 보기 링크 복사') : null,
      p.receiptUrl ? h('a', { class: 'btn small', href: p.receiptUrl, target: '_blank', rel: 'noopener noreferrer' }, '영수증 보기') : null),
    h('p', { class: 'tiny muted', style: { margin: '10px 0 0' } }, '다시 보기 링크는 결제일부터 90일 동안 열려요. 링크를 가진 사람은 누구나 볼 수 있으니 필요한 사람에게만 보내 주세요.'));
}

// ───────── 결제: 주문 만들기 → 토스페이먼츠 결제창(같은 창에서 이동) → 돌아오면 서버 승인
const TOSS_SDK = 'https://js.tosspayments.com/v2/standard';
let payBusy = false;
function guestKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return `guest-${[...a].map((x) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[x % 62]).join('')}`;
}
async function startPayment(data, button) {
  if (payBusy) return;
  if (PAY.mode === 'off') { toast('지금은 결제를 받지 않아요.'); return; }
  if (!payConsent) {
    focusPayCard();
    document.querySelector('#payCard .pay-agree')?.focus({ preventScroll: true });
    toast('결제 전에 환불 안내를 확인하고 체크해 주세요.', 4000);
    return;
  }
  if (!data?.rid || !data?.token) { toast('보고서 번호가 없어요. 보고서를 다시 만든 뒤 결제해 주세요.', 5000); return; }
  const seq = navSeq;
  payBusy = true;
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = '결제창을 여는 중…'; }
  try {
    const o = await post('/api/pay', { action: 'order', rid: data.rid, token: data.token }, 20000);
    if (o.paid) { await reopenReport(data, seq); return; }
    if (seq !== navSeq) return;
    if (!window.TossPayments) await loadScript(TOSS_SDK);
    if (seq !== navSeq) return;
    if (!window.TossPayments) throw new Error('결제창을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
    S.pendingPay = { orderId: o.orderId, rid: data.rid, token: data.token, at: Date.now() };
    save();
    await openTossCheckout(o);
  } catch (e) {
    console.error('[pay]', e);
    if (seq !== navSeq) return;
    const canceled = /CANCEL/i.test(String(e?.code || ''));
    toast(canceled ? '결제를 취소했어요.' : e?.message || '결제창을 열지 못했어요. 잠시 후 다시 시도해 주세요.', 5000);
  } finally {
    payBusy = false;
    if (button) { button.disabled = false; button.textContent = label; }
  }
}
// 토스페이먼츠 결제창 열기
//  - 결제위젯 키(…_gck_…): 결제창형. 토스 결제창(팝업/오버레이)에서 결제수단을 고르고 결제하기를 누르면 결제 요청
//  - API 개별 연동 키(…_ck_…): 결제창(구버전). 카드·간편결제 통합결제창으로 같은 창에서 이동
// 어느 쪽이든 끝나면 successUrl(?pay=success)로 돌아오고, 서버가 금액을 확인한 뒤 승인한다.
let tossWindow = null;
async function openTossCheckout(o) {
  const successUrl = `${location.origin}/?pay=success`;
  const failUrl = `${location.origin}/?pay=fail`;
  const tp = window.TossPayments(o.clientKey);
  const customerKey = window.TossPayments.ANONYMOUS || guestKey();
  if (/_gck_/.test(o.clientKey)) {
    const widgets = tp.widgets({ customerKey });
    await widgets.setAmount({ currency: 'KRW', value: o.amount });
    try { await tossWindow?.destroy?.(); } catch { /* 이미 닫힘 */ }
    tossWindow = await widgets.renderPaymentWindow({ orderName: o.orderName, variantKey: { paymentMethod: 'DEFAULT', agreement: 'AGREEMENT' } });
    tossWindow.on('cancel', () => {
      toast('결제를 취소했어요. 원할 때 다시 결제할 수 있어요.', 4000);
      try { tossWindow?.destroy?.(); } catch { /* 이미 닫힘 */ }
      tossWindow = null;
    });
    tossWindow.on('paymentRequest', async () => {
      try {
        await widgets.requestPayment({ orderId: o.orderId, orderName: o.orderName, successUrl, failUrl });
      } catch (e) {
        console.error('[pay]', e);
        toast(/CANCEL/i.test(String(e?.code || '')) ? '결제를 취소했어요.' : e?.message || '결제를 요청하지 못했어요. 다시 시도해 주세요.', 5000);
      }
    });
    return;
  }
  await tp.payment({ customerKey }).requestPayment({
    method: 'CARD',
    amount: { currency: 'KRW', value: o.amount },
    orderId: o.orderId,
    orderName: o.orderName,
    successUrl,
    failUrl,
    windowTarget: 'self',
    card: { flowMode: 'DEFAULT', useEscrow: false, useCardPoint: false, useAppCardOnly: false },
  });
}
async function reopenReport(data, seq = navSeq) {
  const fresh = await post('/api/pay', { action: 'view', rid: data.rid, token: data.token }, 20000);
  if (S.report?.data?.rid === fresh.rid) { S.report.data = { ...fresh, token: data.token }; save(); }
  if (seq !== navSeq) return;
  route();
}
// 결제창에서 돌아왔을 때 (?pay=success|fail)
async function handlePayReturn() {
  const qs = new URLSearchParams(location.search);
  const kind = qs.get('pay');
  if (kind !== 'success' && kind !== 'fail') return false;
  history.replaceState(null, '', `${location.pathname}#/report`);
  if (kind === 'fail') {
    const code = qs.get('code') || '';
    S.pendingPay = null;
    save();
    route();
    toast(/CANCEL/i.test(code) ? '결제를 취소했어요. 원할 때 다시 결제할 수 있어요.' : qs.get('message') || '결제를 마치지 못했어요.', 6000);
    return true;
  }
  S.pendingPay = { ...(S.pendingPay || {}), paymentKey: qs.get('paymentKey'), orderId: qs.get('orderId'), amount: qs.get('amount') };
  save();
  await confirmPayment();
  return true;
}
async function confirmPayment() {
  const seq = navSeq;
  const p = S.pendingPay;
  if (!p?.paymentKey) { route(); return; }
  document.body.dataset.page = 'report';
  show(h('div', { class: 'card loading' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('h2', null, '결제를 확인하고 있어요'),
    h('p', { class: 'small' }, '창을 닫지 말고 잠시만 기다려 주세요.')));
  setNavbar();
  try {
    let data;
    for (let i = 0; ; i++) {
      try {
        data = await post('/api/pay', { action: 'confirm', paymentKey: p.paymentKey, orderId: p.orderId, amount: p.amount, rid: p.rid, token: p.token }, 45000);
        break;
      } catch (e) {
        if (e.code === 'BUSY' && i < 6) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        throw e;
      }
    }
    if (S.pendingPay === p) S.pendingPay = null;
    const token = data.token || p.token;
    const mine = S.report?.data?.rid && S.report.data.rid === data.rid;
    if (mine) S.report.data = { ...data, token };
    // Keep access even if confirmation finishes after leaving, without moving the current screen.
    const links = paidReportRecoveryLinks();
    if (!links.some((p) => p.rid === data.rid && p.token === token)) links.push({ rid: data.rid, token });
    S.paidReportLinks = links;
    save();
    if (seq !== navSeq) return;
    if (mine) route();
    else location.hash = `#/r/${data.rid}.${token}`;
    toast('결제가 완료됐어요. 맞춤 실행 패키지와 PDF 저장이 열렸어요.', 6000);
  } catch (e) {
    if (seq !== navSeq) return;
    show(h('div', { class: 'card warn' },
      h('h2', null, '결제를 확인하지 못했어요'),
      h('p', null, e.message || '잠시 후 다시 확인해 주세요.'),
      h('p', { class: 'small' }, '같은 결제는 두 번 빠져나가지 않아요. 계속 안 되면 결제 영수증의 주문번호와 함께 고객센터로 알려 주세요.'),
      h('p', { class: 'tiny muted' }, `주문번호: ${p.orderId || '-'} · 오류 코드: ${e.code || '알 수 없음'}`)));
    setNavbar(btn('보고서로', () => { S.pendingPay = null; save(); route(); }), btn('다시 확인', () => confirmPayment(), true));
  }
}

// ───────── 보고서 화면
function reportBody(data, { stale = false, sample = false, linked = false } = {}) {
  const r = data.report || {};
  const locked = !!data.locked;
  const when = (() => {
    try { return new Date(data.createdAt).toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Seoul' }); } catch { return ''; }
  })();
  const planCol = (title, items) => (items?.length ? h('div', { class: 'plan-col' }, h('h3', null, title), h('ul', null, items.map((x) => h('li', null, x)))) : null);
  const analysis = locked ? [] : [['수익 구조', r.analysis?.profit], ['메뉴', r.analysis?.menu], ['고객 경험', r.analysis?.customer], ['어떻게 이어지나요', r.analysis?.connection]].filter(([, t]) => t);
  const b = data.bench;
  const sols = r.solutions || [];
  const freeSols = locked ? sols.slice(0, FREE_SOLUTIONS) : sols;
  const lockedSols = locked ? sols.slice(FREE_SOLUTIONS) : [];
  const mine = !sample && !linked;
  return [
    stale && mine
      ? h('div', { class: 'card warn no-print' },
          h('b', null, reportOutdated() ? '보고서가 더 자세해졌어요. ' : '답변이 바뀌었어요. '),
          reportOutdated() ? '이 보고서는 예전 형식(개선안 4~6개)이에요. ' : '이 보고서는 바뀌기 전 답변으로 만든 거예요. ',
          h('a', { href: '#/done' }, reportOutdated() ? '새 형식으로 다시 만들기' : '바뀐 답변으로 다시 만들기'))
      : null,
    data.mock ? h('div', { class: 'card note small' }, '(모의 응답) 실제 AI가 아니라 화면 점검용으로 만든 보고서예요.') : null,
    data.paid && !sample ? paidCard(data) : null,
    h('div', { class: 'rep-head' },
      h('div', { class: 'rep-kicker' }, sample ? '샘플 보고서 · 예시 데이터' : locked ? 'AI 진단 보고서 · 무료 핵심 진단' : 'AI 진단 보고서 · 베타'),
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

    locked
      ? lockedAnalysis(r.analysis?.locked)
      : analysis.length
        ? h('section', { class: 'card' },
            h('h2', null, '수익 구조·메뉴·고객 경험 연결 분석'),
            analysis.map(([t, x]) => h('div', { class: 'analysis-item' }, h('h3', null, t), h('p', { style: { margin: 0 } }, x))))
        : null,

    h('h2', { class: 'section-title' }, `우선 개선안 ${sols.length}개`),
    h('p', { class: 'small muted' }, `★★★ 우선 개선 · ★★ 이번 주 실행 · ★ 조건부 실험 · 확인 필요. 근거 표시: 답변 = 사장님 답변, 계산 = 서버 계산, 공개 정보 = AI가 인터넷에서 찾은 정보, 추정 = AI의 판단. "인터넷 조사 반영"은 인터넷 후기·평판에서 찾은 개선점이에요.${locked ? ` 무료 진단에서는 ${FREE_SOLUTIONS}순위 개선안을 전부 보여드리고, 나머지는 제목과 발견한 문제까지 보여드려요.` : ''}`),
    h('div', { class: 'sol-list' }, freeSols.map(aiSolutionCard)),
    locked ? payCard(data, { sample }) : null,
    lockedSols.length ? h('div', { class: 'sol-list' }, lockedSols.map(lockedSolutionCard)) : null,

    locked
      ? lockedPlan(r.plan?.locked)
      : h('section', { class: 'card' },
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

    locked && !sample && PAY.mode !== 'off' ? payReminder(data) : null,

    // 맨 아래 고정 안내 (AI가 만든 내용이 아니라 모든 보고서에 똑같이 붙는다. 내용은 promo.js)
    promoSection(),

    mine && !stale ? h('p', { class: 'small no-print', style: { textAlign: 'center' } },
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        const warn = data.paid ? '\n\n결제한 이 보고서는 다시 보기 링크로 계속 볼 수 있어요. 새로 만든 보고서의 실행 패키지는 따로 결제해야 해요.' : '';
        if (!confirm(`같은 답변으로 보고서를 새로 만들까요? 2~4분쯤 걸려요.${warn}`)) return;
        startReport({ refresh: true });
        route();
      } }, '보고서 새로 만들기')) : null,
    !sample && data.rid && data.token ? h('p', { class: 'tiny no-print', style: { textAlign: 'center', margin: '4px 0 0' } },
      h('button', { class: 'linklike', type: 'button', onclick: () => deleteServerCopy(data) }, '서버에 보관된 이 보고서 지우기')) : null,
  ];
}
async function deleteServerCopy(data) {
  const seq = navSeq;
  const paidNote = data.paid ? ' 결제한 보고서라면 다시 보기 링크가 더 이상 열리지 않아요(결제 기록은 법에 따라 5년 보관해요).' : ' 지우면 이 보고서로는 결제할 수 없어요.';
  if (!confirm(`서버에 보관된 이 보고서를 지울까요? 이 브라우저에 저장된 화면은 남아 있어요.${paidNote}`)) return;
  try {
    await post('/api/pay', { action: 'delete', rid: data.rid, token: data.token }, 20000);
    if (S.report?.data?.rid === data.rid) {
      const { rid, token, ...rest } = S.report.data;
      S.report.data = rest;
      save();
    }
    const links = paidReportRecoveryLinks();
    if (links.some((p) => p.rid === data.rid)) {
      S.paidReportLinks = links.filter((p) => p.rid !== data.rid);
      if (S.paidReportLink?.rid === data.rid) S.paidReportLink = null;
      save();
    }
    if (seq !== navSeq) return;
    toast('서버에 보관된 보고서를 지웠어요.', 4000);
    route();
  } catch (e) {
    if (seq !== navSeq) return;
    toast(e.message || '지우지 못했어요. 잠시 후 다시 시도해 주세요.', 5000);
  }
}

function drawReport(data, stale, opts = {}) {
  show(...reportBody(data, { stale, ...opts }));
  const saveBtn = btn('저장하기', () => saveReportPdf(data, saveBtn), true);
  const payBtn = h('button', { class: 'btn primary', type: 'button' }, `${won(PAY.amount)} 결제하기`);
  payBtn.addEventListener('click', () => (payConsent ? startPayment(data, payBtn) : (focusPayCard(), toast('환불 안내를 확인하고 체크한 뒤 결제해 주세요.', 3500))));
  setNavbar(
    opts.linked ? btn('처음으로', () => { location.hash = '#/'; }) : btn('완료 화면', () => { location.hash = '#/done'; }),
    data.locked ? (PAY.mode === 'off' ? null : payBtn) : saveBtn,
  );
}

// 다시 보기 링크 (#/r/보고서번호.토큰) : 다른 기기에서도 서버에 보관된 보고서를 연다
async function renderLinked(rid, token) {
  const seq = navSeq;
  storeName.textContent = '';
  show(h('div', { class: 'card loading' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('h2', null, '보고서를 불러오고 있어요')));
  setNavbar();
  try {
    const data = await post('/api/pay', { action: 'view', rid, token }, 20000);
    if (seq !== navSeq) return;
    data.token = token;
    if (S.report?.data?.rid === rid) {
      S.report.data = { ...data, token: S.report.data.token || token };
      save();
    }
    storeName.textContent = data.store?.name || '';
    drawReport(data, false, { linked: true });
  } catch (e) {
    if (seq !== navSeq) return;
    show(h('div', { class: 'card warn' }, h('h2', null, '보고서를 열지 못했어요'), h('p', null, e.message || '잠시 후 다시 시도해 주세요.')));
    setNavbar(btn('처음으로', () => { location.hash = '#/'; }, true));
  }
}

// ───────── 샘플 보고서 (실제 가게 '연어로' 보고서, 사장님 동의로 공개 · 예시 데이터)
let sampleData = null;
let sampleView = 'paid';
async function renderSample() {
  const seq = navSeq;
  storeName.textContent = '샘플 보고서';
  if (!sampleData) {
    show(h('div', { class: 'card loading' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('h2', null, '샘플 보고서를 불러오고 있어요')));
    setNavbar();
    try {
      const r = await fetch('/sample/report.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      sampleData = await r.json();
    } catch {
      if (seq !== navSeq) return;
      show(h('div', { class: 'card warn' }, h('h2', null, '샘플 보고서를 불러오지 못했어요'), h('p', null, '잠시 후 다시 시도해 주세요.')));
      setNavbar(btn('처음으로', () => { location.hash = '#/'; }, true));
      return;
    }
    if (seq !== navSeq) return;
  }
  const data = sampleView === 'free' ? redactReport(sampleData) : sampleData;
  const tab = (v, label) => h('button', { class: sampleView === v ? 'on' : '', type: 'button', 'aria-pressed': String(sampleView === v), onclick: () => { sampleView = v; renderSample(); } }, label);
  const pdfBtn = h('button', { class: 'btn small', type: 'button' }, '샘플 PDF 저장');
  pdfBtn.addEventListener('click', () => saveReportPdf(sampleData, pdfBtn, { sample: true, fileName: '매출올려드림_샘플보고서_연어로.pdf' }));
  show(
    h('div', { class: 'card sample-bar' },
      h('div', { class: 'sample-badge' }, '샘플 보고서 · 예시 데이터'),
      h('p', { class: 'small', style: { margin: '8px 0 12px' } }, '실제 가게(대구 동성로 연어로) 사장님 동의를 받아 공개한 예시예요. 숫자와 내용은 이 가게 기준이라 우리 가게와 달라요. 개인 연락처는 일부 가렸어요.'),
      h('div', { class: 'seg no-print', role: 'group', 'aria-label': '보기 방식' }, tab('free', '무료 진단 화면'), tab('paid', '결제 후 전체 화면')),
      h('p', { class: 'tiny muted no-print', style: { margin: '10px 0 0' } }, sampleView === 'free'
        ? '무료 진단에서는 이렇게 1순위 개선안까지 보이고, 나머지 실행 자료는 흐리게 가려져요.'
        : '맞춤 실행 패키지를 결제하면 이렇게 모든 개선안의 실행 방법과 실행 계획이 열리고 PDF로 저장할 수 있어요.'),
      sampleView === 'paid' ? h('div', { class: 'no-print', style: { marginTop: '10px' } }, pdfBtn) : null),
    ...reportBody(data, { sample: true }),
  );
  setNavbar(btn('처음으로', () => { location.hash = '#/'; }), btn('무료 진단 시작', goStart, true));
}

// ───────── 이용약관 · 개인정보처리방침 · 환불 정책
const biz = (k, fallback = '사업자 정보 등록 후 표시') => String(BUSINESS[k] || '').trim() || fallback;
const POLICY_DATE = '2026년 11월 11일';
function policyDoc(title, intro, sections, effectiveDate = POLICY_DATE) {
  return [
    h('div', { class: 'policy-head' }, h('h1', null, title), h('p', { class: 'small muted' }, `시행일 ${effectiveDate}`), intro ? h('p', null, intro) : null),
    sections.map(([t, ...items]) => h('section', { class: 'card policy' },
      h('h2', null, t),
      items.map((x) => (Array.isArray(x) ? h('ul', { class: 'note-list' }, x.map((y) => h('li', null, y))) : h('p', null, x))))),
  ];
}
function operatorLine() {
  return `운영자: ${biz('name', '여기봐 AI 운영자')} · 대표 ${biz('owner')} · 사업자등록번호 ${biz('bizNo')} · 주소 ${biz('address')} · 고객센터 ${biz('phone')} · 이메일 ${biz('email')}`;
}
function renderPolicy(kind) {
  storeName.textContent = '';
  const price = `${won(PAY.amount)}(정가 ${won(PAY.list)}, 할인 중)`;
  const docs = {
    terms: () => policyDoc('이용약관', null, [
      ['제1조 (목적)', `이 약관은 ${biz('name', '매출올려드림 AI 운영자')}(이하 '운영자')가 제공하는 매출올려드림 AI(www.kkumsu.com, 이하 '서비스')를 이용하는 조건과 절차, 운영자와 이용자의 권리·의무를 정합니다.`],
      ['제2조 (서비스 내용)',
        ['가게 소개: 별도 동의 후 가게 정보와 답변으로 비공개 초안을 만들고 수정할 수 있습니다. 게시 권한과 내용을 확인하고 공개에 별도 동의하면 가게 소개 페이지를 공개할 수 있으며 베타 기간에는 0원입니다. 실제 결제는 진행하지 않습니다. QR과 공유 문구도 제공합니다. 검색 수집·노출과 AI 추천은 보장하지 않습니다.',
          '무료 핵심 진단: 상호명·주소, 인터뷰 답변, 인터넷 공개 정보를 바탕으로 AI가 만든 진단 보고서 중 핵심 진단(한 줄 진단과 핵심 숫자, 가장 중요한 문제, 지금 바로 할 일, 위생·안전, 인터넷에서 본 우리 가게, 숫자로 본 우리 가게, 우선 개선안 목록과 1순위 개선안, 확인할 것)을 무료로 제공합니다.',
          `맞춤 실행 패키지(유료, 보고서 1건 ${price}): 같은 보고서의 나머지 개선안별 확인 근거·실행 방법·기대 효과·담당·비용과 기간·준비물·확인 지표, 수익 구조·메뉴·고객 경험 연결 분석, 실행 계획, PDF 저장, 결제일부터 90일 동안의 다시 보기 링크를 제공합니다.`,
          '보고서는 AI가 이용자의 답변과 인터넷 공개 정보로 만든 참고 자료예요. 매출·이익 증가 같은 결과를 보장하지 않으며, 중요한 결정 전에는 장부와 현장에서 확인해야 합니다.']],
      ['제3조 (이용 방법)', '가게 정보 입력과 미리보기는 회원가입 없이 시작할 수 있습니다. 간편 로그인은 선택 사항이며, 기존 페이지를 계정에 연결하려면 관리 비밀번호로 소유를 확인해야 합니다. 진행 중인 답변과 보고서는 이용자의 브라우저에 저장되며, 브라우저 저장소를 지우면 다시 볼 수 없을 수 있습니다. 결제한 보고서는 다시 보기 링크로 결제일부터 90일 동안 열 수 있습니다.'], 
      ['제4조 (가격과 결제)', `맞춤 실행 패키지의 가격은 보고서 1건당 ${price}이며 부가세가 포함된 최종 결제 금액입니다. 결제는 토스페이먼츠 결제창(카드·간편결제)으로 하며, 결제가 승인되면 즉시 해당 보고서의 잠긴 내용이 열립니다. 가격이 바뀌어도 이미 결제한 건에는 영향이 없습니다.`],
      ['제5조 (청약철회와 환불)', '맞춤 실행 패키지는 결제와 동시에 제공이 시작되는 디지털 콘텐츠예요. 단순 변심에 의한 청약철회 제한과 환불 기준은 환불 정책에 따릅니다. 이 내용은 결제 전에 안내하고 동의를 받습니다.'],
      ['제6조 (이용자의 의무)', ['다른 사람의 가게를 사칭하거나 권한 없는 내용, 타인의 개인정보, 허위·불법 자료를 게시하거나 서비스 운영을 방해해서는 안 됩니다.', '받은 보고서를 다른 사람에게 판매하거나, 다시 보기 링크를 대가를 받고 배포해서는 안 됩니다.']],
      ['제7조 (서비스 변경과 중단)', '운영자는 서비스 개선을 위해 화면과 기능을 바꿀 수 있습니다. 시스템 점검·장애 등으로 서비스를 일시 중단할 수 있으며, 이미 결제한 보고서를 볼 수 없게 된 경우에는 환불 정책에 따라 환불합니다.'],
      ['제8조 (책임)', '운영자는 AI 진단 결과의 정확성이나 특정 사업 성과를 보장하지 않습니다. 다만 운영자의 고의 또는 과실로 이용자에게 손해가 생긴 경우에는 관련 법령에 따라 책임을 집니다.'],
      ['제9조 (분쟁 해결)', '서비스 이용과 관련한 문의·불만은 고객센터로 접수해 주세요. 분쟁이 생기면 관련 법령과 소비자분쟁해결기준에 따라 해결하며, 소송은 민사소송법에 따른 관할 법원에 제기합니다.'],
      ['운영자 정보', operatorLine()],
    ], '2026년 11월 11일'),
    refund: () => policyDoc('환불 정책', '맞춤 실행 패키지는 결제가 승인되는 즉시 보고서의 잠긴 내용이 열리는 디지털 콘텐츠예요.', [
      ['결제 전에 확인할 수 있어요', ['무료 핵심 진단으로 우리 가게 보고서의 핵심 내용과 1순위 개선안 전체를 먼저 볼 수 있어요.', '샘플 보고서(예시 데이터)로 결제 후 화면을 미리 볼 수 있어요.']],
      ['단순 변심 환불', '결제 후 바로 열람이 시작되므로, 전자상거래 등에서의 소비자보호에 관한 법률 제17조 제2항 제5호에 따라 단순 변심에 의한 청약철회(환불)는 제한돼요. 이 사실은 결제 전에 안내하고 동의를 받아요.'],
      ['전액 환불해 드려요', ['결제했는데 보고서가 열리지 않거나 보관 기간(결제일부터 90일) 안에 볼 수 없는 경우', '같은 보고서가 중복 결제된 경우', `보고서 내용이 서비스 안내와 현저히 다른 경우(예: 실행 방법이 비어 있음). 공급받은 날부터 3개월 이내, 그 사실을 안 날 또는 알 수 있었던 날부터 30일 이내에 요청할 수 있어요(같은 법 제17조 제3항).`]],
      ['환불 요청 방법', `고객센터(${biz('email')} · ${biz('phone')})로 주문번호(결제 영수증에 있어요)와 사유를 알려 주세요. 환불이 결정되면 3영업일 안에 결제를 취소해요. 카드사 반영에는 영업일 기준 3~7일이 걸릴 수 있어요.`],
      ['운영자 정보', operatorLine()],
    ]),
    privacy: () => policyDoc('개인정보처리방침', `${biz('name', '여기봐 AI 운영자')}(이하 '운영자')는 개인정보 보호법에 따라 이용자의 개인정보를 보호하고 관련 고충을 신속하게 처리하기 위해 이 방침을 둡니다. 가입 없이 시작할 수 있으며, 선택적으로 간편 로그인할 때 보안 쿠키와 서버 세션을 사용해요.`, [
      ['1. 처리하는 정보와 목적', [
        'Google 로그인·가게 관리: Google에서 로그인 인증과 서비스별 식별값을 받아 가명 식별값으로 변환해 계정을 구분하고, 사용자가 연결한 가게 식별번호를 관리해요. 로그인 유지와 보안을 위해 필수 쿠키와 서버 세션을 사용해요. Google 비밀번호를 받지 않으며 Google 이메일이나 프로필 정보는 요청하지 않아요. Google 액세스 토큰은 인증 처리에 일시적으로 사용하고 별도 저장하지 않아요. Google에서 받은 식별값과 이를 변환한 값은 로그인·가게 연결 및 보안 목적으로만 사용하며, 광고나 AI 학습에 사용하지 않아요. 로그인 요청 주소 등 기술 정보는 호스팅 사업자의 접속·보안 로그에 기록될 수 있어요.',
        '가게 찾기: 상호명과 주소를 받아 AI가 인터넷 공개 정보로 가게를 찾는 데 써요. 후보가 맞지 않아 다시 찾을 때 별도 동의를 받으면 사용자가 선택적으로 입력한 공개 사이트 주소와 맞지 않는 이전 후보의 이름·주소도 검색에 참고해요.',
        '가게 소개 초안: 별도 동의를 받은 경우에만 상호명·주소, 사장님이 확인한 특징, AI가 검색에서 찾았으나 확인되지 않은 가게 특징과 질문 답변을 AI에 보내 비공개 소개와 고객 예상 질문·답변 초안을 만들어요. 초안 생성 서버는 답변 원문이나 생성된 초안을 별도 캐시에 저장하지 않도록 설계돼 있어요. 서비스 운영·보안 로그와 외부 AI 제공자의 처리·보관 정책은 별도로 적용될 수 있어요.',
        '가게 소개 공개: 공개에 별도 동의한 가게명·가게 주소·제목·소개·섹션·질문과 답변을 누구나 볼 수 있는 페이지와 목록에 저장합니다. 질문과 답변에는 실제 검색 기록이 아닌 예상 질문이 포함될 수 있습니다. 관리 비밀번호는 원문이 아닌 해시 형태로 저장하며, 수정과 삭제에 사용합니다. 신고 사유와 중복 신고 방지를 위한 IP 해시를 처리할 수 있습니다. 검색엔진과 제3자는 공개 정보를 수집하거나 복사할 수 있습니다.',
        'AI 진단 보고서: 이용자가 동의한 경우에만 인터뷰 답변(가게 운영 방식, 매출·비용, 사장님·가족 근무 시간 등)을 받아 보고서를 만드는 데 써요. 답변 원문은 서버에 따로 저장하지 않고, 답변으로 만든 보고서(계산값 포함)만 보관해요.',
        '결제: 주문번호, 결제 고유번호(토스페이먼츠가 주는 값), 결제 금액, 결제 일시, 결제 수단 종류를 결제 확인·환불·분쟁 처리와 법정 기록 보존에 써요. 카드 번호 같은 결제 정보는 토스페이먼츠가 처리하며 운영자는 받지 않아요.',
        '이용량 관리: 접속 IP 주소를 되돌릴 수 없게 바꾼 값(해시)으로 하루 이용 횟수를 세고, 중복 요청 방지를 위한 임시 잠금을 사용해요.',
        'AI·검색 봇 접근 현황: 공개 홈·가게 목록·가게 페이지에 접근한 요청의 경로·시각·User-Agent와 IP 주소를 호스팅 로그에서 받아 알려진 봇 여부와 공식 IP 대역 일치를 확인해요. 통계 저장소에는 가게 식별번호, 집계 숫자·시각과 중복 방지용 요청 식별자 해시만 보관하고 IP 주소, 원본 User-Agent와 원본 요청 로그는 저장하지 않아요. Vercel의 접속·보안 로그에는 별도의 처리·보관 정책이 적용될 수 있어요.',
        '브라우저 저장소: 기존 진단의 진행 답변은 localStorage에, 가게 소개 확인·재검색 참고 사이트 주소·질문 답변·초안은 해당 탭의 sessionStorage에 임시 저장될 수 있어요. 브라우저 데이터를 삭제하면 기기의 저장 내용을 지울 수 있으나 외부 제공자가 보관한 자료까지 지워지는 것은 아니에요.']],
      ['2. 보관 기간', [
        '간편 로그인 보안 상태: 최대 10분. 로그인 세션: 최대 7일이며, 로그아웃하면 해당 브라우저의 세션을 종료해요.',
        '계정과 가게의 연결: 사용자가 연결을 해제하거나 서비스가 종료될 때까지. 연결을 해제해도 공개 페이지와 기존 관리 비밀번호는 별도로 남아요.',
        '가게 찾기 결과와 인터넷 조사 결과: 3일',
        '공개 가게 소개와 관리 비밀번호 해시: 이용자가 삭제하거나 서비스가 종료될 때까지. 삭제하면 소개 내용, 비밀번호 해시와 신고 사유를 지웁니다. 삭제된 주소의 재사용을 막기 위한 임의 식별번호와 삭제 표시는 서비스 종료까지 남을 수 있습니다. 신고 및 보안에 필요한 정보는 운영과 권리 보호에 필요한 기간 보관될 수 있습니다.',
        '보고서: 만든 날부터 7일. 맞춤 실행 패키지를 결제하면 결제일부터 90일(다시 보기 링크)',
        '결제 기록(주문번호·결제 고유번호·금액·일시·수단·보고서 번호): 5년 (전자상거래법의 대금결제 및 재화 등의 공급에 관한 기록). 보고서 내용은 포함하지 않아요.',
        '이용량 집계(IP 해시): 2일',
        'AI·검색 봇 접근 통계: 중복 방지 요청 식별자 해시는 8일, 일별 통계는 15일, 가게별 누적은 마지막 수신부터 180일. 사이트 전체 누적 통계는 별도로 삭제하거나 초기화할 때까지 보관해요. 가게 페이지를 삭제해도 가게별 통계는 즉시 삭제되지 않고 위 기간이 적용돼요.',
        '위에서 자동 삭제 기간을 정한 항목은 해당 기간이 지나면 저장소에서 지워지도록 설정합니다. 공개 페이지 삭제 후에도 외부 검색 결과나 복사본은 즉시 지워지지 않을 수 있어요.']],
      ['3. 외부 서비스·처리 위탁과 국외 이전', [
        'Google: 사용자가 Google 로그인을 선택하면 Google이 인증을 담당하며, Google의 개인정보 처리방침이 별도로 적용돼요.',
        'OpenRouter, Inc.(미국): AI 요청 중계. 동의한 상호명·주소·재검색 참고 사이트 주소·이전 후보 정보·가게 정보와 질문 답변을 요청할 때 네트워크로 전송해요. 데이터 수집을 허용하지 않는 제공 경로를 요청하지만, 외부 제공자의 보관·삭제는 해당 제공자의 정책이 별도로 적용돼요.',
        'Anthropic, PBC 등 OpenRouter가 연결하는 Claude 모델 제공자(미국): 동의한 정보의 AI 처리.',
        '웹 검색 제공자: 가게 찾기와 재검색에서 동의한 상호·주소와 참고 사이트 주소, 이전 후보 정보가 검색 처리에 전달될 수 있어요. 제공자는 연결 방식에 따라 달라질 수 있으며 각 제공자의 정책이 적용돼요.',
        'Vercel Inc.(미국): 웹사이트와 서버 운영 및 봇 접근을 확인하기 위한 호스팅 로그 전달. 서버 함수는 서울 지역에서 실행돼요. 접속·보안 로그는 Vercel의 별도 정책이 적용될 수 있어요.',
        'Layerbase, LLC(미국, 미국 버지니아): AI·검색 봇 접근 통계의 가게 식별번호, 집계 숫자·시각과 중복 방지용 요청 식별자 해시 저장. 이 통계 저장소에는 IP 주소와 원본 User-Agent를 저장하지 않아요. 백업과 제공자의 접속·보안 로그에는 별도 정책이 적용될 수 있어요.',
        location.hostname === 'kkumsu-git-yeogibwa-account-login-20261111-kkkkkum.vercel.app'
          ? '이 시험 화면의 저장소는 Layerbase(미국 버지니아)이며, 시험 데이터만 사용해요. 백업은 별도 제공자에 저장될 수 있어요.'
          : 'Upstash, Inc.(미국 회사, 주 저장 위치: 일본 도쿄 AWS 데이터센터): 로그인 가명 식별값·세션·가게 연결 정보, 보고서·조사 결과·결제 기록 및 별도 동의한 공개 가게 소개와 관리·신고 정보를 저장해요. 백업과 접속·보안 로그의 보관 위치는 제공자의 정책에 따라 달라질 수 있어요.',
        '토스페이먼츠(주)(대한민국): 결제 처리.',
        '가게 검색과 AI 초안·보고서 요청은 각각의 전송 동의 후 처리하며, 공개 페이지를 게시하면 공개 내용이 저장소와 웹사이트 운영 제공자에게 전송됩니다.']],
      ['4. 이용자의 권리', ['언제든지 개인정보의 열람·정정·삭제·처리정지를 요청할 수 있어요.', '내 가게 관리에서 계정 연결을 해제할 수 있고, 공개 가게 페이지는 기존 관리 비밀번호로 수정하거나 삭제할 수 있어요. 연결 해제는 페이지 삭제가 아니에요. 보고서 화면 맨 아래에서 보관된 보고서를 지울 수 있어요. 결제 기록은 법정 보관 기간 동안 남아요.', `요청: ${biz('privacyEmail', biz('email'))}`]],
      ['5. 안전성 확보 조치', ['모든 통신은 HTTPS로 암호화해요.', '보고서는 추측할 수 없는 보고서 번호와 비밀 토큰이 있어야 열리고, 토큰은 서버에 해시로만 저장해요.', '결제 시크릿 키와 AI 키는 서버에만 두고 화면에 보내지 않아요.']],
      ['6. 개인정보 문의', `담당: 여기봐 AI 개인정보 담당 · 이메일: ${biz('privacyEmail')}`],
      ['7. 방침 변경', '이 방침을 바꾸면 시행일과 함께 이 화면에 알려드려요.'],
      ['운영자 정보', operatorLine()],
    ], '2026년 11월 13일'),
  };
  show(h('div', { class: 'policy-page' }, docs[kind]()));
  setNavbar(btn('처음으로', () => { location.hash = '#/'; }, true));
}

// ───────── 바닥글 (약관·개인정보처리방침·사업자 정보)
function renderFooter() {
  const el = document.getElementById('siteFoot');
  if (!el) return;
  const B = BUSINESS;
  append(clear(el), [
    h('nav', { class: 'foot-links', 'aria-label': '약관과 정책' },
      h('a', { href: '#/terms' }, '이용약관'),
      h('a', { href: '#/privacy' }, h('b', null, '개인정보처리방침')),
      h('a', { href: '#/refund' }, '환불 정책')),
    businessReady()
      ? h('p', { class: 'foot-biz' }, [`상호 ${B.name}`, `대표 ${B.owner}`, `사업자등록번호 ${B.bizNo}`, B.mailOrderNo ? `통신판매업 신고 ${B.mailOrderNo}` : null, `주소 ${B.address}`, `고객센터 ${B.phone}`, `이메일 ${B.email}`, `호스팅 ${B.hosting}`].filter(Boolean).join(' · '))
      : null,
    h('p', { class: 'foot-copy' }, '© 여기봐 AI · 검색 결과는 참고 자료이며 AI 추천을 보장하지 않아요.'),
  ]);
}

renderFooter();
handlePayReturn().then((handled) => { if (!handled) route(); }, () => route());
