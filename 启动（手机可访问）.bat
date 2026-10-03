@echo off
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"
title 世界观查询器（手机可访问）

echo.
echo   世界观查询器 —— 局域网模式
echo   ================================================
echo.
echo   这个模式会让同一 WiFi 下的手机也能打开。
echo   注意：不要在公司或公共 WiFi 下用，家里自己的路由器才合适。
echo.
echo   手机访问地址会在下面「局域网：」那一行打印出来。
echo   手机要用浏览器打开这个地址，电脑必须保持开机、本窗口不能关。
echo.

rem 开启局域网访问（等价于 config/config.yaml 里的 lan_access: true）
set "WKV_LAN=1"

set "PYEXE="
if exist ".venv\Scripts\python.exe" set "PYEXE=.venv\Scripts\python.exe"
if not defined PYEXE (
    for %%C in (python py) do (
        if not defined PYEXE where %%C >nul 2>nul && set "PYEXE=%%C"
    )
)
if not defined PYEXE (
    echo   [需要先安装 Python] 请先双击「启动.bat」按提示装好环境。
    echo.
    pause
    exit /b 1
)

if not exist ".venv\.deps_ok" (
    echo   运行环境还没准备好，请先双击「启动.bat」完成首次安装。
    echo.
    pause
    exit /b 1
)

if not exist "web\dist\index.html" (
    echo   [提示] 界面还没构建过。请先双击「启动.bat」完成一次构建。
    echo.
)

"%PYEXE%" -m app.main

echo.
echo   服务已停止。
pause
