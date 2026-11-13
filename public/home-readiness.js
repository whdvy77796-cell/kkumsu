// 첫 화면의 가상 예시. 숫자는 실제 점수 계산 규칙과 같은 함수에서 만든다.
import { calculateReadiness } from './readiness-score.js';

const EXAMPLE_BASE = Object.freeze({ name: '예시 가게', address: '서울 마포구 예시로' });
const EXAMPLES = Object.freeze([
  Object.freeze({ title: '기본 정보', detail: '가게 이름과 주소를 알려요.', answers: {}, chips: ['가게명', '주소'] }),
  Object.freeze({ title: '가게 특징', detail: '대표 메뉴와 우리 가게의 특징을 더해요.', answers: { offer: '고소한 라떼', difference: '조용한 공간' }, chips: ['대표 메뉴', '가게 특징'] }),
  Object.freeze({ title: '방문 상황과 이용 정보', detail: '어떤 손님에게 어울리는지, 이용 방법까지 알려요.', answers: { offer: '고소한 라떼', difference: '조용한 공간', audience: '친구 두 명의 방문', visit: '포장 가능' }, chips: ['방문 상황', '이용 정보'] }),
]);

export function makeHomeReadiness(h) {
  return h('section', { class: 'home-readiness', 'aria-labelledby': 'home-readiness-title' },
    h('div', { class: 'home-readiness-heading' },
      h('span', { class: 'home-readiness-kicker' }, '가게정보 준비도 · 가상의 예시'),
      h('h2', { id: 'home-readiness-title' }, '가게 정보를 더할수록,', h('br'), '우리 가게의 이야기가 선명해져요'),
      h('p', null, 'AI·검색 봇이 접근할 수 있도록 설정된 여기봐 AI에 가게 소개 페이지를 공개해요. 아래는 가상의 입력 예시예요.')),
    h('div', { class: 'home-readiness-steps' }, EXAMPLES.map((step, index) => {
      const score = calculateReadiness({ ...EXAMPLE_BASE, answers: step.answers }).score;
      return h('article', { class: 'home-readiness-step' },
        h('div', { class: 'home-readiness-step-head' }, h('span', { class: 'home-readiness-number' }, '0' + (index + 1)), h('span', { class: 'home-readiness-step-tag' }, step.title)),
        h('div', { class: 'home-readiness-dial', style: { background: `conic-gradient(#315fe8 ${score}%, #e2eaff 0)` } },
          h('div', { class: 'home-readiness-dial-inner' }, h('strong', null, String(score)), h('span', null, '점'))),
        h('h3', null, step.title),
        h('p', null, step.detail),
        h('div', { class: 'home-readiness-chips' }, step.chips.map(chip => h('span', null, chip))));
    })),
    h('div', { class: 'home-readiness-review' },
      h('span', { class: 'home-readiness-plus' }, '+15점'),
      h('p', null, h('strong', null, '예상 질문과 답변까지 직접 확인하면'), h('br'), '입력 정보와 확인 여부에 따라 준비도가 달라져요.')),
    h('section', { class: 'home-readiness-aeo', 'aria-label': 'AI 검색 최적화 안내' },
      h('p', null, h('strong', null, 'AI 검색 최적화(AEO·GEO)는'), ' ChatGPT·클로드·구글 AI 개요·네이버 AI 브리핑이 ', h('strong', null, '우리 가게를 이해하고 소개하기 쉽도록'), ' 정보를 정리하는 일입니다.'),
      h('p', null, '일부 국내 지도·블로그는 ', h('strong', null, '해외 AI 검색 로봇의 수집을 제한해'), ', ', h('strong', null, 'AI가 읽을 수 있는 가게 정보가 부족할 수 있습니다.'))),
    h('p', { class: 'home-readiness-disclaimer' }, '위 점수는 가상의 예시예요. 준비도는 여기봐 AI의 자체 입력 기준이며, 정보의 진위나 공개 내용 반영을 자동 검증하지 않아요. AI의 실제 수집·검색 노출·추천은 보장하지 않아요.'));
}
