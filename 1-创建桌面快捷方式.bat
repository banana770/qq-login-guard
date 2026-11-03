@echo off
title QQ 登录守护 - 创建桌面快捷方式
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22+。
  pause
  exit /b 1
)
node "scripts\create-desktop-shortcut.mjs"
echo.
pause