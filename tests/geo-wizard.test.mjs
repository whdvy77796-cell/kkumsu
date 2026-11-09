import test from 'node:test';
import assert from 'node:assert/strict';
import { mountGeoWizard } from '../public/geo-wizard.js';

class TextNode {
  constructor(value) { this.textContent = String(value); this.parentNode = null; }
}
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.handlers = {};
    this.className = ''; this.value = ''; this.checked = false; this.parentNode = null;
  }
  set textContent(v) { this.children = [new TextNode(v)]; }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(event, fn) { this.handlers[event] = fn; }
  append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); }
  focus() {}
  querySelector(selector) { return nodes(this).find(n => n.tagName?.toLowerCase() === selector) || null; }
  fire(event) { this.handlers[event]?.({ currentTarget: this, target: this, preventDefault() {} }); }
}
function nodes(root) { return [root, ...(root.children || []).flatMap(nodes)]; }
function find(root, predicate) { const node = nodes(root).find(predicate); assert.ok(node, 'element not found'); return node; }
function byTag(root, tag) { return find(root, n => n.tagName === tag.toUpperCase()); }
function button(root, label) { return find(root, n => n.tagName === 'BUTTON' && n.textContent === label); }
function inputByName(root, name) { return find(root, n => n.tagName === 'INPUT' && n.getAttribute('name') === name); }
function checkbox(root, phrase) { return find(root, n => n.tagName === 'LABEL' && n.textContent.includes(phrase)).children[0]; }
function setInput(node, value) { node.value = value; node.fire('input'); }
function check(node) { node.checked = true; node.fire('change'); }
function fileInput(root) { return find(root, n => n.tagName === 'INPUT' && n.getAttribute('type') === 'file'); }
function chooseFiles(root, files) { const node = fileInput(root); node.files = files; node.fire('change'); }
function click(root, text) { button(root, text).fire('click'); }
function submit(root) { byTag(root, 'form').fire('submit'); }
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
function environment(t) {
  const oldDocument = globalThis.document, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const oldFetch = globalThis.fetch, created = [], revoked = [];
  globalThis.document = { createElement: tag => new FakeElement(tag), createTextNode: text => new TextNode(text) };
  URL.createObjectURL = file => { const url = `blob:test/${created.length + 1}`; created.push({ file, url }); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  t.after(() => { globalThis.document = oldDocument; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; globalThis.fetch = oldFetch; });
  return { container: new FakeElement('main'), created, revoked };
}
const candidate = (name = '가게 강남점', address = '서울특별시 강남구 가게로 1') => ({
  name, address, category: '공방', phone: '02-1234-5678', hours: '10:00~18:00',
  menu: [{ name: '도자기 수업', price: '30000원' }], features: ['예약 가능'], strengths: [], channels: [{type: '인스타그램', url: 'https://example.com/brand'}],
});
const result = (candidates = [candidate()], sources = []) => ({ candidates, sources, searchedAt: '2026-11-08T09:00:00Z', cached: false });
async function searchFlow(container, { name = '가게', address = '서울특별시 강남구 가게로 1' } = {}) {
  setInput(inputByName(container, 'name'), name); setInput(inputByName(container, 'address'), address);
  check(checkbox(container, '가게 정보 전송에 동의')); submit(container); await flush();
}
function chooseAndConfirm(container, candidateText) {
  click(container, candidateText); check(checkbox(container, '선택한 가게와 주소가 제 가게'));
  click(container, '확인하고 계속');
}
function candidateButtonText(container, name) {
  return find(container, n => n.tagName === 'BUTTON' && n.className.includes('geo-candidate') && n.textContent.includes(name)).textContent;
}
function photo(name = 'a.png', size = 100, type = 'image/png') { return { name, size, type }; }

test('requires only name, address and explicit consent, then POSTs once with the exact payload', async t => {
  const { container } = environment(t), calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => result() }; };
  const instance = mountGeoWizard(container);
  submit(container); assert.match(container.textContent, /이름과 주소를 모두 입력/); assert.equal(calls.length, 0);
  setInput(inputByName(container, 'name'), '가게'); setInput(inputByName(container, 'address'), '주소 1');
  submit(container); assert.match(container.textContent, /정보 전송에 동의/); assert.equal(calls.length, 0);
  check(checkbox(container, '가게 정보 전송에 동의')); submit(container); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/geo-search'); assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { consent: true, name: '가게', address: '주소 1' });
  assert.match(container.textContent, /3일 보관될 수/); assert.match(container.textContent, /다른 지점/);
  instance.destroy();
});

