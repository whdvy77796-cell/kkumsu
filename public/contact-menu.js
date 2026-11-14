// 문의 주소는 푸터에서 쓰는 사업자 정보와 같은 값을 사용한다.
export function setupContactMenu(doc, win, email) {
  const open = doc.getElementById('contactOpen');
  const dialog = doc.getElementById('contactDialog');
  const close = doc.getElementById('contactClose');
  const address = doc.getElementById('contactAddress');
  const mail = doc.getElementById('contactMail');
  const copy = doc.getElementById('contactCopy');
  const status = doc.getElementById('contactStatus');
  const value = String(email || '').trim();
  if (!open || !dialog || !close || !address || !mail || !copy || !status) return;
  if (!/^[^\s@?&#]+@[^\s@?&#]+$/.test(value)) { open.hidden = true; return; }

  address.textContent = value;
  mail.setAttribute('href', 'mailto:' + value + '?subject=' + encodeURIComponent('여기봐 AI 고객문의'));
  const closeDialog = () => {
    if (dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else { dialog.removeAttribute('open'); if (typeof open.focus === 'function') open.focus(); }
    }
    status.textContent = '';
  };
  open.addEventListener('click', () => {
    if (open.hidden || dialog.open) return;
    status.textContent = '';
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
  close.addEventListener('click', closeDialog);
  dialog.addEventListener('close', () => { status.textContent = ''; });
  if (typeof win.addEventListener === 'function') win.addEventListener('hashchange', closeDialog);
  copy.addEventListener('click', async () => {
    try {
      if (!win.navigator || !win.navigator.clipboard || typeof win.navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      await win.navigator.clipboard.writeText(value);
      status.textContent = '이메일 주소가 복사됐어요.';
    } catch (_) {
      status.textContent = '복사하지 못했어요. 위 주소를 직접 선택해 복사해 주세요.';
    }
  });
}
