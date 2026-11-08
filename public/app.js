// 매출올려드림 AI - 화면 (소개·등록·인터뷰·검토·분석·보고서·보관)
import { h, clear, toast, S, api, deviceCases, rememberCase, forgetCase, tokenFor, resumeLink, saveNow, scheduleSave, setAnswer, setSavedListener, downloadBlob } from './ui.js';
import { QMAP, AREAS, CONCERNS, BIZ_TYPES, SUB_TYPES, WEEKDAYS, TIME_SLOTS, UPLOAD_KINDS } from '/shared/questions.js';
import { visibleQuestions, nextQuestionId, prevQuestionId, progress, makeCtx, resolveOptions, answerText, questionDone, questionResolved, inputSignature } from '/shared/engine.js';
import { compute } from '/shared/calc.js';
import { ENGINE_VERSION } from '/shared/diagnose.js';
import { fmtMan, fmtWon, fmtNum, isNum, parseSpec } from '/shared/format.js';
import { CHANNEL_FIELDS } from '/shared/external.js';
import { renderReport, downloadMeasureCSV } from './report.js';
import { parseNum, fieldInput } from './fields.js';
import { renderFiles, renderExternal, uploadFiles, attachmentsOf } from './screens.js';

const view = document.getElementById('view');
const navbar = document.getElementById('navbar');
const navInner = document.getElementById('navbarInner');
const stepnav = document.getElementById('stepnav');
const storeName = document.getElementById('storeName');

const STANDALONE = () => !!window.__STANDALONE__;
if (STANDALONE()) {
  const bar = document.querySelector('.demo-bar .wrap span');
  if (bar) bar.textContent = 'AI·인터넷 검색·결제 미연결 · 체험판: 이 브라우저에만 저장';
}

setSavedListener((st) => {
  const el = document.getElementById('saveState');
  if (el) el.textContent = st === 'saved' ? '자동 저장됨' : st === 'error' ? '저장 실패 - 다시 시도 중' : '최신 내용으로 다시 불러옴';
  if (st === 'conflict') route();
});

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { if (S.dirty) saveNow(); });
window.addEventListener('beforeprint', () => document.querySelectorAll('details').forEach((d) => { d.dataset.wasOpen = d.open ? '1' : ''; d.open = true; }));
window.addEventListener('afterprint', () => document.querySelectorAll('details').forEach((d) => { d.open = d.dataset.wasOpen === '1'; }));

function setNavbar(...buttons) {
  clear(navInner);
  const bs = buttons.filter(Boolean);
  navbar.hidden = !bs.length;
  navInner.append(...bs);
}

async function route() {
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  setNavbar();
  stepnav.hidden = true;
  try {
    if (!parts.length) return renderIntro();
    if (parts[0] === 'start') return renderStart();
    if (parts[0] === 'open') return openLink(parts[1]);
    if (parts[0] === 'sample') return renderSample(parts[1]);
    if (parts[0] === 'c') {
      if (!(await ensureCase(parts[1]))) return;
      setStepNav(parts[2]);
      switch (parts[2]) {
        case 'interview': return parts[3] === 'done' ? renderInterviewDone() : renderInterview(parts[3]);
        case 'profile': return renderProfile();
        case 'files': return renderFiles(view, { setNavbar });
        case 'external': return renderExternal(view, { setNavbar });
        case 'review': return renderReview();
        case 'analyze': return renderAnalyze();
        case 'report': return renderReportScreen();
        case 'manage': return renderManage();
        default: location.hash = `#/c/${parts[1]}/interview`; return;
      }
    }
    renderIntro();
  } catch (e) {
    showError(e);
  }
}

function showError(e) {
  clear(view).append(h('div', { class: 'card warn' }, h('h2', null, '문제가 생겼어요'), h('p', null, e.message || String(e)),
    h('div', { class: 'btn-row' }, h('a', { class: 'btn', href: '#/' }, '처음으로'))));
}

async function ensureCase(id) {
  if (S.caseId === id && S.data) { storeName.textContent = S.data.profile?.name || ''; return true; }
  if (S.caseId && S.dirty) await saveNow();
  const token = tokenFor(id);
  if (!token) {
    clear(view).append(h('div', { class: 'card' }, h('h2', null, '이어하기 링크가 필요해요'),
      h('p', null, '이 기기에는 이 진단의 접근 정보가 없어요. 처음에 받은 이어하기 링크로 열어주세요.'),
      h('a', { class: 'btn primary', href: '#/' }, '처음 화면에서 링크로 열기')));
    return false;
  }
  return loadCase(id, token);
}

async function loadCase(id, token) {
  S.caseId = id; S.token = token; S.data = null; S.report = null;
  try {
    const r = await api(`/api/cases/${id}`);
    S.data = r.data; S.version = r.version; S.report = r.report; S.reportInputVersion = r.reportInputVersion; S.changes = r.changes || [];
    S.data.settings = S.data.settings || {};
    rememberCase(id, token, S.data.profile?.name);
    storeName.textContent = S.data.profile?.name || '';
    return true;
  } catch (e) {
    S.caseId = null; S.token = null;
    clear(view).append(h('div', { class: 'card warn' }, h('h2', null, '진단 기록을 열 수 없어요'), h('p', null, e.message),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => { forgetCase(id); location.hash = '#/'; } }, '이 기기 목록에서 지우기'), h('a', { class: 'btn', href: '#/' }, '처음으로'))));
    return false;
  }
}

async function openLink(param) {
  const m = String(param || '').match(/^([a-f0-9]{32})\.([A-Za-z0-9_-]{20,100})$/);
  if (!m) return showError(new Error('링크 형식이 올바르지 않아요.'));
  if (await loadCase(m[1], m[2])) {
    history.replaceState(null, '', `#/c/${m[1]}/review`);
    route();
  }
}