test('requires selection and identity confirmation, validates photos, resets rights, and revokes photos on branch switch', async t => {
  const { container, created, revoked } = environment(t);
  const instance = mountGeoWizard(container, { search: async () => result([candidate(), candidate('가게 서초점', '서울특별시 서초구 가게로 2')]) });
  await searchFlow(container);
  click(container, '확인하고 계속'); assert.match(container.textContent, /가게를 선택/);
  click(container, candidateButtonText(container, '강남점'));
  click(container, '확인하고 계속'); assert.match(container.textContent, /본인 가게인지 확인/);
  check(checkbox(container, '선택한 가게와 주소가 제 가게')); click(container, '확인하고 계속');
  chooseFiles(container, [photo('bad.gif', 50, 'image/gif')]); assert.match(container.textContent, /JPG, PNG, WebP 형식/); assert.equal(created.length, 0);
  chooseFiles(container, [photo('big.png', 5 * 1024 * 1024 + 1)]); assert.match(container.textContent, /5MB 이하/);
  chooseFiles(container, Array.from({ length: 5 }, (_, i) => photo(`${i}.png`))); assert.match(container.textContent, /최대 4장/);
  chooseFiles(container, [photo('1.png', 5 * 1024 * 1024), photo('2.png', 5 * 1024 * 1024), photo('3.png', 3 * 1024 * 1024)]);
  assert.match(container.textContent, /전체 크기는 12MB 이하/); assert.equal(created.length, 0);
  chooseFiles(container, [photo()]); click(container, '시안 만들기'); assert.match(container.textContent, /사용 권한을 확인/);
  check(checkbox(container, '선택한 사진을 사용할 권리'));
  chooseFiles(container, [photo('b.png')]); assert.equal(checkbox(container, '선택한 사진을 사용할 권리').checked, false);
  check(checkbox(container, '선택한 사진을 사용할 권리')); click(container, '시안 만들기');
  assert.match(container.textContent, /대표 상품 · 서비스 · 메뉴 · 미검증/);
  assert.match(container.textContent, /질문과 답변 예시 · 확인 필요/);
  assert.match(container.textContent, /서울특별시 강남구 공방/);
  assert.match(container.textContent, /도자기 수업/);
  click(container, '가게 다시 확인'); click(container, candidateButtonText(container, '서초점'));
  assert.match(container.textContent, /이전 가게의 선택 사진과 수정 내용이 지워집니다/);
  check(checkbox(container, '선택한 가게와 주소가 제 가게')); click(container, '확인하고 계속');
  assert.deepEqual(revoked, created.map(x => x.url)); assert.match(container.textContent, /선택한 사진이 없어요/);
  chooseFiles(container, [photo('third.png')]); instance.destroy();
  assert.equal(revoked.length, 3); assert.equal(container.children.length, 0);
});

