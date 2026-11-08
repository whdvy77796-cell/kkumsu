// 로컬 개발 서버: 화면(public/, site/)과 /api/* 를 함께 띄운다.
// OPENROUTER_API_KEY가 없으면 모의 응답(MOCK_AI=1)으로 동작한다.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5180);
if (!process.env.OPENROUTER_API_KEY && process.env.MOCK_AI === undefined) process.env.MOCK_AI = '1';

const routes = {
  '/api/store-search': (await import('../api/store-search.js')).default,
  '/api/report': (await import('../api/report.js')).default,
  '/api/research': (await import('../api/research.js')).default,
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (routes[url.pathname]) return routes[url.pathname](req, res);
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  for (const dir of ['public', 'site']) {
    const base = path.join(ROOT, dir);
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep)) continue;
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch { /* 다음 폴더 */ }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('찾을 수 없어요');
});
server.listen(PORT, () => {
  console.log(`매출올려드림 AI: http://localhost:${PORT}  (AI: ${process.env.MOCK_AI === '1' ? '모의 응답' : 'OpenRouter 실제 호출'})`);
});
