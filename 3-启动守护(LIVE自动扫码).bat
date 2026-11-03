@echo off
title QQ 登录守护（LIVE 自动扫码）
cd /d "%~dp0"
echo ============================================================
echo  警告: 这是 LIVE 模式，掉线时会真的重启 NapCat 并自动扫码。
echo  请先确认: 1) doctor 全绿  2) rehearse 全绿  3) 已停掉旧守护 guard.mjs
echo ============================================================
set /p ok=确认继续? 输入 Y 回车:
if /i not "%ok%"=="Y" (
  echo 已取消。
  pause
  exit /b 0
)
node "src\cli.mjs" run --mode attach --live
pause