test('empty search offers clearly labeled name/address fallback with safe text and source protocols', async t => {
  const { container } = environment(t);
  const attack = '<img src=x onerror=alert(1)>';
  const instance = mountGeoWizard(container, { search: async () => result([], [
    { title: attack, url: 'https://example.com/' }, { title: 'bad', url: 'javascript:alert(1)' }, { title: 'bad2', url: 'data:text/html,x' },
  ]) });
  await searchFlow(container, { name: attack, address: '서울특별시 마포구 예시로 1' });
  assert.match(container.textContent, /입력한 이름과 주소만/);
  chooseAndConfirm(container, candidateButtonText(container, attack)); click(container, '사진 없이 시안 만들기');
  assert.match(container.textContent, /대체 시안/); assert.match(container.textContent, /결제, 실제 게시, AI 읽기·색인 확인 기능은 구현되지 않았습니다/);
  assert.ok(container.textContent.includes(attack));
  assert.equal(nodes(container).filter(n => n.tagName === 'IMG').length, 0);
  const links = nodes(container).filter(n => n.tagName === 'A'); assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'https://example.com/'); assert.equal(links[0].textContent, attack);
  assert.equal(nodes(container).filter(n => n.tagName === 'H4' && n.textContent.includes('대표 상품')).length, 0);
  assert.match(container.textContent, /대표 상품·서비스·메뉴 미입력·미확인/);
  assert.match(container.textContent, /가격 미입력·미확인/);
  instance.destroy();
});

test('cancellation preserves inputs, ignores late results and does not retry', async t => {
  const { container } = environment(t); let resolvePending, receivedSignal; let calls = 0;
  const instance = mountGeoWizard(container, { search: (_payload, { signal }) => { calls++; receivedSignal = signal; return new Promise(resolve => { resolvePending = resolve; }); } });
  setInput(inputByName(container, 'name'), '보존할 가게'); setInput(inputByName(container, 'address'), '보존할 주소');
  check(checkbox(container, '가게 정보 전송에 동의')); submit(container); assert.equal(calls, 1);
  click(container, '검색 취소'); assert.equal(receivedSignal.aborted, true); assert.match(container.textContent, /화면에서 검색을 중단/);
  assert.equal(inputByName(container, 'name').value, '보존할 가게'); assert.equal(inputByName(container, 'address').value, '보존할 주소');
  resolvePending(result()); await flush(); assert.match(container.textContent, /우리 가게부터 찾아볼게요/); assert.equal(calls, 1);
  instance.destroy();
});

test('failed search preserves inputs and optional edits update the private preview without another request', async t => {
  const { container } = environment(t); let calls = 0;
  const instance = mountGeoWizard(container, { search: async () => { calls++; if (calls === 1) throw new Error('offline'); return result(); } });
  await searchFlow(container); assert.match(container.textContent, /검색을 완료하지 못했어요/); assert.equal(inputByName(container, 'name').value, '가게');
  submit(container); await flush(); assert.equal(calls, 1); assert.match(container.textContent, /정보 전송에 동의/);
  check(checkbox(container, '가게 정보 전송에 동의')); submit(container); await flush(); assert.equal(calls, 2);
  chooseAndConfirm(container, candidateButtonText(container, '강남점')); click(container, '사진 없이 시안 만들기');
  click(container, '정보 간단 수정');
  const edit = find(container, n => n.tagName === 'INPUT' && n.getAttribute('id')?.includes('-edit-name'));
  setInput(edit, '수정된 가게'); click(container, '수정 내용 반영');
  assert.match(container.textContent, /수정된 가게/); assert.equal(calls, 2);
  instance.destroy();
});


test('switching even identical-looking candidates and remounting releases old photo URLs', async t => {
  const { container, created, revoked } = environment(t);
  const first = mountGeoWizard(container, { search: async () => result([candidate(), candidate()]) });
  await searchFlow(container);
  let cards = nodes(container).filter(n => n.tagName === 'BUTTON' && n.className.includes('geo-candidate'));
  cards[0].fire('click'); check(checkbox(container, '선택한 가게와 주소가 제 가게')); click(container, '확인하고 계속');
  chooseFiles(container, [photo()]); click(container, '가게 다시 확인');
  cards = nodes(container).filter(n => n.tagName === 'BUTTON' && n.className.includes('geo-candidate'));
  cards[1].fire('click'); assert.match(container.textContent, /이전 가게의 선택 사진과 수정 내용이 지워집니다/);
  check(checkbox(container, '선택한 가게와 주소가 제 가게')); click(container, '확인하고 계속');
  assert.deepEqual(revoked, [created[0].url]);
  chooseFiles(container, [photo('another.png')]);
  const second = mountGeoWizard(container, { search: async () => result() });
  assert.deepEqual(revoked, created.map(p => p.url));
  first.destroy(); assert.match(container.textContent, /우리 가게부터 찾아볼게요/);
  second.destroy();
});

