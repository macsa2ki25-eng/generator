"""REST API。フロントエンドは静的ファイル、データはすべてここから返す。"""
import threading
import time
import traceback

import pandas as pd
from fastapi import APIRouter, HTTPException

from . import config, database, indicators, universe
from .providers import get_provider

router = APIRouter()
provider = get_provider()

_TF_MA = {
    "D": ([5, 20, 60], "日"),
    "W": ([13, 26, 52], "週"),
    "M": ([12, 24, 60], "ヶ月"),
    "m5": ([5, 20, 60], "本"),
    "m15": ([5, 20, 60], "本"),
}
_PROFILE_LOOKBACK = {"D": 120, "W": 104, "M": 72, "m5": None, "m15": None}
_CHART_BARS = {"D": 750, "W": 600, "M": 600, "m5": 2000, "m15": 2000}

# ---------------------------------------------------------------- data access


def _get_daily(code: str, allow_fetch: bool = True) -> pd.DataFrame:
    """日足を返す。キャッシュが新しく履歴も深ければDBから、でなければ取得。"""
    age = time.time() - database.fetched_at(code, "D")
    first = database.first_ts(code, "D")
    deep_enough = first is not None and first < time.time() - (config.DAILY_YEARS - 0.5) * 365 * 86400
    if age < config.DAILY_TTL and deep_enough:
        return database.load_candles(code, "D")
    if not allow_fetch:
        return database.load_candles(code, "D")
    try:
        df = provider.daily(code, years=config.DAILY_YEARS)
        database.save_candles(code, "D", df)
    except Exception:
        traceback.print_exc()
    return database.load_candles(code, "D")


def _get_intraday(code: str, interval: str) -> pd.DataFrame:
    tf = "m5" if interval == "5m" else "m15"
    age = time.time() - database.fetched_at(code, tf)
    if age > config.INTRADAY_TTL:
        try:
            df = provider.intraday(code, interval)
            database.clear_tf(code, tf)  # 分足は期間が流れるので入れ替え
            database.save_candles(code, tf, df)
        except Exception:
            traceback.print_exc()
    return database.load_candles(code, tf)


# ---------------------------------------------------------------- refresh job

_refresh = {"running": False, "done": 0, "total": 0, "finished_at": None, "error": None}
_snapshot_cache = {"at": 0.0, "rows": None}


def _refresh_worker():
    global _snapshot_cache
    codes = universe.codes()
    _refresh.update(running=True, done=0, total=len(codes), error=None)
    try:
        chunk = 30
        for i in range(0, len(codes), chunk):
            part = codes[i : i + chunk]
            data = provider.bulk_daily(part, period="1y")
            for c in part:
                df = data.get(c)
                if df is not None and not df.empty:
                    database.save_candles(c, "D", df)
            _refresh["done"] = min(i + chunk, len(codes))
    except Exception as e:
        traceback.print_exc()
        _refresh["error"] = str(e)
    finally:
        _refresh.update(running=False, finished_at=int(time.time()))
        _snapshot_cache = {"at": 0.0, "rows": None}


@router.post("/refresh")
def start_refresh():
    if _refresh["running"]:
        return {"started": False, "status": _refresh}
    threading.Thread(target=_refresh_worker, daemon=True).start()
    return {"started": True, "status": _refresh}


@router.get("/refresh/status")
def refresh_status():
    return _refresh


# ---------------------------------------------------------------- endpoints


@router.get("/meta")
def meta():
    return {
        "provider": provider.name,
        "is_demo": provider.is_demo,
        "universe_count": len(universe.load()),
        "refresh": _refresh,
    }


@router.get("/universe")
def universe_snapshot():
    now = time.time()
    if _snapshot_cache["rows"] is not None and now - _snapshot_cache["at"] < 60:
        return {"rows": _snapshot_cache["rows"]}
    rows = []
    for stock in universe.load():
        daily = database.load_candles(stock["code"], "D", limit=300)
        snap = indicators.snapshot(daily)
        row = dict(stock)
        row["data"] = snap is not None
        if snap:
            row.update(snap)
        rows.append(row)
    _snapshot_cache.update(at=now, rows=rows)
    return {"rows": rows}


def _candles_json(df: pd.DataFrame, tf: str) -> list[dict]:
    intraday = tf in ("m5", "m15")
    out = []
    if intraday:
        times = database.epoch_seconds(df.index)
    else:
        times = df.index.strftime("%Y-%m-%d").tolist()
    for t, o, h, l, c, v in zip(
        times, df["open"], df["high"], df["low"], df["close"], df["volume"]
    ):
        out.append(
            {"time": t, "open": float(o), "high": float(h), "low": float(l),
             "close": float(c), "volume": float(v)}
        )
    return out


@router.get("/stock/{code}")
def stock(code: str, tf: str = "D"):
    if tf not in _TF_MA:
        raise HTTPException(400, "tf must be one of D, W, M, m5, m15")
    info = universe.by_code().get(code, {"code": code, "name": code, "sector": ""})

    daily = _get_daily(code)
    if daily.empty:
        raise HTTPException(
            503,
            "データを取得できませんでした。ネットワーク接続を確認するか、後でもう一度お試しください。",
        )

    if tf == "D":
        df = daily
    elif tf == "W":
        df = indicators.resample(daily, "W-FRI")
    elif tf == "M":
        df = indicators.resample(daily, "ME")
    else:
        df = _get_intraday(code, "5m" if tf == "m5" else "15m")
        if df.empty:
            raise HTTPException(503, "分足データを取得できませんでした。")

    limit = _CHART_BARS[tf]
    df_view = df.iloc[-limit:]

    # 移動平均は全期間で計算し、チャートに送る区間だけに切り出す
    # (系列ごとに期間が違うと表示範囲の計算がずれるため、必ず揃える)
    periods, unit = _TF_MA[tf]
    close = df["close"]
    mas = {}
    for p in periods:
        s = indicators.sma(close, p).dropna()
        if not df_view.empty:
            s = s[s.index >= df_view.index[0]]
        idx = s.index
        if tf in ("m5", "m15"):
            times = database.epoch_seconds(idx)
        else:
            times = idx.strftime("%Y-%m-%d").tolist()
        mas[str(p)] = [{"time": t, "value": round(float(v), 2)} for t, v in zip(times, s)]

    lookback = _PROFILE_LOOKBACK[tf]
    prof_src = df.iloc[-lookback:] if lookback else df
    profile = indicators.volume_profile(prof_src)
    profile["from_time"] = None
    if not prof_src.empty and tf not in ("m5", "m15"):
        profile["from_time"] = prof_src.index[0].strftime("%Y-%m-%d")

    snap = indicators.snapshot(daily)
    return {
        "meta": info,
        "tf": tf,
        "ma_unit": unit,
        "ma_periods": periods,
        "candles": _candles_json(df_view, tf),
        "ma": mas,
        "profile": profile,
        "stats": snap,
        "is_demo": provider.is_demo,
    }
