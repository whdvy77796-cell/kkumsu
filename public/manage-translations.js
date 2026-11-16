// Private review shared by both edit paths. No automatic saving or retries.
import { normalizeTranslationSource, translationSourceHash, validTranslations, translationPreviews } from './page-translations.js';
const copy = v => JSON.parse(JSON.stringify(v));
export function effectiveTranslationSource(data, preserved) {
  const out = copy(data);
  delete out.translations;
  if (!Object.hasOwn(out, 'situations') && Object.hasOwn(preserved || {}, 'situations')) out.situations = copy(preserved.situations);
  normalizeTranslationSource(out);
  return out;
}
export function makeManageTranslations({ h, btn, post, readSource, canRequest = () => true, alive = () => true, now = () => Date.now() }) {
  let generation = 0, pending = false, candidate = null, reviewed = false, consent = false;
  let attempts = 0, lastAttempt = -Infinity, message = '', panel;
  const fingerprint = () => JSON.stringify(readSource());
  const fail = text => { throw new Error(text); };
  function invalidate(text = '한국어가 바뀌어 임시 번역을 폐기했어요. 최신 내용으로 다시 번역해 주세요.') {
    generation++; reviewed = false; candidate = null; message = text; refresh();
  }
  async function request() {
    if (pending || !alive() || !canRequest()) return;
    if (!consent) { message = 'AI 전송 및 운영자 비용 안내에 동의해 주세요.'; refresh(); return; }
    if (attempts >= 3 || now() - lastAttempt < 30000) { message = '비용 보호를 위해 이 편집 화면에서 최대 3회, 요청 간 30초 간격으로 제한해요. 서버의 별도 한도도 적용돼요.'; refresh(); return; }
    let source, key;
    try { source = copy(readSource()); normalizeTranslationSource(source); key = JSON.stringify(source); }
    catch (e) { message = e.message; refresh(); return; }
    const epoch = ++generation;
    pending = true; reviewed = false; candidate = null;
    message = '번역 중 원문을 수정하면 결과는 폐기돼요.'; refresh();
    try {
      const hash = await translationSourceHash(source);
      if (!alive() || epoch !== generation || key !== fingerprint()) return;
      attempts++; lastAttempt = now();
      const response = await post('/api/store-translate', { consent: true, data: source }, 60000);
      if (!alive() || epoch !== generation || key !== fingerprint()) return;
      const translations = response?.translations;
      if (!validTranslations(translations, source) || translations.sourceHash !== hash) fail('번역 응답의 원문 검증에 실패했어요. 저장하지 않았어요.');
      const normalized = normalizeTranslationSource(source);
      for (const lang of ['en','ja','zh']) {
        if (Object.hasOwn(normalized,'situations') !== Object.hasOwn(translations[lang],'situations')) fail('예상 질문 번역이 누락되어 결과를 폐기했어요.');
      }
      candidate = { source, key, hash, translations: copy(translations) };
      message = '비공개 미리보기예요. 한국어와 세 언어를 비교하고 체크한 뒤 기존 저장 버튼을 눌러야 반영돼요.';
    } catch (e) {
      if (epoch === generation) { candidate = null; message = '번역 결과를 확인하지 못했어요. 자동 재시도하지 않았고 한국어와 기존 저장 번역은 보존돼요. ' + (e.message || ''); }
    } finally { pending = false; if (alive()) refresh(); }
  }
  async function attach(data) {
    if (pending) fail('번역 요청이 끝난 뒤 저장해 주세요.');
    if (!candidate || !reviewed) return data;
    const c = candidate, epoch = generation;
    if (!alive() || c.key !== fingerprint()) { invalidate(); fail('번역 원문이 달라졌어요. 다시 확인해 주세요.'); }
    const hash = await translationSourceHash(readSource());
    if (!alive() || candidate !== c || epoch !== generation || c.key !== fingerprint() || hash !== c.hash || hash !== c.translations.sourceHash) {
      invalidate(); fail('번역 검증 중 내용이 바뀌었어요. 저장하지 않았어요.');
    }
    // Send the full reviewed source when translating; the caller retains revision CAS.
    return { ...data, ...(Object.hasOwn(c.source, 'situations') ? { situations: copy(c.source.situations) } : {}), translations: copy(c.translations) };
  }
  function refresh() {
    if (!panel) return;
    const agree = h('input', { type: 'checkbox', 'data-translation-consent': '1' }); agree.checked = consent;
    agree.addEventListener?.('change', () => { consent = agree.checked; });
    const go = btn('다국어 다시 번역', request); go.disabled = pending || !canRequest();
    const check = h('input', { type: 'checkbox', 'data-translation-reviewed': '1' }); check.checked = reviewed;
    check.disabled = !candidate || pending;
    check.addEventListener?.('change', () => { reviewed = !!candidate && check.checked; });
    const source = candidate?.source;
    const nodes = [h('h2', null, '다국어 다시 번역'),
      h('p', null, '현재 한국어 정보를 AI에 전송해 영어·일본어·중국어로 번역해요. 운영자에게 실제 AI 비용이 발생하며 서비스 한도와 서버 비용 제한이 적용돼요. 자동 저장·공개·재시도는 하지 않아요. 화면을 떠나면 임시 번역은 사라져요.'),
      h('label', null, agree, ' 위 AI 전송과 운영자 비용 안내를 이해하고 번역에 동의해요.'), go,
      h('p', { role: 'status', 'aria-live': 'polite' }, message),
      ...(source ? [h('details', { open: true }, h('summary', null, '번역에 사용한 한국어 원문'), h('pre', { style: 'white-space:pre-wrap' }, JSON.stringify(source, null, 2))), translationPreviews(h, candidate.translations)] : []),
      h('label', null, check, ' 한국어와 영어·일본어·중국어의 이름·주소·숫자·시간·조건을 모두 비교했으며 기존 저장 버튼으로 함께 반영할게요.')];
    if (panel.replaceChildren) panel.replaceChildren(...nodes);
    else if (Array.isArray(panel.children)) panel.children = nodes; // Minimal DOM test doubles.
  }
  function render() { panel = h('section', { class: 'card', 'data-manage-translations': '1' }); refresh(); return panel; }
  return { render, request, attach, invalidate, get pending() { return pending; }, get hasReviewed() { return !!candidate && reviewed; } };
}
