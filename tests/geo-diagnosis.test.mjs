import test from 'node:test';
import assert from 'node:assert/strict';
import { mountGeoDiagnosis } from '../public/geo-diagnosis.js';

class TextNode {
  constructor(value) { this.textContent = String(value); this.parentNode = null; }
}
class FakeElement {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.handlers = {}; this.parentNode = null; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.className = ''; }
  set textContent(value) { this.children = []; this.append(new TextNode(value)); }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { throw new Error('Unsafe innerHTML used: ' + value); }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'hidden') this.hidden = true; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  removeEventListener(name, handler) { if (this.handlers[name] === handler) delete this.handlers[name]; }
  append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } }
  replaceChildren(...items) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...items); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
  focus() { this.focused = true; }
  fire(name) { return this.handlers[name]?.({ currentTarget: this, target: this, preventDefault() {} }); }
}
function descendants(root) { return [root, ...(root.children || []).flatMap(descendants)]; }
function all(root, predicate) { return descendants(root).filter(predicate); }
function one(root, predicate) { const found = descendants(root).find(predicate); assert.ok(found, 'matching node not found'); return found; }
function tag(root, name) { return one(root, node => node.tagName === name.toUpperCase()); }
function byName(root, name) { return one(root, node => node.getAttribute?.('name') === name); }
function section(root, title) { return one(root, node => node.tagName === 'SECTION' && all(node, x => x.tagName === 'H3' && x.textContent === title).length); }
function tbodyRows(root) { return all(tag(root, 'tbody'), node => node.tagName === 'TR'); }
function env(t) {
  const oldDocument = globalThis.document, oldFetch = globalThis.fetch;
  globalThis.document = { createElement: name => new FakeElement(name), createTextNode: text => new TextNode(text) };
  globalThis.fetch = () => { throw new Error('Network is forbidden in tests'); };
  t.after(() => { globalThis.document = oldDocument; globalThis.fetch = oldFetch; });
  return new FakeElement('main');
}
function fill(root, { name = '가게', address = '서울시 강남구 1', website = '', consent = true } = {}) {
  byName(root, 'name').value = name; byName(root, 'address').value = address; byName(root, 'website').value = website; byName(root, 'consent').checked = consent;
}
function submit(root) { return tag(root, 'form').fire('submit'); }
function sample() { return {
  business: { name: '가게', category: '음식점', address: '서울', serviceArea: '강남', offerings: ['식사', '음료'], priceHoursBooking: { price: '1만원', hours: null, booking: '예약 가능' }, description: '설명', sources: [{ title: '공개 출처', url: 'https://example.com/source' }] },
  technicalScan: { targetUrl: 'https://example.com/', items: [
    { key: 'a', label: '항목 A', status: 'present', evidence: '원문   공백\n두 번째 줄', improvement: '개선 A', sourceUrl: 'https://example.com/a' },
    { key: 'b', label: '항목 B', status: 'absent', evidence: '<img src=x onerror=alert(1)>', improvement: '개선 B', sourceUrl: 'javascript:alert(1)' },
    { key: 'c', label: '항목 C', status: 'blocked', evidence: '차단 증거', improvement: '개선 C', sourceUrl: '' },
    { key: 'd', label: '항목 D', status: 'unknown', evidence: '미확인 증거', improvement: '개선 D', sourceUrl: '' }
  ] },
  suggestedQuestions: Array.from({ length: 7 }, (_, i) => '질문 ' + (i + 1)),
  competitors: Array.from({ length: 4 }, (_, i) => ({ name: '비교 ' + (i + 1), region: '지역 ' + (i + 1), reason: '사유 ' + (i + 1), source: { title: '출처 ' + (i + 1), url: i === 1 ? 'javascript:alert(1)' : 'https://example.com/' + i } })),
  priorities: Array.from({ length: 4 }, (_, i) => ({ problem: '문제 ' + (i + 1), inconvenience: '불편 ' + (i + 1), action: '조치 ' + (i + 1) })),
  notice: '별도 확인 안내', scannedAt: '2026-11-08T10:00:00Z', score: 99
}; }