const TABS = [['profile', '가게 정보'], ['interview', '인터뷰'], ['files', '자료'], ['external', '외부 정보'], ['review', '답변 확인'], ['report', '보고서'], ['manage', '보관·삭제']];
function setStepNav(active) {
  stepnav.hidden = false;
  clear(stepnav).append(h('div', { class: 'wrap' }, TABS.map(([k, label]) => h('a', { href: `#/c/${S.caseId}/${k}`, class: active === k || (active === 'analyze' && k === 'report') ? 'on' : '' }, label))));
  const on = stepnav.querySelector('a.on');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// ───────────────── 소개
function renderIntro() {
  storeName.textContent = '';
  const saved = deviceCases();
  let linkInput;
  clear(view).append(
    h('section', { class: 'hero' },
      h('h1', null, '우리 가게, 매출이 달라질 방법을 찾다!'),
      h('h2', { class: 'hero-sub' }, '우리 가게, 어디를 바꾸면 더 잘될까요?'),
      h('p', { class: 'hero-desc' }, '직접 가게를 운영한 5년의 경험과 실제 컨설팅 노하우를 담았습니다.'),
      h('p', { class: 'hero-trust' }, '가게에 대한 질문에 답하면, 수익 구조부터 메뉴·마케팅·운영까지 분석해 맞춤 보고서와 실행 전략을 제안합니다.'),
    ),
    h('div', { class: 'btn-row' }, h('a', { class: 'btn primary block', href: '#/start' }, '우리 가게 진단 시작하기')),
    h('div', { class: 'card' },
      h('h2', null, '받게 될 보고서 예시'),
      h('p', { class: 'small muted' }, '가상의 가게 2곳으로 만든 예시예요. 업종과 답변에 따라 질문과 결과가 어떻게 달라지는지 볼 수 있어요.'),
      h('div', { class: 'btn-row' }, h('a', { class: 'btn', href: '#/sample/restaurant' }, '배달 중심 분식집'), h('a', { class: 'btn', href: '#/sample/cafe' }, '매장 중심 카페'))),
    h('div', { class: 'card' },
      h('h2', null, '이렇게 진행돼요'),
      h('ol', { class: 'steps-list' },
        h('li', null, h('b', null, '가게 정보 '), h('span', { class: 'muted small' }, '가게 이름·주소·업종·고민 (2분)')),
        h('li', null, h('b', null, '맞춤 인터뷰 '), h('span', { class: 'muted small' }, '업종과 답변에 따라 질문이 달라져요 (15~25분, 중간 저장)')),
        h('li', null, h('b', null, '자료 추가 '), h('span', { class: 'muted small' }, '메뉴판·매출 파일 등 (선택)')),
        h('li', null, h('b', null, '외부 정보 '), h('span', { class: 'muted small' }, '공개 페이지 확인 내용 기록 (데모: 직접 입력)')),
        h('li', null, h('b', null, '답변 확인 '), h('span', { class: 'muted small' }, '빠진 항목과 서로 맞지 않는 값 재확인')),
        h('li', null, h('b', null, '분석 보고서 '), h('span', { class: 'muted small' }, '핵심 진단, 우선 해결 3가지, 근거')),
        h('li', null, h('b', null, '실행 계획 '), h('span', { class: 'muted small' }, '이번 주 할 일과 효과 확인 방법')))),
    h('div', { class: 'card' },
      h('h2', null, '비용 안내'),
      h('p', null, '지금 데모 버전은 무료이고 결제 기능이 없어요.'),
      h('p', { class: 'small muted' }, '정식 버전은 "무료 기본 진단 + 상세 보고서 건당 결제" 구조를 검토 중이며 가격은 아직 정해지지 않았어요. 유료가 되더라도 인터뷰를 시작하기 전에 먼저 알려드려요.')),
    h('div', { class: 'card' },
      h('h2', null, '입력한 정보는 이렇게 다뤄요'),
      h('ul', { class: 'small' },
        STANDALONE() ? h('li', null, h('b', null, '체험판: '), '서버 없이 이 브라우저에만 저장돼요. 다른 기기나 다른 브라우저에서는 이어서 할 수 없고, 브라우저 데이터를 지우면 자료도 사라져요. 실제 매출 자료 대신 연습용 숫자로 써보세요.') : null,
        h('li', null, '매출·비용·사진은 공개되지 않아요. 이어하기 링크를 가진 사람만 열 수 있어요.'),
        h('li', null, `${STANDALONE() ? '이 브라우저에' : '서버에'} 저장되는 내용은 링크에 들어 있는 열쇠로 암호화돼요. 그래서 링크를 잃어버리면 되찾을 수 없어요.`),
        h('li', null, '언제든 "보관·삭제"에서 내 자료를 모두 지울 수 있어요.'),
        h('li', null, '이 기기의 브라우저에 이어하기 정보가 저장돼요. 공용 컴퓨터라면 마친 뒤 "이 기기에서 지우기"를 눌러주세요.'))),
    h('div', { class: 'card' },
      h('h2', null, '이어서 하기'),
      saved.length ? h('div', { class: 'area-list' }, saved.map((c) => h('a', { href: `#/c/${c.id}/review` }, h('span', null, c.name), h('span', { class: 'muted small' }, new Date(c.updatedAt).toLocaleDateString('ko-KR'))))) : h('p', { class: 'small muted' }, '이 기기에 저장된 진단이 없어요.'),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, '이어하기 링크로 열기'), linkInput = h('input', { type: 'url', placeholder: '받아둔 링크를 붙여넣으세요' })),
      h('button', { class: 'btn', onclick: () => { const m = linkInput.value.match(/#\/open\/([^\s]+)/); if (!m) return toast('링크 형식이 올바르지 않아요.'); location.hash = `#/open/${m[1]}`; } }, '링크로 열기')),
  );
}

// ───────────────── 예시 보고서
async function renderSample(kind) {
  storeName.textContent = '예시 보고서';
  clear(view).append(h('p', null, '예시 보고서를 불러오는 중...'));
  const r = await api(`/api/sample-report?kind=${encodeURIComponent(kind)}`, { noAuth: true });
  clear(view).append(
    renderReport(r.report, r.data, { sample: true }),
    h('div', { class: 'card no-print' }, h('h3', null, '이 예시로 직접 체험해 보기'), h('p', { class: 'small muted' }, '예시 가게 답변이 채워진 진단을 새로 만들어요. 답변을 바꾸면 보고서가 어떻게 달라지는지 확인할 수 있어요.'),
      h('button', { class: 'btn primary block', onclick: async () => {
        const c = await api('/api/cases', { method: 'POST', body: { sample: kind }, noAuth: true });
        rememberCase(c.id, c.token, c.data.profile.name);
        S.caseId = null;
        location.hash = `#/c/${c.id}/review`;
      } }, '예시 가게로 체험 시작')),
  );
}

// ───────────────── 가게 등록
const reg = { step: 1, p: { name: '', address: '', biz: '', sub: '', channels: {}, concerns: [] } };
function renderStart() {
  storeName.textContent = '';
  const p = reg.p;
  const card = h('div', { class: 'card' });
  const hint = h('div', { class: 'hint' });
  const title = ['가게 기본 정보', '가게 위치', '온라인 채널 (선택)', '가장 큰 고민'][reg.step - 1];
  card.append(h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, `가게 등록 ${reg.step}/4`)), h('h2', null, title));
  if (reg.step === 1) {
    card.append(
      h('label', { class: 'field' }, h('span', { class: 'lab' }, '가게 이름'), h('input', { type: 'text', value: p.name, maxlength: 80, placeholder: '예: 골목분식', oninput: (e) => { p.name = e.target.value; } })),
      h('div', { class: 'lab', style: { fontWeight: 700, marginTop: '12px' } }, '업종'),
      h('div', { class: 'opts two' }, BIZ_TYPES.map((b) => h('button', { class: `opt ${p.biz === b.v ? 'on' : ''}`, onclick: () => { p.biz = b.v; p.sub = ''; renderStart(); } }, b.label))),
      p.biz ? [h('div', { class: 'lab', style: { fontWeight: 700 } }, '세부 업종'), h('div', { class: 'chips' }, SUB_TYPES[p.biz].map((s) => h('button', { class: `chip ${p.sub === s ? 'on' : ''}`, onclick: () => { p.sub = s; renderStart(); } }, s)))] : null,
      h('p', { class: 'small muted' }, '음식점과 카페는 묻는 질문이 달라요.'));
  } else if (reg.step === 2) {
    card.append(h('label', { class: 'field' }, h('span', { class: 'lab' }, '정확한 주소'), h('input', { type: 'text', value: p.address, maxlength: 200, placeholder: '예: 서울시 ○○구 ○○로 12, 1층', oninput: (e) => { p.address = e.target.value; } })),
      h('p', { class: 'small muted' }, '공개 정보를 확인할 때 같은 이름의 다른 가게와 구분하는 데 써요.'));
  } else if (reg.step === 3) {
    card.append(h('p', { class: 'small muted' }, '운영 중인 곳만 적어주세요. 데모에서는 자동으로 열어보지 않고, 확인할 목록으로만 써요.'),
      CHANNEL_FIELDS.map((f) => h('label', { class: 'field' }, h('span', { class: 'lab' }, f.label), h('input', { type: f.key === 'deliveryApp' ? 'text' : 'url', value: p.channels[f.key] || '', placeholder: f.key === 'deliveryApp' ? '예: 배달의민족 - 골목분식' : 'https://', oninput: (e) => { p.channels[f.key] = e.target.value.trim(); } }))));
  } else {
    card.append(h('p', { class: 'small muted' }, '최대 3개까지 골라주세요. 고른 고민과 관련된 질문을 먼저, 더 자세히 물어봐요.'),
      h('div', { class: 'opts' }, CONCERNS.map((c) => h('button', { class: `opt ${p.concerns.includes(c.id) ? 'on' : ''}`, onclick: () => {
        if (p.concerns.includes(c.id)) p.concerns = p.concerns.filter((x) => x !== c.id);
        else if (p.concerns.length >= 3) return toast('최대 3개까지 고를 수 있어요.');
        else p.concerns = [...p.concerns, c.id];
        renderStart();
      } }, c.label))),
      h('div', { class: 'card note small' }, h('b', null, '시작 전 안내 '), h('ul', null, h('li', null, '인터뷰는 15~25분 정도 걸려요. 중간에 자동 저장되고, 이어하기 링크로 다시 열 수 있어요.'), h('li', null, '모르는 값은 "정확히 모름", "대략 입력", "나중에 답하기"를 눌러도 돼요. 모르는 비용을 0원으로 계산하지 않아요.'), h('li', null, '데모 버전은 무료예요. 결제 단계가 없어요.'))));
  }
  card.append(hint);
  clear(view).append(card);
  const next = async () => {
    if (reg.step === 1 && (!p.name.trim() || !p.biz)) { hint.textContent = '가게 이름과 업종을 입력해 주세요.'; return; }
    if (reg.step < 4) { reg.step++; renderStart(); window.scrollTo(0, 0); return; }
    if (!p.concerns.length) { hint.textContent = '고민을 1개 이상 골라주세요.'; return; }
    const r = await api('/api/cases', { method: 'POST', body: { profile: p }, noAuth: true });
    rememberCase(r.id, r.token, p.name);
    S.caseId = r.id; S.token = r.token; S.data = r.data; S.version = r.version; S.report = null;
    reg.step = 1; reg.p = { name: '', address: '', biz: '', sub: '', channels: {}, concerns: [] };
    showLinkModal(true);
  };
  setNavbar(reg.step > 1 ? h('button', { class: 'btn', onclick: () => { reg.step--; renderStart(); } }, '이전') : h('a', { class: 'btn', href: '#/' }, '취소'),
    h('button', { class: 'btn primary', onclick: next }, reg.step < 4 ? '다음' : '인터뷰 시작하기'));
}

function showLinkModal(first) {
  const link = resumeLink();
  setNavbar();
  storeName.textContent = S.data.profile.name;
  clear(view).append(h('div', { class: 'card' },
    h('h2', null, first ? '진단을 만들었어요' : '이어하기 링크'),
    h('p', null, STANDALONE() ? '아래 링크로 이 브라우저에서 이어서 작성하고 보고서를 다시 볼 수 있어요. 체험판은 이 브라우저에만 저장돼 다른 기기에서는 열리지 않아요.' : '아래 링크가 있으면 다른 기기에서도 이어서 작성하고 보고서를 다시 볼 수 있어요. 비밀번호처럼 보관하고 다른 사람에게 보내지 마세요.'),
    h('div', { class: 'linkbox' }, link),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(link).then(() => toast('링크를 복사했어요.'), () => toast('복사하지 못했어요. 직접 선택해 복사해 주세요.')) }, '링크 복사'),
      h('button', { class: 'btn', disabled: true, title: '데모에서는 이메일 발송이 연결되지 않았어요' }, '이메일로 받기 (준비 중)')),
    h('p', { class: 'tiny muted' }, '이메일 발송은 아직 연결되지 않았어요. 링크를 잃어버리면 암호화된 자료를 되찾을 수 없어요.'),
    h('a', { class: 'btn primary block', href: `#/c/${S.caseId}/interview` }, first ? '인터뷰 시작' : '돌아가기')));
}

