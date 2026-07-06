#!/bin/bash
# このファイルをダブルクリックすると FIND ME サーバーが起動します。
cd "$(dirname "$0")" || exit 1

echo ""
echo "  FIND ME サーバーを起動します..."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [!] Node.js が見つかりませんでした。"
  echo ""
  echo "  先に Node.js をインストールしてください:"
  echo "      https://nodejs.org/ja"
  echo "  ↑「LTS」と書かれた方をダウンロードして、"
  echo "    画面の指示どおりに進めればOKです。"
  echo ""
  echo "  インストールが終わったら、このファイルをもう一度"
  echo "  ダブルクリックしてください。"
  echo ""
  echo "（この画面は閉じて大丈夫です）"
  exit 1
fi

node server.js

echo ""
echo "  サーバーが停止しました。この画面は閉じて大丈夫です。"
