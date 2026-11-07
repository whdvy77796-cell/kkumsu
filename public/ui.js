// 공용 화면 도우미 · 서버 통신 · 상태

// 화면 코드에서 조건부 요소(null·false)와 배열을 그대로 넘길 수 있게 append를 안전하게 바꾼다.
const nativeAppend = Element.prototype.append;
Element.prototype.append = function safeAppend(...kids) {
  return nativeAppend.apply(this, kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
};

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'open') el.open = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export const S = {
  caseId: null, token: null, data: null, version: 0, report: null, reportInputVersion: null, changes: [],
  saveTimer: null, saving: false, dirty: false, status: null,
};

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (S.token && !opts.noAuth) headers.Authorization = `Bearer ${S.token}`;
  let body = opts.body;
  if (body !== undefined && !opts.raw) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  if (window.__LOCAL_BACKEND__) {
    // 체험판: 서버 대신 이 브라우저 안의 저장소를 사용
    const lr = await window.__LOCAL_BACKEND__(path, { method: opts.method || 'GET', headers, body });
    if (lr.status >= 400) {
      const e = new Error((lr.body && lr.body.message) || `요청이 실패했어요 (${lr.status})`);
      e.status = lr.status;
      e.data = lr.body;
      throw e;
    }
    return lr.body;
  }
  const r = await fetch(path, { method: opts.method || 'GET', headers, body });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json() : await r.blob();
  if (!r.ok) {
    const e = new Error((data && data.message) || `요청이 실패했어요 (${r.status})`);
    e.status = r.status;
    e.data = data;
    throw e;
  }
  return data;
}

// 이 기기(브라우저)에 저장하는 이어하기 목록
const KEY = 'maechul.cases.v1';
export function deviceCases() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export function rememberCase(id, token, name) {
  const list = deviceCases().filter((x) => x.id !== id);
  list.unshift({ id, token, name: name || '이름 없는 가게', updatedAt: new Date().toISOString() });
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
}
export function forgetCase(id) {
  localStorage.setItem(KEY, JSON.stringify(deviceCases().filter((x) => x.id !== id)));
}
export function tokenFor(id) {
  return deviceCases().find((x) => x.id === id)?.token || null;
}
export function resumeLink(id = S.caseId, token = S.token) {
  return `${location.origin}${location.pathname}#/open/${id}.${token}`;
}

let onSaved = null;
export function setSavedListener(fn) { onSaved = fn; }

export function scheduleSave(delay = 600) {
  S.dirty = true;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, delay);
}

export async function saveNow() {
  clearTimeout(S.saveTimer);
  if (!S.caseId || !S.dirty || S.saving) return;
  S.saving = true;
  S.dirty = false;
  try {
    const r = await api(`/api/cases/${S.caseId}`, { method: 'PUT', body: { data: S.data, baseVersion: S.version } });
    S.version = r.version;
    S.data = r.data;
    rememberCase(S.caseId, S.token, S.data.profile?.name);
    onSaved && onSaved('saved');
  } catch (e) {
    if (e.status === 409 && e.data) {
      S.data = e.data.data;
      S.version = e.data.version;
      toast(e.data.message);
      onSaved && onSaved('conflict');
    } else {
      S.dirty = true;
      toast(`저장하지 못했어요: ${e.message}`);
      onSaved && onSaved('error');
    }
  } finally {
    S.saving = false;
    if (S.dirty) scheduleSave(1200);
  }
}

export function setAnswer(qid, patch) {
  const prev = S.data.answers[qid] || {};
  const next = { ...prev, ...patch, at: Date.now() };
  if (!('src' in patch) && prev.src && prev.src !== 'owner' && ('v' in patch)) next.src = 'owner';
  S.data.answers[qid] = next;
  scheduleSave();
}

export function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function uid() {
  return Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
}
