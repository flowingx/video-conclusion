@echo off
chcp 65001 >nul
title Leanin 本地版
cd /d %~dp0
rem 把 Git 自带的 openssl 加入 PATH（用于生成 HTTPS 证书，供 GitHub Pages 前端调用）
if exist "C:\Program Files\Git\mingw64\bin" set "PATH=C:\Program Files\Git\mingw64\bin;%PATH%"
if exist "C:\Program Files\Git\usr\bin" set "PATH=C:\Program Files\Git\usr\bin;%PATH%"
echo.
echo   正在启动 Leanin 本地版...
echo   本机访问      http://127.0.0.1:5218
echo   HTTPS 端口    https://127.0.0.1:5219  （GitHub Pages 前端用）
echo   关闭此窗口即退出服务
echo.
node server.js
pause