// ───────────────── 가게 정보 수정
function renderProfile() {
  const p = S.data.profile;
  p.channels = p.channels || {};
  const upd = () => { scheduleSave(); storeName.textContent = p.name; };
  clear(view).append(h('div', { class: 'card' },
    h('h2', null, '가게 정보'),
    h('label', { class: 'field' }, h('span', { class: 'lab' }, '가게 이름'), h('input', { type: 'text', value: p.name, oninput: (e) => { p.name = e.target.value; upd(); } })),
    h('label', { class: 'field' }, h('span', { class: 'lab' }, '정확한 주소'), h('input', { type: 'text', value: p.address, oninput: (e) => { p.address = e.target.value; upd(); } })),
    h('div', { class: 'lab', style: { fontWeight: 700 } }, '업종'),
    h('div', { class: 'opts two' }, BIZ_TYPES.map((b) => h('button', { class: `opt ${p.biz === b.v ? 'on' : ''}`, onclick: () => { if (p.biz !== b.v && !confirm('업종을 바꾸면 질문이 달라져요. 기존 답변은 남아 있어요. 바꿀까요?')) return; p.biz = b.v; upd(); renderProfile(); } }, b.label))),
    h('div', { class: 'chips' }, (SUB_TYPES[p.biz] || []).map((s) => h('button', { class: `chip ${p.sub === s ? 'on' : ''}`, onclick: () => { p.sub = s; upd(); renderProfile(); } }, s))),
    h('h3', null, '고민 (최대 3개)'),
    h('div', { class: 'opts' }, CONCERNS.map((c) => h('button', { class: `opt ${p.concerns.includes(c.id) ? 'on' : ''}`, onclick: () => {
      if (p.concerns.includes(c.id)) p.concerns = p.concerns.filter((x) => x !== c.id);
      else if (p.concerns.length >= 3) return toast('최대 3개까지 고를 수 있어요.');
      else p.concerns = [...p.concerns, c.id];
      upd(); renderProfile();
    } }, c.label))),
    h('h3', null, '온라인 채널'),
    CHANNEL_FIELDS.map((f) => h('label', { class: 'field' }, h('span', { class: 'lab' }, f.label), h('input', { type: 'text', value: p.channels[f.key] || '', oninput: (e) => { p.channels[f.key] = e.target.value.trim(); upd(); } }))),
    h('p', { class: 'saving', id: 'saveState' }, '변경하면 자동 저장돼요')));
  setNavbar(h('a', { class: 'btn primary', href: `#/c/${S.caseId}/interview` }, '인터뷰로'));
}

