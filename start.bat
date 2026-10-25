@echo off
title Leanin Local
cd /d %~dp0
rem Add Git's openssl to PATH (used to generate the HTTPS certificate for GitHub Pages frontend)
if exist "C:\Program Files\Git\mingw64\bin" set "PATH=C:\Program Files\Git\mingw64\bin;%PATH%"
if exist "C:\Program Files\Git\usr\bin" set "PATH=C:\Program Files\Git\usr\bin;%PATH%"
echo.
echo   Starting Leanin Local...
echo   Local       http://127.0.0.1:5218
echo   HTTPS       https://127.0.0.1:5219  (for GitHub Pages frontend)
echo   Close this window to stop the server.
echo.
node server.js
pause
