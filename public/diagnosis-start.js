// 기존 가게 진단의 독립적인 시작 화면. 소개 페이지 임시저장소는 건드리지 않는다.
export function makeDiagnosisStart({ h, show, setNavbar, btn, storeName, getState, begin, confirmOverwrite }) {
  return {
    render() {
      storeName.textContent = '';
      const nameIn = h('input', { type: 'text', name: 'diagnosisName', maxlength: 60, autocomplete: 'organization', placeholder: '예: 골목분식' });
      const addressIn = h('input', { type: 'text', name: 'diagnosisAddress', maxlength: 120, autocomplete: 'street-address', placeholder: '예: 서울 마포구 망원로 12' });
      const consent = h('input', { type: 'checkbox', id: 'diagnosisSearchConsent' });
      const hint = h('div', { class: 'hint', role: 'alert' }, '');
      const go = () => {
        const name = String(nameIn.value || '').trim().replace(/\s+/g, ' ');
        const address = String(addressIn.value || '').trim().replace(/\s+/g, ' ');
        if (!name) { hint.textContent = '가게 이름을 입력해 주세요.'; nameIn.focus?.(); return; }
        if (address.length < 4) { hint.textContent = '주소를 동·도로명까지 입력해 주세요.'; addressIn.focus?.(); return; }
        if (!consent.checked) { hint.textContent = '가게 정보를 찾기 위한 외부 전송에 동의해 주세요.'; consent.focus?.(); return; }
        if (Object.keys(getState() || {}).length && !confirmOverwrite()) return;
        begin(name, address);
      };
      show(
        h('div', { class: 'card' },
          h('h2', null, '기존 가게 진단 시작'),
          h('p', { class: 'small muted' }, '가게 정보를 찾은 뒤 운영 상황을 질문하고 진단해요. 가게 소개 페이지 만들기와는 별도입니다.'),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, '가게 이름'), nameIn),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, '주소'), addressIn),
          h('label', { class: 'page-consent' }, consent, h('span', null, '가게 이름과 주소를 OpenRouter, 연결된 AI와 웹 검색 제공자에게 보내 공개 정보를 찾는 데 동의합니다.')),
          h('p', { class: 'tiny muted' }, '검색 결과는 서버에 임시 보관될 수 있으며, 기존 진단 데이터는 이 브라우저에 저장돼요. AI 검색에는 운영자 크레딧이 사용될 수 있어요.'),
          hint,
          h('button', { class: 'btn primary block go', type: 'button', onclick: go }, '동의하고 가게 찾기')),
      );
      setNavbar(btn('처음으로', () => { location.hash = '#/'; }));
    },
  };
}
