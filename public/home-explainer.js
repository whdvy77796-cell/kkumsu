// 첫 화면에서 서비스의 이유와 현재 이용 순서를 설명한다.
// 베타 공개는 무료이며, 향후 가격 안내가 현재 결제로 오인되지 않도록 구분한다.
import { FIRST_HOME_PRICE } from './home-pricing.js';

export function makeHomeExplainer(h, focusStart) {
  const step = (number, title, ...body) => h('li', { class: 'home-how-step' },
    h('span', { class: 'home-how-number', 'aria-hidden': 'true' }, number),
    h('div', null, h('h3', null, title), ...body.map(text => h('p', null, text))));

  return h('div', { class: 'home-explainer' },
    h('section', { class: 'home-explainer-card home-why', 'aria-labelledby': 'home-why-title' },
      h('p', { class: 'home-eyebrow' }, 'WHY?'),
      h('h2', { id: 'home-why-title' }, '왜 여기봐AI를 써야 할까요?'),
      h('p', { class: 'home-why-lead' }, '손님이 AI에게 가게를 물을 때, AI는 어디서 우리 가게를 알게 될까요?'),
      h('p', null, '네이버 플레이스에 가게 소개를 정성껏 올려도, 외부 AI가 그 내용을 자유롭게 읽을 수 있는 건 아니에요. 플랫폼마다 외부에서 정보를 수집할 수 있는 범위가 다르기 때문이에요.'),
      h('p', null, '여기봐AI는 AI 검색이 우리 가게를 발견하고 참고할 수 있는 공개 페이지를 하나 더 만들어드려요. 위치와 메뉴는 물론, “삼덕동에서 엄마랑 조용히 얘기할 카페 있어?”처럼 손님이 물어볼 만한 질문에 우리 가게가 왜 잘 맞는지까지 담을 수 있어요.'),
      h('p', null, '사장님이 확인한 정보를 AI가 읽기 쉬운 글로 정리하고, 사장님이 검토한 뒤 여기봐AI에 공개해요.'),
      h('button', { class: 'btn primary home-explainer-cta', type: 'button', onclick: focusStart }, '무료로 우리 가게 페이지 만들기'),
      h('p', { class: 'home-price' }, '제작·미리보기 무료', h('br'), `첫 100명 공개 1회 ${FIRST_HOME_PRICE} `, h('span', null, '(유료 전환 후 적용 예정)')),
      h('p', { class: 'home-price-current' }, '현재 베타 기간에는 공개와 QR·소개글도 무료예요. 결제는 운영하지 않아요.'),
      h('p', { class: 'home-no-guarantee' }, '검색 노출·AI 추천·인용은 보장하지 않아요.')),
    h('section', { class: 'home-explainer-card home-how', 'aria-labelledby': 'home-how-title' },
      h('p', { class: 'home-eyebrow' }, 'HOW IT WORKS'),
      h('h2', { id: 'home-how-title' }, '이렇게 진행돼요'),
      h('ol', { class: 'home-how-list' },
        step('01', '가게 이름과 주소를 입력하세요',
          '동의 후 여기봐AI가 공개된 가게 정보를 찾아 보여드려요. 우리 매장이 맞는지 확인해 주세요. 상호명과 주소는 다음 단계에서, 소개 내용은 미리보기에서 고칠 수 있어요.'),
        step('02', '사장님만 아는 특징을 들려주세요',
          '“두 분이 오시면 어느 자리를 권하세요?”, “손님들이 방문 전에 꼭 물어보는 게 있나요?”처럼 우리 가게를 떠올려 보세요. 대표 메뉴·서비스와 가게 특징 등을 묻는 5개 항목에 알고 계신 내용을 답해주세요. 대표 메뉴·서비스만 필수예요.'),
        step('03', '우리 가게 소개 페이지를 확인하고 공개하세요',
          '동의 후 여기봐AI가 사장님의 답변을 바탕으로 소개글과 손님이 물어볼 만한 예상 질문·답변을 만들어요. 실제 고객의 질문 기록은 아니에요. 무료로 미리 보고 수정한 뒤, 마음에 들면 여기봐AI에 공개하세요.',
          `첫 100명 공개 1회 ${FIRST_HOME_PRICE}은 유료 전환 후 적용 예정이며, 현재 베타 기간에는 무료로 공개할 수 있어요.`),
        step('04', '가게 링크와 QR코드를 내 채널에도 활용하세요',
          '인스타그램 프로필이나 운영 중인 홈페이지엔 링크를, 매장 안내판엔 QR코드를 넣어보세요. 함께 제공되는 소개 문구를 활용하면 우리 가게의 특징을 일관되게 알릴 수 있어요.'))));
}
