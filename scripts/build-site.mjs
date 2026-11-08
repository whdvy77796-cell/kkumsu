// 배포용 정적 파일을 dist/ 에 모은다. Vercel이 `npm run build`로 실행한다.
// api/ 폴더의 서버 함수는 Vercel이 따로 배포한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });
for (const dir of ['public', 'site']) {
  for (const f of await fs.readdir(path.join(ROOT, dir))) {
    await fs.copyFile(path.join(ROOT, dir, f), path.join(DIST, f));
  }
}
console.log(`배포 파일: ${(await fs.readdir(DIST)).join(', ')}`);