// ───────────────── 인터뷰
function curQuestion(qid) {
  const qs = visibleQuestions(S.data);
  return { qs, q: qs.find((x) => x.id === qid) || QMAP[qid] || null };
}

function renderInterview(qid) {
  let { qs, q } = curQuestion(qid);
  if (!q) {
    const nid = nextQuestionId(S.data, null);
    if (!nid) { location.hash = `#/c/${S.caseId}/interview/done`; return; }
    history.replaceState(null, '', `#/c/${S.caseId}/interview/${nid}`);
    ({ qs, q } = curQuestion(nid));
  }
  const ctx = makeCtx(S.data);
  const pr = progress(S.data);
  const idx = qs.findIndex((x) => x.id === q.id);
  const area = AREAS.find((a) => a.id === q.area);
  const a = S.data.answers[q.id] || {};
  const hint = h('div', { class: 'hint', role: 'alert' });
  const card = h('div', { class: 'card' });
  const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
  const remain = pr.total - pr.done;
  const bar = h('div', { class: 'bar' }, h('i', { style: { width: `${pct}%` } }));
  card.append(
    h('div', { class: 'qhead' }, h('span', { class: 'area-tag' }, area?.name || ''), h('span', { class: 'small muted' }, `${idx >= 0 ? idx + 1 : '-'} / ${pr.total}`)),
    bar,
    h('div', { class: 'tiny muted' }, `남은 질문 약 ${remain}개 · 약 ${Math.max(1, Math.round(remain * 0.25))}분`, ' · ', h('span', { id: 'saveState' }, '자동 저장')),
    h('div', { class: 'qtext', id: 'qtext' }, q.text),
    q.help && q.type !== 'check' ? h('p', { class: 'help' }, q.help) : null,
    q.example ? h('p', { class: 'example' }, q.example) : null,
    q.why ? h('details', { class: 'why' }, h('summary', null, '왜 묻나요?'), h('p', { class: 'small' }, q.why)) : null,
  );
  const goNext = () => {
    if (!questionResolved(S.data, q)) {
      hint.textContent = q.type === 'list' ? '항목을 하나 이상 추가하거나 "나중에 답하기"를 눌러주세요.' : '답을 입력하거나 아래 "정확히 모름"·"나중에 답하기"를 눌러주세요.';
      return;
    }
    const nid = nextQuestionId(S.data, q.id);
    location.hash = nid ? `#/c/${S.caseId}/interview/${nid}` : `#/c/${S.caseId}/interview/done`;
  };
  const rerender = () => renderInterview(q.id);
  card.append(inputFor(q, a, ctx, { goNext, rerender }));
  card.append(statusChips(q, a, goNext, rerender));
  card.append(hint);
  const toc = h('details', { class: 'sec' }, h('summary', null, '질문 목차'), h('div', { class: 'body' }, h('div', { class: 'area-list' }, AREAS.filter((ar) => pr.byArea[ar.id]).map((ar) => {
    const first = qs.find((x) => x.area === ar.id && !questionResolved(S.data, x)) || qs.find((x) => x.area === ar.id);
    return h('a', { href: `#/c/${S.caseId}/interview/${first.id}` }, h('span', null, ar.name), h('span', { class: 'muted small' }, `${pr.byArea[ar.id].done}/${pr.byArea[ar.id].total}`));
  })), h('label', { class: 'check-line' }, h('input', { type: 'checkbox', checked: !!S.data.settings?.deepAll, onchange: (e) => { S.data.settings.deepAll = e.target.checked; scheduleSave(); rerender(); } }), '고민과 관계없는 영역도 자세히 답하기')));
  clear(view).append(card, toc);
  const prev = prevQuestionId(S.data, q.id);
  setNavbar(h('button', { class: 'btn', disabled: !prev, onclick: () => { location.hash = `#/c/${S.caseId}/interview/${prev}`; } }, '이전'),
    h('button', { class: 'btn primary', onclick: goNext }, '다음'));
  window.scrollTo(0, 0);
}

