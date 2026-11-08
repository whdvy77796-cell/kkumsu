@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 매출올려드림 AI 로컬 실행 (OPENROUTER_API_KEY가 없으면 모의 응답으로 동작)
start "" http://localhost:5180
node scripts\dev.mjs
pause
