import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlacePage, renderPlacePage } from '../lib/place-page.mjs';

const policy = {
  imageHosts: ['images.example.com'],
  reservationHosts: ['booking.example.com'],
};
const minimal = { slug: 'my-place', storeName: '좋은 가게' };
const full = {
  slug: ' MY-PLACE-42 ',
  storeName: ' 좋은 가게 ',
  address: '서울특별시 중구 예시로 12',
  category: '카페',
  description: '사장님이 직접 제공한 소개입니다.',
  hours: '화~일 10:00~18:00',
  parking: '주차 공간 없음',
  menu: [
    { name: '커피', priceKrw: 4500, verified: true },
    { name: '물', priceKrw: 0, verified: true },
  ],
  reservationLinks: [{ label: '예약하기', url: 'https://booking.example.com/book?party=2&date=1' }],
  faqs: [{ question: '휴무일은 언제인가요?', answer: '매주 월요일입니다.' }],
  keywordTopics: ['커피', '서울 카페'],
  images: [{ url: 'https://images.example.com/a.jpg?x=1&y=2', alt: '가게 내부', ownerApproved: true }],
};

function jsonLd(html) {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  return JSON.parse(scripts[0][1]);
}
function clone(value) { return structuredClone(value); }
function rejectOwner(patch, regex = /./) {
  assert.throws(() => renderPlacePage({ ...minimal, ...patch }, policy), regex);
}

test('renders complete Korean HTML with visible supplied information and SEO', () => {
  const html = renderPlacePage(full, policy);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<meta name="robots" content="index,follow">/);
  assert.match(html, /<title>좋은 가게 \| 카페<\/title>/);
  assert.match(html, /<meta name="description" content="좋은 가게 · 카페 · 서울특별시 중구 예시로 12 · 사장님이 직접 제공한 소개입니다\.">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.kkumsu\.com\/places\/my-place-42">/);
  for (const text of ['좋은 가게', '서울특별시 중구 예시로 12', '카페', '사장님이 직접 제공한 소개입니다.',
    '화~일 10:00~18:00', '주차 공간 없음', '커피', '4,500원', '0원', '예약하기',
    '휴무일은 언제인가요?', '매주 월요일입니다.', '서울 카페', '가게 내부']) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  assert.match(html, /href="https:\/\/booking\.example\.com\/book\?party=2&amp;date=1"/);
  assert.match(html, /src="https:\/\/images\.example\.com\/a\.jpg\?x=1&amp;y=2"/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /href="#main">본문 바로가기/);
  assert.match(html, /aria-labelledby="faq"/);
  assert.match(html, /alt="가게 내부"/);
  assert.match(html, /@media\(max-width:360px\)/);
});

test('schema contains only supplied facts also shown as body text', () => {
  const html = renderPlacePage(full, policy);
  assert.deepEqual(jsonLd(html), {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: '좋은 가게',
    address: '서울특별시 중구 예시로 12',
    description: '사장님이 직접 제공한 소개입니다.',
  });
  assert.deepEqual(jsonLd(renderPlacePage(minimal)), {
    '@context': 'https://schema.org', '@type': 'LocalBusiness', name: '좋은 가게',
  });
});

test('omits absent, null, empty and blank optional fields without invention', () => {
  const data = { ...minimal, address: '  ', category: null, description: '', hours: null,
    parking: undefined, menu: [], reservationLinks: null, faqs: [], keywordTopics: [], images: [] };
  const html = renderPlacePage(data);
  assert.deepEqual(normalizePlacePage(data), minimal);
  for (const label of ['매장 정보', '업종', '주소', '영업시간', '주차', '메뉴', '예약', '자주 묻는 질문', '관련 주제', '사진']) {
    assert.ok(!html.includes(`>${label}<`), `unexpected ${label}`);
  }
  assert.match(html, /<meta name="description" content="좋은 가게">/);
});

test('normalizes without mutating the submitted data and is deterministic', () => {
  const data = clone(full);
  const before = clone(data);
  assert.deepEqual(normalizePlacePage(data, policy).slug, 'my-place-42');
  assert.deepEqual(data, before);
  assert.equal(renderPlacePage(data, policy), renderPlacePage(data, policy));
  assert.equal(normalizePlacePage({ ...minimal, storeName: '가게\n  이름 😀' }).storeName, '가게 이름 😀');
});

