// 인소서 파일 -> 텍스트 변환기 (브라우저 로컬 전용)
//
// 계약:  const { text, warnings } = await readEssayFile(file)
//   - file: File/Blob. 이름·내용은 어디로도 전송하지 않는다 (네트워크 API 사용 없음).
//   - 반환: { text: string, warnings: string[] }  (text 는 절대 6000자에서 자르지 않는다)
//   - 실패: FileReaderError(message 는 사용자에게 바로 보여줄 수 있는 한국어) 를 throw
// 지원: TXT(UTF-8/UTF-16 BOM/검증된 EUC-KR), 텍스트 층이 있는 PDF, DOCX, HWPX(제한적)
// 거부: 구형 HWP/DOC, 스캔(텍스트 없음) PDF, 암호화, 손상 파일, 너무 큰 파일, ZIP 폭탄 의심 파일
//
// 라이브러리(모두 이 폴더 아래 same-origin 자체 호스팅, 원격 CDN/워커 없음):
//   ./vendor/pdfjs/    PDF.js 5.4.530 (Apache-2.0)
//   ./vendor/mammoth/  mammoth 1.13.0 (BSD-2-Clause)

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ESSAY_CHARS = 6000; // 앱의 입력 한도. 넘어도 자르지 않고 경고만 한다.
export const LIMITS = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  maxExtractedChars: 100000, // 이보다 길면 에세이가 아니라고 보고 거부
  maxPdfPages: 20,
  maxZipEntries: 200,
  maxZipEntryBytes: 20 * 1024 * 1024,
  maxZipTotalBytes: 30 * 1024 * 1024,
  maxZipRatio: 200, // 1MB 초과 항목의 압축비 상한
  maxXmlPartBytes: 8 * 1024 * 1024,
  maxHwpxSections: 50,
  timeoutMs: 20000,
});

export class FileReaderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FileReaderError';
    this.code = code || 'read_failed';
  }
}
const fail = (code, message) => new FileReaderError(message, code);

const MSG = {
  empty: '파일이 비어 있어요.',
  tooBig: '파일이 너무 커요. 5MB 이하 파일만 읽을 수 있어요.',
  hwp: '구형 한글(.hwp) 파일은 읽을 수 없어요. 한글에서 "다른 이름으로 저장"으로 .hwpx 또는 .docx, .txt로 저장하거나, 내용을 복사해 붙여넣어 주세요.',
  doc: '구형 워드(.doc) 파일은 읽을 수 없어요. .docx 또는 .txt로 다시 저장하거나, 내용을 복사해 붙여넣어 주세요.',
  encrypted: '암호가 걸린 파일은 읽을 수 없어요. 암호를 해제한 파일을 올리거나, 내용을 복사해 붙여넣어 주세요.',
  corrupt: '파일이 손상되었거나 올바른 형식이 아니어서 읽을 수 없어요. 다른 파일로 시도하거나 내용을 복사해 붙여넣어 주세요.',
  unsupported: '지원하지 않는 파일 형식이에요. .txt, .pdf(글자가 들어 있는 PDF), .docx, .hwpx 파일만 읽을 수 있어요.',
  zipBomb: '파일 구조가 비정상적으로 커서 안전을 위해 읽지 않았어요.',
  scanned: '이 PDF에서 글자를 찾지 못했어요. 스캔본이나 이미지로 된 PDF일 수 있어요. 이 도구는 이미지 속 글자를 인식(OCR)하지 않으니, 글자를 복사해 붙여넣어 주세요.',
  noText: '파일에서 읽을 수 있는 글자를 찾지 못했어요.',
  timeout: '파일을 읽는 데 너무 오래 걸려 중단했어요. 더 작거나 단순한 파일로 시도해 주세요.',
  tooLong: '파일의 글자 수가 너무 많아요. 자기소개서 한 문항 분량의 파일을 올려 주세요.',
  tooManyPages: (n, max) => `PDF가 ${n}쪽이라 너무 길어요. ${max}쪽 이하의 PDF만 읽을 수 있어요. (일부만 읽지 않도록 전체를 거부해요.)`,
  encoding: 'TXT 파일의 글자 인코딩을 확실하게 확인하지 못했어요. UTF-8 또는 EUC-KR(한글 윈도우 메모장 ANSI) 형식으로 저장해 다시 올리거나, 내용을 복사해 붙여넣어 주세요.',
  copyBlocked: '이 PDF는 작성자가 내용 복사를 제한해 두어서 읽지 않았어요. 내용을 직접 붙여넣어 주세요.',
  garbled: '이 PDF의 글자가 올바르게 추출되지 않아요(글꼴 문제일 수 있어요). 잘못된 글자가 들어가지 않도록 읽지 않았어요. 내용을 복사해 붙여넣어 주세요.',
  oldBrowser: '이 브라우저는 파일 읽기에 필요한 기능을 지원하지 않아요. 최신 브라우저로 시도하거나 내용을 붙여넣어 주세요.',
  engine: '파일 읽기 도구를 불러오지 못했어요. 새로고침 후 다시 시도하거나 내용을 붙여넣어 주세요.',
};

