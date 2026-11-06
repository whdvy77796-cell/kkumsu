# public/vendor : 자체 호스팅 서드파티 파일 (수정 없이 원본 그대로)

모두 npm 공식 레지스트리의 공식 tarball 에서 가져왔고, tarball 의 SHA-1(npm `shasum`)을 레지스트리 값과 대조했다.
런타임에 외부 URL을 요청하지 않는다(CDN/원격 워커 없음).

## PDF.js (pdfjs-dist) 6.5.438 : Apache-2.0
- 출처: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz (소스 저장소 https://github.com/mozilla/pdf.js)
- tarball sha1   : e7f8986ec4ea04057b5d9d2f0e5b63ea94d2303f
- tarball sha512 : sha512-vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==
- 포함 파일(package/build/ 및 package/cmaps/ 에서 복사):
  - pdfjs/pdf.min.mjs            sha256 3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440 (474,284 B)
  - pdfjs/pdf.worker.min.mjs     sha256 1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa (1,271,915 B)
  - pdfjs/cmaps/                 한국어 관련 CMap 만(KSC*, UniKS*, Adobe-Korea1*) + cmaps/LICENSE (Adobe CMap 라이선스)
  - pdfjs/LICENSE (Apache-2.0)   sha256 0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594
  - pdfjs/package.json (버전·라이선스 표기용)

## mammoth 1.13.0 : BSD-2-Clause
- 출처: https://registry.npmjs.org/mammoth/-/mammoth-1.13.0.tgz (소스 저장소 https://github.com/mwilliamson/mammoth.js)
- tarball sha1   : c054d53bfe4f47ca4713f2e9af93abf5b10bd1f2
- tarball sha512 : sha512-2cawcYFcP7ISfXbBcL9lmVgTNWo88v/52ND1gnywHtVT/pX0//puPnf0iMPV9ZgmuvNOE+zkIhDgZ9M2c2dDDg==
- 포함 파일(package/ 에서 복사):
  - mammoth/mammoth.browser.min.js sha256 92914a3708cfdf1e62cb553d1856a7fedab21da83d8ee82845de2f897b368cab (405,060 B)
  - mammoth/LICENSE                 sha256 6663bbd049205d38a496ccacb412a151980b444627d38de218b3b809aef330f1
  - mammoth/package.json
  - mammoth/THIRD_PARTY_LICENSES.txt  (번들 의존성 고지. 이 폴더에서 작성한 파일이며 원본 tarball 에는 없음. 아래 "서드파티 고지 근거와 한계" 참조)

### mammoth 서드파티 고지 근거와 한계
- 근거: 공식 tarball 의 비압축 번들 `mammoth.browser.js` 안의 `// Module: 이름@버전` / `// License:` 헤더 13개. 모듈: @xmldom/xmldom 0.8.6(MIT), base64-js 1.5.1(MIT), buffer 4.9.1(MIT), dingbat-to-unicode 1.0.2(BSD-2-Clause), ieee754 1.1.8(BSD-3-Clause), isarray 1.0.0(MIT), jszip 3.7.1(MIT OR GPL-3.0-or-later, MIT 선택), lop 0.4.2(BSD-2-Clause), mammoth 1.13.0(BSD-2-Clause), option 0.2.4(BSD-2-Clause), process 0.11.9(MIT), underscore 1.13.1(MIT), xmlbuilder 10.0.0(MIT).
- 라이선스 원문은 위 각 정확한 버전의 npm 공식 tarball 에서 그대로 복사했고 tarball SHA-1 을 npm 레지스트리 값과 대조했다.
- 미확인: 실제 배포하는 `mammoth.browser.min.js` 가 위 비압축 번들과 바이트/모듈 단위로 동일한 빌드라는 증명(소스맵·바이트 일치 확인 없음). 같은 패키지·릴리스라 일치할 가능성이 높다는 추정일 뿐이다.
- jszip 이 자체 번들에 포함할 수 있는 하위 패키지(pako, lie, immediate, readable-stream 등 12개)는 npm tarball 에 락파일이 없어 GitHub `Stuk/jszip` 의 `v3.7.1` 태그 package-lock.json 기준 버전으로 고지에 포함했다(PART B). 해당 dist 가 정확히 그 버전으로 빌드됐는지, 실제로 어떤 것이 포함됐는지는 미확인이다. string_decoder 는 락파일의 0.10.31 과 readable-stream 2.3.6 이 요구하는 ~1.1.1 의 1.1.1 을 둘 다 넣었다.
- 원문이 없는 항목: isarray 1.0.0 은 LICENSE 파일이 없어 README 의 License 절을 사용했고, set-immediate-shim 1.0.1 은 전문이 없고 package.json/readme 에 "MIT © Sindre Sorhus" 표기만 있어 전문을 만들어 넣지 않았다.
- pako 1.0.5: LICENSE 파일에는 MIT 만 있고 package.json 은 "(MIT AND Zlib)" 이다. zlib 라이선스 조건은 원본의 `lib/zlib/*.js` 소스 헤더에만 있어 그 헤더(zstream.js)를 그대로 인용해 넣었다.
- 이 고지는 최선의 정리이며 법률 자문이 아니다. 공개 전 다시 검토할 것.

## 업데이트 방법
새 버전의 tarball 을 같은 방식으로 받아 sha1/sha512 를 대조하고 위 파일을 교체한 뒤 `node --test tests/file-reader.test.mjs` 를 다시 실행한다.
