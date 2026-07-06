@echo off
chcp 65001 >nul
cd /d "%~dp0"
title FIND ME サーバー

echo.
echo   FIND ME サーバーを起動します...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js が見つかりませんでした。
  echo.
  echo   先に Node.js をインストールしてください:
  echo       https://nodejs.org/ja
  echo   ↑「LTS」と書かれた方をダウンロードして、
  echo     画面の指示どおり「次へ」を押していけばOKです。
  echo.
  echo   インストールが終わったら、このファイルをもう一度
  echo   ダブルクリックしてください。
  echo.
  pause
  exit /b
)

node server.js

echo.
echo   サーバーが停止しました。この画面は閉じて大丈夫です。
pause
