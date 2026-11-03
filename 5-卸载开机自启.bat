@echo off
title QQ 登录守护 - 卸载开机自启
cd /d "%~dp0"
node "scripts\uninstall-autostart.mjs"
echo.
pause