// 실제 브라우저 시험용 로컬 서버 (수동 실행): node tests/file-reader-browser-server.mjs [port]
// public/ 를 서빙하고, 운영(vercel.json)과 같은 CSP 를 적용한 뒤 /__harness 에서 가상 파일 시험을 돌린다.
// 가상 파일 생성기만 사용하며 외부 네트워크 접근은 없다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, makeDocx, makeHwpx, makeAsciiPdf, makeKoreanPdf, SAMPLE_KO } from './file-reader-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const port = Number(process.argv[2] || 8123);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const fixtures = {
  'utf8.txt': Buffer.from(SAMPLE_KO),
  'euckr.txt': Buffer.from([0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9, 0xb6, 0xf3, 0xb8, 0xb6, 0xb9, 0xd9, 0xbb, 0xe7, 0xbe, 0xc6, 0xc0, 0xda, 0xc7, 0xcf]),
  'long.txt': Buffer.from('가'.repeat(6200)),
  'a.docx': makeDocx([SAMPLE_KO, '두 번째 문단']),
  'a.hwpx': makeHwpx([SAMPLE_KO, '둘째 문단']),
  'ascii.pdf': makeAsciiPdf(['Synthetic applicant sentence', 'Second page text']),
  'korean.pdf': makeKoreanPdf('가상한글문장입니다'),
  'scanned.pdf': makeAsciiPdf(['']),
  'enc.pdf': makeAsciiPdf(['x'], { encrypt: true }),
  'bomb.docx': makeZip({ '[Content_Types].xml': '<x/>', 'word/document.xml': '<d/>' }, { lieUsize: { 'word/document.xml': 99999999 } }),
  'old.hwp': Buffer.concat([ole, Buffer.from('FileHeader', 'utf16le'), Buffer.alloc(64)]),
  'enc.docx': Buffer.concat([ole, Buffer.from('EncryptedPackage', 'utf16le'), Buffer.alloc(64)]),
};
const harnessJs = `
import { readEssayFile } from '/file-reader.mjs';
const out = {};
for (const name of ${JSON.stringify(Object.keys(fixtures))}) {
  const buf = await (await fetch('/__fixture/' + name)).arrayBuffer();
  try { const r = await readEssayFile(new File([buf], name)); out[name] = { ok: true, text: r.text.slice(0, 60), len: r.text.length, warnings: r.warnings }; }
  catch (e) { out[name] = { ok: false, code: e.code, message: e.message }; }
}
out.__resources = performance.getEntriesByType('resource').map((x) => x.name).filter((n) => !n.includes('/__fixture/'));
out.__origins = [...new Set(performance.getEntriesByType('resource').map((x) => new URL(x.name).origin))];
document.getElementById('out').textContent = JSON.stringify(out, null, 1);
document.title = 'done';
`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.bcmap': 'application/octet-stream', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const h = { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__harness') { res.writeHead(200, { ...h, 'Content-Type': 'text/html' }); return res.end('<!doctype html><meta charset="utf-8"><pre id="out">running</pre><script type="module" src="/__harness.js"></script>'); }
  if (url.pathname === '/__harness.js') { res.writeHead(200, { ...h, 'Content-Type': 'text/javascript' }); return res.end(harnessJs); }
  if (url.pathname.startsWith('/__fixture/')) { const b = fixtures[decodeURIComponent(url.pathname.slice(11))]; if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200, { ...h, 'Content-Type': 'application/octet-stream' }); return res.end(b); }
  const file = path.join(root, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, h); return res.end('not found'); }
  res.writeHead(200, { ...h, 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('listening http://127.0.0.1:' + port + '/__harness'));
