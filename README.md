# 매출올려드림 AI (베타)

음식점·카페 사장님이 **상호명과 주소**만 입력하면, AI(Claude)가 인터넷에 공개된 가게 정보를 찾아 보여주고,
사장님이 "우리 가게가 맞다"고 확인하면 그 정보를 바탕으로 **맞춤 설문 10문항(5점 척도)** 을 만들어 주는 웹서비스입니다.

- 공개 주소: https://www.kkumsu.com
- 이전 버전(질문 126개 + 규칙 기반 보고서)은 GitHub 브랜치 `archive/maechul-rules-v1-20261108` 에 보관되어 있습니다.

## 화면 흐름

1. **첫 화면**: 상호명·주소 입력 → `다음`
2. **AI 가게 찾기** (`POST /api/store-search`): Claude가 웹 검색(최대 3회)으로 주소·업종·전화·영업시간·메뉴·평점·리뷰 경향·온라인 채널을 정리합니다. 30초~1분 걸립니다.
3. **맞는지 확인**: 후보가 1곳이면 `아니에요 / 네, 맞아요`, 여러 곳이면 카드마다 `이 가게가 맞아요`. AI가 참고한 출처 링크도 함께 보여줍니다.
   - `아니에요` → 입력값이 남은 첫 화면으로 돌아가고, 같은 값으로 다시 찾으면 저장된 결과 대신 새로 검색합니다.
   - 못 찾으면 `다시 입력` 또는 `정보 없이 질문 받기`.
4. **맞춤 설문** (`POST /api/survey`): 확인한 정보로 진술문 10개를 만들고, 각 문항을
   `전혀 그렇지 않다 · 그렇지 않다 · 보통이다 · 그렇다 · 매우 그렇다` 중에서 고릅니다. 한 화면에 10문항이 모두 나옵니다.
5. **완료**: 답변 요약을 보여줍니다. 답변은 서버로 보내지 않고 브라우저(localStorage)에만 저장합니다.
   다음 단계(답변을 바탕으로 한 분석 보고서)는 아직 만들지 않았습니다.

## 구조

```
api/store-search.js   가게 찾기 (Claude + openrouter:web_search 서버 도구)
api/survey.js         맞춤 설문 10문항 (Claude, 구조화 출력)
lib/ai.mjs            OpenRouter 호출, JSON 꺼내기, 비용 계산
lib/guard.mjs         같은 사이트 요청만 허용, 방문자별 횟수·하루 예산 제한, 결과 캐시(Upstash Redis)
lib/prompts.mjs       Claude 지시문과 응답 형식(JSON Schema)
lib/validate.mjs      입력 검사, AI 응답 정리(빈 값·링크·길이)
lib/mock.mjs          로컬 점검용 모의 응답 (MOCK_AI=1, 운영 배포에서는 꺼짐)
public/               화면 (index.html, app.js, styles.css, 로고)
site/                 robots.txt, sitemap.xml, 네이버·구글 소유확인 파일
scripts/build-site.mjs  public/ + site/ → dist/ (Vercel 빌드)
scripts/dev.mjs       로컬 개발 서버 (화면 + /api)
tests/api.test.mjs    서버 함수 점검 (가짜 AI·저장소 사용)
```

## 환경변수 (Vercel)

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | 예 | OpenRouter 키. 기본 모델 `anthropic/claude-sonnet-5.5` |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | 예 | Upstash Redis. 없으면 배포 환경에서 AI를 부르지 않습니다 |
| `SESSION_SECRET` | 권장 | 방문자 IP를 해시할 때 쓰는 비밀값 |
| `MAECHUL_DAILY_BUDGET_USD` | 아니오 | 하루 전체 AI 예산. 기본 **$1** |
| `MAECHUL_IP_DAILY_SEARCHES` | 아니오 | 방문자(IP)별 하루 가게 찾기 횟수. 기본 **4** |
| `MAECHUL_IP_DAILY_SURVEYS` | 아니오 | 방문자(IP)별 하루 설문 만들기 횟수. 기본 **8** |
| `MAECHUL_AI_MODEL` | 아니오 | 모델 변경 (예: `anthropic/claude-opus-5.5`) |
| `MAECHUL_SEARCH_ENGINE` | 아니오 | 웹 검색 엔진. 기본 `auto`(Claude 자체 검색). `exa` 등으로 바꿀 수 있음 |
| `MAECHUL_ALLOWED_HOSTS` | 아니오 | 같은 주소 외에 허용할 호스트(쉼표 구분) |

## 비용과 이용량 관리

- 호출 전에 최대 예상 비용(가게 찾기 $0.35, 설문 $0.08)을 하루 예산에서 잡아두고, 끝나면 OpenRouter가 알려준 실제 비용으로 정산합니다.
  응답을 못 받아 실제 비용을 모르면 잡아둔 금액을 그대로 둡니다.
- 하루 예산을 넘거나 방문자별 횟수를 넘으면 AI를 부르지 않고 안내 문구를 보여줍니다 (한국 시간 기준 날짜).
- 같은 상호명·주소, 같은 가게 정보는 3일 동안 캐시해서 다시 비용이 들지 않게 합니다.
- 다른 사이트에서 이 API를 부르지 못하게 `Origin`이 같은 주소인 요청만 받습니다.
- OpenRouter 요청에 `provider.data_collection: deny`를 넣어 학습에 쓰지 않는 제공자만 씁니다.

## 실행

```bash
npm start          # http://localhost:5180 (키가 없으면 모의 응답)
npm test           # 서버 함수 점검
npm run build      # dist/ 생성
```

실제 AI로 로컬 실행: `OPENROUTER_API_KEY=... npm start` (Redis가 없으면 메모리에서 횟수를 셉니다).

## 알려진 한계

- AI가 찾은 정보는 틀리거나 오래됐을 수 있습니다. 네이버 지도·플레이스처럼 검색에 잘 안 잡히는 정보는 빠질 수 있습니다.
- 설문 답변을 분석해 보고서를 만드는 단계는 아직 없습니다.
- 방문자 구분은 IP 기준이라 같은 와이파이의 여러 사람이 횟수를 함께 씁니다.
