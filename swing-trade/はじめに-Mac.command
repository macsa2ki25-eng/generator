#!/bin/bash
# スイングトレード分析 起動スクリプト (Mac)
# 初回は必要なライブラリを自動インストールします(数分かかります)
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 が見つかりません。https://www.python.org/downloads/ からインストールしてください。"
  read -p "Enterで終了"
  exit 1
fi

if [ ! -d .venv ]; then
  echo "初回セットアップ中..."
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r requirements.txt

python -m backend.main
