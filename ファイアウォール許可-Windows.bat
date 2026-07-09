@echo off
chcp 65001 >nul
title FIND ME ファイアウォール許可

rem 管理者権限が無ければ、UAC(「このアプリがデバイスに変更を…」)で昇格して再実行する
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   管理者の許可をお願いします。
  echo   このあと「はい」を押してください...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo   FIND ME : 他のタブレットからつながるように、
echo             ポート 3000 への接続を許可します...
echo.

rem 同じ名前の古い設定があれば消してから追加(重複防止)。全ネットワーク種別に適用
netsh advfirewall firewall delete rule name="FIND ME port 3000" >nul 2>&1
netsh advfirewall firewall add rule name="FIND ME port 3000" dir=in action=allow protocol=TCP localport=3000 profile=any

echo.
echo   ============================================
echo    設定が完了しました！
echo   ============================================
echo.
echo   このあと、もう一度サーバーを起動して
echo   （はじめに-Windows.bat をダブルクリック）、
echo   タブレットのブラウザで
echo       http://(黒い画面に出た数字):3000
echo   を開いてください。
echo.
echo   ※元に戻したい時は、この画面をもう一度使わずに
echo     「ファイアウォール許可を取り消す」場合は
echo     スタッフの人に伝えてください。
echo.
pause