test('escapes body, metadata, attributes, and script-closing attacks in JSON-LD', () => {
  const attack = '</script><script>alert(1)</script><img src=x onerror=1>&';
  const data = {
    ...minimal, storeName: attack, category: `" onmouseover="alert(1)`,
    address: attack, description: attack, hours: attack, parking: attack,
    menu: [{ name: attack, priceKrw: 1, verified: true }],
    reservationLinks: [{ label: attack, url: 'https://booking.example.com/book?q=%22%3E%3Csvg%20onload=alert(1)%3E&n=1' }],
    faqs: [{ question: attack, answer: attack }], keywordTopics: [attack],
    images: [{ url: 'https://images.example.com/x?x=%22&y=1', alt: attack, ownerApproved: true }],
  };
  const html = renderPlacePage(data, policy);
  assert.ok(!html.includes(attack));
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.equal((html.match(/<img\b/g) || []).length, 1);
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;alert\(1\)/);
  assert.match(html, /\\u003c\/script\\u003e/);
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/);
  assert.equal(jsonLd(html).name, attack);
  assert.equal(jsonLd(html).address, attack);
  assert.equal(jsonLd(html).description, attack);
  assert.ok(!html.includes('<svg'));
});

test('accepts only a bounded single ASCII slug under the fixed canonical origin', () => {
  assert.match(renderPlacePage({ ...minimal, slug: '  CAFE-42  ' }), /href="https:\/\/www\.kkumsu\.com\/places\/cafe-42"/);
  for (const bad of ['', ' ', '../admin', '.', '..', '/one', 'one/two', 'one?x=1', 'one#frag',
    'one%2ftwo', 'one--two', '-one', 'one-', '한글', 'https://evil.com', 'a'.repeat(81)]) {
    rejectOwner({ slug: bad }, /slug/);
  }
});

test('only explicitly verified finite whole-KRW prices and approved images are accepted', () => {
  for (const item of [
    { name: '메뉴', priceKrw: 100 }, { name: '메뉴', priceKrw: 100, verified: false },
    { name: '메뉴', priceKrw: -1, verified: true }, { name: '메뉴', priceKrw: 1.5, verified: true },
    { name: '메뉴', priceKrw: Infinity, verified: true }, { name: '메뉴', priceKrw: NaN, verified: true },
    { name: '메뉴', priceKrw: '1000', verified: true }, { name: '메뉴', priceKrw: 100000001, verified: true },
    { name: '', priceKrw: 100, verified: true }, { name: '메뉴', priceKrw: 100, verified: true, invented: true },
  ]) rejectOwner({ menu: [item] }, /menu/);
  for (const image of [
    { url: 'https://images.example.com/x', alt: '사진' },
    { url: 'https://images.example.com/x', alt: '사진', ownerApproved: false },
    { url: 'https://images.example.com/x', alt: '', ownerApproved: true },
  ]) rejectOwner({ images: [image] }, /images/);
});

test('external URLs require HTTPS, public host, no credentials, and exact trusted allowlist', () => {
  for (const url of [
    'javascript:alert(1)', 'data:text/html,hi', 'http://booking.example.com/a', '//booking.example.com/a',
    'https://user:pass@booking.example.com/a', 'https://booking.example.com@evil.example.com/a',
    'https://booking.example.com.evil.example.com/a', 'https://evil.example.com/a',
    'https://booking.example.com:444/a', 'https://booking.example.com./a',
    'https://booking.example.com\\@evil.example.com/a', 'https://booking.example.com/line\nfeed',
    'https://localhost/a', 'https://x.localhost/a', 'https://x.internal/a', 'https://127.0.0.1/a',
    'https://2130706433/a', 'https://0x7f000001/a', 'https://[::1]/a', 'https://192.168.1.1/a',
    `https://booking.example.com/${'a'.repeat(2049)}`,
  ]) rejectOwner({ reservationLinks: [{ label: '예약', url }] }, /reservationLinks/);
  for (const url of ['http://images.example.com/x', 'https://evil.example.com/x', 'https://images.example.com@evil.example.com/x']) {
    rejectOwner({ images: [{ url, alt: '사진', ownerApproved: true }] }, /images/);
  }
  assert.throws(() => renderPlacePage({ ...minimal, reservationLinks: full.reservationLinks }), /allowlist/);
  assert.throws(() => renderPlacePage({ ...minimal, images: full.images }), /allowlist/);
  const valid = normalizePlacePage({ ...minimal, reservationLinks: [{ label: '예약', url: 'https://BOOKING.example.com:443/a' }] }, policy);
  assert.equal(valid.reservationLinks[0].url, 'https://booking.example.com/a');
});

test('host policies reject local, literal, malformed, suffix and wildcard entries', () => {
  for (const host of ['localhost', 'x.localhost', 'foo.local', 'foo.internal', 'foo.home.arpa',
    '127.0.0.1', '2130706433', '[::1]', '*.example.com', '.example.com', 'example.com.',
    'https://example.com', 'example.com:443', 'user@example.com', 'foo.test', 'foo.invalid',
    'foo.example', 'foo.onion', '-bad.example.com', 'foo..example.com', 'example.com/path']) {
    assert.throws(() => renderPlacePage(minimal, { imageHosts: [host] }), /policy\.imageHosts/);
  }
  assert.throws(() => renderPlacePage(minimal, { imageHosts: Array(51).fill('images.example.com') }), /policy\.imageHosts/);
  assert.throws(() => renderPlacePage(minimal, { imageHosts: ['images.example.com'], extra: true }), /unknown property/);
});

