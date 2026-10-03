@echo off
chcp 65001 >nul
title 洛谷刷题本
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo   正在启动「洛谷刷题本」...
echo   浏览器会自动打开；关闭这个窗口即停止服务。
echo.

node server.mjs --open

echo.
echo   服务已停止。
pause
exit /b 0

:NONODE
echo.
echo   [错误] 没有找到 Node.js。
echo   请先安装 Node.js 20 或更高版本：https://nodejs.org/
echo.
pause
exit /b 1
