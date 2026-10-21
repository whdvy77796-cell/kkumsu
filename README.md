# 꿈수 신당

한국식 꿈 해몽과 로또 번호 추천 사이트입니다. 무당·당산나무·한옥 컨셉이고, 한국 모바일 사용자를 대상으로 합니다.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 사이트 전체 화면 (해몽, 꿈 일기, 당첨번호 카드, 이미지 저장) |
| `api/dream.js` | Vercel 서버리스 함수: Gemini AI 해몽 + 번호 풀이 (API 키는 여기서만 사용) |
| `api/lotto.js` | Vercel 서버리스 함수: 당첨번호 중계 API (1시간 캐시) |
| `vercel.json` | 함수 실행 지역을 서울(`icn1`)로 지정 |
| `package.json` | Vercel용 기본 설정 |
| `cloudflare-worker.js` | (선택) GitHub Pages를 계속 쓸 때 중계 API만 Cloudflare에 올리는 코드 |

## AI 해몽 (Gemini)

- 화면은 `/api/dream`만 부르고, API 키는 Vercel 환경변수에만 둡니다. **index.html이나 GitHub에 키를 넣지 마세요.**
- 번호는 화면에서 무작위로 뽑고, AI는 해몽과 번호마다의 풀이만 씁니다.
- AI가 응답하지 않으면(키 없음, 한도 초과, 오류) 내장 해몽 사전으로 자동으로 풀어 줍니다. 사이트가 멈추지 않아요.
- 해몽 말투와 풀이 방식은 `api/dream.js` 맨 위 `SYSTEM` 글을 고치면 바뀝니다.

### 환경변수 (Vercel → 프로젝트 → Settings → Environment Variables)
| 이름 | 값 | 필수 |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio에서 만든 키 | 필수 |
| `GEMINI_MODEL` | 기본 `gemini-2.5-flash`. 더 저렴하게: `gemini-2.5-flash-lite` | 선택 |
| `RATE_PER_HOUR` | 한 사람이 1시간에 쓸 수 있는 횟수, 기본 20 | 선택 |
| `ALLOWED_ORIGINS` | GitHub Pages 등 다른 주소에서 부를 때 그 주소 (예: `https://아이디.github.io`) | 선택 |

환경변수를 넣거나 바꾼 뒤에는 Deployments → 맨 위 배포 → Redeploy를 해야 적용됩니다.

## 당첨번호 데이터

- 예전 주소 `common.do?method=getLottoNumber`는 동행복권 사이트 개편 후 JSON 대신 메인 페이지로 넘어갑니다.
- 그래서 중계 API는 공식 `https://www.dhlottery.co.kr/lt645/selectPstLt645Info.do?srchLtEpsd=all`을 1순위로 씁니다. 전 회차를 한 번에 받아 1시간 동안 들고 있습니다.
- 공식 주소가 막히면 공개 JSON(`https://smok95.github.io/lotto/results/{회차}.json`)을 씁니다.
- 동행복권은 해외 IP를 막는 경우가 있어서 Vercel 함수 지역을 서울로 지정했습니다.
- 화면은 중계 API가 없거나 실패하면 공개 JSON을 브라우저에서 바로 읽습니다. 그래서 GitHub Pages에 `index.html`만 올려도 당첨번호 카드가 동작합니다.

## 배포

### A. Vercel (권장: 공식 데이터 중계까지 동작)
1. 이 폴더를 GitHub 저장소에 올립니다.
2. vercel.com → Add New Project → 저장소 선택 → Deploy.
3. 환경변수 `GEMINI_API_KEY`를 넣고 Redeploy 합니다.

### B. GitHub Pages 그대로
- `index.html`만 올려도 동작합니다. 당첨번호는 공개 JSON에서 읽습니다.
- 공식 데이터를 쓰고 싶으면 `api/lotto.js`만 Vercel에 배포하거나 `cloudflare-worker.js`를 Cloudflare Workers에 배포하세요. 그다음 `index.html`의 `LOTTO_API`를 그 주소로 바꿉니다.

### 공통 설정 (index.html 맨 아래 스크립트 첫 부분)
- `LOTTO_API`: 중계 API 주소. Vercel이면 그대로 `/api/lotto`.
- `SITE_URL`: 이미지 카드 하단에 넣을 주소. 비우면 접속한 주소를 씁니다. 도메인을 샀다면 넣으세요.

## 저장 데이터 (브라우저 localStorage)
- `kkumsu_diary_v1`: 꿈 일기 (최대 200개)
- `kkumsu_draws_v1`: 추첨이 끝난 회차의 당첨번호 캐시 (최근 80회)