test('required fields, consent and website validation precede exactly one injected request', async t => {
  const root = env(t), calls = [];
  const view = mountGeoDiagnosis(root, { request: async payload => { calls.push(payload); return sample(); } });
  await submit(root); assert.match(root.textContent, /상호명을 입력/); assert.equal(calls.length, 0);
  fill(root, { address: '', consent: false }); await submit(root); assert.match(root.textContent, /가게 주소를 입력/);
  fill(root, { website: 'javascript:alert(1)', consent: false }); await submit(root); assert.match(root.textContent, /http:\/\//);
  fill(root, { website: 'https://id:password@example.com', consent: false }); await submit(root); assert.match(root.textContent, /올바른 주소/);
  fill(root, { consent: false }); await submit(root); assert.match(root.textContent, /동의해 주세요/); assert.equal(calls.length, 0);
  assert.match(root.textContent, /외부 AI/); assert.match(root.textContent, /캐시될 수/); assert.match(root.textContent, /사진은 필요하지 않으며/);
  assert.match(root.textContent, /OpenRouter와 Claude/); assert.match(root.textContent, /최대 3일 저장될 수/); assert.match(root.textContent, /불필요한 개인정보/);
  assert.equal(byName(root, 'name').getAttribute('maxlength'), '60'); assert.equal(byName(root, 'address').getAttribute('maxlength'), '120'); assert.equal(byName(root, 'website').getAttribute('maxlength'), '2048');
  fill(root, { name: '가'.repeat(61) }); await submit(root); assert.match(root.textContent, /60자 이내/); assert.equal(calls.length, 0);
  fill(root, { address: '가'.repeat(121) }); await submit(root); assert.match(root.textContent, /120자 이내/); assert.equal(calls.length, 0);
  fill(root, { name: '  가게  ', address: '  주소  ' }); await submit(root);
  assert.deepEqual(calls, [{ consent: true, name: '가게', address: '주소' }]);
  fill(root, { website: 'https://example.com/path' }); await submit(root);
  assert.deepEqual(calls[1], { consent: true, name: '가게', address: '서울시 강남구 1', website: 'https://example.com/path' });
  view.destroy(); assert.equal(root.children.length, 0);
});

test('five sections preserve all returned table rows, exact statuses and evidence; lists are capped', async t => {
  const root = env(t); const raw = sample();
  mountGeoDiagnosis(root, { request: async () => raw }); fill(root, { website: 'https://example.com' }); await submit(root);
  const sections = all(root, node => node.tagName === 'SECTION'); assert.equal(sections.length, 5);
  assert.deepEqual(sections.map(s => tag(s, 'h3').textContent), ['공개 정보 정리', '공식 웹사이트 점검', 'AI가 제안한 예상 질문', '비교할 업체', '우선 개선할 과제']);
  const business = section(root, '공개 정보 정리'); assert.match(business.textContent, /미검증/);
  const details = all(business, n => n.className === 'gd-detail');
  assert.equal(details.find(n => n.textContent.startsWith('가격')).textContent, '가격1만원');
  assert.equal(details.find(n => n.textContent.startsWith('운영시간')).textContent, '운영시간확인 불가');
  assert.equal(details.find(n => n.textContent.startsWith('예약')).textContent, '예약예약 가능');
  const tech = section(root, '공식 웹사이트 점검');
  assert.deepEqual(all(tag(tech, 'thead'), n => n.tagName === 'TH').map(n => n.textContent), ['점검 항목', '확인 결과', '근거', '개선할 내용']);
  const rows = tbodyRows(tech); assert.equal(rows.length, raw.technicalScan.items.length);
  rows.forEach((row, i) => {
    const cells = row.children; assert.equal(cells[0].textContent, raw.technicalScan.items[i].label);
    assert.equal(cells[1].children[0].textContent, raw.technicalScan.items[i].status);
    assert.equal(cells[2].children[0].textContent, raw.technicalScan.items[i].evidence);
    assert.equal(cells[3].textContent, raw.technicalScan.items[i].improvement);
  });
  assert.match(rows[0].textContent, /해당 항목 확인/); assert.match(rows[1].textContent, /없음 또는 미발견/); assert.match(rows[2].textContent, /차단되어 확인 불가/); assert.match(rows[3].textContent, /확인 불가/);
  assert.equal(all(section(root, 'AI가 제안한 예상 질문'), n => n.tagName === 'LI').length, 5);
  assert.equal(all(section(root, '비교할 업체'), n => n.className === 'gd-card').length, 3);
  assert.equal(all(section(root, '우선 개선할 과제'), n => n.className === 'gd-priority').length, 3);
  assert.doesNotMatch(root.textContent, /질문 6|비교 4|문제 4|99점|총점/);
  assert.match(root.textContent, /실제 AI 답변에 업체가 나타나는지/); assert.match(root.textContent, /별도 측정/);
  assert.equal(all(root, n => n.tagName === 'IMG').length, 0);
  const hrefs = all(root, n => n.tagName === 'A').map(n => n.getAttribute('href'));
  assert.ok(hrefs.length >= 2); assert.ok(hrefs.every(href => /^https?:\/\//.test(href))); assert.ok(hrefs.every(href => !href.includes('javascript:')));
  assert.match(section(root, '비교할 업체').textContent, /주소 확인 불가/);
  assert.ok(all(root, n => n.tagName === 'A').every(n => n.getAttribute('rel') === 'noopener noreferrer'));
});

test('omitted website is not inspected, while missing results for submitted website are uncertain', async t => {
  const root = env(t);
  const result = { ...sample(), technicalScan: { items: [] }, business: {}, suggestedQuestions: [], competitors: [], priorities: [] };
  mountGeoDiagnosis(root, { request: async () => result });
  fill(root); await submit(root); let tech = section(root, '공식 웹사이트 점검');
  assert.match(tech.textContent, /웹사이트를 입력하지 않아 웹사이트를 점검하지 않았습니다/); assert.equal(all(tech, n => n.tagName === 'TR').length, 0);
  assert.match(section(root, '공개 정보 정리').textContent, /확인 불가/);
  assert.match(section(root, 'AI가 제안한 예상 질문').textContent, /확인 불가/);
  fill(root, { website: 'https://example.com' }); await submit(root); tech = section(root, '공식 웹사이트 점검');
  assert.match(tech.textContent, /점검 결과를 확인할 수 없습니다/); assert.match(tech.textContent, /수행 여부는 응답만으로 알 수 없습니다/);
  assert.doesNotMatch(tech.textContent, /입력하지 않아 웹사이트를 점검하지 않았습니다/);
});

test('nine unknown rows are displayed only when provided, without inventing rows', async t => {
  const root = env(t); const raw = sample();
  raw.technicalScan = { items: Array.from({ length: 9 }, (_, i) => ({ key: String(i), label: '항목' + i, status: 'unknown', evidence: '원문' + i, improvement: '' })) };
  mountGeoDiagnosis(root, { request: async () => raw }); fill(root); await submit(root);
  const tech = section(root, '공식 웹사이트 점검'), rows = tbodyRows(tech);
  assert.equal(rows.length, 9); assert.match(tech.textContent, /점검을 요청하지 않았습니다/);
  for (let i=0; i<9; i++) { assert.equal(rows[i].children[1].children[0].textContent, 'unknown'); assert.equal(rows[i].children[2].children[0].textContent, '원문' + i); }
});

test('a pending request is not duplicated, failure preserves fields, and nothing retries automatically', async t => {
  const root = env(t); let rejectPending, calls = 0;
  mountGeoDiagnosis(root, { request: () => { calls++; return new Promise((resolve, reject) => { rejectPending = reject; }); } });
  fill(root, { website: 'https://example.com' });
  const first = submit(root), second = submit(root); await second;
  assert.equal(calls, 1); assert.equal(tag(root, 'fieldset').disabled, true); assert.match(root.textContent, /진단 중/);
  assert.match(root.textContent, /중단된다고 보장할 수 없습니다/);
  rejectPending(new Error('unknown status')); await first; await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(tag(root, 'fieldset').disabled, false);
  assert.equal(byName(root, 'name').value, '가게'); assert.equal(byName(root, 'address').value, '서울시 강남구 1');
  assert.equal(byName(root, 'website').value, 'https://example.com'); assert.equal(byName(root, 'consent').checked, true);
  assert.match(root.textContent, /이미 요청을 처리했거나 비용이 발생했을 수/); assert.match(root.textContent, /다시 시도하면 새 요청/);
});

test('destroy prevents late DOM changes and does not claim to cancel the request; back is optional', async t => {
  const root = env(t); let complete, backCount = 0;
  const view = mountGeoDiagnosis(root, { onBack: () => backCount++, request: () => new Promise(resolve => { complete = resolve; }) });
  one(root, n => n.tagName === 'BUTTON' && n.textContent.includes('돌아가기')).fire('click'); assert.equal(backCount, 1);
  fill(root); const pending = submit(root); view.destroy(); assert.equal(root.children.length, 0);
  complete(sample()); await pending; assert.equal(root.children.length, 0); view.destroy();
  const next = mountGeoDiagnosis(root, { request: async () => sample() }); assert.equal(all(root, n => n.tagName === 'BUTTON' && n.textContent.includes('돌아가기')).length, 0);
  const last = mountGeoDiagnosis(root, { request: async () => sample() }); assert.equal(all(root, n => n.tagName === 'FORM').length, 1);
  next.destroy(); assert.equal(all(root, n => n.tagName === 'FORM').length, 1); last.destroy(); assert.equal(root.children.length, 0);
});

test('safe validation codes map to fixed messages, never arbitrary upstream text', async t => {
  const root = env(t); let code = 'WEBSITE';
  mountGeoDiagnosis(root, { request: async () => { const error = new Error('sensitive internal text'); error.code = code; throw error; } });
  fill(root, { website: 'https://example.com' }); await submit(root);
  assert.match(root.textContent, /공개 홈페이지 도메인 주소를 확인/); assert.doesNotMatch(root.textContent, /sensitive internal text/);
  code = 'INTERNAL'; await submit(root); assert.match(root.textContent, /서버나 외부 서비스가 이미 요청을 처리/);
});

test('template-based questions are disclosed rather than called AI-generated', async t => {
  const root = env(t), raw = sample(); raw.notice = '예상 질문 5개는 업종·지역을 반영한 규칙 기반 템플릿이며 AI 생성이나 실제 검색량 자료가 아닙니다.';
  mountGeoDiagnosis(root, { request: async () => raw }); fill(root); await submit(root);
  assert.match(section(root, '예상 질문').textContent, /규칙 기반/); assert.doesNotMatch(root.textContent, /AI가 제안한 예상 질문/);
});
