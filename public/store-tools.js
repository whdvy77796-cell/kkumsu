// 가게 페이지 발행 후: 관리(수정·삭제), 신고, 링크·QR·공유 화면. 브라우저 ESM 모듈.
// 비밀번호는 저장·표시·URL 노출을 하지 않고, 이 모듈의 클로저 메모리에만 잠시 둔다. innerHTML은 쓰지 않는다.
import qrcode from './vendor/qrcode.mjs';

export const ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const LIMITS = { name: 60, address: 120, headline: 200, intro: 2000, heading: 200, body: 4000, question: 300, answer: 2000, max: 8, faqs: 12 };
export const REPORT_REASONS = [
  { code: 'impersonation', label: '다른 사람이나 가게를 사칭하고 있어요' },
  { code: 'inaccurate', label: '내용이 사실과 달라요' },
  { code: 'inappropriate', label: '부적절하거나 불쾌한 내용이에요' },
  { code: 'other', label: '그 밖의 문제가 있어요' },
];

const str = (v) => (typeof v === 'string' ? v : '');
const len = (s) => [...s].length;

export function publicUrl(id, origin) {
  return `${origin ?? globalThis.location?.origin ?? ''}/stores/${id}`;
}
export function manageHref(id) { return `/#/manage/${id}`; }

// 홍보 문구: 전달받은 가게 이름·한 줄 소개·소개글 외의 사실은 쓰지 않는다.
export function buildShareText(data, url) {
  const name = str(data?.name).trim();
  const headline = str(data?.headline).trim();
  let intro = str(data?.intro).trim().replace(/\s+/g, ' ');
  if (len(intro) > 140) intro = `${[...intro].slice(0, 140).join('').trimEnd()}…`;
  return [`${name} 소개 페이지를 만들었어요.`, headline, intro, `자세한 내용은 여기서 확인해 보세요.\n${url}`].filter(Boolean).join('\n\n');
}

export function validStoreShape(d) {
  return !!d && typeof d === 'object' && ['name', 'address', 'headline', 'intro'].every((k) => typeof d[k] === 'string')
    && Array.isArray(d.sections) && d.sections.every((s) => s && typeof s.heading === 'string' && typeof s.body === 'string')
    && Array.isArray(d.faqs) && d.faqs.every((f) => f && typeof f.question === 'string' && typeof f.answer === 'string')
    && (d.situations === undefined || (Array.isArray(d.situations) && d.situations.every((f) => f && typeof f.question === 'string' && typeof f.answer === 'string')));
}

// 편집 중인 값을 서버에 보낼 정확한 모양으로 정리하고 문제를 찾는다. 오류 없으면 error는 null.
export function cleanStoreData(d) {
  const t = (v) => str(v).trim();
  const data = {
    name: t(d.name), address: t(d.address), headline: t(d.headline), intro: t(d.intro),
    sections: (d.sections || []).map((s) => ({ heading: t(s.heading), body: t(s.body) })),
    faqs: (d.faqs || []).map((f) => ({ question: t(f.question), answer: t(f.answer) })),
    situations: (Array.isArray(d.situations) ? d.situations : []).map((f) => ({ question: t(f?.question), answer: t(f?.answer) })),
  };
  const need = (v, label, max) => (!v ? `${label}을(를) 입력해 주세요.` : len(v) > max ? `${label}은(는) ${max}자까지 쓸 수 있어요.` : null);
  let error = need(data.name, '가게 이름', LIMITS.name) || need(data.address, '주소', LIMITS.address)
    || need(data.headline, '한 줄 소개', LIMITS.headline) || need(data.intro, '소개글', LIMITS.intro);
  if (!error && data.sections.length > LIMITS.max) error = `안내 항목은 ${LIMITS.max}개까지 넣을 수 있어요.`;
  if (!error && data.faqs.length > LIMITS.faqs) error = `고객 질문과 답변은 ${LIMITS.faqs}개까지 넣을 수 있어요.`;
  if (!error && data.situations.length > LIMITS.max) error = `예상 질문은 ${LIMITS.max}개까지 넣을 수 있어요.`;
  data.sections.forEach((s, i) => { error ||= need(s.heading, `안내 ${i + 1}의 제목`, LIMITS.heading) || need(s.body, `안내 ${i + 1}의 내용`, LIMITS.body); });
  data.faqs.forEach((f, i) => { error ||= need(f.question, `질문 ${i + 1}`, LIMITS.question) || need(f.answer, `답변 ${i + 1}`, LIMITS.answer); });
  data.situations.forEach((f, i) => { error ||= need(f.question, `예상 질문 ${i + 1}`, LIMITS.question) || need(f.answer, `예상 질문 ${i + 1}의 답변`, LIMITS.answer); });
  const situationUrl = /(?:\b[a-z][a-z\d+.-]*:\/\/|(?:mailto|tel|file|vbscript|blob):|\/\/[\p{L}\p{N}]|(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,63}|한국)(?=$|[^\p{L}\p{N}-]))/iu;
  if (!error && data.situations.some(f => situationUrl.test(f.question) || situationUrl.test(f.answer))) error = '예상 질문과 답변에는 웹 주소를 넣을 수 없어요.';
  return { data, error };
}

