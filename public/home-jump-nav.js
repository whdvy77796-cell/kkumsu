// 홈 화면에서만 가격·FAQ 위치로 이동한다. 해시 라우팅과 입력값은 건드리지 않는다.
export function setupHomeJumpNav(doc, win) {
  const nav = doc.getElementById('homeJumpNav');
  if (!nav) return { show() {}, hide() {} };

  for (const [name, id] of [['price', 'home-pricing'], ['faq', 'home-faq']]) {
    const button = nav.querySelector('[data-home-jump="' + name + '"]');
    if (!button) continue;
    button.addEventListener('click', () => {
      if (nav.hidden) return;
      const section = doc.getElementById(id);
      if (!section || typeof section.scrollIntoView !== 'function') return;
      const reduceMotion = typeof win.matchMedia === 'function' && !!win.matchMedia('(prefers-reduced-motion: reduce)').matches;
      section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      if (typeof section.focus === 'function') section.focus({ preventScroll: true });
    });
  }

  return {
    show() { nav.hidden = false; },
    hide() { nav.hidden = true; },
  };
}
