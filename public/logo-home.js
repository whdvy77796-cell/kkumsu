// 첫 화면에서는 새로고침이나 재렌더링 없이 맨 위로 이동한다.
// 다른 화면은 기존 홈 링크를 사용하며, 일시 입력을 잃을 수 있을 때만 확인한다.
export function setupHomeLogo(doc, win) {
  const logo = doc.querySelector('header .logo');
  if (!logo) return;
  const value = selector => String(doc.querySelector(selector)?.value || '').trim();
  const hasEntered = selector => String(doc.querySelector(selector)?.value || '').length > 0;
  logo.addEventListener('click', event => {
    // 새 탭, 보조 버튼, 브라우저가 이미 처리한 클릭은 원래 링크 동작을 보존한다.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const hash = win.location.hash || '#/';
    if (hash === '#/') {
      event.preventDefault();
      const reduced = typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
      win.scrollTo({ top: 0, left: 0, behavior: reduced ? 'auto' : 'smooth' });
      return;
    }
    let message = '';
    if (hash === '#/diagnosis-start' && (value('#view input[name="diagnosisName"]') || value('#view input[name="diagnosisAddress"]') || doc.querySelector('#diagnosisSearchConsent')?.checked)) {
      message = '지금 입력한 진단 시작 정보는 아직 저장되지 않았어요. 처음 화면으로 이동할까요?';
    } else if (hash === '#/page-publish' && (hasEntered('#publish-password') || hasEntered('#publish-password-again'))) {
      message = '처음 화면으로 이동하면 입력 중인 관리 비밀번호를 다시 입력해야 해요. 이동할까요?';
    } else if (/^#\/manage\/[A-Za-z0-9_-]{22}$/.test(hash) && (doc.querySelector('#view .manage #f-name') || hasEntered('#view .manage #manage-pw'))) {
      message = '관리 화면을 나가면 저장하지 않은 수정 내용이 사라질 수 있어요. 처음 화면으로 이동할까요?';
    }
    if (message && !win.confirm(message)) event.preventDefault();
  });
}
