import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, makeDocx, makeHwpx, makeAsciiPdf, makeKoreanPdf, SAMPLE_KO } from './file-reader-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 네트워크 감시: 시험 중 어떤 네트워크 API 호출도 없어야 한다.
const netCalls = [];
globalThis.fetch = (...a) => { netCalls.push(['fetch', String(a[0])]); return Promise.reject(new Error('network forbidden in test')); };
globalThis.XMLHttpRequest = class { constructor() { netCalls.push(['xhr']); } };
globalThis.WebSocket = class { constructor() { netCalls.push(['ws']); } };

// pdfjs-dist 5.x 의 비-legacy 빌드는 로드 시점에 DOMMatrix 를 참조한다(브라우저에는 있음).
// 텍스트 추출에는 렌더링이 필요 없으므로 Node 시험에서만 자리표시자로 둔다.
globalThis.DOMMatrix ??= class DOMMatrix {};

// Node 에는 브라우저 <script> 가 없으므로 같은 vendor 번들을 직접 평가한다(브라우저에서는 script 태그로 로드).
globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(root, 'public/vendor/mammoth/mammoth.browser.min.js'), 'utf8'));

const { readEssayFile, FileReaderError, LIMITS, MAX_ESSAY_CHARS } = await import('../public/file-reader.mjs');

const F = (bytes, name, type = '') => new File([bytes], name, { type });
const ok = async (bytes, name, type) => readEssayFile(F(bytes, name, type));
async function rejects(bytes, name, code, re) {
  await assert.rejects(readEssayFile(F(bytes, name)), (e) => {
    assert.ok(e instanceof FileReaderError, `FileReaderError 여야 함: ${e}`);
    assert.equal(e.code, code, `code=${e.code} msg=${e.message}`);
    assert.match(e.message, /[가-힣]/);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test('TXT: UTF-8, BOM, UTF-16', async () => {
  let r = await ok(Buffer.from(SAMPLE_KO + '\r\n두 번째 줄', 'utf8'), 'a.txt');
  assert.equal(r.text, SAMPLE_KO + '\n두 번째 줄');
  assert.deepEqual(r.warnings, []);
  r = await ok(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE_KO)]), 'a.txt');
  assert.equal(r.text, SAMPLE_KO);
  r = await ok(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SAMPLE_KO, 'utf16le')]), 'a.txt');
  assert.equal(r.text, SAMPLE_KO);
  r = await ok(Buffer.from(SAMPLE_KO), 'noext', 'text/plain');
  assert.equal(r.text, SAMPLE_KO);
});

test('TXT: 검증된 EUC-KR 만 허용하고 경고', async () => {
  // 가나다라마바사아자하 (KS X 1001)
  const euc = Buffer.from([0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9, 0xb6, 0xf3, 0xb8, 0xb6, 0xb9, 0xd9, 0xbb, 0xe7, 0xbe, 0xc6, 0xc0, 0xda, 0xc7, 0xcf]);
  const r = await ok(euc, 'k.txt');
  assert.equal(r.text, '가나다라마바사아자하');
  assert.ok(r.warnings.some((w) => w.includes('EUC-KR')));
  await rejects(Buffer.from([0xb0, 0xa1, 0xb3]), 'bad.txt', 'encoding'); // 잘린 멀티바이트
  await rejects(Buffer.from([0x80, 0x81, 0x82, 0x83, 0xfe, 0xfe]), 'bin.txt', 'encoding');
  await rejects(Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00]), 'nul.txt', 'unsupported');
});

test('6000자 초과는 자르지 않고 경고', async () => {
  const long = '가'.repeat(MAX_ESSAY_CHARS + 123);
  const r = await ok(Buffer.from(long), 'long.txt');
  assert.equal(r.text.length, MAX_ESSAY_CHARS + 123);
  assert.ok(r.warnings.some((w) => w.includes('자르지 않았')));
  await rejects(Buffer.from('가'.repeat(LIMITS.maxExtractedChars + 1)), 'huge.txt', 'too_long');
});

