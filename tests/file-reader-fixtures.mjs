// file-reader 시험용 "가상" 파일 생성기. 실제 사용자 자료는 절대 쓰지 않는다.
import zlib from 'node:zlib';

const te = new TextEncoder();
export const SAMPLE_KO = '가상 지원자의 테스트 문장입니다. 저는 동아리에서 행사 안내문을 정리했습니다.';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 최소 ZIP 작성기. opts: { store:true, flags, lieUsize:{name:size}, lieMethod }
export function makeZip(files, opts = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const store = opts.store || raw.length === 0;
    const comp = store ? raw : zlib.deflateRawSync(raw);
    const nm = Buffer.from(name, 'utf8');
    const flags = opts.flags ?? 0x800;
    const usize = opts.lieUsize?.[name] ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(nm.length, 26);
    const entry = Buffer.concat([lh, nm, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nm]));
    locals.push(entry);
    offset += entry.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function makeDocx(paragraphs, { extraBody = '' } = {}) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('') + extraBody;
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

export function makeHwpx(paragraphs, { manifest, section = null, extra = {} } = {}) {
  const ps = paragraphs.map((p) => `<hp:p id="0"><hp:run charPrIDRef="0"><hp:t>${esc(p)}</hp:t></hp:run></hp:p>`).join('');
  const files = {
    mimetype: 'application/hwp+zip',
    'version.xml': '<?xml version="1.0" encoding="UTF-8"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version"/>',
    'Contents/section0.xml': section ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${ps}</hs:sec>`,
    ...extra,
  };
  if (manifest) files['META-INF/manifest.xml'] = manifest;
  return makeZip(files);
}

// ── PDF ──
function buildPdf(objs, trailerExtra = '') {
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const stream = (s) => `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`;

// pages: 각 쪽의 ASCII 문자열(빈 문자열 = 글자 없는 쪽). 
export function makeAsciiPdf(pages, { encrypt = false } = {}) {
  const n = pages.length;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Placeholder true >>',
  ];
  pages.forEach((t, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    const content = t ? `BT /F1 14 Tf 72 700 Td (${t.replace(/[()\\]/g, '')}) Tj ET` : '';
    objs.push(stream(content));
  });
  const enc = encrypt
    ? ' /Encrypt << /Filter /Standard /V 1 /R 2 /O (' + 'A'.repeat(32) + ') /U (' + 'B'.repeat(32) + ') /P -44 >> /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]'
    : '';
  return buildPdf(objs, enc);
}

// 한글 PDF: 글꼴 미내장 Type0(Identity-H) + ToUnicode 로 글자 매핑. 글자별 CID 를 1..N 으로 부여.
export function makeKoreanPdf(str) {
  const chars = [...new Set([...str])];
  const cid = new Map(chars.map((c, i) => [c, i + 1]));
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  const bf = chars.map((c) => `<${hex(cid.get(c))}> <${hex(c.codePointAt(0))}>`);
  const tounicode = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${bf.length} beginbfchar ${bf.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const shown = [...str].map((c) => hex(cid.get(c))).join('');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /TestSans /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>',
    stream(tounicode),
    stream(`BT /F1 14 Tf 72 700 Td <${shown}> Tj ET`),
  ];
  return buildPdf(objs);
}
