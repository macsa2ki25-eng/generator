import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # swing-trade/
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "market.db"
UNIVERSE_CSV = DATA_DIR / "universe.csv"
FRONTEND_DIR = BASE_DIR / "frontend"

# データプロバイダ: "yfinance"(本番) / "demo"(合成データ・オフライン確認用)
PROVIDER = os.environ.get("SWT_PROVIDER", "yfinance").lower()

HOST = os.environ.get("SWT_HOST", "127.0.0.1")
PORT = int(os.environ.get("SWT_PORT", "8765"))
OPEN_BROWSER = os.environ.get("SWT_OPEN_BROWSER", "1") == "1"

# キャッシュ有効期間(秒)
DAILY_TTL = 6 * 3600
INTRADAY_TTL = 10 * 60

# 日足の取得年数(チャート・週足・月足の元データ)
DAILY_YEARS = 10
