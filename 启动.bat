@echo off
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"
title 世界观查询器

echo.
echo   世界观查询器
echo   ================================================
echo.

rem ---- 1. 找一个可用的 Python ----
set "PYEXE="
if exist ".venv\Scripts\python.exe" set "PYEXE=.venv\Scripts\python.exe"

if not defined PYEXE (
    for %%C in (python py) do (
        if not defined PYEXE where %%C >nul 2>nul && set "PYEXE=%%C"
    )
)

if not defined PYEXE (
    echo   [需要先安装 Python]
    echo.
    echo     打开 https://www.python.org/downloads/ 下载安装。
    echo     安装第一步务必勾选 "Add python.exe to PATH"，
    echo     装完再重新双击本文件。
    echo.
    pause
    exit /b 1
)

rem ---- 2. 首次运行：建独立运行环境（不动系统里的 Python） ----
if not exist ".venv\Scripts\python.exe" (
    echo   首次运行，正在准备独立运行环境（只做这一次，约 1~2 分钟）...
    echo.
    "%PYEXE%" -m venv .venv
    if errorlevel 1 (
        echo.
        echo   [失败] 创建运行环境出错。
        echo          若提示没有权限，把整个文件夹挪到桌面或 D 盘再试。
        echo.
        pause
        exit /b 1
    )
    set "PYEXE=.venv\Scripts\python.exe"
)

rem ---- 3. 依赖 ----
if not exist ".venv\.deps_ok" (
    echo   正在安装运行依赖...
    echo.
    "%PYEXE%" -m pip install --disable-pip-version-check -q --upgrade pip
    "%PYEXE%" -m pip install --disable-pip-version-check -q -r requirements.txt
    if errorlevel 1 (
        echo.
        echo   [失败] 依赖没装上，多半是网络问题。手动执行这条试试：
        echo.
        echo     .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
        echo.
        pause
        exit /b 1
    )
    echo ok> ".venv\.deps_ok"
)

rem ---- 4. 界面产物 ----
if not exist "web\dist\index.html" (
    where npm >nul 2>nul
    if errorlevel 1 (
        echo   [提示] 没检测到 Node.js，界面还没构建过，这次只能起后端接口。
        echo          装好 Node.js 之后重新双击本文件就能看到界面。
        echo.
    ) else (
        echo   正在构建界面（只做这一次，约 1~2 分钟）...
        echo.
        pushd web
        if not exist "node_modules" call npm install --no-fund --no-audit
        call npm run build
        popd
    )
)

rem ---- 5. 启动 ----
"%PYEXE%" -m app.main

echo.
echo   服务已停止。窗口可以关掉了。
pause