test('a search timeout stops loading, aborts the request and preserves the inputs', t => {
  const { container } = environment(t);
  const oldSetTimeout = globalThis.setTimeout, oldClearTimeout = globalThis.clearTimeout;
  t.after(() => { globalThis.setTimeout = oldSetTimeout; globalThis.clearTimeout = oldClearTimeout; });
  let timeout, signal;
  globalThis.setTimeout = (fn, ms) => { assert.equal(ms, 180000); timeout = fn; return 7; };
  globalThis.clearTimeout = () => {};
  const instance = mountGeoWizard(container, { search: (_body, options) => { signal = options.signal; return new Promise(() => {}); } });
  setInput(inputByName(container, 'name'), '보존'); setInput(inputByName(container, 'address'), '서울 주소');
  check(checkbox(container, '가게 정보 전송에 동의')); submit(container); timeout();
  assert.equal(signal.aborted, true); assert.match(container.textContent, /서버의 AI 처리가 계속됐을 수/);
  assert.equal(inputByName(container, 'name').value, '보존'); assert.equal(inputByName(container, 'address').value, '서울 주소');
  instance.destroy();
});


test('다른 가게만 검색된 경우 입력한 가게 정보로 진행하며 다른 지점 정보를 섞지 않는다', async t => {
  const { container } = environment(t);
  const instance = mountGeoWizard(container, { search: async () => result([candidate('다른 가게', '서울특별시 중구 다른길 2')]) });
  await searchFlow(container, {name:'내 브랜드', address:'서울특별시 마포구 입력로 1'});
  const cards = nodes(container).filter(n => n.tagName === 'BUTTON' && n.className.includes('geo-candidate'));
  assert.equal(cards.length, 2); cards[1].fire('click');
  check(checkbox(container, '선택한 가게와 주소가 제 가게')); click(container, '확인하고 계속');
  click(container, '사진 없이 시안 만들기');
  assert.match(container.textContent, /대체 시안/);
  assert.match(container.textContent, /내 브랜드/);
  assert.ok(!container.textContent.includes('도자기 수업'));
  instance.destroy();
});


test('AI 검색 실패 뒤에는 검색하지 않은 입력 정보만으로 명확히 구분된 시안을 만들 수 있다', async t => {
  const { container } = environment(t);
  const instance = mountGeoWizard(container, { search: async () => { throw new Error('network'); } });
  await searchFlow(container, {name:'예시 브랜드', address:'서울특별시 중구 예시로 9'});
  click(container, '검색 없이 입력 정보로 시안');
  assert.match(container.textContent, /AI 검색을 완료하지 못했어요/);
  chooseAndConfirm(container, candidateButtonText(container, '예시 브랜드'));
  click(container, '사진 없이 시안 만들기');
  assert.match(container.textContent, /AI 검색을 완료하지 못해 입력한 이름·주소만으로/);
  assert.match(container.textContent, /업종, 상품, 서비스, 가격 등을 추측하지 않았어요/);
  instance.destroy();
});


test('상품 이름만 있고 가격이 없는 검색 결과는 가격을 확인 필요로 남긴다', async t => {
  const { container } = environment(t);
  const c = {...candidate(), menu:[{name:'도자기 수업', price:null}]};
  const instance = mountGeoWizard(container, {search:async()=>result([c])});
  await searchFlow(container); chooseAndConfirm(container, candidateButtonText(container,'강남점'));
  click(container, '사진 없이 시안 만들기');
  assert.match(container.textContent, /가격 미입력·미확인/);
  assert.match(container.textContent, /서울특별시 강남구/);
  instance.destroy();
});