function statusChips(q, a, goNext, rerender) {
  const allow = q.allow || [];
  if (!allow.length) return null;
  const numeric = ['money', 'number', 'percent', 'split'].includes(q.type);
  const wrap = h('div', { class: 'status-chips' });
  if (allow.includes('approx') && numeric) {
    wrap.append(h('button', { class: `chip ${a.s === 'approx' ? 'on' : ''}`, onclick: () => {
      setAnswer(q.id, { s: a.s === 'approx' ? 'exact' : 'approx' });
      rerender();
    } }, a.s === 'approx' ? '대략 입력 (선택됨)' : '대략 입력이에요'));
  }
  const map = { unknown: '정확히 모름', na: '해당 없음', later: '나중에 답하기' };
  for (const k of ['unknown', 'na', 'later']) {
    if (!allow.includes(k)) continue;
    wrap.append(h('button', { class: `chip ${a.s === k ? 'on' : ''}`, onclick: () => {
      setAnswer(q.id, { s: k });
      if (k === 'unknown' && ['money', 'number', 'percent'].includes(q.type)) toast('모르는 값은 0원으로 계산하지 않고 "추가 확인 필요"로 표시해요.');
      goNext();
    } }, map[k]));
  }
  return wrap;
}

function setValue(q, v, extra = {}) {
  const a = S.data.answers[q.id] || {};
  const s = a.s === 'approx' ? 'approx' : 'exact';
  setAnswer(q.id, { v, s, ...extra });
}

