@echo off
chcp 65001 > nul
cd /d "%~dp0"
where node > nul 2> nul
if errorlevel 1 (
  echo Node.js가 필요해요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo 설치 없이 보려면 상위 폴더의 "매출올려드림AI_체험판.html"을 여세요.
  pause
  exit /b 1
)
echo 매출올려드림 AI 서버를 시작합니다. 잠시 후 브라우저에서 http://127.0.0.1:5180 이 열려요. (종료: Ctrl+C)
start "" cmd /c "timeout /t 2 > nul & start http://127.0.0.1:5180"
node server\server.js
pause
