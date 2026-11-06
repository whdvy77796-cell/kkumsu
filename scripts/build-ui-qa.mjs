#!/usr/bin/env node
// Local UI QA builder (synthetic data only). Usage: node scripts/build-ui-qa.mjs <output-dir>
// Reads the CURRENT files in ../public at run time and writes self-contained file:// pages:
//   index.html, terms.html, privacy.html
// Production files are never modified. The QA banner and fetch mock exist only in the output.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const out = process.argv[2];
if (!out) { console.error('Usage: node scripts/build-ui-qa.mjs <output-dir>'); process.exit(2); }
const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = name => readFileSync(join(pub, name), 'utf8');
const scriptSafe = s => s.replace(/<\/(script)/gi, '<\\/$1');
const BANNER_TEXT = '가상 데이터 화면 검증 · 실제 AI 생성·결제 아님';
const FAKE_ID = '00000000-0000-4000-8000-000000000001';

const logo = read('logo.svg');
const logoUri = 'data:image/svg+xml;base64,' + Buffer.from(logo).toString('base64');
const css = read('style.css');
const bankSrc = read('question-bank.js');
const appSrc = read('app.js');
const indexSrc = read('index.html');

if (!/^export const QUESTION_BANK\b/m.test(bankSrc)) throw new Error('question-bank.js export format changed; update build-ui-qa.mjs');
const importRe = /^import \{ ?QUESTION_BANK ?\} from '\.\/question-bank\.js';\s*$/m;
if (!importRe.test(appSrc)) throw new Error('app.js import line changed; update build-ui-qa.mjs');

// QA-only fixed scenario (?qa=facts | ?qa=facts-corrected). Synthetic constants only: no server input, no secrets.
// Appended AFTER the app's own bootstrap() call so it only overrides in-memory state S; POST requests stay blocked by the fetch mock.
const QA_SCENARIO = `
;(() => {
 const mode = new URLSearchParams(location.search).get('qa');
 if (mode !== 'facts' && mode !== 'facts-corrected') return;
 const ans = (id, question, answer) => ({id, question, answer});
 const fact = (id, kind, text, quote, answerId) => ({id, kind, text, originalText: text, edited: false, included: true, quote, answerId});
 S.view = 'review';
 S.answers = [
  ans('q6', '[가상] 상황과 행동', '[가상 답변] 카페에서 음료가 다르다는 손님에게 메뉴를 다시 묻고 영수증과 컵 라벨을 비교했습니다.'),
  ans('q7', '[가상] 판단과 역할', '[가상 답변] 기억만으로 단정하지 않으려고 확인했고, 차이를 매니저에게 전달하는 역할을 했습니다.'),
  ans('q8', '[가상] 실제 결과', '[가상 답변] 담당 직원이 음료를 다시 만들었습니다. 저는 제조하지 않았고 수치로 기록한 성과는 없습니다.'),
  ans('q9', '[가상] 긴 단어 줄바꿈 점검', '[가상 답변] 긴문자열점검_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz_https://example.invalid/가상/아주/긴/경로/줄바꿈/검증')
 ];
 S.facts = {readiness: 'ready', missing: [], facts: [
  fact('f1', 'fact', '[가상] 음료가 다르다는 손님에게 메뉴를 다시 묻고 영수증과 컵 라벨을 비교했다.', '카페에서 음료가 다르다는 손님에게 메뉴를 다시 묻고 영수증과 컵 라벨을 비교했습니다.', 'q6'),
  fact('f2', 'fact', '[가상] 기억으로 단정하지 않으려 확인했고 차이를 매니저에게 전달했다.', '기억만으로 단정하지 않으려고 확인했고, 차이를 매니저에게 전달하는 역할을 했습니다.', 'q7'),
  fact('f3', 'fact', '[가상] 음료 재제조는 다른 직원이 했고 본인의 수치 성과는 없다.', '담당 직원이 음료를 다시 만들었습니다. 저는 제조하지 않았고 수치로 기록한 성과는 없습니다.', 'q8'),
  fact('f4', 'interpretation', '[가상 AI 해석] 불확실한 상황에서 기억보다 확인 가능한 기록을 먼저 확인하는 태도를 보였다.', '기억만으로 단정하지 않으려고 확인했고', 'q7'),
  fact('f5', 'interpretation', '[가상 AI 해석] 긴문자열점검_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz_https://example.invalid/가상/아주/긴/경로/줄바꿈/검증', '긴문자열점검', 'q9')
 ]};
 if (mode === 'facts-corrected') {
  const f = S.facts.facts;
  f[1].text = '[가상 사용자 정정] 차이를 확인한 뒤 매니저에게 정확히 전달했다.'; f[1].edited = true;
  f[3].included = false;
  S.excluded = '[가상] 학교 이름과 과장된 표현은 빼주세요.';
 }
 S.consent = true; /* earlier interview-stage consent, as a real user reaching this step would have */ S.finalConsent = false; S.verified = false; S.previewDisclosureAccepted = false;
 render();
 // checkStatus() of the app finishes after this and only re-renders on home; refresh once so provider/payment notice reflect the mocked status (no user edits can exist yet).
 setTimeout(() => { if (S.view === 'review' && !S.edited && !S.finalConsent) render(); }, 600);
})();
`;
// Single combined module: question bank (export stripped) + app (import removed, QA-only link rewrites).
const combined = bankSrc.replace(/^export const QUESTION_BANK\b/m, 'const QUESTION_BANK')
  + '\n' + appSrc.replace(importRe, '')
    .replaceAll('"/terms.html"', '"./terms.html"').replaceAll('"/privacy.html"', '"./privacy.html"')
    .replaceAll('/logo.svg', logoUri)
  + '\n' + QA_SCENARIO;

