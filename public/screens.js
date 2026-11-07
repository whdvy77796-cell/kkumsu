// 자료 첨부 화면 · 외부 정보 화면
import { h, clear, toast, S, api, saveNow, scheduleSave, setAnswer, uid } from './ui.js';
import { UPLOAD_KINDS, QMAP } from '/shared/questions.js';
import { compute, specText } from '/shared/calc.js';
import { publicInfoChecks, competitorComparisons, SOURCE_LABEL, OWN_FIELDS, uncheckedChannels, entryUsable } from '/shared/external.js';
import { fmtMan, fmtWon, fmtPct, isNum, todayISO, parseSpec } from '/shared/format.js';
import { parseNum, fieldInput } from './fields.js';

export function attachmentsOf(kind) {
  return (S.data?.attachments || []).filter((f) => !kind || f.kind === kind);
}

export async function uploadFiles(files, kind) {
  await saveNow();
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) { toast(`${file.name}: 10MB보다 커서 올리지 않았어요.`); continue; }
    try {
      toast(`${file.name} 올리는 중...`);
      const r = await api(`/api/cases/${S.caseId}/files`, { method: 'POST', raw: true, body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Kind': kind } });
      S.data = r.data; S.version = r.version;
      toast(`${file.name} 올렸어요.`);
    } catch (e) {
      toast(`${file.name}: ${e.message}`, 4000);
    }
  }
}

async function loadThumb(f, img) {
  try {
    const blob = await api(`/api/cases/${S.caseId}/files/${f.id}`);
    img.src = URL.createObjectURL(blob);
  } catch { img.alt = '미리보기를 불러오지 못했어요'; }
}

// ───────────────── 자료 첨부
export function renderFiles(view, { setNavbar }) {
  const rer = () => renderFiles(view, { setNavbar });
  let kindSel;
  const fi = h('input', { type: 'file', multiple: true, accept: 'image/*,.pdf,.csv,.txt,.xlsx', hidden: true, onchange: async (e) => { await uploadFiles([...e.target.files], kindSel.value); rer(); } });
  const root = h('div', null,
    h('div', { class: 'card' }, h('h2', null, '자료 추가 (선택)'),
      h('p', { class: 'small' }, '말로 설명하기 어려운 부분은 사진이나 파일로 보여주세요. 없어도 진행할 수 있어요.'),
      h('ul', { class: 'small muted' },
        h('li', null, '올린 자료는 이어하기 링크를 가진 사람만 볼 수 있고, 암호화해 저장해요.'),
        h('li', null, '사람 얼굴이나 손님 개인정보가 나오지 않게 찍어주세요. 화장실은 사람이 없을 때 찍어주세요.'),
        h('li', null, h('b', null, '데모: '), '사진 속 글자나 상태를 자동으로 읽지 않아요(AI 미연결). 매출 CSV 파일은 숫자를 읽어 확인 화면을 보여드려요.')),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, '어떤 자료인가요?'), kindSel = h('select', null, UPLOAD_KINDS.map((k) => h('option', { value: k.v }, k.label)))),
      fi, h('button', { class: 'btn primary block', onclick: () => fi.click() }, '파일 고르기'),
      h('p', { class: 'tiny muted' }, '사진(JPG·PNG·WEBP·HEIC), PDF, CSV · 파일당 10MB · 최대 30개')),
  );
  const files = attachmentsOf();
  if (!files.length) root.append(h('p', { class: 'muted' }, '아직 올린 자료가 없어요.'));
  for (const k of UPLOAD_KINDS) {
    const list = files.filter((f) => f.kind === k.v);
    if (!list.length) continue;
    root.append(h('h3', null, k.label));
    for (const f of list) root.append(fileCard(f, rer));
  }
  clear(view).append(root);
  setNavbar(h('a', { class: 'btn', href: `#/c/${S.caseId}/interview` }, '인터뷰'), h('a', { class: 'btn primary', href: `#/c/${S.caseId}/external` }, '다음: 외부 정보'));
}

