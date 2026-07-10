"""テクニカル指標の計算。"""
import numpy as np
import pandas as pd


def sma(series: pd.Series, n: int) -> pd.Series:
    return series.rolling(n, min_periods=n).mean()


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.rolling(n, min_periods=n).mean()


def resample(daily: pd.DataFrame, rule: str) -> pd.DataFrame:
    """日足から週足('W-FRI')・月足('ME')を合成する。"""
    if daily.empty:
        return daily
    out = pd.DataFrame(
        {
            "open": daily["open"].resample(rule).first(),
            "high": daily["high"].resample(rule).max(),
            "low": daily["low"].resample(rule).min(),
            "close": daily["close"].resample(rule).last(),
            "volume": daily["volume"].resample(rule).sum(),
        }
    ).dropna()
    return out


def volume_profile(df: pd.DataFrame, bins: int = 26) -> dict:
    """価格帯別出来高の近似計算。

    各足の出来高を、その足の値幅(安値〜高値)に均等に按分して価格帯に積む。
    ティックデータによる厳密な値ではないが、節(しこり)の把握には十分。
    """
    if df.empty:
        return {"min": 0, "max": 0, "bins": [], "poc": -1}
    lo = float(df["low"].min())
    hi = float(df["high"].max())
    if hi <= lo:
        hi = lo * 1.001 + 1
    edges = np.linspace(lo, hi, bins + 1)
    vols = np.zeros(bins)
    l = df["low"].to_numpy()
    h = df["high"].to_numpy()
    v = df["volume"].to_numpy()
    width = np.maximum(h - l, 1e-9)
    for i in range(bins):
        overlap = np.clip(np.minimum(h, edges[i + 1]) - np.maximum(l, edges[i]), 0, None)
        vols[i] = float((v * overlap / width).sum())
    poc = int(vols.argmax()) if vols.any() else -1
    return {
        "min": lo,
        "max": hi,
        "bins": [round(float(x)) for x in vols],
        "poc": poc,
    }


def snapshot(daily: pd.DataFrame) -> dict | None:
    """ユニバース一覧・スクリーニング用のサマリ(直近日足ベース)。"""
    if daily is None or len(daily) < 2:
        return None
    c = daily["close"]
    last = daily.iloc[-1]
    prev_close = float(c.iloc[-2])
    close = float(last["close"])
    ma5 = sma(c, 5).iloc[-1]
    ma20 = sma(c, 20).iloc[-1]
    ma60 = sma(c, 60).iloc[-1]
    vol20 = daily["volume"].rolling(20).mean().iloc[-1]
    year = daily.iloc[-250:]
    high52 = float(year["high"].max())
    low52 = float(year["low"].min())

    def f(x):
        return None if x is None or pd.isna(x) else float(x)

    ma5, ma20, ma60, vol20 = f(ma5), f(ma20), f(ma60), f(vol20)
    po = bool(ma5 and ma20 and ma60 and ma5 > ma20 > ma60)
    return {
        "date": daily.index[-1].strftime("%Y-%m-%d"),
        "close": close,
        "change": close - prev_close,
        "change_pct": (close - prev_close) / prev_close * 100 if prev_close else 0.0,
        "volume": float(last["volume"]),
        "turnover": close * float(last["volume"]),
        "vol_ratio": float(last["volume"]) / vol20 if vol20 else None,
        "ma5": ma5,
        "ma20": ma20,
        "ma60": ma60,
        "po": po,
        "above60": bool(ma60 and close > ma60),
        "dist20": (close - ma20) / ma20 * 100 if ma20 else None,
        "high52": high52,
        "low52": low52,
        "near_high": close >= high52 * 0.97,
    }
