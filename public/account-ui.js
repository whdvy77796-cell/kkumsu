// 사장님 계정: 대시보드(로그인 상태·가게 목록·기존 페이지 연결·로그아웃)와 계정 수정 화면. 브라우저 ESM 모듈.
// innerHTML은 쓰지 않는다(모든 문자열은 h()가 텍스트로 넣는다). 비밀번호는 저장·표시·URL 노출 없이 요청 본문에만 쓴다.
// 수정 중인 내용은 브라우저 저장소(localStorage 등)에 저장하지 않고 이 모듈의 메모리에만 둔다.
// AI·결제 호출은 없다. 사진 기능은 아직 없으며 '준비 중'으로만 안내한다.
import { ID_RE, LIMITS, cleanStoreData, validStoreShape, buildQrModules, drawQr, publicUrl } from './store-tools.js';
import { makeAiAccessPanel } from './ai-access-ui.js';

const str = (v) => (typeof v === 'string' ? v : '');
const msgOf = (e) => (e && typeof e.message === 'string' && e.message) || '요청이 실패했어요. 잠시 후 다시 시도해 주세요.';
// 공식 로그인 버튼 이미지(public에 있음). 버튼 글자는 이미지 안에 있으므로 링크 안에는 텍스트를 따로 두지 않고 alt만 둔다(스크린리더 중복 낭독 방지).
const PROVIDER_IMAGES = {
  kakao: { src: '/kakao-login.svg', alt: '카카오 로그인' },
  naver: { src: '/naver-login.png', alt: '네이버 로그인' },
  // 구글: Google 공식 브랜딩 가이드의 '커스텀 버튼' 형식. 표준 컬러 G(공식 signin-assets.zip의 Light 아이콘에서 G만 자른 /google-g.svg) + 한국어 문구.
  google: { iconSrc: '/google-g.svg' },
};
const PROVIDERS = [['kakao', '카카오로 로그인'], ['naver', '네이버로 로그인'], ['google', 'Google 계정으로 로그인']];
const LEAVE_MESSAGE = '저장하지 않은 변경사항이 있어요. 이 화면을 나가면 입력한 내용이 사라져요. 나갈까요?';