const VENDOR = new URL('./vendor/', import.meta.url);

// ───────────────────────── 공통 유틸 ─────────────────────────
function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const startsWith = (d, sig, off = 0) => sig.every((b, i) => d[off + i] === b);
const sleepTick = () => new Promise((r) => setTimeout(r, 0));

function makeDeadline(ms) {
  const end = Date.now() + ms;
  return () => {
    if (Date.now() > end) throw fail('timeout', MSG.timeout);
  };
}

function countChars(s) {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
}

function normalizeText(raw) {
  let t = String(raw)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/[ \t\u00A0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// 최종 출력 공통 처리: 길이 검증·경고. 6000자를 넘어도 자르지 않는다.
function finish(rawText, warnings) {
  const text = normalizeText(rawText);
  if (!text) throw fail('empty_text', MSG.noText);
  if (text.length > LIMITS.maxExtractedChars) throw fail('too_long', MSG.tooLong);
  const n = countChars(text);
  const out = [...warnings];
  if (n > MAX_ESSAY_CHARS) {
    out.push(`읽은 글이 ${n.toLocaleString('ko-KR')}자로 ${MAX_ESSAY_CHARS.toLocaleString('ko-KR')}자 제한을 넘어요. 자동으로 자르지 않았으니 직접 줄여 주세요.`);
  }
  return { text, warnings: out };
}

// ───────────────────────── 안전한 ZIP 검사 ─────────────────────────
// 압축 해제 전 중앙 디렉터리·헤더를 검증하고, 실제 해제 시에도 바이트 상한을 강제한다.
function parseZip(data) {
  const len = data.length;
  if (len < 22) throw fail('corrupt', MSG.corrupt);
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 65535); i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 5 && data[i + 3] === 6) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail('corrupt', MSG.corrupt);
  const disk = u16(data, eocd + 4);
  const cdDisk = u16(data, eocd + 6);
  const countDisk = u16(data, eocd + 8);
  const count = u16(data, eocd + 10);
  const cdSize = u32(data, eocd + 12);
  const cdOff = u32(data, eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) throw fail('corrupt', MSG.corrupt);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw fail('zip_bomb', MSG.zipBomb); // ZIP64 는 5MB 파일에 불필요
  if (count === 0 || count > LIMITS.maxZipEntries) throw fail('zip_bomb', MSG.zipBomb);
  if (cdOff + cdSize > eocd) throw fail('corrupt', MSG.corrupt);

  const names = new Set();
  const entries = [];
  let p = cdOff;
  let total = 0;
  const nameDec = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOff + cdSize || u32(data, p) !== 0x02014b50) throw fail('corrupt', MSG.corrupt);
    const flags = u16(data, p + 8);
    const method = u16(data, p + 10);
    const csize = u32(data, p + 20);
    const usize = u32(data, p + 24);
    const nl = u16(data, p + 28);
    const el = u16(data, p + 30);
    const cl = u16(data, p + 32);
    const lho = u32(data, p + 42);
    if (p + 46 + nl + el + cl > cdOff + cdSize) throw fail('corrupt', MSG.corrupt);
    if (flags & 0x1 || flags & 0x40 || method === 99) throw fail('encrypted', MSG.encrypted);
    if (method !== 0 && method !== 8) throw fail('corrupt', MSG.corrupt);
    if (csize === 0xffffffff || usize === 0xffffffff) throw fail('zip_bomb', MSG.zipBomb);
    const name = nameDec.decode(data.subarray(p + 46, p + 46 + nl));
    if (names.has(name)) throw fail('corrupt', MSG.corrupt); // 중복 이름 = 모호한 구조
    if (name.includes('\0') || name.startsWith('/') || name.includes('..\\') || name.includes('../')) throw fail('corrupt', MSG.corrupt);
    names.add(name);
    if (usize > LIMITS.maxZipEntryBytes) throw fail('zip_bomb', MSG.zipBomb);
    if (usize > 1024 * 1024 && usize / Math.max(csize, 1) > LIMITS.maxZipRatio) throw fail('zip_bomb', MSG.zipBomb);
    total += usize;
    if (total > LIMITS.maxZipTotalBytes) throw fail('zip_bomb', MSG.zipBomb);
    if (method === 0 && csize !== usize) throw fail('corrupt', MSG.corrupt);
    // 로컬 헤더 검증
    if (lho + 30 > cdOff || u32(data, lho) !== 0x04034b50) throw fail('corrupt', MSG.corrupt);
    if (u16(data, lho + 6) & 0x1) throw fail('encrypted', MSG.encrypted);
    const start = lho + 30 + u16(data, lho + 26) + u16(data, lho + 28);
    const end = start + csize;
    if (end > cdOff) throw fail('corrupt', MSG.corrupt);
    entries.push({ name, method, csize, usize, start, end, isDir: name.endsWith('/') });
    p += 46 + nl + el + cl;
  }
  // 겹치는 데이터 영역(overlapping-entry zip bomb) 거부
  const sorted = [...entries].filter((e) => e.csize > 0).sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) throw fail('zip_bomb', MSG.zipBomb);
  return { entries, byName: new Map(entries.map((e) => [e.name, e])), total };
}

