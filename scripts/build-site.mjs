// 공개 사이트(www.kkumsu.com) 배포용 빌드: dist/ 에 단일 HTML과 검색엔진 파일을 만든다.
// Vercel이 `npm run build`로 실행하고 dist/를 그대로 배포한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStandalone } from './build-standalone.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SITE_URL = process.env.SITE_URL || 'https://www.kkumsu.com';

await fs.rm(DIST, { recursive: true, force: true });
await buildStandalone(path.join(DIST, 'index.html'), {
  siteUrl: SITE_URL,
  title: '매출올려드림 AI · 음식점·카페 가게 진단',
  assetsDir: DIST,
});
for (const f of await fs.readdir(path.join(ROOT, 'site'))) {
  await fs.copyFile(path.join(ROOT, 'site', f), path.join(DIST, f));
}
console.log(`배포 파일: ${(await fs.readdir(DIST)).join(', ')}`);
