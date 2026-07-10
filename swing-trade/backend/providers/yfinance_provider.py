"""Yahoo Finance (yfinance) プロバイダ。

- 東証銘柄はコード + ".T"
- 株価は分割調整済み(auto_adjust=False: 配当調整はしない=実際の株価表示に一致)
- 分足は 5m/15m とも直近約60日・約15〜20分遅延
"""
import pandas as pd
import yfinance as yf

from .base import DataProvider

_COLS = {"Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume"}


def _normalize(df: pd.DataFrame, daily: bool) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=list(_COLS.values()))
    df = df.rename(columns=_COLS)
    df = df[[c for c in _COLS.values() if c in df.columns]].dropna(how="any")
    idx = df.index
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_convert("Asia/Tokyo").tz_localize(None)
    df = df.copy()
    df.index = idx.normalize() if daily else idx
    df = df[~df.index.duplicated(keep="last")]
    return df


class YFinanceProvider(DataProvider):
    name = "yfinance"
    is_demo = False

    def daily(self, code: str, years: int = 10) -> pd.DataFrame:
        df = yf.Ticker(f"{code}.T").history(
            period=f"{years}y", interval="1d", auto_adjust=False, actions=False
        )
        return _normalize(df, daily=True)

    def intraday(self, code: str, interval: str) -> pd.DataFrame:
        period = "30d" if interval == "5m" else "60d"
        df = yf.Ticker(f"{code}.T").history(
            period=period, interval=interval, auto_adjust=False, actions=False, prepost=False
        )
        return _normalize(df, daily=False)

    def bulk_daily(self, codes: list[str], period: str = "1y") -> dict[str, pd.DataFrame]:
        out: dict[str, pd.DataFrame] = {}
        chunk_size = 30
        for i in range(0, len(codes), chunk_size):
            chunk = codes[i : i + chunk_size]
            symbols = [f"{c}.T" for c in chunk]
            try:
                data = yf.download(
                    symbols, period=period, interval="1d",
                    auto_adjust=False, actions=False,
                    group_by="ticker", threads=True, progress=False,
                )
            except Exception:
                data = None
            for c in chunk:
                sub = pd.DataFrame()
                if data is not None and not data.empty:
                    try:
                        if isinstance(data.columns, pd.MultiIndex):
                            sub = data[f"{c}.T"].dropna(how="all")
                        else:
                            sub = data.dropna(how="all")
                    except KeyError:
                        pass
                out[c] = _normalize(sub, daily=True)
        return out
