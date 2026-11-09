// 배포용 정적 파일을 dist/ 에 모은다. Vercel이 `npm run build`로 실행한다.
// api/ 폴더의 서버 함수는 Vercel이 따로 배포한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { payConfig, publicPay } from '../lib/pay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });
for (const dir of ['public', 'site']) {
  // 하위 폴더(예: public/vendor)까지 그대로 복사한다
  await fs.cp(path.join(ROOT, dir), DIST, { recursive: true });
}
// 결제 설정: 서버(api/pay.js)와 같은 규칙으로 이 배포의 결제 모드를 정해 화면에 넘긴다 (공개 값만, 시크릿 키는 절대 안 씀)
const pay = publicPay(payConfig(process.env));
await fs.writeFile(
  path.join(DIST, 'pay-config.js'),
  `// 배포 때 자동으로 만든 파일 (scripts/build-site.mjs)\nexport const PAY = ${JSON.stringify(pay)};\n`,
);
console.log(`결제 모드: ${pay.mode} · ${pay.amount}원 (정가 ${pay.list}원)`);
console.log(`배포 파일: ${(await fs.readdir(DIST)).join(', ')}`);