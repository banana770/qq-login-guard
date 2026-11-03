@echo off
title QQ 登录守护 - 安装开机自启
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22+。
  pause
  exit /b 1
)
echo ============================================================
echo  选择开机自启模式（登录 Windows 后自动启动守护）
echo    1 = dry-run 只观察，不重启不扫码   [默认]
echo    2 = LIVE    掉线时自动重启 NapCat 并扫码
echo    3 = embed   由守护拉起 NapCat（"随 NapCat 启动"）
echo ============================================================
set /p mode=请输入 1/2/3 后回车:
set ARG=--mode attach
if "%mode%"=="2" set ARG=--mode attach --live
if "%mode%"=="3" set ARG=--mode embed
node "scripts\install-autostart.mjs" %ARG%
echo.
pause