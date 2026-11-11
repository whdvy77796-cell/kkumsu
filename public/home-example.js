// 홈페이지에서 실제 사례로 오인하지 않도록 가상 대화와 실제 공개 페이지를 구분한다.
export function makeHomeExample(h) {
  return h('figure', { class: 'home-sample', 'aria-label': 'AI 추천 가상 예시' },
    h('img', {
      src: '/yeogibwa-ai-example.png', width: '1000', height: '1225', decoding: 'async', fetchpriority: 'high',
      alt: '가상 예시: 동성로 맛집을 묻는 질문에 AI가 연어로를 추천하고 여기봐 AI를 출처로 제시하는 대화와 실제 연어로 소개 페이지. 실제 AI 답변이나 인용 사례가 아닙니다.',
    }),
    h('figcaption', { class: 'home-sample-caption' },
      h('p', null, '가상 대화와 가상 출처 연결을 연출한 예시예요. 실제 AI 추천 사례가 아니며, 검색 노출·추천·인용을 보장하지 않아요.'),
      h('a', { href: '/stores/Sv7dlOYSMMVctFPtL1xI8w', target: '_blank', rel: 'noopener noreferrer' }, '실제 연어로 소개 페이지 보기 ↗')),
  );
}