test('크기·빈 파일·확장자·서명', async () => {
  await rejects(Buffer.alloc(0), 'e.txt', 'empty');
  await rejects(Buffer.alloc(LIMITS.maxFileBytes + 1, 0x61), 'big.txt', 'too_big');
  await rejects(Buffer.from('hello'), 'x.csv', 'unsupported');
  await rejects(Buffer.from('{\\rtf1\\ansi hi}'), 'x.txt', 'unsupported');
  await rejects(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'x.png', 'image', /OCR/);
  await rejects(Buffer.from('   \n  '), 'blank.txt', 'empty_text');
});

test('구형 HWP/DOC·암호화 OLE 거부', async () => {
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const hwp = Buffer.concat([Buffer.from(ole), Buffer.from('FileHeader', 'utf16le'), Buffer.alloc(64)]);
  await rejects(hwp, 'a.hwp', 'legacy_hwp', /hwpx/);
  await rejects(Buffer.concat([Buffer.from(ole), Buffer.alloc(64)]), 'a.doc', 'legacy_doc');
  const enc = Buffer.concat([Buffer.from(ole), Buffer.from('EncryptedPackage', 'utf16le'), Buffer.alloc(64)]);
  await rejects(enc, 'a.docx', 'encrypted');
});

test('DOCX 정상 추출', async () => {
  const r = await ok(makeDocx([SAMPLE_KO, '두 번째 문단 & <b>태그처럼 보이는 글</b>']), 'a.docx');
  assert.equal(r.text, `${SAMPLE_KO}\n\n두 번째 문단 & <b>태그처럼 보이는 글</b>`);
  assert.ok(r.warnings.length >= 1);
});

test('DOCX 글상자·수정 내역 경고', async () => {
  const body = '<w:p><w:r><w:t>본문</w:t></w:r></w:p><w:p><w:r><w:txbxContent><w:p><w:r><w:t>상자</w:t></w:r></w:p></w:txbxContent></w:r></w:p>';
  const r = await ok(makeDocx([], { extraBody: body }), 'a.docx');
  assert.ok(r.warnings.some((w) => w.includes('글상자')));
});

test('DOCX 비어 있음/손상/누락', async () => {
  await rejects(makeDocx(['']), 'e.docx', 'empty_text');
  const good = makeDocx([SAMPLE_KO]);
  await rejects(good.subarray(0, good.length - 40), 'c.docx', 'corrupt'); // EOCD 잘림
  const midBad = Buffer.from(good);
  midBad.fill(0xff, 60, 200); // 압축 데이터 손상
  await assert.rejects(readEssayFile(F(midBad, 'm.docx')), (e) => e instanceof FileReaderError);
  await rejects(makeZip({ 'hello.txt': 'x' }), 'z.docx', 'unsupported');
});

test('ZIP 방어: 엔트리 수·선언 크기·거짓 선언·암호·겹침', async () => {
  const many = {};
  for (let i = 0; i < LIMITS.maxZipEntries + 1; i++) many[`f${i}.txt`] = 'a';
  await rejects(makeZip(many), 'many.docx', 'zip_bomb');

  const base = { '[Content_Types].xml': '<x/>', 'word/document.xml': '<w:document xmlns:w="x"/>' };
  await rejects(makeZip(base, { lieUsize: { 'word/document.xml': 50 * 1024 * 1024 } }), 'big.docx', 'zip_bomb');

  // 압축 폭탄: 25MB 크기 항목
  await rejects(makeZip({ ...base, 'word/big.bin': Buffer.alloc(LIMITS.maxZipEntryBytes + 1024) }), 'bomb.docx', 'zip_bomb');

  // 합계 초과: 20MB 이하 항목 2개 = 합계 30MB 초과
  const chunk = Buffer.alloc(16 * 1024 * 1024);
  await rejects(makeZip({ ...base, 'a.bin': chunk, 'b.bin': chunk }), 'sum.docx', 'zip_bomb');

  // 선언은 작은데 실제로는 큼 (거짓 선언)
  const lie = makeZip({ ...base, 'word/x.bin': Buffer.alloc(2 * 1024 * 1024) }, { lieUsize: { 'word/x.bin': 100 } });
  await rejects(lie, 'lie.docx', 'zip_bomb');

  await rejects(makeZip(base, { flags: 0x801 }), 'enc.docx', 'encrypted');

  // 겹치는 항목: 두 번째 중앙 디렉터리 항목의 로컬 오프셋을 첫 번째와 같게
  const z = makeZip({ 'a.txt': 'aaaaaaaaaaaaaaaa', 'b.txt': 'bbbbbbbbbbbbbbbb' }, { store: true });
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
  const second = z.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), cd + 4);
  z.writeUInt32LE(0, second + 42);
  await rejects(z, 'ov.docx', 'zip_bomb');
});