// 상한을 강제하며 한 항목을 해제. keep=false 면 검증만(메모리 보관 안 함).
async function inflateEntry(data, e, deadline, keep) {
  const raw = data.subarray(e.start, e.end);
  if (e.method === 0) return keep ? raw : null;
  if (typeof DecompressionStream === 'undefined') throw fail('old_browser', MSG.oldBrowser);
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(raw).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let got = 0;
  try {
    for (;;) {
      deadline();
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > e.usize) throw fail('zip_bomb', MSG.zipBomb); // 선언된 크기보다 크게 풀리면 거짓 선언
      if (keep) chunks.push(value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch {}
    if (err instanceof FileReaderError) throw err;
    throw fail('corrupt', MSG.corrupt);
  }
  if (got !== e.usize) throw fail('corrupt', MSG.corrupt);
  if (!keep) return null;
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function verifyAllEntries(data, zip, deadline) {
  for (const e of zip.entries) {
    if (e.isDir || e.usize === 0) continue;
    await inflateEntry(data, e, deadline, false);
  }
}

async function readXmlPart(data, zip, name, deadline) {
  const e = zip.byName.get(name);
  if (!e) return null;
  if (e.usize > LIMITS.maxXmlPartBytes) throw fail('zip_bomb', MSG.zipBomb);
  const bytes = await inflateEntry(data, e, deadline, true);
  return new TextDecoder('utf-8').decode(bytes);
}

// ───────────────────────── TXT ─────────────────────────
function decodeText(data) {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(3)), warnings: [] }; } catch { throw fail('encoding', MSG.encoding); }
  }
  try {
    if (data[0] === 0xff && data[1] === 0xfe) return { text: new TextDecoder('utf-16le', { fatal: true }).decode(data.subarray(2)), warnings: [] };
    if (data[0] === 0xfe && data[1] === 0xff) return { text: new TextDecoder('utf-16be', { fatal: true }).decode(data.subarray(2)), warnings: [] };
  } catch {
    throw fail('encoding', MSG.encoding);
  }
  if (data.includes(0)) throw fail('unsupported', MSG.unsupported); // BOM 없는 NUL 포함 = 바이너리
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), warnings: [] };
  } catch {
    /* UTF-8 이 아님 -> EUC-KR(CP949) 후보 검증 */
  }
  let dec;
  try {
    dec = new TextDecoder('euc-kr', { fatal: true }).decode(data);
  } catch {
    throw fail('encoding', MSG.encoding);
  }
  // 검증: 대체문자/사용자정의영역/제어문자 없음, 비ASCII 글자의 90% 이상이 한글 음절이어야 함
  if (/[\uFFFD\uE000-\uF8FF]/.test(dec) || /[\u0000-\u0008\u000E-\u001F]/.test(dec)) throw fail('encoding', MSG.encoding);
  let nonAscii = 0, hangul = 0;
  for (const ch of dec) {
    const c = ch.codePointAt(0);
    if (c > 0x7f) {
      nonAscii++;
      if (c >= 0xac00 && c <= 0xd7a3) hangul++;
    }
  }
  if (nonAscii < 2 || hangul / nonAscii < 0.9) throw fail('encoding', MSG.encoding);
  return { text: dec, warnings: ['UTF-8이 아니어서 EUC-KR(한글 ANSI)로 해석했어요. 글자가 깨지지 않았는지 확인해 주세요.'] };
}

