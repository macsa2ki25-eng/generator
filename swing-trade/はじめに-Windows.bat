@echo off
rem スイングトレード分析 起動スクリプト (Windows)
rem 初回は必要なライブラリを自動インストールします(数分かかります)
cd /d %~dp0
chcp 65001 >nul

where py >nul 2>nul
if errorlevel 1 (
  echo Python が見つかりません。https://www.python.org/downloads/ からインストールしてください。
  echo インストール時に「Add Python to PATH」にチェックを入れてください。
  pause
  exit /b 1
)

if not exist .venv (
  echo 初回セットアップ中...
  py -3 -m venv .venv
)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt

python -m backend.main
pause
