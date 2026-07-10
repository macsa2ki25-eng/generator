"""JPX日経400の構成銘柄リストを公式サイトから取得して data/universe.csv を更新する。

使い方(swing-trade ディレクトリで):
    python scripts/update_universe.py

- 日経の公表CSV(構成銘柄・ウエート一覧)からコードと銘柄名を取得する
- 既存CSVに業種(sector)がある銘柄はそれを引き継ぐ。新規銘柄の業種は空欄になるので、
  必要に応じて手で補完するか、JPXの「東証上場銘柄一覧」から転記する
- 公表URLは変更されることがある。失敗した場合は下のURLリストを最新に直すこと
"""
import csv
import io
import sys
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
CSV_PATH = BASE / "data" / "universe.csv"

CANDIDATE_URLS = [
    "https://indexes.nikkei.co.jp/nkave/archives/file/jpx_nikkei_index_400_weight_jp.csv",
    "https://indexes.nikkei.co.jp/nkave/archives/file/jpx_nikkei_400_weight_jp.csv",
]


def fetch_csv() -> str:
    last_err = None
    for url in CANDIDATE_URLS:
        try:
            print(f"取得中: {url}")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as res:
                raw = res.read()
            for enc in ("shift_jis", "cp932", "utf-8"):
                try:
                    return raw.decode(enc)
                except UnicodeDecodeError:
                    continue
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"  失敗: {e}")
    raise SystemExit(f"構成銘柄リストを取得できませんでした: {last_err}")


def parse(text: str) -> list[tuple[str, str]]:
    rows = []
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if len(row) < 2:
            continue
        code = row[0].strip().strip('"')
        name = row[1].strip().strip('"')
        if code.isdigit() and len(code) == 4:
            rows.append((code, name))
    if len(rows) < 300:
        raise SystemExit(
            f"解析結果が{len(rows)}件しかありません。CSVの形式が変わった可能性があります。"
        )
    return rows


def main():
    old_sectors: dict[str, str] = {}
    if CSV_PATH.exists():
        with open(CSV_PATH, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                old_sectors[r["code"]] = r.get("sector", "")

    text = fetch_csv()
    stocks = parse(text)

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["code", "name", "sector"])
        for code, name in sorted(stocks):
            w.writerow([code, name, old_sectors.get(code, "")])

    missing = sum(1 for c, _ in stocks if not old_sectors.get(c))
    print(f"完了: {len(stocks)}銘柄を書き込みました → {CSV_PATH}")
    if missing:
        print(f"注意: {missing}銘柄は業種が未設定です(アプリは業種なしでも動作します)")


if __name__ == "__main__":
    sys.exit(main())
