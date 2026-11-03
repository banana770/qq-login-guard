@echo off
title QQ 登录守护（dry-run 观察模式）
cd /d "%~dp0"
node "src\cli.mjs" run --mode attach
pause