test('HWPX 정상 추출·표/줄바꿈·엔티티', async () => {
  const r = await ok(makeHwpx([SAMPLE_KO, '둘째 & 셋째 <끝>']), 'a.hwpx');
  assert.equal(r.text, `${SAMPLE_KO}\n둘째 & 셋째 <끝>`);
  assert.ok(r.warnings.length >= 1);
});

test('HWPX: DTD 거부, 암호화 거부, 글자 없음', async () => {
  const dtd = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><hs:sec xmlns:hs="h" xmlns:hp="p"><hp:p><hp:run><hp:t>&a;</hp:t></hp:run></hp:p></hs:sec>';
  await rejects(makeHwpx([], { section: dtd }), 'd.hwpx', 'corrupt');
  await rejects(makeHwpx([SAMPLE_KO], { manifest: '<manifest:manifest><manifest:file-entry><manifest:encryption-data/></manifest:file-entry></manifest:manifest>' }), 'e.hwpx', 'encrypted');
  await rejects(makeHwpx([], { section: '<hs:sec xmlns:hs="h"></hs:sec>' }), 'n.hwpx', 'empty_text');
});

test('PDF: 영문 텍스트 층, 여러 쪽 경고, 빈 쪽 경고', async () => {
  let r = await ok(makeAsciiPdf(['Synthetic applicant sentence one']), 'a.pdf');
  assert.match(r.text, /Synthetic applicant sentence one/);
  assert.ok(r.warnings.some((w) => w.includes('OCR 없음')));
  r = await ok(makeAsciiPdf(['Page one text', 'Page two text']), 'b.pdf');
  assert.match(r.text, /Page one text[\s\S]*Page two text/);
  assert.ok(r.warnings.some((w) => w.includes('총 2쪽')));
  r = await ok(makeAsciiPdf(['Page one text', '', 'Page three']), 'c.pdf');
  assert.ok(r.warnings.some((w) => w.startsWith('2쪽')));
});

test('PDF: 한글 텍스트(ToUnicode)', async () => {
  const r = await ok(makeKoreanPdf('가상한글문장입니다'), 'k.pdf');
  assert.equal(r.text, '가상한글문장입니다');
});

test('PDF: 스캔(글자 없음)·쪽수 초과·암호·손상', async () => {
  await rejects(makeAsciiPdf(['']), 's.pdf', 'scanned', /OCR/);
  await rejects(makeAsciiPdf(Array(LIMITS.maxPdfPages + 1).fill('x')), 'p.pdf', 'too_many_pages');
  await rejects(makeAsciiPdf(['secret'], { encrypt: true }), 'e.pdf', 'encrypted');
  await rejects(Buffer.from('%PDF-1.4\nthis is not a real pdf'), 'c.pdf', 'corrupt');
});

test('격리: 네트워크 호출 0건, 소스에 원격 URL/전송 API 없음', async () => {
  assert.deepEqual(netCalls, []);
  const src = fs.readFileSync(path.join(root, 'public/file-reader.mjs'), 'utf8');
  assert.doesNotMatch(src, /https?:\/\//);
  assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB)\b/);
  assert.doesNotMatch(src, /\binnerHTML\b|\beval\s*\(|new Function/);
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    assert.ok(fs.existsSync(path.join(root, 'public/vendor/pdfjs', f)));
  }
});

test('bad UTF-8 with BOM returns a clear encoding error', async()=>{const f=new File([new Uint8Array([0xef,0xbb,0xbf,0xff,0xff])],'bad.txt',{type:'text/plain'});await assert.rejects(()=>readEssayFile(f), e=>e?.code==='encoding');});