// 22자 페이지 ID 또는 공개(/stores/ID)·관리(#/manage/ID) 주소 전체에서 ID만 뽑는다. 못 찾으면 ''.
export function extractStoreId(input) {
  const v = str(input).trim();
  if (!v) return '';
  if (ID_RE.test(v)) return v;
  const m = v.match(/(?:\/stores\/|\/manage\/)([A-Za-z0-9_-]{22})(?=$|[/?#])/);
  return m ? m[1] : '';
}

// 로그인 링크는 서버가 준비됐다고(true) 알려 준 제공자만 만든다.
export function loginLinks(status) {
  const p = status && typeof status.providers === 'object' && status.providers ? status.providers : {};
  return PROVIDERS.filter(([k]) => p[k] === true).map(([k, label]) => ({
    provider: k, label, href: `/api/owner-auth?op=start&provider=${k}&return=dashboard`,
    imageSrc: PROVIDER_IMAGES[k]?.src ?? '', imageAlt: PROVIDER_IMAGES[k]?.alt ?? '', iconSrc: PROVIDER_IMAGES[k]?.iconSrc ?? '',
  }));
}

// 서버 버전(revision): 소문자 16진수 32자 문자열만 인정한다(백엔드 확정 계약). 숫자·대문자·임의 문자열은 모두 '없음'으로 본다.
const REVISION_RE = /^[a-f0-9]{32}$/;
export function isValidRevision(v) {
  return typeof v === 'string' && REVISION_RE.test(v);
}

// updatedAt(ISO 문자열·밀리초·초 단위 숫자)을 읽기 쉬운 한국 시간 문자열로. 해석할 수 없으면 ''.
export function formatUpdatedAt(v) {
  let t;
  if (typeof v === 'number' && Number.isFinite(v)) t = v < 1e11 ? v * 1000 : v;
  else if (typeof v === 'string' && v.trim()) { t = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v); if (/^\d+$/.test(v.trim()) && t < 1e11) t *= 1000; }
  else return '';
  const date = new Date(t);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  } catch { return ''; }
}

// 수정 화면이 서버로 보낼 값. 기본값에서는 situations(예상 질문)를 아예 보내지 않아, 서버가 가진 최신 값이 그대로 유지된다.
// includeSituations=true는 사용자가 예상 질문을 실제로 고쳤을 때만 쓴다. 그러면 검증된 질문·답 쌍 전체를 보내고, 전부 삭제했다면 빈 배열 []를 명시적으로 보낸다.
export function buildUpdateData(d, includeSituations = false) {
  const { data, error } = cleanStoreData({ ...d, situations: includeSituations && Array.isArray(d.situations) ? d.situations : [] });
  if (error) return { data: null, error };
  const out = { name: data.name, address: data.address, headline: data.headline, intro: data.intro, sections: data.sections, faqs: data.faqs };
  if (includeSituations && Array.isArray(d.situations)) out.situations = data.situations.map((x) => ({ question: x.question, answer: x.answer }));
  return { data: out, error: null };
}
const samePairs = (a, b) => a.length === b.length && a.every((x, i) => x.question === b[i].question && x.answer === b[i].answer);

// 수정 요청이 '서버에 반영되지 않았다'고 확실히 말할 수 있는 오류인가(일반 4xx 검증·인증 오류).
// 그렇지 않은 오류(시간 초과, 네트워크, 5xx, 알 수 없는 오류)는 이미 저장되었을 수 있으므로 '결과 미확인'으로 취급한다.
export function isDefinitiveRejection(e) {
  if (isConflictError(e)) return false;
  const status = Number(e?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) return true;
  return /^HTTP_4\d\d$/.test(String(e?.code ?? '')) || /^(VALIDATION|INVALID|BAD_REQUEST|FORBIDDEN|UNAUTHENTICATED|UNAUTHORIZED|CONSENT|TOO_LARGE|NOT_FOUND)/i.test(String(e?.code ?? ''));
}

// 충돌(409)로 보이는 오류인가. 기존 post()는 서버 code가 있으면 그것을, 없으면 HTTP_<status>를 err.code에 넣는다.
export function isConflictError(e) {
  return e?.status === 409 || /(^|[^0-9])409([^0-9]|$)|CONFLICT|REVISION|STALE/i.test(String(e?.code ?? ''));
}

// supportsUnlink: 서버가 POST {action:'unlink',id}를 지원하면 true(기본 true). false면 해제 UI 숨김.
// isRouteCurrent: 선택. 호출한 쪽이 "지금도 이 화면 경로인가"를 알려 주는 추가 가드.
// confirmFn: 선택. 저장 안 한 변경사항이 있을 때 나가도 되는지 묻는 함수(기본 window.confirm). 없으면 안전하게 '나가지 않음'.
// getDraftResume: 선택. 이 탭에 작성 중인 초안이 있을 때 돌아갈 화면 hash를 돌려주는 함수. 아래 세 값 중 정확히 하나일 때만 인정한다.
export const DRAFT_RESUME_HASHES = Object.freeze(['#/page-preview', '#/page-edit', '#/page-publish']);
export function makeAccountUI({ h, show, setNavbar, btn, post, fetcher, storeName, supportsUnlink = true, isRouteCurrent, confirmFn, getDraftResume }) {
  let seq = 0; // 늦게 도착한 응답이 최신 화면을 덮지 않게 한다
  let dirty = false; // 저장하지 않은 수정이 있는가(검증된 저장 성공에서만 false로 돌아간다)
  const hashNow = () => String(globalThis.location?.hash ?? '');
  const stale = (my, hash0) => my !== seq || hashNow() !== hash0 || (typeof isRouteCurrent === 'function' && !isRouteCurrent());
  const note = (cls = 'muted') => h('p', { class: cls, role: 'status', 'aria-live': 'polite' });
  const setNote = (el, text, cls) => { el.textContent = text; if (cls) el.className = cls; };
  const toHome = () => { location.hash = '#/'; };
  const toDash = () => { location.hash = '#/my-stores'; };

  // 상위 코드(헤더·로고·메뉴)가 이동 전에 호출한다.
  function isEditingDirty() { return dirty; }
  function confirmLeave(message = LEAVE_MESSAGE) {
    if (!dirty) return true;
    const ask = typeof confirmFn === 'function' ? confirmFn : (typeof globalThis.confirm === 'function' ? (m) => globalThis.confirm(m) : null);
    let ok = false;
    try { ok = ask ? ask(message) === true : false; } catch { ok = false; }
    if (ok) dirty = false;
    return ok;
  }
  // 브라우저 닫기·새로고침·주소 직접 이동 시 경고(내용은 저장하지 않는다)
  globalThis.addEventListener?.('beforeunload', (ev) => {
    if (!dirty) return undefined;
    ev?.preventDefault?.();
    if (ev) ev.returnValue = '';
    return '';
  });
  // 초안 이어하기 링크: 허용 목록과 정확히 일치할 때만 만든다(임의 주소 불가). 초안 내용은 읽지·옛기지·전송하지 않는다.
  function resumeBlock() {
    let target = null;
    try { target = typeof getDraftResume === 'function' ? getDraftResume() : null; } catch { target = null; }
    if (typeof target !== 'string' || !DRAFT_RESUME_HASHES.includes(target)) return null;
    return h('section', { class: 'card note', 'data-draft-resume': target },
      h('a', { class: 'btn', href: target }, '이 탭에서 작성 중인 초안으로 돌아가기'),
      h('p', { class: 'small muted' }, '작성 중인 초안은 이 탭에만 있어요. 계정이나 클라우드에 저장되지 않았으니, 탭을 닫으면 사라질 수 있어요.'));
  }
  const guardedNav = (go) => () => { if (confirmLeave()) go(); };

  async function getJson(url) {
    const res = await fetcher(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (res && typeof res.json === 'function') {
      let data = null;
      try { data = await res.json(); } catch { /* 아래에서 처리 */ }
      if (res.ok === false || !data) {
        const err = new Error(data?.error || `요청이 실패했어요. (${res.status ?? '?'})`);
        err.code = data?.code || `HTTP_${res.status}`;
        err.status = res.status;
        throw err;
      }
      return data;
    }
    return res; // 이미 해석된 JSON을 돌려주는 fetcher도 허용
  }
  const isAuthErr = (e) => e?.status === 401 || e?.status === 403 || e?.code === 'HTTP_401' || e?.code === 'HTTP_403' || e?.code === 'UNAUTHENTICATED';

  function failure(title, e, retry) {
    setNavbar(btn('처음으로', toHome));
    show(h('section', { class: 'card' }, h('h1', null, title),
      h('p', { class: 'error', role: 'alert' }, msgOf(e)),
      retry ? btn('다시 시도', retry, true) : null));
  }

  // ───────── 대시보드
  async function renderDashboard() {
    const my = ++seq;
    dirty = false; // 새 화면이 시작됐다. 나가기 전 확인은 상위 코드가 confirmLeave()로 한다.
    const hash0 = hashNow();
    setNavbar(btn('처음으로', toHome));
    show(h('section', { class: 'card' }, h('h1', null, '내 가게 계정'), h('p', { class: 'muted', role: 'status' }, '로그인 상태를 확인하는 중이에요…')));
    let status;
    try { status = await getJson('/api/owner-auth?op=status'); } catch (e) { if (!stale(my, hash0)) failure('로그인 상태를 확인하지 못했어요', e, renderDashboard); return; }
    if (stale(my, hash0)) return;
    if (status.authenticated !== true) return renderLoggedOut(status);
    let stores;
    try {
      const r = await getJson('/api/owner-stores?op=list');
      stores = Array.isArray(r.stores) ? r.stores : [];
    } catch (e) {
      if (stale(my, hash0)) return;
      if (isAuthErr(e)) return renderLoggedOut({ authenticated: false, providers: status.providers });
      failure('가게 목록을 불러오지 못했어요', e, renderDashboard); return;
    }
    if (stale(my, hash0)) return;
    renderLoggedIn(status, stores);
  }

  function renderLoggedOut(status) {
    const links = loginLinks(status);
    setNavbar(btn('처음으로', toHome));
    show(
      h('section', { class: 'card' },
        h('h1', null, '내 가게 계정'),
        h('p', { class: 'muted' }, '로그인하면 만든 가게 페이지를 한곳에서 보고 고칠 수 있어요. 로그인 없이도 지금처럼 페이지를 만들 수 있어요.'),
        links.length
          ? h('div', { class: 'field' }, links.map((l) => h('a', { class: `account-provider account-provider-${l.provider}${l.imageSrc ? '' : ' account-provider-text'}`, href: l.href, 'data-provider': l.provider },
            l.imageSrc ? h('img', { class: 'account-provider-image', src: l.imageSrc, alt: l.imageAlt }) : [l.iconSrc ? h('img', { class: 'account-provider-icon', src: l.iconSrc, alt: '', width: 20, height: 20, 'aria-hidden': 'true' }) : null, h('span', { class: 'account-provider-label' }, l.label)])))
          : h('p', { class: 'card note', role: 'status' }, '계정 로그인은 아직 준비 중이에요. 지금은 로그인할 수 없어요.'),
        btn('로그인 없이 시작하기', toHome, links.length === 0)),
      resumeBlock());
  }

  function renderLoggedIn(status, stores) {
    const msg = note();
    let busy = false;
    const hashAtRender = hashNow();

    function unlinkBlock(s) {
      const ack = h('input', { type: 'checkbox', id: `unlink-ok-${s.id}` });
      const um = note();
      const go = btn('연결 해제하기', async () => {
        if (busy) return;
        if (!ack.checked) { setNote(um, '해제 내용을 이해했다는 항목에 체크해 주세요.', 'error'); return; }
        busy = true; go.disabled = true; setNote(um, '해제하는 중이에요…', 'muted');
        try {
          await post('/api/owner-stores', { action: 'unlink', id: s.id }, 30000);
          busy = false;
          if (hashNow() !== hashAtRender) return;
          return renderDashboard();
        } catch (e) { setNote(um, msgOf(e), 'error'); }
        busy = false; go.disabled = false;
      }, true);
      const box = h('div', { class: 'card note', hidden: true }, h('p', null, '이 계정과의 연결만 끊어요. 가게 페이지는 삭제되지 않고 공개 주소도 그대로 열려요. 기존 관리 비밀번호도 바뀌거나 삭제되지 않아요. 다시 연결하려면 관리 비밀번호가 필요해요.'), h('label', { for: `unlink-ok-${s.id}` }, ack, ' 위 내용을 이해했고, 이 계정에서만 연결을 해제합니다.'), um, go);
      const toggle = btn('계정에서 연결 해제…', () => { box.hidden = !box.hidden; });
      return h('div', null, toggle, box);
    }

    const items = stores.filter((s) => s && ID_RE.test(str(s.id))).map((s) => {
      const url = publicUrl(s.id);
      const qrBox = h('div', null);
      let qrShown = false;
      const qrBtn = btn('QR 보기', () => {
        if (qrShown) { qrBox.replaceChildren?.(); qrShown = false; return; }
        const canvas = h('canvas', { role: 'img', 'aria-label': `${str(s.name)} 공개 페이지 QR 코드`, style: { width: '100%', maxWidth: '220px', height: 'auto', imageRendering: 'pixelated' } });
        try { drawQr(canvas, buildQrModules(url)); } catch { qrBox.append?.(h('p', { class: 'error' }, 'QR 코드를 만들지 못했어요. 주소를 복사해 쓰세요.')); qrShown = true; return; }
        qrBox.append?.(canvas, h('p', { class: 'muted small' }, '이 기기 안에서 만든 QR이에요. 위 공개 주소로 연결돼요.'));
        qrShown = true;
      });
      const when = formatUpdatedAt(s.updatedAt);
      return h('article', { class: 'card', 'data-store-id': s.id },
        h('h2', null, str(s.name) || '(이름 없음)'),
        s.address ? h('p', { class: 'muted' }, str(s.address)) : null,
        s.headline ? h('p', null, str(s.headline)) : null,
        s.hidden === true ? h('p', { class: 'card warn', role: 'status' }, '신고가 쌓여 이 페이지는 현재 숨겨져 있어요. 수정만으로 다시 공개되지는 않아요.') : null,
        when ? h('p', { class: 'small muted' }, `마지막 수정: ${when}`) : null,
        h('p', null, h('a', { href: `/stores/${s.id}`, target: '_blank', rel: 'noopener' }, url)),
        makeAiAccessPanel({ h, fetcher, kind: 'store', storeId: s.id }),
        h('div', { class: 'field' }, btn('내용 수정', () => { location.hash = `#/my-stores/${s.id}`; }, true), qrBtn),
        supportsUnlink ? unlinkBlock(s) : null,
        qrBox);
    });

    // 기존 페이지 연결
    const idIn = h('input', { type: 'text', id: 'claim-id', maxlength: 400, autocomplete: 'off', placeholder: '22자 ID 또는 공개 페이지 주소' });
    const pwIn = h('input', { type: 'password', id: 'claim-pw', maxlength: 200, autocomplete: 'off' });
    const claimBtn = btn('이 계정에 연결', () => submitClaim(), true);
    async function submitClaim() {
      if (busy) return;
      const id = extractStoreId(idIn.value);
      const password = pwIn.value;
      if (!id) { setNote(msg, '22자 페이지 ID나 공개 페이지 주소(…/stores/ID)를 입력해 주세요.', 'error'); return; }
      if (!password) { setNote(msg, '기존 관리 비밀번호를 입력해 주세요. 비밀번호 없이는 연결할 수 없어요.', 'error'); return; }
      busy = true; claimBtn.disabled = true; setNote(msg, '연결하는 중이에요…', 'muted');
      try {
        await post('/api/owner-stores', { action: 'claim', id, password }, 30000);
        pwIn.value = ''; idIn.value = '';
        busy = false;
        if (hashNow() !== hashAtRender) return;
        return renderDashboard();
      } catch (e) {
        pwIn.value = '';
        setNote(msg, msgOf(e), 'error');
      }
      busy = false; claimBtn.disabled = false;
    }

    const outBtn = btn('로그아웃', async () => {
      if (busy) return;
      busy = true; outBtn.disabled = true; setNote(msg, '로그아웃하는 중이에요…', 'muted');
      try {
        await post('/api/owner-auth?op=logout', {}, 20000);
        busy = false;
        if (hashNow() !== hashAtRender) return;
        return renderDashboard();
      } catch (e) { setNote(msg, `${msgOf(e)} 로그아웃되지 않았을 수 있어요.`, 'error'); }
      busy = false; outBtn.disabled = false;
    });

    setNavbar(btn('처음으로', toHome));
    show(
      h('section', { class: 'card' },
        h('h1', null, '내 가게 계정'),
        h('p', { class: 'muted' }, `로그인됨${status.provider ? ` (${status.provider === 'kakao' ? '카카오' : status.provider === 'naver' ? '네이버' : status.provider === 'google' ? '구글' : '소셜'} 계정)` : ''}. 가게 페이지는 로그인 없이도 계속 공개 주소로 열려요.`),
        outBtn),
      resumeBlock(),
      stores.length
        ? items
        : h('section', { class: 'card' }, h('p', { class: 'muted' }, '아직 이 계정에 연결된 가게가 없어요. 아래에서 기존 페이지를 연결하거나, 새 페이지를 만들어 보세요.'), btn('새 가게 페이지 만들기', toHome)),
      h('section', { class: 'card' },
        h('h2', null, '기존 가게 페이지 연결'),
        h('p', { class: 'muted' }, '이미 만든 페이지의 22자 ID 또는 공개 주소와, 그때 정한 관리 비밀번호를 입력하세요. 연결해도 기존 페이지와 주소, 관리 비밀번호는 그대로 남아요. 비밀번호로 소유를 확인할 수 없으면 계정이 대신 가져올 수 없어요. 비밀번호는 저장하지 않고 이번 요청에만 쓰여요.'),
        h('div', { class: 'field' }, h('label', { for: 'claim-id' }, '페이지 ID 또는 주소'), idIn),
        h('div', { class: 'field' }, h('label', { for: 'claim-pw' }, '관리 비밀번호'), pwIn),
        claimBtn),
      msg);
  }

  // ───────── 계정 수정
  async function renderAccountEdit(id) {
    const my = ++seq;
    dirty = false;
    const hash0 = hashNow();
    setNavbar(btn('내 가게 목록', toDash));
    if (!ID_RE.test(str(id))) {
      show(h('section', { class: 'card' }, h('h1', null, '주소를 확인해 주세요'), h('p', { class: 'error', role: 'alert' }, '페이지 주소가 올바르지 않아요.')));
      return;
    }
    show(h('section', { class: 'card' }, h('h1', null, '내용 수정'), h('p', { class: 'muted', role: 'status' }, '불러오는 중이에요…')));
    let res;
    try { res = await getJson(`/api/owner-stores?op=read&id=${encodeURIComponent(id)}`); } catch (e) {
      if (stale(my, hash0)) return;
      if (isAuthErr(e)) {
        show(h('section', { class: 'card' }, h('h1', null, '로그인이 필요해요'), h('p', { class: 'error', role: 'alert' }, '로그인이 풀렸거나 이 계정의 가게가 아니에요.'), btn('내 가게 계정으로', toDash, true)));
      } else failure('가게 정보를 불러오지 못했어요', e, () => renderAccountEdit(id));
      return;
    }
    if (stale(my, hash0)) return;
    if (!validStoreShape(res?.data)) { failure('가게 정보를 불러오지 못했어요', new Error('저장된 내용의 형식이 올바르지 않아요.'), () => renderAccountEdit(id)); return; }
    if (!isValidRevision(res.revision)) {
      // 버전 정보가 없으면 다른 기기의 변경을 덮어쓸 수 있으므로 수정 자체를 막는다.
      failure('지금은 수정할 수 없어요', new Error('저장 버전 정보를 확인하지 못해서, 다른 변경을 덮어쓰지 않도록 수정을 막았어요. 잠시 후 다시 시도해 주세요.'), () => renderAccountEdit(id));
      return;
    }
    edit(id, res.data, res.revision, res.hidden === true, my, hash0);
  }

  function edit(id, original, initialRevision, hidden, my, hash0) {
    const d = {
      name: original.name, address: original.address, headline: original.headline, intro: original.intro,
      sections: original.sections.map((s) => ({ heading: s.heading, body: s.body })),
      faqs: original.faqs.map((f) => ({ question: f.question, answer: f.answer })),
    };
    // situations(예상 질문): 이 필드가 이미 있는 기존 페이지에서만 편집 구역을 보여준다. 없는 새 페이지에는 만들지 않는다.
    let hasSit = Array.isArray(original.situations); // 저장 응답에서 다른 곳이 추가한 예상 질문이 확인되면 true로 바뀔 수 있다
    const pairs = (arr) => arr.map((x) => ({ question: str(x?.question), answer: str(x?.answer) }));
    if (hasSit) d.situations = pairs(original.situations);
    let sitBaseline = hasSit ? pairs(original.situations) : []; // 서버에 있다고 알고 있는 마지막 값
    // 사용자가 예상 질문을 서버 기준값(sitBaseline)과 다르게 고쳤을 때만 true. false면 요청에서 situations를 아예 뺀다.
    const sitChanged = () => hasSit && !samePairs(d.situations, sitBaseline);
    // 저장 응답 검사. 돌려준 data가 있으면 형식이 맞아야 하고, 예상 질문을 보내지 않았는데 이 페이지에 예상 질문이 있었다면 응답에 그 현재 값이 있어야 한다.
    // 반환: { ok:false } 또는 { ok:true, server: 서버의 예상 질문 쌍 | null }
    const checkReturned = (r, withSit, sent) => {
      const rd = r?.data;
      if (rd === undefined || rd === null) return (withSit || !hasSit) ? { ok: true, server: null } : { ok: false };
      if (!validStoreShape(rd)) return { ok: false };
      if (rd.situations === undefined) return hasSit ? { ok: false } : { ok: true, server: null };
      const server = pairs(rd.situations);
      if (withSit && !samePairs(server, sent)) return { ok: false };
      return { ok: true, server };
    };
    let revision = initialRevision; // 마지막으로 서버에서 확인한 버전
    let confirmed = false;
    let busy = false;
    let status = { text: '', cls: 'muted' };
    let conflict = null; // null | { kind: 'conflict' | 'unverified' }
    let latest = null; // 충돌 후 불러온 서버 최신본 { data, revision }
    let overwriteOk = false;
    let gen = 0; // 수정 세대: 입력·추가·삭제마다 늘어난다. 저장 요청 중에 새로 입력했는지 알아낸다.
    let sitGen = 0; // 예상 질문만의 수정 세대(저장 요청 중에 예상 질문을 고쳤는지 구분)
    let okEl = null; // 현재 그려진 '사실 확인' 체크박스
    const markDirty = () => {
      if (stale(my, hash0)) return; // 떠난(오래된) 편집 화면이 지금 화면의 공유 상태를 바꾸지 않게 한다
      dirty = true; gen += 1;
      confirmed = false; // 내용이 바뀌었으니 다시 확인하게 한다
      if (okEl) okEl.checked = false;
    };

    function draw() {
      if (stale(my, hash0)) return; // 다른 화면으로 이동했으면 그리지 않는다(저장 응답이 늦어도 안전)
      const field = (key, label, max, area, obj, fid, isSit = false) => {
        const el = h(area ? 'textarea' : 'input', { id: fid, maxlength: max, rows: area ? 5 : null, type: area ? null : 'text', value: obj[key] });
        el.addEventListener?.('input', () => { obj[key] = el.value; if (isSit) sitGen += 1; markDirty(); });
        return h('div', { class: 'field' }, h('label', { for: fid }, `${label} (최대 ${max}자)`), el);
      };
      const addSection = (heading) => { if (busy || d.sections.length >= LIMITS.max) return; d.sections.push({ heading, body: '' }); markDirty(); draw(); };
      const addBtns = [['안내 항목 추가', ''], ['영업시간 항목 추가', '영업시간'], ['메뉴·가격 항목 추가', '메뉴·가격']].map(([label, heading]) => {
        const b = btn(label, () => addSection(heading));
        if (d.sections.length >= LIMITS.max) b.disabled = true;
        return b;
      });
      const sectionBlock = h('fieldset', { class: 'card' },
        h('legend', null, `안내 항목 (${d.sections.length}/${LIMITS.max})`),
        h('p', { class: 'muted' }, '영업시간, 메뉴·가격, 주차 같은 안내를 항목으로 적어 주세요. 별도의 시간표·메뉴판 기능이 아니라 자유롭게 쓰는 글이에요.'),
        d.sections.map((s, i) => h('div', { class: 'field' },
          field('heading', `제목 ${i + 1}`, LIMITS.heading, false, s, `acc-s${i}-h`),
          field('body', `내용 ${i + 1}`, LIMITS.body, true, s, `acc-s${i}-b`),
          btn('이 안내 항목 삭제', () => { if (busy) return; d.sections.splice(i, 1); markDirty(); draw(); }))),
        h('div', { class: 'field' },
          addBtns,
          d.sections.length >= LIMITS.max ? h('p', { class: 'muted' }, `최대 ${LIMITS.max}개까지예요.`) : null));
      const faqBlock = h('fieldset', { class: 'card' },
        h('legend', null, `고객 질문과 답변 (${d.faqs.length}/${LIMITS.faqs})`),
        d.faqs.map((f, i) => h('div', { class: 'field' },
          field('question', `질문 ${i + 1}`, LIMITS.question, false, f, `acc-q${i}-q`),
          field('answer', `답변 ${i + 1}`, LIMITS.answer, true, f, `acc-q${i}-a`),
          btn('이 질문 삭제', () => { if (busy) return; d.faqs.splice(i, 1); markDirty(); draw(); }))),
        btn('질문 추가', () => { if (busy || d.faqs.length >= LIMITS.faqs) return; d.faqs.push({ question: '', answer: '' }); markDirty(); draw(); }),
        d.faqs.length >= LIMITS.faqs ? h('p', { class: 'muted' }, `최대 ${LIMITS.faqs}개까지예요.`) : null);

      const sitBlock = hasSit ? h('fieldset', { class: 'card', 'data-situations': '1' },
        h('legend', null, `예상 질문과 답변 (${d.situations.length}/${LIMITS.max})`),
        h('p', { class: 'muted' }, '손님이 이런 상황에서 찾는다고 가정한 예상 질문이에요. 실제 검색을 측정한 결과가 아니고, AI가 가게를 언급해 준다고 보장하지 않아요. 답변이 사실과 맞는지 직접 확인해 주세요. 웹 주소는 넣을 수 없고, 여기서는 AI를 쓰지 않아요. 고치지 않으면 서버의 예상 질문은 그대로 유지돼요.'),
        d.situations.map((s, i) => h('div', { class: 'field' },
          field('question', `예상 질문 ${i + 1}`, LIMITS.question, false, s, `acc-t${i}-q`, true),
          field('answer', `예상 답변 ${i + 1}`, LIMITS.answer, true, s, `acc-t${i}-a`, true),
          btn('이 예상 질문 삭제', () => { if (busy) return; d.situations.splice(i, 1); sitGen += 1; markDirty(); draw(); }))),
        btn('예상 질문 추가', () => { if (busy || d.situations.length >= LIMITS.max) return; d.situations.push({ question: '', answer: '' }); sitGen += 1; markDirty(); draw(); }),
        d.situations.length >= LIMITS.max ? h('p', { class: 'muted' }, `최대 ${LIMITS.max}개까지예요.`) : null) : null;

      const msg = note(status.cls);
      msg.textContent = status.text;
      const ok = h('input', { type: 'checkbox', id: 'acc-confirm' });
      ok.checked = confirmed;
      okEl = ok;
      ok.addEventListener?.('change', () => { confirmed = ok.checked; });

      // 충돌·확인 불가 상태: 최신본을 확인하고 덮어쓰기에 따로 동의해야만 다시 저장할 수 있다.
      const needLatest = !!conflict && !latest;
      const needOverwrite = !!conflict && !!latest;
      const save = btn('변경사항 반영하기', () => onSave(), true);
      if (busy || needLatest) save.disabled = true;
      const ow = h('input', { type: 'checkbox', id: 'acc-overwrite' });
      ow.checked = overwriteOk;
      ow.addEventListener?.('change', () => { overwriteOk = ow.checked; });

      async function loadLatest() {
        if (busy) return;
        busy = true; status = { text: '최신 내용을 불러오는 중이에요…', cls: 'muted' }; draw();
        try {
          const r = await getJson(`/api/owner-stores?op=read&id=${encodeURIComponent(id)}`);
          if (stale(my, hash0)) { busy = false; return; } // 떠난 화면: 아무것도 바꾸지 않는다
          if (!validStoreShape(r?.data) || !isValidRevision(r?.revision)) throw new Error('최신 내용의 버전 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');
          latest = { data: r.data, revision: r.revision };
          overwriteOk = false;
          const unchanged = r.revision === revision;
          status = { text: `서버의 최신 내용을 불러왔어요.${unchanged ? ' 조회 시점에는 서버 버전이 그대로예요. 이전 요청이 아직 처리 중일 수도 있어요.' : ' 버전이 바뀌어 있어요(방금 요청이 반영됐거나 다른 변경이 있었을 수 있어요).'} 아래에서 내용을 확인하세요. 내가 입력한 내용은 그대로 남아 있어요.`, cls: 'muted' };
        } catch (e) {
          if (stale(my, hash0)) { busy = false; return; }
          status = { text: msgOf(e), cls: 'error' };
        }
        busy = false; draw();
      }
      function discardAndReload() {
        if (busy || stale(my, hash0)) return;
        if (!confirmLeave('내가 입력한 변경사항을 버리고 서버의 최신 내용을 다시 불러올까요?')) return;
        renderAccountEdit(id);
      }

      async function onSave() {
        if (busy) return;
        confirmed = ok.checked;
        overwriteOk = ow.checked;
        const withSit = sitChanged();
        const { data, error } = buildUpdateData(d, withSit);
        if (error) { setNote(msg, error, 'error'); return; }
        if (!confirmed) { setNote(msg, '바뀐 내용이 사실과 맞고 공개 페이지에 반영해도 된다는 항목에 체크해 주세요.', 'error'); return; }
        if (conflict && !latest) { setNote(msg, '먼저 서버의 최신 내용을 불러와 확인해 주세요.', 'error'); return; }
        if (conflict && !overwriteOk) { setNote(msg, '최신 내용을 확인했고 내 입력으로 덮어써도 되는지 체크해 주세요.', 'error'); return; }
        const expectedRevision = conflict ? latest.revision : revision;
        if (!isValidRevision(expectedRevision)) { setNote(msg, '버전 정보를 확인할 수 없어 저장할 수 없어요.', 'error'); return; }
        const genAtSend = gen;
        const sitGenAtSend = sitGen;
        const prevBaseline = sitBaseline;
        busy = true; save.disabled = true; setNote(msg, '반영하는 중이에요…', 'muted');
        try {
          const r = await post('/api/owner-stores', { action: 'update', id, consent: true, expectedRevision, data }, 30000);
          // 이 편집 화면이 이미 떠난 뒤 응답이 왔다(요청은 성공했을 수 있다): 공유 상태(dirty)나 새 편집 화면은 절대 건드리지 않는다.
          if (stale(my, hash0)) { busy = false; return; }
          // 응답 검증: 새 revision이 유효해야 하고, 서버가 돌려준 data가 있으면 형식이 맞아야 한다.
          // 예상 질문을 보내지 않았는데 이 페이지에 예상 질문이 있었다면, 서버의 현재 situations가 응답에 있어야 오래된 화면 값을 바로잡을 수 있다.
          const sent = withSit ? pairs(data.situations) : null;
          const chk = checkReturned(r, withSit, sent);
          if (!isValidRevision(r?.revision) || !chk.ok) {
            // 저장 결과를 확인할 수 없다: 변경사항 표시를 지우지 않고, 다시 저장하려면 최신본 확인을 거치게 한다.
            conflict = { kind: 'unverified' }; latest = null; overwriteOk = false;
            status = { text: '저장이 되었는지 확인하지 못했어요(새 버전 정보가 없어요). 입력한 내용은 그대로 두었어요. 최신 내용을 불러와 확인한 뒤 다시 시도해 주세요.', cls: 'error' };
          } else {
            revision = r.revision; // 서버에 반영된 새 버전
            conflict = null; latest = null; overwriteOk = false; confirmed = false;
            const full = gen === genAtSend; // false: 저장하는 동안 새로 입력한 내용이 있다 → 지우지도 '저장됨'으로 표시하지도 않는다
            if (full) {
              Object.assign(d, { name: data.name, address: data.address, headline: data.headline, intro: data.intro, sections: data.sections, faqs: data.faqs });
              dirty = false;
            } else dirty = true;
            // 예상 질문 조정: 서버가 지금 가진 값(보낸 값 또는 응답의 data.situations)이 새 기준이 된다.
            const sitEditedDuring = sitGen !== sitGenAtSend;
            const server = withSit ? sent : chk.server;
            let sitNote = '';
            if (server) {
              const remoteChanged = !withSit && hasSit && !samePairs(server, prevBaseline);
              if (!hasSit) { hasSit = true; d.situations = pairs(server); sitNote = ' 다른 곳에서 추가된 예상 질문이 있어 아래에 표시했어요.'; }
              else if (!sitEditedDuring) { d.situations = pairs(server); if (remoteChanged) sitNote = ' 다른 곳에서 바뀐 예상 질문을 최신 값으로 갱신했어요.'; }
              else if (remoteChanged) sitNote = ' 다른 곳에서 예상 질문이 바뀐 상태예요. 입력 중인 예상 질문은 그대로 두었고, 다음에 반영하면 서버의 예상 질문을 내 값으로 덮어써요.';
              sitBaseline = pairs(server);
            }
            status = !full ? { text: '이전 입력은 반영됐지만, 저장하는 동안 새로 고친 내용이 있어요. 그 내용은 아직 반영되지 않았어요. 확인 항목에 다시 체크하고 반영하기를 눌러 주세요.', cls: 'ok' } : { text: hidden ? '내용을 저장했어요. 신고로 숨겨진 페이지는 수정만으로 다시 공개되지 않아요.' : '반영했어요. 공개 페이지에서 확인해 보세요.', cls: 'ok' };
            if (sitNote) status.text += sitNote;
          }
        } catch (e) {
          if (stale(my, hash0)) { busy = false; return; } // 떠난 화면의 오류는 새 화면에 영향을 주지 않는다.
          if (isConflictError(e)) {
            conflict = { kind: 'conflict' }; latest = null; overwriteOk = false;
            status = { text: '다른 기기나 다른 창에서 이 가게 정보가 먼저 바뀌었어요. 아무것도 덮어쓰지 않았고, 내가 입력한 내용은 그대로 남아 있어요. 최신 내용을 불러와 확인해 주세요.', cls: 'error' };
          } else if (isDefinitiveRejection(e)) {
            status = { text: msgOf(e), cls: 'error' }; // 확실히 반영되지 않음: 그대로 고쳐 다시 시도 가능
          } else {
            // 시간 초과·네트워크·서버 오류: 이미 저장됐을 수 있어 바로 다시 보내지 않는다.
            conflict = { kind: 'unverified' }; latest = null; overwriteOk = false;
            status = { text: '요청 결과를 확인하지 못했어요. 이미 저장됐을 수도 있어서 바로 다시 보내지 않았어요. 입력한 내용은 그대로 남아 있어요. 최신 내용을 불러와 비교한 뒤 다시 시도해 주세요.', cls: 'error' };
          }
        }
        busy = false; draw();
      }

      const latestPanel = latest ? h('section', { class: 'card note', 'data-latest': '1' },
        h('h2', null, '서버의 최신 내용 (읽기 전용)'),
        h('p', null, h('b', null, '가게 이름: '), latest.data.name),
        h('p', null, h('b', null, '주소: '), latest.data.address),
        h('p', null, h('b', null, '한 줄 소개: '), latest.data.headline),
        h('p', null, h('b', null, '소개글: '), latest.data.intro),
        latest.data.sections.map((s) => h('p', null, h('b', null, `${s.heading}: `), s.body)),
        latest.data.faqs.map((f) => h('p', null, h('b', null, `Q. ${f.question} `), `A. ${f.answer}`)),
        Array.isArray(latest.data.situations) && latest.data.situations.length ? h('div', { 'data-latest-situations': '1' }, h('h3', null, '서버의 예상 질문과 답변'), latest.data.situations.map((f) => h('p', null, h('b', null, `Q. ${str(f?.question)} `), `A. ${str(f?.answer)}`))) : null,
        sitChanged() ? h('p', { class: 'warn', role: 'status' }, '내가 고친 예상 질문과 답변을 저장하면 위 서버의 예상 질문이 통째로 내 값으로 바뀝니다.') : (hasSit ? h("p", { class: 'muted' }, '예상 질문은 내가 고치지 않았으므로 저장할 때 보내지 않고 서버의 값이 그대로 유지돼요.') : null),
        h('label', { for: 'acc-overwrite' }, ow, ' 위 최신 내용을 확인했고, 내가 입력한 내용으로 덮어써도 됩니다.')) : null;
      const conflictPanel = conflict ? h('section', { class: 'card warn', role: 'alert', 'data-conflict': conflict.kind },
        h('h2', null, conflict.kind === 'conflict' ? '다른 변경과 충돌했어요' : '저장 결과를 확인해야 해요'),
        h('p', null, '이 상태에서는 확인 없이 다시 저장할 수 없어요. 내 입력은 지워지지 않았어요.'),
        h('div', { class: 'field' }, btn('서버 최신 내용 불러와 비교하기', () => loadLatest(), !latest), btn('내 입력을 버리고 최신 내용으로 다시 열기', () => discardAndReload()))) : null;

      setNavbar(btn('내 가게 목록', guardedNav(toDash)), btn('공개 페이지 보기', () => window.open(`/stores/${id}`, '_blank', 'noopener')));
      show(h('section', { class: 'card manage' },
        h('h1', null, '내용 수정'),
        hidden ? h('p', { class: 'card warn', role: 'status' }, '신고가 쌓여 이 페이지가 숨겨졌어요. 수정만으로 다시 공개되지는 않아요.') : null,
        h('p', { class: 'muted' }, '손님에게 보이는 공개 주소(/stores/…)는 바뀌지 않아요. AI는 쓰지 않고, 입력한 내용 그대로 저장돼요. 입력 중인 내용은 이 기기에 저장되지 않으니, 나가기 전에 반영하기를 눌러 주세요.'),
        h('p', { class: 'card note' }, '가게 정보가 인터넷의 다른 정보(지도, 후기, 다른 사이트)와 다르면 어느 쪽이 맞는지 직접 확인해 한쪽으로 맞춰 주세요. 서로 다르면 손님이 헷갈릴 수 있어요.'),
        h('p', { class: 'card note', 'data-consistency-note': '1' }, '한 곳의 조건을 바꿔도 소개글, 안내 항목, 다른 질문·답변에 있는 같은 조건은 자동으로 바뀌지 않아요. 예를 들어 한 질문에서 ‘반려견 테라스만’ 같은 조건을 고쳤다면, 다른 곳에 서로 어긋나는 내용이 남아 있지 않은지 직접 확인하고 해당하는 곳을 모두 고쳐 주세요. 내용을 자동으로 고쳐 쓰지는 않아요.'),
        conflictPanel, latestPanel,
        field('name', '가게 이름', LIMITS.name, false, d, 'acc-name'),
        field('address', '주소', LIMITS.address, false, d, 'acc-address'),
        field('headline', '한 줄 소개', LIMITS.headline, false, d, 'acc-headline'),
        field('intro', '소개글', LIMITS.intro, true, d, 'acc-intro'),
        sectionBlock, faqBlock,
        sitBlock,
        h('section', { class: 'card' }, h('h2', null, '사진'), h('p', { class: 'muted', role: 'status' }, '사진 기능 준비 중이에요. 아직 사진을 올릴 수 없어요.')),
        h('label', { for: 'acc-confirm' }, ok, ' 바뀐 내용이 사실과 맞고, 공개 페이지에 반영해도 됩니다.'),
        msg, save));
    }
    draw();
  }

  return { renderDashboard, renderAccountEdit, isEditingDirty, confirmLeave };
}