// ───────────────────────── DOCX ─────────────────────────
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('no document'));
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('script load failed'));
    document.head.appendChild(s);
  });
}
let mammothPromise;
async function loadMammoth() {
  if (globalThis.mammoth?.extractRawText) return globalThis.mammoth; // 이미 로드됨(테스트 포함)
  mammothPromise ||= loadScript(new URL('mammoth/mammoth.browser.min.js', VENDOR).href).then(() => {
    if (!globalThis.mammoth?.extractRawText) throw new Error('mammoth missing');
    return globalThis.mammoth;
  });
  try {
    return await mammothPromise;
  } catch {
    mammothPromise = undefined;
    throw fail('engine', MSG.engine);
  }
}

async function readDocx(data, zip, deadline) {
  const warnings = [];
  const docXml = await readXmlPart(data, zip, 'word/document.xml', deadline);
  if (docXml == null) throw fail('corrupt', MSG.corrupt);
  if (/<w:txbxContent[\s>]/.test(docXml)) warnings.push('글상자 안의 글자는 빠질 수 있어요. 누락된 내용이 없는지 확인해 주세요.');
  if (/<w:del[\s>]/.test(docXml)) warnings.push('수정 내역(삭제된 글)이 있는 문서예요. 읽은 글이 원하는 최종본인지 확인해 주세요.');
  if ([...zip.byName.keys()].some((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) {
    /* 머리글/바닥글은 읽지 않는다 */
  }
  const mammoth = await loadMammoth();
  deadline();
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  let result;
  try {
    result = await mammoth.extractRawText({ arrayBuffer: ab }); // HTML 이 아닌 순수 텍스트만 반환
  } catch {
    throw fail('corrupt', MSG.corrupt);
  }
  deadline();
  warnings.push('본문 글만 읽었어요(머리글·바닥글·이미지 속 글자 제외). 표·목록이 있으면 순서를 확인해 주세요.');
  return finish(result.value || '', warnings);
}

// ───────────────────────── HWPX ─────────────────────────
function decodeXmlEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, g) => {
    if (g === 'lt') return '<';
    if (g === 'gt') return '>';
    if (g === 'amp') return '&';
    if (g === 'quot') return '"';
    if (g === 'apos') return "'";
    const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
  });
}