test('rejects malformed records, unknown properties, accessors and sparse arrays', () => {
  for (const value of [null, 0, 'x', [], new Date(), Object.create({ storeName: 'x' })]) {
    assert.throws(() => renderPlacePage(value), /ownerData/);
  }
  rejectOwner({ storeName: null }, /storeName/);
  rejectOwner({ storeName: 42 }, /storeName/);
  rejectOwner({ category: false }, /category/);
  rejectOwner({ hours: '\u0000bad' }, /hours/);
  rejectOwner({ storeName: '\ud800' }, /storeName/);
  rejectOwner({ storeName: 'abc\u202eexe' }, /storeName/);
  rejectOwner({ description: 'a'.repeat(1201) }, /description/);
  rejectOwner({ menu: 'not an array' }, /menu/);
  rejectOwner({ faqs: [{ question: '질문' }] }, /answer/);
  rejectOwner({ menu: Array(41).fill({ name: 'm', priceKrw: 1, verified: true }) }, /menu/);
  rejectOwner({ keywordTopics: Array(16).fill('topic') }, /keywordTopics/);
  rejectOwner({ unexpected: 'value' }, /unknown property/);
  const polluted = JSON.parse('{"slug":"my-place","storeName":"가게","__proto__":{"polluted":true}}');
  assert.throws(() => renderPlacePage(polluted), /unknown property/);
  assert.equal({}.polluted, undefined);
  let invoked = false;
  const withGetter = { ...minimal };
  Object.defineProperty(withGetter, 'description', { enumerable: true, get() { invoked = true; return 'x'; } });
  assert.throws(() => renderPlacePage(withGetter), /data property/);
  assert.equal(invoked, false);
  const sparse = Array(1);
  rejectOwner({ keywordTopics: sparse }, /keywordTopics/);
  const extra = ['x']; extra.extra = true;
  rejectOwner({ keywordTopics: extra }, /keywordTopics/);
});

test('all text and collection limits reject oversized input while accepting the boundary', () => {
  const fieldCases = [
    [80, (s) => ({ storeName: s })], [200, (s) => ({ address: s })],
    [60, (s) => ({ category: s })], [1200, (s) => ({ description: s })],
    [300, (s) => ({ hours: s })], [300, (s) => ({ parking: s })],
    [80, (s) => ({ menu: [{ name: s, priceKrw: 1, verified: true }] })],
    [80, (s) => ({ reservationLinks: [{ label: s, url: 'https://booking.example.com/' }] })],
    [200, (s) => ({ faqs: [{ question: s, answer: 'a' }] })],
    [1000, (s) => ({ faqs: [{ question: 'q', answer: s }] })],
    [60, (s) => ({ keywordTopics: [s] })],
    [160, (s) => ({ images: [{ url: 'https://images.example.com/a', alt: s, ownerApproved: true }] })],
  ];
  for (const [max, patch] of fieldCases) {
    assert.doesNotThrow(() => normalizePlacePage({ ...minimal, ...patch('x'.repeat(max)) }, policy));
    assert.throws(() => normalizePlacePage({ ...minimal, ...patch('x'.repeat(max + 1)) }, policy), /exceeds/);
  }
  const collections = [
    ['menu', 40, { name: '메뉴', priceKrw: 1, verified: true }],
    ['reservationLinks', 8, { label: '예약', url: 'https://booking.example.com/' }],
    ['faqs', 20, { question: '질문', answer: '답변' }],
    ['keywordTopics', 15, '주제'],
    ['images', 10, { url: 'https://images.example.com/a', alt: '사진', ownerApproved: true }],
  ];
  for (const [key, max, item] of collections) {
    assert.doesNotThrow(() => normalizePlacePage({ ...minimal, [key]: Array(max).fill(item) }, policy));
    assert.throws(() => normalizePlacePage({ ...minimal, [key]: Array(max + 1).fill(item) }, policy), /at most/);
  }
  const base = 'https://booking.example.com/';
  const exact = base + 'a'.repeat(2048 - base.length);
  assert.doesNotThrow(() => normalizePlacePage({ ...minimal, reservationLinks: [{ label: '예약', url: exact }] }, policy));
  assert.throws(() => normalizePlacePage({ ...minimal, reservationLinks: [{ label: '예약', url: `${exact}a` }] }, policy), /HTTPS URL/);
});

test('metadata is bounded and does not split Unicode code points', () => {
  const html = renderPlacePage({ ...minimal, description: '😀'.repeat(200) });
  const meta = html.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.ok(Array.from(meta).length <= 160);
  assert.doesNotMatch(meta, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});