function inputFor(q, a, ctx, { goNext, rerender }) {
  const wrap = h('div', null);
  const live = a.s === 'unknown' || a.s === 'na' || a.s === 'later' ? undefined : a.v;
  switch (q.type) {
    case 'choice': {
      const opts = resolveOptions(q, ctx);
      wrap.append(h('div', { class: 'opts' }, opts.map((o) => h('button', { class: `opt ${String(live) === String(o.v) ? 'on' : ''}`, onclick: () => {
        setAnswer(q.id, { v: o.v, s: 'exact' });
        rerender();
        setTimeout(goNext, 180);
      } }, o.label, o.desc ? h('small', null, o.desc) : null))));
      break;
    }
    case 'check': {
      wrap.append(h('div', { class: 'card warn small' }, q.help),
        h('div', { class: 'opts' }, q.options.map((o) => h('button', { class: `opt ${a.v === o.v && a.sig === q.sig ? 'on' : ''}`, onclick: () => {
          setAnswer(q.id, { v: o.v, s: 'exact', sig: q.sig });
          if (o.v === 'fix') location.hash = `#/c/${S.caseId}/interview/${q.related[0]}`;
          else setTimeout(goNext, 150);
        } }, o.label))));
      break;
    }
    case 'multi': {
      const opts = resolveOptions(q, ctx);
      const cur = Array.isArray(live) ? live : [];
      const exclusive = ['none', 'unknown'];
      wrap.append(h('div', { class: 'chips' }, opts.map((o) => h('button', { class: `chip ${cur.includes(o.v) ? 'on' : ''}`, onclick: () => {
        let next;
        if (cur.includes(o.v)) next = cur.filter((x) => x !== o.v);
        else if (exclusive.includes(o.v)) next = [o.v];
        else {
          next = [...cur.filter((x) => !exclusive.includes(x)), o.v];
          if (q.max && next.length > q.max) { toast(`최대 ${q.max}개까지 고를 수 있어요.`); return; }
        }
        setAnswer(q.id, { v: next, s: 'exact' });
        rerender();
      } }, o.label))));
      break;
    }
    case 'money':
    case 'number':
    case 'percent': {
      const man = q.type === 'money' && q.inputUnit === 'man';
      const unit = q.type === 'money' ? (man ? '만 원' : '원') : q.type === 'percent' ? '%' : (q.unit || '');
      const shown = isNum(live) ? (man ? live / 10000 : live) : '';
      const preview = h('div', { class: 'preview' }, isNum(live) ? previewText(q, live) : '');
      const inp = h('input', { type: 'text', inputmode: 'decimal', value: shown === '' ? '' : String(shown), 'aria-labelledby': 'qtext', placeholder: man ? '예: 3000' : '숫자로 입력', oninput: (e) => {
        const n = parseNum(e.target.value);
        if (n === null) { setAnswer(q.id, { v: null, s: 'later' === a.s ? 'later' : 'exact' }); preview.textContent = ''; return; }
        if (Number.isNaN(n) || n < 0) { preview.textContent = '숫자만 입력해 주세요'; return; }
        const v = man ? Math.round(n * 10000) : n;
        setValue(q, v);
        preview.textContent = previewText(q, v);
      }, onkeydown: (e) => { if (e.key === 'Enter') goNext(); } });
      wrap.append(h('div', { class: 'unit-input' }, inp, h('span', { class: 'unit' }, unit)), preview);
      if (q.period) {
        const p = a.p || 'month';
        wrap.append(h('div', { class: 'chips' }, [['month', '한 달 기준'], ['week', '일주일 기준'], ['year', '1년 기준']].map(([k, l]) => h('button', { class: `chip ${p === k ? 'on' : ''}`, onclick: () => { setAnswer(q.id, { p: k }); rerender(); } }, l))));
      }
      setTimeout(() => inp.focus({ preventScroll: true }), 50);
      break;
    }
    case 'text': {
      const el = q.long
        ? h('textarea', { 'aria-labelledby': 'qtext', maxlength: 1000, oninput: (e) => setValue(q, e.target.value) }, live || '')
        : h('input', { type: 'text', 'aria-labelledby': 'qtext', maxlength: 300, value: live || '', oninput: (e) => setValue(q, e.target.value), onkeydown: (e) => { if (e.key === 'Enter') goNext(); } });
      wrap.append(el);
      break;
    }
    case 'month': {
      const now = new Date();
      const [y0, m0] = String(live || '').split('-');
      const ys = h('select', { 'aria-label': '연도' }, [now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear()].map((y) => h('option', { value: y }, `${y}년`)));
      const ms = h('select', { 'aria-label': '월' }, Array.from({ length: 12 }, (_, i) => h('option', { value: String(i + 1).padStart(2, '0') }, `${i + 1}월`)));
      ys.value = y0 || String(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
      ms.value = m0 || String(now.getMonth() === 0 ? 12 : now.getMonth()).padStart(2, '0');
      const upd = () => setValue(q, `${ys.value}-${ms.value}`);
      ys.onchange = upd; ms.onchange = upd;
      if (!live) upd();
      wrap.append(h('div', { class: 'split3', style: { gridTemplateColumns: '1fr 1fr' } }, ys, ms));
      break;
    }
    case 'split': {
      const v = { hall: 0, takeout: 0, delivery: 0, ...(live || {}) };
      const sumEl = h('div', { class: 'small' });
      const showSum = () => { const t = (+v.hall || 0) + (+v.takeout || 0) + (+v.delivery || 0); sumEl.className = t === 100 ? 'sum-ok' : 'sum-bad'; sumEl.textContent = t === 100 ? '합계 100% ✓' : `합계 ${t}% (100%가 되게 맞춰주세요)`; };
      const field = (k, label) => h('label', null, label, h('div', { class: 'unit-input' }, h('input', { type: 'text', inputmode: 'numeric', value: String(v[k] ?? 0), oninput: (e) => { v[k] = Math.max(0, Math.min(100, parseNum(e.target.value) || 0)); setValue(q, { ...v }); showSum(); } }), h('span', { class: 'unit' }, '%')));
      wrap.append(h('div', { class: 'split3' }, field('hall', '매장 식사'), field('takeout', '포장'), field('delivery', '배달')), sumEl,
        h('div', { class: 'chips' }, [['매장 위주', 80, 15, 5], ['배달 위주', 15, 15, 70], ['포장 위주', 20, 70, 10], ['반반', 50, 20, 30]].map(([l, a1, b1, c1]) => h('button', { class: 'chip', onclick: () => { setValue(q, { hall: a1, takeout: b1, delivery: c1 }); rerender(); } }, l))));
      showSum();
      break;
    }
    case 'hours': {
      const v = { open: '', close: '', breakTime: '', closed: [], ...(live || {}) };
      const upd = () => setValue(q, { ...v });
      wrap.append(h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', { class: 'lab' }, '여는 시간'), h('input', { type: 'time', value: v.open, onchange: (e) => { v.open = e.target.value; upd(); } })),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, '닫는 시간'), h('input', { type: 'time', value: v.close, onchange: (e) => { v.close = e.target.value; upd(); } }))),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, '쉬는 시간 (있으면)'), h('input', { type: 'text', value: v.breakTime, placeholder: '예: 15:00~17:00', oninput: (e) => { v.breakTime = e.target.value; upd(); } })),
      h('div', { class: 'lab', style: { fontWeight: 600 } }, '쉬는 날'),
      h('div', { class: 'chips' }, WEEKDAYS.map((d) => h('button', { class: `chip ${v.closed.includes(d) ? 'on' : ''}`, onclick: () => { v.closed = v.closed.includes(d) ? v.closed.filter((x) => x !== d) : [...v.closed, d]; upd(); rerender(); } }, d)),
        h('button', { class: `chip ${live && !v.closed.length ? 'on' : ''}`, onclick: () => { v.closed = []; upd(); rerender(); } }, '연중무휴')));
      break;
    }
    case 'slots': {
      const v = { days: [], times: [], ...(live || {}) };
      const tog = (k, x) => { v[k] = v[k].includes(x) ? v[k].filter((y) => y !== x) : [...v[k], x]; setValue(q, { ...v }); rerender(); };
      wrap.append(h('div', { class: 'lab', style: { fontWeight: 600 } }, '요일'), h('div', { class: 'chips' }, WEEKDAYS.map((d) => h('button', { class: `chip ${v.days.includes(d) ? 'on' : ''}`, onclick: () => tog('days', d) }, d))),
        h('div', { class: 'lab', style: { fontWeight: 600 } }, '시간대'), h('div', { class: 'chips' }, TIME_SLOTS.map((t) => h('button', { class: `chip ${v.times.includes(t.v) ? 'on' : ''}`, onclick: () => tog('times', t.v) }, t.label))));
      break;
    }
    case 'list':
      wrap.append(listEditor(q, Array.isArray(live) ? live : [], rerender));
      break;
    case 'upload': {
      const files = attachmentsOf(q.kind);
      const fi = h('input', { type: 'file', accept: 'image/*,.pdf,.csv,.txt', multiple: true, hidden: true, onchange: async (e) => { await uploadFiles([...e.target.files], q.kind); rerender(); } });
      wrap.append(fi,
        files.length ? h('ul', null, files.map((f) => h('li', { class: 'small' }, `${f.name} (${Math.round(f.size / 1024)}KB)`))) : h('p', { class: 'small muted' }, '아직 올린 파일이 없어요.'),
        h('button', { class: 'btn block', onclick: () => fi.click() }, q.kind === 'restroom' ? '사진 올리기 (사람이 나오지 않게)' : '사진·파일 올리기'),
        h('p', { class: 'tiny muted' }, '데모에서는 사진 속 내용을 자동으로 읽지 않아요. 사진은 사장님만 볼 수 있고, 판단 근거로 쓸 때는 "사진 확인"과 "답변"을 구분해 표시해요.'));
      break;
    }
    default:
      wrap.append(h('p', null, '지원하지 않는 질문 형식이에요.'));
  }
  return wrap;
}

function previewText(q, v) {
  if (q.type === 'money') return `= ${q.inputUnit === 'man' ? fmtMan(v) : fmtWon(v)}`;
  if (q.type === 'percent') return `= ${v}%`;
  return `= ${fmtNum(v)}${q.unit ? ' ' + q.unit : ''}`;
}

function listEditor(q, rows, rerender) {
  const wrap = h('div', null);
  const commit = (next) => setAnswer(q.id, { v: next, s: 'exact' });
  rows.forEach((row, i) => {
    const box = h('div', { class: 'listrow' }, h('div', { class: 'rowhead' }, h('span', null, `${i + 1}. ${row[q.fields[0].key] || '새 항목'}`),
      h('button', { class: 'btn small danger', onclick: () => { commit(rows.filter((_, j) => j !== i)); rerender(); } }, '삭제')));
    const grid = h('div', { class: 'grid2' });
    if (q.id === 'p_items') {
      grid.append(h('label', { class: 'field' }, h('span', { class: 'lab' }, '규격 한 번에 입력 (선택)'), h('input', { type: 'text', placeholder: '예: 1kg, 500g×20, 18L', onchange: (e) => {
        const sp = parseSpec(e.target.value);
        if (!sp) return toast('규격을 읽지 못했어요. 아래 칸에 직접 입력해 주세요.');
        Object.assign(row, { size: sp.size, unit: sp.unit, count: sp.count });
        commit([...rows]);
        rerender();
      } })));
    }
    for (const f of q.fields) grid.append(fieldInput(f, row, () => commit([...rows])));
    box.append(grid);
    wrap.append(box);
  });
  wrap.append(h('button', { class: 'btn block', onclick: () => { commit([...rows, {}]); rerender(); } }, '+ 항목 추가'));
  return wrap;
}

function renderInterviewDone() {
  const pr = progress(S.data);
  const unresolved = visibleQuestions(S.data).filter((q) => !questionDone(S.data, q));
  clear(view).append(h('div', { class: 'card' },
    h('h2', null, '인터뷰를 마쳤어요'),
    h('p', null, `질문 ${pr.total}개 중 ${pr.done}개에 답했어요.${unresolved.length ? ` "나중에 답하기"로 남겨둔 질문 ${unresolved.length}개는 답변 확인 화면에서 다시 볼 수 있어요.` : ''}`),
    h('label', { class: 'check-line' }, h('input', { type: 'checkbox', checked: !!S.data.settings?.deepAll, onchange: (e) => { S.data.settings.deepAll = e.target.checked; scheduleSave(); if (e.target.checked) location.hash = `#/c/${S.caseId}/interview`; } }), '다른 영역도 자세히 답하기 (질문이 늘어나요)'),
    h('div', { class: 'btn-row' }, h('a', { class: 'btn', href: `#/c/${S.caseId}/files` }, '자료 올리기 (선택)'), h('a', { class: 'btn', href: `#/c/${S.caseId}/external` }, '외부 정보 기록 (선택)')),
    h('a', { class: 'btn primary block', style: { marginTop: '10px' }, href: `#/c/${S.caseId}/review` }, '답변 확인하고 분석하기')));
}

// ───────────────── 답변 확인
function renderReview() {
  const qs = visibleQuestions(S.data);
  const ctx = makeCtx(S.data);
  const pr = progress(S.data);
  const calc = compute(S.data);
  const checks = qs.filter((q) => q.type === 'check' && !questionDone(S.data, q));
  const missingCore = qs.filter((q) => q.type !== 'check' && q.type !== 'upload' && q.depth === 'core' && !questionDone(S.data, q));
  const root = h('div', null,
    h('div', { class: 'card' }, h('h2', null, '답변 확인'), h('p', null, `질문 ${pr.total}개 중 ${pr.done}개에 답했어요.`),
      h('div', { class: 'bar' }, h('i', { style: { width: `${pr.total ? Math.round((pr.done / pr.total) * 100) : 0}%` } })),
      h('p', { class: 'small muted' }, '분석에 쓰일 정보예요. 틀린 값은 "수정"을 눌러 고쳐주세요. 고치면 보고서도 다시 계산돼요.')));
  if (checks.length) root.append(h('div', { class: 'card warn' }, h('h3', null, `재확인이 필요해요 (${checks.length})`), checks.map((q) => h('div', { class: 'filebox' }, h('b', null, q.label), h('p', { class: 'small' }, q.help), h('a', { class: 'btn small', href: `#/c/${S.caseId}/interview/${q.id}` }, '확인하기')))));
  if (calc.missingCosts.length) root.append(h('div', { class: 'card note' }, h('h3', null, '아직 모르는 비용'), h('p', { class: 'small' }, '이 비용들은 0원으로 계산하지 않아요. 이익은 "입력된 비용만 뺀 금액"으로 표시하고, 실제 이익은 그보다 적을 수 있다고 알려드려요.'),
    h('ul', null, calc.missingCosts.map((m) => h('li', null, m.label, ' ', QMAP[m.key] ? h('a', { href: `#/c/${S.caseId}/interview/${m.key}` }, '입력') : null)))));
  if (missingCore.length) root.append(h('div', { class: 'card note' }, h('h3', null, `아직 답하지 않은 질문 (${missingCore.length})`), h('ul', null, missingCore.slice(0, 15).map((q) => h('li', null, h('a', { href: `#/c/${S.caseId}/interview/${q.id}` }, q.label))))));
  for (const ar of AREAS) {
    const list = qs.filter((q) => q.area === ar.id && q.type !== 'check');
    if (!list.length) continue;
    root.append(h('details', { class: 'sec' }, h('summary', null, `${ar.name} (${list.filter((q) => questionDone(S.data, q)).length}/${list.length})`),
      h('div', { class: 'body' }, h('div', { class: 'kv', style: { gridTemplateColumns: '1fr' } }, list.map((q) => {
        const a = S.data.answers[q.id];
        const txt = q.type === 'upload' ? `파일 ${attachmentsOf(q.kind).length}개` : answerText(q, a, ctx);
        const src = a && typeof a.src === 'string' && a.src.startsWith('file') ? ' (파일에서 추출·확인)' : '';
        return h('div', null, h('span', null, q.label), h('b', null, txt + src, ' ', h('a', { class: 'small', href: `#/c/${S.caseId}/interview/${q.id}` }, '수정')));
      })))));
  }
  clear(view).append(root);
  setNavbar(h('a', { class: 'btn', href: `#/c/${S.caseId}/interview` }, '인터뷰 계속'), h('a', { class: 'btn primary', href: `#/c/${S.caseId}/analyze` }, '분석하기'));
}

// ───────────────── 분석 진행
async function runAnalyze() {
  await saveNow();
  const r = await api(`/api/cases/${S.caseId}/analyze`, { method: 'POST', body: {} });
  S.report = r.report; S.reportInputVersion = r.reportInputVersion; S.changes = r.changes || [];
  return r;
}

async function renderAnalyze() {
  clear(view).append(h('div', { class: 'card' }, h('h2', null, '분석 중'), h('p', { class: 'muted' }, '입력값을 계산하고 진단 규칙을 적용하고 있어요.')));
  const r = await runAnalyze();
  const qs = visibleQuestions(S.data);
  const checks = qs.filter((q) => q.type === 'check' && !questionDone(S.data, q));
  clear(view).append(h('div', { class: 'card' },
    h('h2', null, '분석을 마쳤어요'),
    h('p', { class: 'small muted' }, '데모 모드는 AI 대신 정해진 계산 로직과 공개된 진단 규칙으로 분석해요. 실제로 수행한 단계는 아래와 같아요.'),
    h('ol', { class: 'steps-list' }, r.report.steps.map((s) => h('li', null, h('b', null, s.label), h('div', { class: 'small muted' }, s.detail))))),
  checks.length ? h('div', { class: 'card warn' }, h('h3', null, '추가 확인 요청'), h('p', { class: 'small' }, '아래 항목을 확인하면 보고서가 더 정확해져요. 확인하지 않아도 보고서는 볼 수 있어요.'), h('ul', null, checks.map((q) => h('li', null, h('a', { href: `#/c/${S.caseId}/interview/${q.id}` }, q.label))))) : null);
  setNavbar(h('a', { class: 'btn', href: `#/c/${S.caseId}/review` }, '답변 확인'), h('a', { class: 'btn primary', href: `#/c/${S.caseId}/report` }, '보고서 보기'));
}

// ───────────────── 보고서
async function renderReportScreen() {
  let stale = !S.report || S.report.inputSig !== inputSignature(S.data) || S.report.engine !== ENGINE_VERSION;
  if (stale) {
    clear(view).append(h('div', { class: 'card' }, h('p', null, '최신 답변으로 보고서를 다시 계산하는 중...')));
    await runAnalyze();
    stale = false;
  }
  const el = renderReport(S.report, S.data, {
    stale, changes: S.changes, caseId: S.caseId,
    onReanalyze: async () => { await runAnalyze(); renderReportScreen(); },
    onTogglePlan: (text, on) => { S.data.settings.planDone = { ...(S.data.settings.planDone || {}) }; if (on) S.data.settings.planDone[text] = true; else delete S.data.settings.planDone[text]; scheduleSave(); },
  });
  clear(view).append(el);
  setNavbar(h('button', { class: 'btn', onclick: () => window.print() }, 'PDF 저장'), h('a', { class: 'btn primary', href: `#/c/${S.caseId}/review` }, '답변 수정'));
}

// ───────────────── 보관·삭제
function renderManage() {
  let shown = false;
  const box = h('div', { class: 'linkbox' }, '••••••••••••••••••••••••••••••');
  const exportJSON = () => downloadBlob(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), data: S.data, report: S.report }, null, 2)], { type: 'application/json' }), `매출올려드림_${S.data.profile.name}.json`);
  clear(view).append(
    h('div', { class: 'card' }, h('h2', null, '이어하기 링크'),
      h('p', { class: 'small' }, '이 링크가 있으면 누구나 이 진단을 열 수 있어요. 비밀번호처럼 보관하세요.'), box,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => { shown = !shown; box.textContent = shown ? resumeLink() : '••••••••••••••••••••••••••••••'; } }, '링크 보기/숨기기'),
        h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(resumeLink()).then(() => toast('링크를 복사했어요.'), () => toast('복사하지 못했어요.')) }, '링크 복사'),
        h('button', { class: 'btn small', disabled: true }, '이메일로 받기 (준비 중)')),
      h('p', { class: 'tiny muted' }, '이메일 발송은 아직 연결되지 않았어요.'),
      h('hr', { class: 'soft' }),
      h('h3', null, '링크 새로 만들기'),
      h('p', { class: 'small' }, '링크가 다른 사람에게 전달됐다면 새 링크를 만드세요. 예전 링크로는 더 이상 열 수 없어요.'),
      h('button', { class: 'btn small', onclick: async () => {
        if (!confirm('새 링크를 만들까요? 예전 링크는 더 이상 쓸 수 없어요.')) return;
        await saveNow();
        const r = await api(`/api/cases/${S.caseId}/rotate`, { method: 'POST', body: {} });
        S.token = r.token;
        rememberCase(S.caseId, S.token, S.data.profile.name);
        toast(r.message);
        shown = true; box.textContent = resumeLink();
      } }, '새 링크 만들기')),
    h('div', { class: 'card' }, h('h2', null, '내려받기'),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn small', href: `#/c/${S.caseId}/report` }, '보고서 PDF (보고서 화면에서 저장)'),
        h('button', { class: 'btn small', disabled: !S.report, onclick: () => downloadMeasureCSV(S.report) }, '효과 확인 기록표 CSV'),
        h('button', { class: 'btn small', onclick: exportJSON }, '전체 데이터 JSON'))),
    h('div', { class: 'card' }, h('h2', null, '이 기기에서 지우기'),
      h('p', { class: 'small' }, STANDALONE() ? '이 브라우저의 이어하기 목록에서만 지워요. 암호화된 자료는 남아 있어 링크로 다시 열 수 있어요. 자료까지 지우려면 아래 "모두 삭제"를 쓰세요.' : '이 브라우저에 저장된 이어하기 정보만 지워요. 서버의 자료는 남아 있어서 링크로 다시 열 수 있어요.'),
      h('button', { class: 'btn small', onclick: () => { forgetCase(S.caseId); S.caseId = null; S.data = null; S.token = null; toast('이 기기에서 지웠어요.'); location.hash = '#/'; } }, '이 기기에서 지우기')),
    h('div', { class: 'card warn' }, h('h2', null, '내 자료 모두 삭제'),
      h('p', { class: 'small' }, `${STANDALONE() ? '이 브라우저에' : '서버에'} 저장된 답변·사진·파일·보고서를 모두 지워요. 되돌릴 수 없어요.`),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, `삭제하려면 가게 이름 "${S.data.profile.name}"을(를) 그대로 입력하세요`),
        h('input', { type: 'text', id: 'delName', autocomplete: 'off', oninput: (e) => { document.getElementById('delBtn').disabled = e.target.value.trim() !== S.data.profile.name.trim(); } })),
      h('button', { class: 'btn danger', id: 'delBtn', disabled: true, onclick: async () => {
        if (document.getElementById('delName').value.trim() !== S.data.profile.name.trim()) return toast('가게 이름이 달라 삭제하지 않았어요.');
        clearTimeout(S.saveTimer); S.dirty = false;
        const r = await api(`/api/cases/${S.caseId}`, { method: 'DELETE' });
        forgetCase(S.caseId);
        S.caseId = null; S.data = null; S.token = null; S.report = null;
        stepnav.hidden = true;
        clear(view).append(h('div', { class: 'card' }, h('h2', null, r.deleted ? '삭제했어요' : '삭제하지 못했어요'), h('p', null, r.message), h('a', { class: 'btn', href: '#/' }, '처음으로')));
      } }, '모두 삭제')));
}

// 모든 화면 함수가 준비된 뒤 첫 화면을 그린다
route();
