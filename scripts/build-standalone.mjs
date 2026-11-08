// 설치 없이 열어보는 체험판(단일 HTML) 만들기: node scripts/build-standalone.mjs [출력 경로]
// 모든 모듈을 하나의 스크립트로 묶고, 서버 대신 브라우저 저장소(public/local-backend.js)를 사용한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = [
  'shared/format.js', 'shared/benchmarks.js', 'shared/questions.js', 'shared/external.js', 'shared/engine.js',
  'shared/calc.js', 'shared/diagnose.js', 'shared/samples.js', 'shared/casekit.js', 'server/csv.js',
  'public/ui.js', 'public/fields.js', 'public/report.js', 'public/screens.js', 'public/local-backend.js', 'public/app.js',
];

function resolveSpec(fromKey, spec) {
  if (spec.startsWith('/')) return spec.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), spec));
}

function transform(key, src) {
  const exportsList = [];
  let out = src.replace(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm, (m, names, spec) => {
    const target = resolveSpec(key, spec);
    if (!ORDER.includes(target)) throw new Error(`알 수 없는 import: ${spec} (${key})`);
    if (ORDER.indexOf(target) > ORDER.indexOf(key)) throw new Error(`순서 오류: ${key}가 ${target}보다 먼저 와요`);
    const binds = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${a.trim()}: ${b.trim()}` : a.trim(); });
    return `const { ${binds.join(', ')} } = __m[${JSON.stringify(target)}];`;
  });
  out = out.replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (m, names) => {
    for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) { const [a, b] = n.split(/\s+as\s+/); exportsList.push(b ? `${b.trim()}: ${a.trim()}` : a.trim()); }
    return '';
  });
  out = out.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (m, kind, name) => { exportsList.push(name); return `${kind} ${name}`; });
  if (/^\s*(import|export)\s/m.test(out)) throw new Error(`변환되지 않은 import/export: ${key}`);
  return `__m[${JSON.stringify(key)}] = (() => {\n${out}\nreturn { ${exportsList.join(', ')} };\n})();\n`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// outPath: 만들 HTML 경로. opts.siteUrl이 있으면 공개 사이트용 제목·canonical·공유 미리보기 태그를 넣는다.
export async function buildStandalone(outPath, opts = {}) {
  let bundle = 'const __m = {};\n';
  for (const key of ORDER) bundle += `// ── ${key}\n` + transform(key, await fs.readFile(path.join(ROOT, key), 'utf8'));
  bundle = bundle.replace(/<\/script/gi, '<\\/script');
  const css = await fs.readFile(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  let html = await fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const rep = (from, to) => { if (!html.includes(from)) throw new Error(`index.html에서 찾지 못함: ${from}`); html = html.replace(from, () => to); };
  const repAll = (from, to) => { if (!html.includes(from)) throw new Error(`index.html에서 찾지 못함: ${from}`); html = html.split(from).join(to); };
  rep('<link rel="stylesheet" href="/styles.css">', `<style>\n${css}\n</style>`);
  // 로고·아이콘: 배포 폴더가 있으면 파일로 복사하고, 없으면(단일 파일 체험판) HTML 안에 넣는다
  for (const name of ['logo.png', 'icon.png']) {
    const file = path.join(ROOT, 'public', name);
    if (opts.assetsDir) {
      await fs.mkdir(opts.assetsDir, { recursive: true });
      await fs.copyFile(file, path.join(opts.assetsDir, name));
    } else {
      repAll(`"/${name}"`, `"data:image/png;base64,${(await fs.readFile(file)).toString('base64')}"`);
    }
  }
  if (opts.siteUrl) {
    const url = opts.siteUrl.replace(/\/+$/, '') + '/';
    const title = opts.title || '매출올려드림 AI';
    const desc = opts.description || '가게에 대한 질문에 답하면, 수익 구조부터 메뉴·마케팅·운영까지 분석해 맞춤 보고서와 실행 전략을 제안합니다.';
    rep('<title>매출올려드림 AI</title>', [
      `<title>${esc(title)}</title>`,
      `<link rel="canonical" href="${esc(url)}">`,
      '<meta property="og:type" content="website">',
      `<meta property="og:site_name" content="매출올려드림 AI">`,
      `<meta property="og:title" content="${esc(title)}">`,
      `<meta property="og:description" content="${esc(desc)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      '<meta name="twitter:card" content="summary">',
    ].join('\n  '));
  } else {
    rep('<title>매출올려드림 AI</title>', '<title>매출올려드림 AI (체험판)</title>');
  }
  rep('<script type="module" src="/app.js"></script>', `<script>\n"use strict";\n(() => {\n${bundle}\n})();\n</script>`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html);
  console.log(`체험판 생성: ${outPath} (${Math.round(html.length / 1024)}KB)`);
  return outPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStandalone(path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'standalone.html')));
}