const mock = `(() => {
 const FAKE_ID = ${JSON.stringify(FAKE_ID)};
 const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
 const status = {ready: true, freeAvailable: true, paymentReady: false, paymentMode: 'disabled',
  paymentDisabledReason: '[가상 데이터] 화면 검증용이라 결제를 받지 않습니다.', provider: {name: '가상 검증(실제 AI 아님)'}, model: '가상 모델(검증용)', latestResultId: FAKE_ID, paymentLegal: {}};
 const seg = (kind, text, lines) => kind === 'visible' ? {kind, text} : {kind, lines};
 const result = {resultId: FAKE_ID, access: 'preview', note: '[가상 데이터] 실제 AI가 만든 글이 아닙니다.',
  purchase: {ready: false, mode: 'disabled', disabledReason: '[가상 데이터] 화면 검증용이라 결제를 받지 않습니다.'},
  quality: {checks: [{label: '[가상] 사실 확인', status: 'pass'}, {label: '[가상] 문항 적합성', status: 'warn'}]},
  sections: [{id: 's1', heading: '[가상 예시] 지원 동기', charCount: 480, charLimit: 500,
   segments: [seg('visible', '[가상 예시 문장] 이 화면은 레이아웃 검증용 합성 데이터입니다.'), seg('locked', null, 4), seg('visible', '[가상 예시 문장] 잠긴 영역은 글이 아닌 자리표시자입니다.')]}]};
 const real = window.fetch.bind(window);
 window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = String(init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  if (/\\/api\\//.test(url)) {
   if (method !== 'GET') return json({error: '가상 데이터 화면 검증 중에는 실제 AI 생성·결제·삭제 요청을 보내지 않습니다.', code: 'QA_MOCK_BLOCKED', retryable: false}, 403);
   if (/\\/api\\/insosoe(\\?|$)/.test(url)) return json(status);
   if (/\\/api\\/payment(\\?|$)/.test(url)) return json({result});
   return json({error: 'QA_MOCK_NOT_FOUND'}, 404);
  }
  if (/^https?:/i.test(url)) return json({error: 'QA_MOCK_EXTERNAL_BLOCKED'}, 403);
  return real(input, init);
 };
 document.addEventListener('DOMContentLoaded', () => {
  const b = document.createElement('div');
  b.id = 'qa-banner'; b.setAttribute('role', 'note');
  b.textContent = ${JSON.stringify(BANNER_TEXT)};
  b.style.cssText = 'position:sticky;top:0;z-index:2147483000;background:#b00020;color:#fff;font:900 clamp(18px,4.5vw,30px)/1.3 sans-serif;text-align:center;padding:14px 12px;border-bottom:6px solid #ffd600;letter-spacing:0';
  document.body.prepend(b);
 });
})();`;

const head = (title) => `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${css}</style><script>${scriptSafe(mock)}</script>`;

// index: reuse the CURRENT production body markup; only replace the head (css/script inlined).
const bodyMatch = indexSrc.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('index.html body not found');
const indexOut = `<!doctype html><html lang="ko"><head>${head('[QA 가상 데이터] 인소서')}<script type="module">${scriptSafe(combined)}</script></head><body>${bodyMatch[1]}</body></html>`;

function policy(name) {
  let h = read(name);
  const js = read('policy.js');
  h = h.replace(/<link[^>]*rel="stylesheet"[^>]*>/i, '')
       .replace(/<link[^>]*rel="icon"[^>]*>/i, '')
       .replace(/<script[^>]*src="\/policy\.js"[^>]*><\/script>/i, '')
       .replace('</head>', `${head('[QA 가상 데이터] ' + name)}<script type="module">${scriptSafe(js)}</script></head>`)
       .replaceAll('href="/terms.html', 'href="./terms.html').replaceAll('href="/privacy.html', 'href="./privacy.html')
       .replaceAll('href="/"', 'href="./index.html"').replaceAll('/logo.svg', logoUri);
  if (!h.includes('qa-banner') && !h.includes('가상 데이터')) throw new Error('policy injection failed for ' + name);
  return h;
}

const dir = resolve(out);
mkdirSync(dir, {recursive: true});
const files = {'index.html': indexOut, 'terms.html': policy('terms.html'), 'privacy.html': policy('privacy.html')};
for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 12);
console.log('QA build written to ' + dir);
for (const n of ['index.html', 'style.css', 'question-bank.js', 'app.js', 'policy.js']) console.log('  source ' + n + ' sha256:' + sha(read(n)));
for (const n of Object.keys(files)) console.log('  output ' + n + ' (' + files[n].length + ' chars)');