// HWPML 섹션 XML 에서 hp:t 글자만 순서대로 모은다. DTD/엔티티 선언이 있으면 거부(엔티티 폭탄 방지).
function hwpxSectionText(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('corrupt', MSG.corrupt);
  const re = /<(\/?)([A-Za-z0-9_.-]+:)?([A-Za-z0-9_.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let out = '';
  let tDepth = 0;
  let sawT = false;
  let m;
  while ((m = re.exec(xml))) {
    if (m[6] !== undefined) {
      if (tDepth > 0) out += decodeXmlEntities(m[6]);
      continue;
    }
    const closing = m[1] === '/';
    const selfClose = m[5] === '/';
    const local = m[3];
    if (local === 't') {
      sawT = true;
      if (closing) tDepth = Math.max(0, tDepth - 1);
      else if (!selfClose) tDepth++;
    } else if (local === 'lineBreak' && !closing) out += '\n';
    else if (local === 'tab' && !closing) out += '\t';
    else if (local === 'p' && closing) out += '\n';
    else if (local === 'tc' && closing) out += '\t';
    else if (local === 'tr' && closing) out += '\n';
  }
  return { text: out, sawT };
}

async function readHwpx(data, zip, deadline) {
  const manifest = await readXmlPart(data, zip, 'META-INF/manifest.xml', deadline);
  if (manifest && /encryption-data|manifest:encryption/i.test(manifest)) throw fail('encrypted', MSG.encrypted);
  const secs = [...zip.byName.keys()]
    .map((n) => /^Contents\/section(\d+)\.xml$/i.exec(n))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (!secs.length) throw fail('corrupt', MSG.corrupt);
  if (secs.length > LIMITS.maxHwpxSections) throw fail('zip_bomb', MSG.zipBomb);
  let all = '';
  let sawT = false;
  for (const s of secs) {
    deadline();
    const xml = await readXmlPart(data, zip, s[0], deadline);
    const r = hwpxSectionText(xml);
    sawT ||= r.sawT;
    all += r.text + '\n';
    await sleepTick();
  }
  if (!sawT) throw fail('empty_text', MSG.noText);
  return finish(all, ['HWPX는 본문 글만 읽었어요(표·글상자·머리말/꼬리말·이미지 속 글자는 순서가 달라지거나 빠질 수 있어요). 내용을 꼭 확인해 주세요.']);
}

// ───────────────────────── PDF ─────────────────────────
let pdfjsPromise;
async function loadPdfjs() {
  pdfjsPromise ||= (async () => {
    const lib = await import(new URL('pdfjs/pdf.min.mjs', VENDOR).href);
    const worker = new URL('pdfjs/pdf.worker.min.mjs', VENDOR);
    if (typeof location !== 'undefined' && location.origin && location.origin !== 'null' && worker.origin !== location.origin) {
      throw new Error('worker must be same-origin');
    }
    lib.GlobalWorkerOptions.workerSrc = worker.href;
    return lib;
  })();
  try {
    return await pdfjsPromise;
  } catch {
    pdfjsPromise = undefined;
    throw fail('engine', MSG.engine);
  }
}

async function readPdf(data, deadline) {
  // 일부 PDF 는 헤더 앞에 쓰레기 바이트가 있지만 pdf.js 가 처리한다.
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: data.slice(), // pdf.js 가 버퍼를 소유(transfer)하므로 복사본 전달
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    cMapUrl: new URL('pdfjs/cmaps/', VENDOR).href,
    cMapPacked: true,
    verbosity: 0,
  });
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      task.destroy().catch(() => {});
      rej(fail('timeout', MSG.timeout));
    }, LIMITS.timeoutMs);
  });
  const work = (async () => {
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      if (e?.name === 'PasswordException') throw fail('encrypted', MSG.encrypted);
      throw fail('corrupt', MSG.corrupt);
    }
    try {
      const perms = await doc.getPermissions().catch(() => null);
      if (Array.isArray(perms)) {
        const PF = pdfjs.PermissionFlag || {};
        const copy = PF.COPY ?? 0x10;
        const acc = PF.COPY_FOR_ACCESSIBILITY ?? 0x200;
        if (!perms.includes(copy) && !perms.includes(acc)) throw fail('copy_blocked', MSG.copyBlocked);
      }
      const n = doc.numPages;
      if (n > LIMITS.maxPdfPages) throw fail('too_many_pages', MSG.tooManyPages(n, LIMITS.maxPdfPages));
      let all = '';
      const empty = [];
      for (let i = 1; i <= n; i++) {
        deadline();
        let pageText = '';
        try {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          for (const it of tc.items) {
            if (typeof it.str !== 'string') continue;
            pageText += it.str;
            if (it.hasEOL) pageText += '\n';
          }
          page.cleanup();
        } catch (e) {
          if (e instanceof FileReaderError) throw e;
          throw fail('corrupt', MSG.corrupt); // 일부 쪽만 조용히 빠지는 일을 막기 위해 전체 실패 처리
        }
        if (!pageText.trim()) empty.push(i);
        all += pageText + '\n\n';
        if (all.length > LIMITS.maxExtractedChars * 2) throw fail('too_long', MSG.tooLong);
      }
      if (empty.length === n) throw fail('scanned', MSG.scanned);
      const bad = (all.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
      const visible = all.replace(/\s/g, '').length;
      if (visible && bad / visible > 0.05) throw fail('garbled', MSG.garbled);
      const warnings = [];
      if (empty.length) warnings.push(`${empty.join(', ')}쪽에서는 글자를 찾지 못해 비어 있어요(이미지 쪽일 수 있고, 이미지 속 글자는 읽지 않아요). 빠진 내용이 없는지 확인해 주세요.`);
      warnings.push(`PDF의 글자 층만 읽었어요(OCR 없음, 총 ${n}쪽). 단·표·머리글이 있으면 글 순서가 섞이거나 줄바꿈이 어색할 수 있으니 확인해 주세요.`);
      return finish(all, warnings);
    } finally {
      try { await doc.destroy(); } catch {}
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
    task.destroy().catch(() => {});
  }
}

// ───────────────────────── 진입점 ─────────────────────────
const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function includesUtf16(data, str) {
  const pat = [];
  for (const ch of str) pat.push(ch.charCodeAt(0), 0);
  outer: for (let i = 0; i + pat.length <= data.length; i++) {
    for (let j = 0; j < pat.length; j++) if (data[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

export async function readEssayFile(file) {
  if (!file || typeof file.size !== 'number' || typeof file.arrayBuffer !== 'function') throw fail('invalid', MSG.corrupt);
  if (file.size === 0) throw fail('empty', MSG.empty);
  if (file.size > LIMITS.maxFileBytes) throw fail('too_big', MSG.tooBig);

  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch {
    throw fail('read_failed', '파일을 읽지 못했어요. 파일이 이동/삭제되었거나 접근할 수 없는 상태일 수 있어요.');
  }
  if (buf.byteLength === 0) throw fail('empty', MSG.empty);
  if (buf.byteLength > LIMITS.maxFileBytes) throw fail('too_big', MSG.tooBig);
  const data = new Uint8Array(buf);
  const ext = extOf(file.name);
  const deadline = makeDeadline(LIMITS.timeoutMs);

  // 1) 내용 서명으로 형식을 판별한다(확장자는 보조 정보).
  if (startsWith(data, OLE_SIG)) {
    const head = data.subarray(0, Math.min(data.length, 4 * 1024 * 1024));
    if (includesUtf16(head, 'EncryptedPackage') || includesUtf16(head, 'EncryptionInfo')) throw fail('encrypted', MSG.encrypted);
    if (ext === 'hwp' || includesUtf16(head, 'HwpSummaryInformation') || includesUtf16(head, 'FileHeader')) throw fail('legacy_hwp', MSG.hwp);
    if (ext === 'doc' || ext === 'docx') throw fail('legacy_doc', MSG.doc);
    throw fail('unsupported', MSG.unsupported);
  }
  let pdfAt = -1;
  for (let i = 0; !startsWith(data, [0x50, 0x4b, 3, 4]) && i < Math.min(data.length - 4, 1024); i++) {
    if (data[i] === 0x25 && data[i + 1] === 0x50 && data[i + 2] === 0x44 && data[i + 3] === 0x46 && data[i + 4] === 0x2d) { pdfAt = i; break; }
  }
  if (pdfAt >= 0) return readPdf(data, deadline);

  if (startsWith(data, [0x50, 0x4b, 3, 4])) {
    const zip = parseZip(data);
    await verifyAllEntries(data, zip, deadline); // 실제 해제 바이트 상한·시간 검증(보관 안 함)
    const has = (n) => zip.byName.has(n);
    if (has('word/document.xml') && has('[Content_Types].xml')) return readDocx(data, zip, deadline);
    if ([...zip.byName.keys()].some((n) => /^Contents\/section\d+\.xml$/i.test(n))) return readHwpx(data, zip, deadline);
    if (has('EncryptedPackage')) throw fail('encrypted', MSG.encrypted);
    throw fail('unsupported', MSG.unsupported);
  }
  if (startsWith(data, [0x50, 0x4b, 5, 6]) || startsWith(data, [0x50, 0x4b, 7, 8])) throw fail('corrupt', MSG.corrupt);
  if (data[0] === 0x7b && data[1] === 0x5c && data[2] === 0x72 && data[3] === 0x74) throw fail('unsupported', MSG.unsupported); // RTF
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47]) || startsWith(data, [0xff, 0xd8, 0xff]) || startsWith(data, [0x47, 0x49, 0x46])) {
    throw fail('image', '이미지 파일은 읽을 수 없어요. 이 도구는 이미지 속 글자를 인식(OCR)하지 않아요. 글자를 복사해 붙여넣어 주세요.');
  }

  // 2) 나머지는 TXT 후보. 확장자나 MIME 이 텍스트일 때만.
  const mime = String(file.type || '').toLowerCase();
  const textLike = ['txt', 'text', 'md'].includes(ext) || mime === 'text/plain' || mime === 'text/markdown';
  if (!textLike) throw fail('unsupported', MSG.unsupported);
  const { text, warnings } = decodeText(data);
  return finish(text, warnings);
}
