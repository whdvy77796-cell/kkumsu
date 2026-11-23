// 여기봐 AI의 현재 무료 이용 안내.
export function makeHomePricing(h, focusStart) {
  const feature = (text, pending = false) => h('li', { class: pending ? 'pricing-feature pricing-feature-pending' : 'pricing-feature' },
    h('span', { class: 'pricing-check', 'aria-hidden': 'true' }, '✓'), h('span', null, text));
  return h('section', { id: 'home-pricing', class: 'home-pricing', tabindex: '-1', 'aria-labelledby': 'home-pricing-title' },
    h('div', { class: 'pricing-heading' },
      h('p', { class: 'pricing-eyebrow' }, '여기봐 AI 이용 안내'),
      h('h2', { id: 'home-pricing-title' }, '가게 소개, 무료로 시작하세요'),
      h('p', { class: 'pricing-lead' }, '만들기부터 공개와 공유까지 결제 없이 이용할 수 있어요.')),
    h('div', { class: 'pricing-plans' },
      h('article', { class: 'pricing-plan pricing-free', 'aria-labelledby': 'pricing-free-title' },
        h('p', { class: 'pricing-plan-label' }, '무료 이용'),
        h('h3', { id: 'pricing-free-title' }, '우리 가게 소개 페이지'),
        h('p', { class: 'pricing-amount' }, '0원'),
        h('p', { class: 'pricing-plan-desc' }, '회원가입이나 결제 없이 만들고 공개해요.'),
        h('ul', { class: 'pricing-features' },
          feature('가게 정보 검색 및 직접 확인'),
          feature('AI 소개글·예상 질문과 답변 미리보기'),
          feature('공개 전 내용 확인과 수정'),
          feature('가게 소개 페이지 공개'),
          feature('공개 주소와 QR 코드'),
          feature('SNS에 쓸 공유 문구'),
          feature('관리 비밀번호로 내용 수정·삭제'),
          feature('내 가게 AI 검색 봇 접근 현황 (준비중)', true)),
        h('p', { class: 'pricing-plan-note' }, 'AI가 찾고 작성한 내용은 공개하기 전에 직접 확인해 주세요.'))),
    h('p', { class: 'pricing-disclaimer' }, 'AI·검색 봇의 접근은 AI 답변의 추천·인용이나 실제 손님 방문을 뜻하지 않아요. 검색 노출과 AI 추천은 보장하지 않아요.'),
    h('button', { class: 'btn primary go pricing-start', type: 'button', onclick: focusStart }, '지금 무료로 페이지 만들기'));
}