// QR 모듈 행렬(true=검정). 주소는 이 브라우저 안에서만 인코딩한다.
export function buildQrModules(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}
// 정수 배율로 선명하게 그리고, 사방에 4칸(quiet zone)을 둔다.
export function drawQr(canvas, modules, cell = 10, quiet = 4) {
  const size = (modules.length + quiet * 2) * cell;
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#000000';
  modules.forEach((row, r) => row.forEach((on, c) => { if (on) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell); }));
  return size;
}

async function copyText(text, field) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 권한이 막힌 경우 아래 대체 방법 */ }
  try {
    if (field?.select) {
      field.focus?.(); field.select(); field.setSelectionRange?.(0, text.length);
      if (document.execCommand?.('copy')) return true;
    }
  } catch { /* 선택 상태만 유지 */ }
  return false;
}

export function makeStoreTools({ h, show, setNavbar, btn, post, onDeleted, onUpdated }) {
  const msgOf = (e) => (e && e.message) || '요청이 실패했어요. 잠시 후 다시 시도해 주세요.';
  const toHome = () => { location.hash = '#/'; };
  const openPublic = (id) => () => window.open(`/stores/${id}`, '_blank', 'noopener');
  const badId = () => {
    setNavbar(btn('처음으로', toHome, true));
    show(h('section', { class: 'card' }, h('h1', null, '주소를 확인해 주세요'), h('p', { class: 'muted', role: 'alert' }, '페이지 주소가 올바르지 않아요.')));
  };
  const note = (cls = 'muted') => h('p', { class: cls, 'aria-live': 'polite' });
  const setNote = (el, text, cls) => { el.textContent = text; if (cls) el.className = cls; };

  // ───────── 관리
  function renderManage(id) {
    if (!ID_RE.test(String(id))) return badId();
    let password = ''; // 메모리 전용: 저장·표시·URL 사용 안 함
    let busy = false;
    const viewLink = () => h('a', { href: `/stores/${id}`, target: '_blank', rel: 'noopener' }, '공개 페이지 열기');

    function login() {
      password = '';
      const pw = h('input', { type: 'password', id: 'manage-pw', autocomplete: 'current-password', maxlength: 200, required: true });
      const status = note();
      const go = btn('관리 시작', () => submit(), true);
      async function submit() {
        const typed = pw.value;
        if (busy) return;
        if (!typed) { setNote(status, '비밀번호를 입력해 주세요.', 'error'); return; }
        busy = true; go.disabled = true; setNote(status, '확인하는 중이에요…', 'muted');
        try {
          const res = await post('/api/stores', { action: 'auth', id, password: typed }, 20000);
          let data = validStoreShape(res?.data) ? res.data : null;
          if (!data) {
            const r = await fetch(`/api/stores?id=${encodeURIComponent(id)}`);
            const j = await r.json().catch(() => null);
            if (!r.ok || !validStoreShape(j?.data)) throw new Error('가게 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
            data = j.data;
          }
          password = typed; pw.value = '';
          busy = false;
          edit(data, res?.hidden === true);
          return;
        } catch (e) {
          setNote(status, msgOf(e), 'error');
        }
        busy = false; go.disabled = false;
      }
      setNavbar(btn('공개 페이지 보기', openPublic(id)));
      show(h('section', { class: 'card manage' },
        h('h1', null, '가게 페이지 관리'),
        h('p', { class: 'muted' }, '이 화면은 만든 사람만 쓰는 관리 화면이에요. 손님에게 보이는 공개 페이지와 달라요.'),
        h('label', { for: 'manage-pw' }, '관리 비밀번호'), pw,
        h('p', { class: 'muted' }, '비밀번호는 잃어버리면 복구할 수 없어요. 이 기기에 저장하지 않고, 화면에도 다시 보여주지 않아요.'),
        h('p', { class: 'small muted' }, '이전에 이 가게를 계정에 연결해 두셨다면 ', h('a', { href: 'https://www.kkumsu.com/#/my-stores' }, '기존 계정으로 관리하기 (기존 주소)'), '를 이용할 수 있어요.'),
        status, go, viewLink()));
      pw.addEventListener?.('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }

    function edit(initial, hidden = false) {
      const d = {
        name: initial.name, address: initial.address, headline: initial.headline, intro: initial.intro,
        sections: initial.sections.map((s) => ({ ...s })), faqs: initial.faqs.map((f) => ({ ...f })),
        situations: (Array.isArray(initial.situations) ? initial.situations : []).map((f) => ({ question: f.question, answer: f.answer })),
      };
      // Existing pages that already published the previous separate questions
      // retain their owner controls. New pages use only the single FAQ list.
      const hasLegacySituations = d.situations.length > 0;
      let verified = false;
      let status = { text: '', cls: 'muted' };
      let confirmDelete = false;
      let deleteChecked = false;

      function draw() {
        const field = (key, label, max, area, obj, idx) => {
          const fid = `f-${key}${idx}`;
          const el = h(area ? 'textarea' : 'input', { id: fid, maxlength: max, rows: area ? 5 : null, type: area ? null : 'text', value: obj[key] });
          el.addEventListener?.('input', () => { obj[key] = el.value; });
          return h('div', { class: 'field' }, h('label', { for: fid }, `${label} (최대 ${max}자)`), el);
        };
        const list = (kind) => {
          const isSec = kind === 'sections';
          const isSit = kind === 'situations';
          const arr = d[kind];
          const title = isSec ? '안내 항목' : isSit ? '기존에 공개한 예상 질문' : '고객 질문과 답변';
          const addLabel = isSec ? '안내 항목 추가' : isSit ? '예상 질문 추가' : '질문 추가';
          const delLabel = isSec ? '이 안내 항목 삭제' : isSit ? '이 예상 질문 삭제' : '이 질문 삭제';
          const prefix = isSit ? '예상 질문' : '질문';
          const max = isSec || isSit ? LIMITS.max : LIMITS.faqs;
          const add = btn(addLabel, () => { if (arr.length >= max) return; arr.push(isSec ? { heading: '', body: '' } : { question: '', answer: '' }); draw(); });
          add.disabled = arr.length >= max;
          return h('fieldset', { class: 'card' },
            h('legend', null, `${title} (${arr.length}/${max})`),
            isSit ? h('p', { class: 'muted' }, '손님이 이런 상황에서 찾는다고 가정한 예상 질문이에요. 실제 사용자 검색을 측정한 결과가 아니에요. 답변이 사실과 맞는지 직접 확인해 주세요. AI가 가게를 언급해 준다고 보장하지 않아요. 여기서 고치는 데에는 AI를 쓰지 않아요.') : null,
            arr.map((it, i) => h('div', { class: 'field' },
              isSec
                ? [field('heading', `제목 ${i + 1}`, LIMITS.heading, false, it, `-s${i}`), field('body', `내용 ${i + 1}`, LIMITS.body, true, it, `-s${i}`)]
                : [field('question', `${prefix} ${i + 1}`, LIMITS.question, false, it, `${isSit ? '-t' : '-q'}${i}`), field('answer', `답변 ${i + 1}`, LIMITS.answer, true, it, `${isSit ? '-t' : '-q'}${i}`)],
              btn(delLabel, () => { arr.splice(i, 1); draw(); }))),
            add,
            arr.length >= max ? h('p', { class: 'muted' }, `최대 ${max}개까지예요.`) : null);
        };
        const msg = h('p', { class: status.cls, role: 'status', 'aria-live': 'polite' }, status.text);
        const ok = h('input', { type: 'checkbox', id: 'verified' });
        ok.checked = verified;
        ok.addEventListener?.('change', () => { verified = ok.checked; });
        const save = btn('저장하기', () => onSave(), true);
        async function onSave() {
          if (busy) return;
          verified = ok.checked;
          const { data, error } = cleanStoreData(d);
          if (error) { setNote(msg, error, 'error'); return; }
          if (!verified) { setNote(msg, '바뀐 내용이 사실과 맞는지 확인했다는 항목에 체크해 주세요.', 'error'); return; }
          busy = true; save.disabled = true; setNote(msg, '저장하는 중이에요…', 'muted');
          try {
            await post('/api/stores', { action: 'update', id, password, data, consent: true }, 30000);
            Object.assign(d, data); onUpdated?.(id, data); verified = false;
            status = { text: hidden ? '내용을 저장했어요. 신고로 숨겨진 페이지는 수정만으로 다시 공개되지 않아요.' : '저장했어요. 공개 페이지에 반영됐는지 확인해 보세요.', cls: 'ok' };
          } catch (e) { status = { text: msgOf(e), cls: 'error' }; }
          busy = false; draw();
        }
        const delBox = h('input', { type: 'checkbox', id: 'del-ok' });
        delBox.checked = deleteChecked;
        delBox.addEventListener?.('change', () => { deleteChecked = delBox.checked; });
        const delStatus = note();
        const delGo = btn('영구 삭제하기', async () => {
          if (busy) return;
          if (!delBox.checked) { setNote(delStatus, '삭제를 이해했다는 항목에 체크해 주세요.', 'error'); return; }
          busy = true; delGo.disabled = true; setNote(delStatus, '삭제하는 중이에요…', 'muted');
          try {
            await post('/api/stores', { action: 'delete', id, password }, 30000);
            password = ''; busy = false; onDeleted?.(id); deleted();
          } catch (e) { busy = false; delGo.disabled = false; setNote(delStatus, msgOf(e), 'error'); }
        }, true);
        const delArea = confirmDelete
          ? h('div', { class: 'card danger' }, h('p', null, '삭제하면 공개 주소가 더 이상 열리지 않고, 되돌릴 수 없어요.'),
            h('label', { for: 'del-ok' }, delBox, ' 되돌릴 수 없다는 것을 이해했고, 이 페이지를 삭제합니다.'), delStatus, delGo,
            btn('취소', () => { confirmDelete = false; deleteChecked = false; draw(); }))
          : btn('이 페이지 삭제…', () => { confirmDelete = true; draw(); });
        setNavbar(btn('공개 페이지 보기', openPublic(id)));
        show(h('section', { class: 'card manage' },
          h('h1', null, '내용 수정'),
          hidden ? h('p', { class: 'card warn', role: 'status' }, '신고가 쌓여 이 페이지가 숨겨졌어요. 내용을 수정하거나 삭제할 수 있지만, 수정만으로 다시 공개되지는 않아요.') : null,
          h('p', { class: 'muted' }, '관리 화면이에요. 손님에게는 공개 페이지(/stores/…)만 보여요. AI는 쓰지 않고, 입력한 내용 그대로 저장돼요.'),
          field('name', '가게 이름', LIMITS.name, false, d, ''), field('address', '주소', LIMITS.address, false, d, ''),
          field('headline', '한 줄 소개', LIMITS.headline, false, d, ''), field('intro', '소개글', LIMITS.intro, true, d, ''),
          list('sections'), list('faqs'), hasLegacySituations ? list('situations') : null,
          h('label', { for: 'verified' }, ok, ' 바뀐 내용이 사실과 맞는지 직접 확인했어요.'),
          msg, save, viewLink(),
          h('hr'), h('h2', null, '페이지 삭제'), delArea));
      }
      draw();
    }

    function deleted() {
      setNavbar(btn('처음으로', toHome, true));
      show(h('section', { class: 'card' }, h('h1', null, '페이지를 삭제했어요'), h('p', { class: 'muted', role: 'status' }, '공개 주소는 더 이상 열리지 않아요. 검색 결과에서 사라지는 시간은 검색 서비스마다 달라요.')));
    }
    login();
  }

  // ───────── 신고
  function renderReport(id) {
    if (!ID_RE.test(String(id))) return badId();
    let reason = '';
    let busy = false;
    let sent = false;
    const status = note();
    const go = btn('신고하기', async () => {
      if (busy || sent) return;
      if (!reason) { setNote(status, '이유를 하나 골라 주세요.', 'error'); return; }
      busy = true; go.disabled = true; setNote(status, '보내는 중이에요…', 'muted');
      try {
        await post('/api/stores', { action: 'report', id, reason }, 20000);
        sent = true;
        setNote(status, '신고가 접수됐어요. 신고가 쌓이면 이 페이지가 숨겨질 수 있어요. 개별 검토나 처리 결과는 약속드리지 못해요.', 'ok');
      } catch (e) { go.disabled = false; setNote(status, msgOf(e), 'error'); }
      busy = false;
    }, true);
    setNavbar(btn('공개 페이지로', () => { location.href = `/stores/${id}`; }));
    show(h('section', { class: 'card report' },
      h('h1', null, '이 페이지 신고'),
      h('p', { class: 'muted' }, '이유만 골라 주세요. 이름·연락처 등 개인정보는 받지 않아요.'),
      h('fieldset', null, h('legend', null, '신고 이유'),
        REPORT_REASONS.map((r) => {
          const input = h('input', { type: 'radio', name: 'reason', id: `r-${r.code}`, value: r.code });
          input.addEventListener?.('change', () => { reason = r.code; });
          return h('div', null, h('label', { for: `r-${r.code}` }, input, ` ${r.label}`));
        })),
      status, go));
  }

  // ───────── 발행 완료: 링크·공유·QR
  function renderPublished(id, data) {
    if (!ID_RE.test(String(id))) return badId();
    const url = publicUrl(id);
    const manageUrl = `${globalThis.location?.origin ?? ''}${manageHref(id)}`;
    const urlField = h('input', { type: 'text', readonly: true, id: 'pub-url', value: url, 'aria-label': '공개 페이지 주소' });
    const urlNote = note();
    const copyUrl = btn('주소 복사', async () => {
      setNote(urlNote, (await copyText(url, urlField)) ? '주소를 복사했어요.' : '자동 복사가 막혔어요. 선택된 주소를 직접 복사해 주세요.', 'muted');
    });
    const shareBox = h('textarea', { id: 'share-text', rows: 9, 'aria-label': '공유 문구(수정 가능)' });
    shareBox.value = buildShareText(data, url);
    const shareNote = note();
    const copyShare = btn('문구 복사', async () => {
      setNote(shareNote, (await copyText(shareBox.value, shareBox)) ? '문구를 복사했어요.' : '자동 복사가 막혔어요. 선택된 문구를 직접 복사해 주세요.', 'muted');
    });

    const canvas = h('canvas', { 'aria-label': '공개 페이지 QR 코드', role: 'img', style: { width: '100%', maxWidth: '260px', height: 'auto', imageRendering: 'pixelated' } });
    const qrNote = note();
    let qrReady = false;
    try { drawQr(canvas, buildQrModules(url)); qrReady = true; } catch { setNote(qrNote, 'QR 코드를 만들지 못했어요. 주소를 복사해 쓰세요.', 'error'); }
    const download = btn('QR 이미지(PNG) 저장', () => {
      if (!qrReady) return;
      try {
        canvas.toBlob((blob) => {
          if (!blob) { setNote(qrNote, '이미지를 만들지 못했어요.', 'error'); return; }
          const obj = URL.createObjectURL(blob);
          const a = h('a', { href: obj, download: `store-qr-${id.slice(0, 6)}.png` });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(obj), 4000);
        }, 'image/png');
      } catch { setNote(qrNote, '이미지 저장에 실패했어요.', 'error'); }
    });
    download.disabled = !qrReady;

    setNavbar(btn('공개 페이지 보기', openPublic(id), true));
    show(
      h('section', { class: 'card published' },
        h('h1', null, '페이지가 발행됐어요'),
        h('h2', null, '공개 페이지 (손님에게 알려도 되는 주소)'),
        h('p', null, h('a', { href: `/stores/${id}`, target: '_blank', rel: 'noopener' }, url)),
        urlField, copyUrl, urlNote,
        h('p', { class: 'muted' }, '지금 보고 있는 주소 기준이에요. 검색에 노출되는 시점이나 순위는 보장하지 않아요.')),
      h('section', { class: 'card' },
        h('h2', null, '공유 문구'),
        h('p', { class: 'muted' }, '입력하신 가게 이름·한 줄 소개·소개글로 만든 문구예요. 자유롭게 고쳐서 쓰세요.'),
        shareBox, copyShare, shareNote),
      h('section', { class: 'card' },
        h('h2', null, 'QR 코드'),
        h('p', { class: 'muted' }, '이 기기 안에서 만들어요. 주소를 외부 QR 서비스로 보내지 않아요.'),
        canvas, download, qrNote),
      h('section', { class: 'card manage-link' },
        h('h2', null, '관리 (만든 사람 전용)'),
        h('p', null, h('a', { href: manageHref(id) }, '내용 수정·삭제하기'), ' (관리 비밀번호가 필요해요)'),
        h('p', { class: 'muted' }, `관리 주소: ${manageUrl} — 손님에게 공유하지 마세요. 비밀번호는 잃어버리면 복구할 수 없어요.`)));
  }

  return { renderManage, renderReport, renderPublished };
}
