"""デモ用の合成データプロバイダ(オフライン・開発確認用)。

実データが取得できない環境でもUIと計算ロジックを確認できるように、
銘柄コードから決定論的に生成したそれらしい値動きを返す。
実データと混同しないよう、UI側で必ず「デモデータ」バナーを表示する。
"""
import numpy as np
import pandas as pd

from .base import DataProvider

_TICK_SESSIONS = [("09:00", "11:30"), ("12:30", "15:30")]  # 東証の立会時間


def _tick_round(prices: np.ndarray) -> np.ndarray:
    """ざっくり呼値: 1000円未満は0.5円、5000円未満は1円、それ以上は5円刻み。"""
    out = prices.copy()
    out = np.where(out < 1000, np.round(out * 2) / 2, np.where(out < 5000, np.round(out), np.round(out / 5) * 5))
    return out


class DemoProvider(DataProvider):
    name = "demo"
    is_demo = True

    def _rng(self, code: str, salt: int = 0) -> np.random.Generator:
        return np.random.default_rng(int(code) * 7919 + salt)

    def daily(self, code: str, years: int = 10) -> pd.DataFrame:
        # 常に12年分を生成して末尾を切り出す(取得年数によらず同じ値を返すため)
        total_years = 12
        rng = self._rng(code)
        end = pd.Timestamp.today().normalize()
        idx = pd.bdate_range(end=end, periods=total_years * 245)
        n = len(idx)

        # レジーム切替型のランダムウォーク(上昇/下落/レンジ)
        mus = np.array([0.0012, -0.0009, 0.0001])
        sigmas = np.array([0.017, 0.024, 0.012])
        regime = np.zeros(n, dtype=int)
        r = rng.integers(0, 3)
        for i in range(n):
            if rng.random() < 1 / 60:  # 平均60営業日でレジーム転換
                r = rng.integers(0, 3)
            regime[i] = r
        rets = rng.normal(mus[regime], sigmas[regime])

        base = float(rng.uniform(400, 12000))
        close = base * np.exp(np.cumsum(rets))
        open_ = np.empty(n)
        open_[0] = close[0]
        open_[1:] = close[:-1] * (1 + rng.normal(0, 0.004, n - 1))
        span = np.abs(rng.normal(0, 0.008, n)) + 0.002
        high = np.maximum(open_, close) * (1 + span)
        low = np.minimum(open_, close) * (1 - span)

        vol_base = float(rng.uniform(3e5, 8e6))
        volume = vol_base * np.exp(rng.normal(0, 0.45, n)) * (1 + 12 * np.abs(rets))

        df = pd.DataFrame(
            {
                "open": _tick_round(open_),
                "high": _tick_round(high),
                "low": _tick_round(low),
                "close": _tick_round(close),
                "volume": np.round(volume, -2),
            },
            index=idx,
        )
        df["high"] = df[["open", "high", "low", "close"]].max(axis=1)
        df["low"] = df[["open", "high", "low", "close"]].min(axis=1)
        return df.iloc[-years * 245 :]

    def intraday(self, code: str, interval: str) -> pd.DataFrame:
        step = 5 if interval == "5m" else 15
        days = 10 if interval == "5m" else 30
        daily = self.daily(code, years=1).iloc[-days:]
        rng = self._rng(code, salt=step)

        frames = []
        for date, row in daily.iterrows():
            times = []
            for start, endt in _TICK_SESSIONS:
                rng_t = pd.date_range(
                    f"{date.date()} {start}", f"{date.date()} {endt}", freq=f"{step}min"
                )[:-1]
                times.extend(rng_t)
            m = len(times)
            # 日足の始値→終値をブラウン橋でつなぐ
            noise = rng.normal(0, 1, m).cumsum()
            noise -= np.linspace(noise[0], noise[-1], m)
            path = np.linspace(row["open"], row["close"], m) + noise * (row["high"] - row["low"]) * 0.15
            path = np.clip(path, row["low"], row["high"])
            o = np.empty(m)
            o[0] = row["open"]
            o[1:] = path[:-1]
            c = path
            h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 0.0012, m)))
            l = np.minimum(o, c) * (1 - np.abs(rng.normal(0, 0.0012, m)))
            u = np.abs(np.linspace(-1, 1, m)) + 0.4  # 寄り引けに出来高が偏るU字
            v = row["volume"] * u / u.sum() * np.exp(rng.normal(0, 0.25, m))
            frames.append(
                pd.DataFrame(
                    {"open": _tick_round(o), "high": _tick_round(h), "low": _tick_round(l),
                     "close": _tick_round(c), "volume": np.round(v, -1)},
                    index=pd.DatetimeIndex(times),
                )
            )
        df = pd.concat(frames)
        df["high"] = df[["open", "high", "low", "close"]].max(axis=1)
        df["low"] = df[["open", "high", "low", "close"]].min(axis=1)
        return df

    def bulk_daily(self, codes: list[str], period: str = "1y") -> dict[str, pd.DataFrame]:
        return {c: self.daily(c, years=2) for c in codes}
