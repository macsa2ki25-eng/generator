"""SQLiteキャッシュ。ローソク足と取得時刻を保存する。

ts はエポック秒。日足は日付 00:00 を、分足はJSTの壁時計時刻を
「UTCとして」エンコードした値(フロント側でそのままJST表示になる)。
"""
import sqlite3
import threading
import time

import pandas as pd

from . import config

_lock = threading.Lock()


def _conn():
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init():
    with _lock, _conn() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS candles(
                 code TEXT NOT NULL, tf TEXT NOT NULL, ts INTEGER NOT NULL,
                 open REAL, high REAL, low REAL, close REAL, volume REAL,
                 PRIMARY KEY(code, tf, ts))"""
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS fetch_meta(
                 code TEXT NOT NULL, tf TEXT NOT NULL,
                 fetched_at INTEGER NOT NULL,
                 PRIMARY KEY(code, tf))"""
        )


def epoch_seconds(index) -> list[int]:
    """DatetimeIndexをエポック秒へ(pandasの内部単位ns/us/msに依存しない)。"""
    return pd.DatetimeIndex(index).as_unit("s").asi8.tolist()


def save_candles(code: str, tf: str, df: pd.DataFrame):
    """dfは open/high/low/close/volume 列、indexはtz-naiveのDatetimeIndex。"""
    now = int(time.time())
    with _lock, _conn() as c:
        if df is not None and not df.empty:
            ts = epoch_seconds(df.index)
            rows = [
                (code, tf, int(t), float(o), float(h), float(l), float(cl), float(v))
                for t, o, h, l, cl, v in zip(
                    ts, df["open"], df["high"], df["low"], df["close"], df["volume"]
                )
            ]
            c.executemany(
                "INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?,?)", rows
            )
        c.execute(
            "INSERT OR REPLACE INTO fetch_meta VALUES(?,?,?)", (code, tf, now)
        )


def load_candles(code: str, tf: str, limit: int | None = None) -> pd.DataFrame:
    with _lock, _conn() as c:
        q = "SELECT ts, open, high, low, close, volume FROM candles WHERE code=? AND tf=? ORDER BY ts"
        df = pd.read_sql_query(q, c, params=(code, tf))
    if df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    df.index = pd.to_datetime(df.pop("ts"), unit="s")
    if limit:
        df = df.iloc[-limit:]
    return df


def fetched_at(code: str, tf: str) -> int:
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT fetched_at FROM fetch_meta WHERE code=? AND tf=?", (code, tf)
        ).fetchone()
    return row[0] if row else 0


def first_ts(code: str, tf: str) -> int | None:
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT MIN(ts) FROM candles WHERE code=? AND tf=?", (code, tf)
        ).fetchone()
    return row[0] if row and row[0] is not None else None


def clear_tf(code: str, tf: str):
    with _lock, _conn() as c:
        c.execute("DELETE FROM candles WHERE code=? AND tf=?", (code, tf))
