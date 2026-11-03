@echo off
title QQ 登录守护 - 配置页
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 22 或更高版本: https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动配置页（若守护已在运行会直接打开网页）...
node "src\cli.mjs" setup
echo.
echo 配置服务已退出。
pause