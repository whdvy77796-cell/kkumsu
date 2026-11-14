// 홈페이지 FAQ: 실제 운영 중인 베타 조건과 공개 전 안내만 담는다.
import { FIRST_HOME_PRICE, HOME_PRICE_STEPS } from './home-pricing.js';

export const HOME_FAQ = Object.freeze([
  Object.freeze({
    question: '여기봐 AI는 어떤 서비스인가요?',
    paragraphs: Object.freeze([
      '사장님이 확인한 가게 정보와 답변을 바탕으로 AI가 읽기 쉬운 가게 소개 페이지와 예상 질문·답변을 만들어요.',
      '공개한 페이지는 링크와 QR코드로 손님에게 공유할 수 있어요.',
    ]),
  }),
  Object.freeze({
    question: '등록하면 AI가 우리 가게를 추천해 주나요?',
    paragraphs: Object.freeze([
      '가게 정보를 AI가 읽기 쉽도록 정리해 드리지만, AI와 검색엔진의 수집·검색 노출·추천·인용 여부나 시점은 보장하지 않아요.',
      'AI·검색 봇의 페이지 접근은 AI 추천이나 실제 손님 방문을 뜻하지 않아요.',
    ]),
  }),
  Object.freeze({
    question: '이용 요금은 얼마인가요?',
    paragraphs: Object.freeze([
      '현재 베타 기간에는 페이지 제작·공개와 QR코드·공유 문구가 무료이며, 실제 결제는 운영하지 않아요.',
      `유료 서비스 도입 시 ${HOME_PRICE_STEPS[0].range}의 공개 가격은 1회 ${FIRST_HOME_PRICE}으로 예정되어 있어요. 월 정기결제는 없을 예정이에요.`,
      '이미 무료로 공개한 페이지를 자동으로 유료 상품으로 전환하거나 결제를 요구하지 않아요. 이후 무료 서비스 운영 정책을 바꿀 때는 미리 안내할게요.',
      '새 유료 상품은 가게 1곳을 1년간 공개하는 1회 결제로 준비하고 있어요. 자동 갱신은 없고 결제일과 공개 시작일 중 더 늦은 날부터 7일 안에는 이용 여부와 관계없이 전액 환불받을 수 있도록 준비해요.',
    ]),
  }),
  Object.freeze({
    question: '회원가입을 해야 하나요?',
    paragraphs: Object.freeze([
      '아니요. 회원가입 없이 시작할 수 있어요. 공개 후 관리할 수 있도록 관리 주소와 비밀번호를 안전하게 보관해 주세요.',
      '현재 관리 비밀번호는 잃어버리면 복구할 수 없어요.',
    ]),
  }),
  Object.freeze({
    question: '내용을 수정하거나 페이지를 삭제할 수 있나요?',
    paragraphs: Object.freeze([
      'AI가 작성한 내용은 공개 전에 직접 확인하고 수정할 수 있어요. 공개 후에도 관리 비밀번호로 내용을 수정하거나 페이지를 삭제할 수 있어요.',
      '내용을 수정해도 기존 페이지 주소와 QR코드는 그대로 사용할 수 있어요.',
    ]),
  }),
  Object.freeze({
    question: '입력한 가게 정보는 어디에 사용되나요?',
    paragraphs: Object.freeze([
      '동의하신 상호명과 주소는 공개된 가게 정보를 찾는 데 쓰이며, OpenRouter와 연결된 AI·웹 검색 제공자에게 전송될 수 있어요.',
      '소개글 초안을 만들 때는 확인한 정보와 질문 답변을 별도 동의 후 AI에 보내요.',
    ]),
    privacyLink: true,
  }),
]);

export function makeHomeFaq(h) {
  return h('section', { id: 'home-faq', class: 'home-faq', tabindex: '-1', 'aria-labelledby': 'home-faq-title' },
    h('div', { class: 'faq-heading' },
      h('p', { class: 'faq-eyebrow' }, 'FAQ'),
      h('h2', { id: 'home-faq-title' }, '자주 묻는 질문'),
      h('p', { class: 'faq-lead' }, '여기봐 AI가 궁금하신가요?')),
    h('div', { class: 'faq-list' }, HOME_FAQ.map((item) =>
      h('details', { class: 'faq-item' },
        h('summary', { class: 'faq-question' },
          h('span', { class: 'faq-q', 'aria-hidden': 'true' }, 'Q.'),
          h('span', { class: 'faq-question-text' }, item.question),
          h('span', { class: 'faq-icon', 'aria-hidden': 'true' })),
        h('div', { class: 'faq-answer' },
          item.paragraphs.map((paragraph) => h('p', null, paragraph)),
          item.privacyLink ? h('p', null, h('a', { href: '#/privacy' }, '개인정보처리방침 자세히 보기')) : null)))));
}