function fileCard(f, rer) {
  const box = h('div', { class: 'filebox' });
  const head = h('div', { class: 'rowhead', style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
    h('b', null, f.name), h('button', { class: 'btn small danger', onclick: async () => {
      if (!confirm(`${f.name} 파일을 삭제할까요?`)) return;
      await saveNow();
      const r = await api(`/api/cases/${S.caseId}/files/${f.id}`, { method: 'DELETE' });
      S.data = r.data; S.version = r.version; toast('삭제했어요.'); rer();
    } }, '삭제'));
  box.append(head, h('div', { class: 'tiny muted' }, `${Math.round(f.size / 1024)}KB · ${new Date(f.at).toLocaleString('ko-KR')}`));
  if (f.type === 'image') {
    if (f.mime === 'image/heic') box.append(h('p', { class: 'small muted' }, 'HEIC 사진은 이 브라우저에서 미리보기가 안 될 수 있어요.'));
    else { const img = h('img', { alt: f.name, style: { maxWidth: '100%', maxHeight: '260px', borderRadius: '10px', marginTop: '8px', display: 'block' } }); box.append(img); loadThumb(f, img); }
  }
  if (f.extractNote) box.append(h('p', { class: 'small' }, h('span', { class: 'badge ev-need' }, '자동 판독 없음'), ' ', f.extractNote));
  if (f.type === 'image' || f.type === 'pdf') {
    const att = S.data.attachments.find((x) => x.id === f.id);
    box.append(h('label', { class: 'field' }, h('span', { class: 'lab' }, '이 자료에서 사장님이 확인한 점 (선택)'),
      h('textarea', { placeholder: '예: 메뉴판 맨 아래 가격이 손글씨로 고쳐져 있음', oninput: (e) => { att.note = e.target.value; scheduleSave(); } }, att.note || '')));
    const go = { menu_board: ['m_list', '메뉴 목록에 직접 옮겨 적기'], receipt: ['p_items', '매입 품목에 직접 옮겨 적기'], sales_file: ['s_history', '월별 매출에 직접 옮겨 적기'], review: [null, '리뷰 내용을 외부 정보에 기록'] }[f.kind];
    if (go) box.append(h('a', { class: 'btn small', href: go[0] ? `#/c/${S.caseId}/interview/${go[0]}` : `#/c/${S.caseId}/external` }, go[1]));
  }
  if (f.type === 'csv') box.append(csvCard(f, rer));
  return box;
}

function csvCard(f, rer) {
  const ex = f.extract;
  const wrap = h('div', { style: { marginTop: '10px' } });
  if (!ex) return wrap;
  const colSel = (label, key) => {
    const sel = h('select', { onchange: async () => {
      await saveNow();
      const body = { dateCol: dateS.value === '' ? null : +dateS.value, amountCol: amtS.value === '' ? null : +amtS.value, statusCol: stS.value === '' ? null : +stS.value };
      const r = await api(`/api/cases/${S.caseId}/files/${f.id}/extract`, { method: 'POST', body });
      S.data = r.data; S.version = r.version; rer();
    } }, h('option', { value: '' }, '없음'), (ex.columns || []).map((c) => h('option', { value: c.i }, c.name || `열 ${c.i + 1}`)));
    sel.value = ex[key] === null || ex[key] === undefined ? '' : String(ex[key]);
    return [h('span', { class: 'small' }, label), sel];
  };
  const [dl, dateS] = colSel('날짜 열', 'dateCol');
  const [al, amtS] = colSel('금액 열', 'amountCol');
  const [sl, stS] = colSel('취소 표시 열(선택)', 'statusCol');
  wrap.append(h('h4', null, '파일에서 읽은 값 (확인 전에는 분석에 쓰지 않아요)'), h('div', { class: 'grid2' }, h('label', { class: 'field' }, dl, dateS), h('label', { class: 'field' }, al, amtS), h('label', { class: 'field' }, sl, stS)));
  if (!ex.ok) { wrap.append(h('p', { class: 'hint' }, ex.error)); return wrap; }
  const months = ex.months.map((m) => ({ ...m }));
  const table = h('table', { class: 't' }, h('tr', null, h('th', null, '월'), h('th', null, '합계 (원)'), h('th', null, '결제 줄 수')),
    months.map((m) => h('tr', null, h('td', null, m.month, m.partial ? h('div', { class: 'tiny muted' }, `기록 ${m.days}일 - 한 달 전체가 아닐 수 있음`) : null),
      h('td', null, h('input', { type: 'text', inputmode: 'numeric', value: String(m.total), oninput: (e) => { const n = parseNum(e.target.value); if (isNum(n)) m.total = n; } })),
      h('td', null, h('input', { type: 'text', inputmode: 'numeric', value: String(m.count), oninput: (e) => { const n = parseNum(e.target.value); if (isNum(n)) m.count = n; } })))));
  const wd = ['월', '화', '수', '목', '금', '토', '일'];
  wrap.append(h('div', { class: 'tscroll' }, table),
    h('p', { class: 'small muted' }, `읽은 줄 ${ex.usedRows}개 / 전체 ${ex.rowCount}개`),
    h('p', { class: 'small' }, '요일별 합계: ', wd.map((d, i) => `${d} ${fmtMan(ex.weekday[i])}`).join(' · ')),
    ex.warnings.length ? h('ul', { class: 'small' }, ex.warnings.map((w) => h('li', null, w))) : null);
  if (f.extractApplied) { wrap.append(h('p', { class: 'okline' }, '확인 후 매출 답변에 반영했어요. 숫자를 바꾸려면 인터뷰의 매출 질문에서 고쳐주세요.')); return wrap; }
  if (f.confirmed) { wrap.append(h('p', { class: 'okline' }, '확인한 참고 자료예요. 전체 매출이 다 들어 있지 않아 매출 답변에는 반영하지 않았어요.')); return wrap; }
  const full = months.filter((m) => !m.partial);
  const basisSel = h('select', null, h('option', { value: 'gross' }, '손님 결제금액 (수수료 빼기 전)'), h('option', { value: 'net' }, '통장 입금액 (수수료 빠짐)'), h('option', { value: 'unknown' }, '잘 모르겠어요'));
  const cHist = h('input', { type: 'checkbox', checked: true });
  const cLatest = h('input', { type: 'checkbox', checked: full.length > 0 });
  const cOrders = h('input', { type: 'checkbox', checked: false });
  const cOk = h('input', { type: 'checkbox' });
  const scopeSel = h('select', null, h('option', { value: '' }, '선택해 주세요'), h('option', { value: 'all' }, '매장·포장·배달 매출이 모두 들어 있어요'), h('option', { value: 'part' }, '일부만 들어 있어요 (예: 배달앱 매출 빠짐)'), h('option', { value: 'unknown' }, '잘 모르겠어요'));
  const replaceNote = h('div', { class: 'small' });
  const A0 = S.data.answers;
  const cur = (id, fmt) => (A0[id] && A0[id].v !== undefined && A0[id].v !== null && !['unknown', 'na', 'later'].includes(A0[id].s) ? fmt(A0[id].v) : null);
  const updateNote = () => {
    const items = [];
    const last = months.filter((m) => !m.partial).slice(-1)[0];
    if (scopeSel.value === 'all' && cLatest.checked && last && cur('s_monthly', fmtMan)) items.push(`최근 월매출: 지금 답변 ${cur('s_monthly', fmtMan)} → 파일 값 ${fmtMan(last.total)}`);
    if (scopeSel.value === 'all' && cOrders.checked && last && cur('s_orders', (v) => `${v}건`)) items.push(`월 주문 건수: 지금 답변 ${cur('s_orders', (v) => `${v}건`)} → 파일 값 ${last.count}건`);
    replaceNote.textContent = scopeSel.value && scopeSel.value !== 'all' ? '전체 매출이 다 들어 있지 않은 파일은 월매출·주문 수로 쓰지 않고, 확인한 참고 자료로만 보관해요.' : items.length ? `바뀌는 답변: ${items.join(' / ')}` : '';
    applyBtn.disabled = !(cOk.checked && scopeSel.value);
  };
  const applyBtn = h('button', { class: 'btn primary block', disabled: true, onclick: () => {
    const src = `file:${f.id}`;
    const att = S.data.attachments.find((x) => x.id === f.id);
    if (scopeSel.value !== 'all') {
      att.confirmed = true; att.extractApplied = false; att.note = `${att.note ? att.note + ' / ' : ''}일부 매출만 담긴 파일(참고용)`;
      scheduleSave(100);
      toast('참고 자료로만 보관했어요. 매출 답변은 바꾸지 않았어요.');
      setTimeout(rer, 300);
      return;
    }
    const fullNow = months.filter((m) => !m.partial);
    if (cHist.checked) setAnswer('s_history', { v: months.map((m) => ({ month: m.month, amount: m.total })), s: 'exact', src });
    const last = fullNow[fullNow.length - 1];
    if (last && cLatest.checked) {
      setAnswer('s_monthly', { v: last.total, s: 'exact', src, p: 'month' });
      setAnswer('s_month', { v: last.month, s: 'exact', src });
      setAnswer('s_basis', { v: basisSel.value, s: 'exact', src });
    }
    if (last && cOrders.checked && last.count > 0) {
      setAnswer('s_orders', { v: last.count, s: 'exact', src });
      setAnswer('s_ticket', { v: Math.round(last.total / last.count), s: 'exact', src });
    }
    att.confirmed = true; att.extractApplied = true;
    scheduleSave(100);
    toast('확인한 값을 매출 답변에 반영했어요.');
    setTimeout(rer, 300);
  } }, '확인하고 반영하기');
  for (const el of [cOk, cLatest, cOrders, cHist]) el.onchange = updateNote;
  scopeSel.onchange = updateNote;
  wrap.append(h('div', { class: 'card note' },
    h('label', { class: 'field' }, h('span', { class: 'lab' }, '이 파일에 들어 있는 매출'), scopeSel),
    h('label', { class: 'field' }, h('span', { class: 'lab' }, '이 파일의 금액 기준'), basisSel),
    h('label', { class: 'check-line' }, cHist, '월별 합계를 "월별 매출 기록"에 넣기'),
    h('label', { class: 'check-line' }, cLatest, `가장 최근의 한 달 전체 기록(${full.length ? full[full.length - 1].month : '없음'})을 "최근 월매출"로 쓰기`),
    h('label', { class: 'check-line' }, cOrders, '줄 수를 주문 건수로 쓰기 (한 줄 = 결제 1건인 파일일 때만)'),
    h('label', { class: 'check-line' }, cOk, '위 숫자를 확인했어요 (예: 30을 300으로 잘못 읽지 않았는지)'),
    replaceNote,
    applyBtn));
  return wrap;
}

// ───────────────── 외부 정보
export function renderExternal(view, { setNavbar }) {
  const rer = () => renderExternal(view, { setNavbar });
  S.data.external = S.data.external || { entries: [], quotes: [] };
  const ext = S.data.external;
  const checks = publicInfoChecks(S.data);
  const root = h('div', null,
    h('div', { class: 'card note' }, h('h2', null, '외부 정보'),
      h('p', null, h('span', { class: 'badge ev-need' }, '자동 검색 미연결'), ' 데모에서는 인터넷 검색을 하지 않아요.'),
      h('p', { class: 'small' }, '직접 확인한 공개 정보만 아래에 기록해 주세요. 출처와 확인 날짜, 가게명·주소 일치 여부를 함께 적어야 분석에 써요. 찾지 못한 정보는 비워두면 되고, 없는 정보를 채워 넣지 않아요.')));

  const unchecked = uncheckedChannels(S.data);
  const ch = S.data.profile.channels || {};
  const chList = Object.entries(ch).filter(([, v]) => v);
  root.append(h('div', { class: 'card' }, h('h3', null, '등록한 채널'),
    chList.length ? h('ul', null, chList.map(([k, v]) => h('li', { class: 'small' }, `${SOURCE_LABEL[k === 'deliveryApp' ? 'app' : k] || k}: ${v} `, unchecked.some((u) => u.key === k) ? h('span', { class: 'badge b-warn' }, '확인 기록 없음') : h('span', { class: 'badge b-ok' }, '확인 기록 있음')))) : h('p', { class: 'small muted' }, '등록한 채널이 없어요. 가게 정보에서 추가할 수 있어요.')));

  // 우리 가게 공개 정보
  const own = ext.entries.filter((e) => e.kind === 'own');
  const ownBox = h('div', { class: 'card' }, h('h3', null, '우리 가게 공개 정보'), h('p', { class: 'small muted' }, '예: 네이버 플레이스에 적힌 영업시간·메뉴 가격. 답변과 다르면 재확인 질문이 만들어져요.'));
  for (const e of own) {
    const chk = checks.find((c) => c.entryId === e.id);
    ownBox.append(h('div', { class: 'filebox small' },
      h('b', null, `${SOURCE_LABEL[e.source] || e.source} · ${OWN_FIELDS.find((x) => x.v === e.field)?.label || e.field}`), e.sample ? h('span', { class: 'badge b-warn' }, '가상 예시') : null,
      h('div', null, e.field === 'menu_price' ? `${e.menuName} ${fmtWon(+e.price)}` : e.value),
      h('div', { class: 'tiny muted' }, `${e.observedAt || '날짜 없음'} 확인 · ${e.url || '주소 없음'}`),
      !entryUsable(e) ? h('div', { class: 'tiny', style: { color: '#b42318' } }, '가게명·주소가 모두 일치하지 않아 분석에서 제외해요 (같은 이름의 다른 가게일 수 있음).') : null,
      chk ? h('div', null, h('span', { class: 'badge b-warn' }, '답변과 다름'), ' ', h('a', { href: `#/c/${S.caseId}/interview/${chk.id}` }, '재확인 질문으로')) : (entryUsable(e) ? h('div', { class: 'tiny okline' }, '답변과 다른 점 없음 (또는 비교할 답변 없음)') : null),
      h('button', { class: 'btn small danger', onclick: () => { ext.entries = ext.entries.filter((x) => x.id !== e.id); scheduleSave(); rer(); } }, '삭제')));
  }
  ownBox.append(entryForm('own', rer));
  root.append(ownBox);

  // 리뷰 반복 내용
  const reviews = ext.entries.filter((e) => e.kind === 'review');
  const rvBox = h('div', { class: 'card' }, h('h3', null, '공개 리뷰에서 반복되는 내용'), h('p', { class: 'small muted' }, '여러 리뷰에서 반복되는 칭찬·불편만 적어주세요. 리뷰 문장 안의 요청은 분석 자료로만 다뤄요.'));
  for (const e of reviews) rvBox.append(h('div', { class: 'filebox small' }, h('b', null, `${e.field === 'praise' ? '칭찬' : '불편'}: ${e.value}`), e.count ? ` (${e.count}건)` : '', e.sample ? h('span', { class: 'badge b-warn' }, '가상 예시') : null,
    h('div', { class: 'tiny muted' }, `${SOURCE_LABEL[e.source] || e.source} · ${e.observedAt || '날짜 없음'}${e.period ? ` · ${e.period}` : ''}`),
    h('button', { class: 'btn small danger', onclick: () => { ext.entries = ext.entries.filter((x) => x.id !== e.id); scheduleSave(); rer(); } }, '삭제')));
  rvBox.append(entryForm('review', rer));
  root.append(rvBox);

  // 주변 가게
  const comps = competitorComparisons(S.data);
  root.append(h('div', { class: 'card' }, h('h3', null, '주변 가게 비교'),
    h('p', { class: 'small muted' }, '메뉴 이름만 같다고 같은 상품으로 보지 않아요. 양·구성이 같을 때만 "같은 조건 비교"로 표시해요. 주변 가게의 매출·원가는 추정하지 않아요.'),
    comps.length ? h('ul', null, comps.map((x) => h('li', { class: 'small' }, `${x.name} ${x.menu || ''} ${fmtWon(x.theirPrice)} → ${x.level === 'same' ? '같은 조건 비교' : '참고 비교'}${x.reason ? ` (${x.reason})` : ''}`))) : h('p', { class: 'small' }, '아직 입력한 주변 가게가 없어요.'),
    h('a', { class: 'btn small', href: `#/c/${S.caseId}/interview/pr_competitors` }, '주변 가게 입력·수정')));

  // 식재료 견적·시세
  const calc = compute(S.data);
  const qBox = h('div', { class: 'card' }, h('h3', null, '식재료 견적·시세'),
    h('p', { class: 'small muted' }, '공개 시세나 받아본 견적을 적어주세요. 브랜드·규격·등급·부가세·배송비가 모두 같고 30일 이내에 확인한 것만 절감액을 계산해요.'));
  for (const q of ext.quotes) {
    const row = calc.purchase.rows.find((r) => r.comparisons.some((c) => c.quote.id === q.id));
    const cmp = row?.comparisons.find((c) => c.quote.id === q.id);
    qBox.append(h('div', { class: 'filebox small' },
      h('b', null, `${q.item} · ${specText(q)} · ${fmtWon(+q.price)}`), q.sample ? h('span', { class: 'badge b-warn' }, '가상 예시') : null,
      h('div', { class: 'tiny muted' }, `${SOURCE_LABEL[q.sourceType] || q.sourceType} ${q.sourceName || ''} · ${q.observedAt || '날짜 없음'} · 부가세 ${q.vat === 'incl' ? '포함' : q.vat === 'excl' ? '별도' : '모름'} · 배송비 ${q.ship === '' || q.ship == null ? '모름' : fmtWon(+q.ship)}`),
      cmp ? h('div', null, h('span', { class: `badge ${cmp.level === 'same' ? 'b-ok' : cmp.level === 'similar' ? 'b-warn' : 'b-bad'}` }, cmp.level === 'same' ? '같은 조건 비교' : cmp.level === 'similar' ? '참고 비교 (조건 다름)' : '비교 불가'), cmp.reasons.length ? ` ${cmp.reasons.join(' · ')}` : '',
        isNum(cmp.monthlySaving) ? h('div', null, `예상 절감액 월 약 ${fmtWon(cmp.monthlySaving)} (현재 구매량 기준)`) : null)
        : h('div', { class: 'tiny', style: { color: '#b42318' } }, '같은 이름의 매입 품목이 없어 비교하지 못했어요. 인터뷰의 "주요 식재료 구매 정보"에 품목을 입력해 주세요.'),
      h('button', { class: 'btn small danger', onclick: () => { ext.quotes = ext.quotes.filter((x) => x.id !== q.id); scheduleSave(); rer(); } }, '삭제')));
  }
  qBox.append(quoteForm(rer));
  root.append(qBox);

  clear(view).append(root);
  setNavbar(h('a', { class: 'btn', href: `#/c/${S.caseId}/files` }, '자료'), h('a', { class: 'btn primary', href: `#/c/${S.caseId}/review` }, '다음: 답변 확인'));
}

function entryForm(kind, rer) {
  const e = { id: uid(), kind, source: kind === 'review' ? 'place' : 'place', observedAt: todayISO(), nameMatch: false, addrMatch: false, field: kind === 'review' ? 'complaint' : 'hours' };
  const body = h('div', null);
  const draw = () => {
    clear(body);
    const fields = [
      { key: 'source', label: '출처', type: 'select', options: Object.entries(SOURCE_LABEL).filter(([k]) => !['kamis', 'shop', 'vendor'].includes(k)) },
      { key: 'url', label: '페이지 주소', type: 'text', placeholder: 'https://' },
      { key: 'observedAt', label: '확인한 날짜', type: 'date' },
      kind === 'own'
        ? { key: 'field', label: '항목', type: 'select', options: OWN_FIELDS.map((f) => [f.v, f.label]) }
        : { key: 'field', label: '구분', type: 'select', options: [['praise', '칭찬'], ['complaint', '불편']] },
    ];
    for (const f of fields) body.append(fieldInput(f, e, () => { if (f.key === 'field') draw(); }));
    if (kind === 'own' && e.field === 'menu_price') {
      body.append(fieldInput({ key: 'menuName', label: '메뉴 이름', type: 'text' }, e, () => {}), fieldInput({ key: 'price', label: '공개된 가격', type: 'won', unit: '원' }, e, () => {}));
    } else if (kind === 'own') {
      body.append(fieldInput({ key: 'value', label: '공개된 내용', type: 'text', placeholder: e.field === 'hours' ? '예: 11:00~21:00' : e.field === 'closed' ? '예: 매주 일요일' : '' }, e, () => {}));
    } else {
      body.append(fieldInput({ key: 'value', label: '반복되는 내용', type: 'text', placeholder: '예: 배달이 늦음' }, e, () => {}),
        fieldInput({ key: 'count', label: '언급된 리뷰 수', type: 'number', unit: '건' }, e, () => {}),
        fieldInput({ key: 'period', label: '확인한 기간', type: 'text', placeholder: '예: 최근 3개월 리뷰' }, e, () => {}));
    }
    body.append(fieldInput({ key: 'nameMatch', label: '가게 이름이 일치해요', type: 'check' }, e, () => {}),
      fieldInput({ key: 'addrMatch', label: '주소가 일치해요 (같은 이름의 다른 지점이 아님)', type: 'check' }, e, () => {}));
  };
  draw();
  return h('details', { class: 'more' }, h('summary', null, kind === 'own' ? '+ 확인한 공개 정보 추가' : '+ 리뷰 내용 추가'), body,
    h('button', { class: 'btn small primary', onclick: () => {
      if (!e.observedAt) return toast('확인한 날짜를 적어주세요.');
      if (e.field === 'menu_price' ? !(e.menuName && isNum(+e.price) && e.price !== '') : !e.value) return toast('공개된 내용을 적어주세요.');
      S.data.external.entries.push({ ...e, id: uid() });
      scheduleSave(); toast('기록했어요.'); rer();
    } }, '기록하기'));
}

function quoteForm(rer) {
  const q = { id: uid(), sourceType: 'vendor', observedAt: todayISO(), vat: '', ship: '', count: 1 };
  const items = (S.data.answers.p_items?.v || []).map((x) => x.name).filter(Boolean);
  const body = h('div', null,
    items.length ? fieldInput({ key: 'item', label: '비교할 매입 품목', type: 'select', options: items.map((n) => [n, n]) }, q, () => {}) : h('p', { class: 'small hint' }, '먼저 인터뷰의 "주요 식재료 구매 정보"에 품목을 입력해야 비교할 수 있어요.'),
    fieldInput({ key: 'sourceType', label: '출처 종류', type: 'select', options: [['vendor', '납품 견적'], ['shop', '온라인 판매처'], ['kamis', '공개 식재료 시세'], ['other', '기타']] }, q, () => {}),
    fieldInput({ key: 'sourceName', label: '출처 이름', type: 'text', placeholder: '예: ○○식자재 견적서' }, q, () => {}),
    fieldInput({ key: 'url', label: '주소 (있으면)', type: 'text' }, q, () => {}),
    fieldInput({ key: 'observedAt', label: '확인한 날짜', type: 'date' }, q, () => {}),
    fieldInput({ key: 'brand', label: '브랜드·제조사', type: 'text' }, q, () => {}),
    h('label', { class: 'field' }, h('span', { class: 'lab' }, '규격 한 번에 입력 (예: 1kg, 500g×20)'), h('input', { type: 'text', onchange: (ev) => { const sp = parseSpec(ev.target.value); if (sp) { Object.assign(q, sp); toast(`규격: ${specText(q)}`); } else toast('규격을 읽지 못했어요. 아래 칸에 입력해 주세요.'); } })),
    fieldInput({ key: 'size', label: '규격(한 단위의 양)', type: 'number' }, q, () => {}),
    fieldInput({ key: 'unit', label: '규격 단위', type: 'select', options: [['kg', 'kg'], ['g', 'g'], ['L', 'L'], ['ml', 'ml'], ['개', '개']] }, q, () => {}),
    fieldInput({ key: 'count', label: '입수', type: 'number' }, q, () => {}),
    fieldInput({ key: 'grade', label: '등급·원산지·종류', type: 'text' }, q, () => {}),
    fieldInput({ key: 'price', label: '1단위 가격', type: 'won', unit: '원' }, q, () => {}),
    fieldInput({ key: 'vat', label: '부가세', type: 'select', options: [['incl', '포함'], ['excl', '별도']], emptyLabel: '모름' }, q, () => {}),
    fieldInput({ key: 'ship', label: '배송비 (주문 1회당, 무료면 0)', type: 'won', unit: '원' }, q, () => {}),
    fieldInput({ key: 'minUnits', label: '배송비 기준 주문 수량 (예: 10개 주문 시 배송비 3,000원이면 10)', type: 'number' }, q, () => {}),
    fieldInput({ key: 'minOrder', label: '최소 주문금액', type: 'won', unit: '원' }, q, () => {}),
    fieldInput({ key: 'conditions', label: '기타 조건', type: 'text', placeholder: '예: 주 2회 배송, 지역 한정' }, q, () => {}));
  return h('details', { class: 'more' }, h('summary', null, '+ 견적·시세 추가'), body,
    h('button', { class: 'btn small primary', disabled: !items.length, onclick: () => {
      if (!q.item) return toast('비교할 품목을 골라주세요.');
      if (!isNum(+q.price) || q.price === '') return toast('가격을 입력해 주세요.');
      if (!q.observedAt) return toast('확인한 날짜를 적어주세요.');
      S.data.external.quotes.push({ ...q, id: uid() });
      scheduleSave(); toast('기록했어요.'); rer();
    } }, '기록하기'));
}
