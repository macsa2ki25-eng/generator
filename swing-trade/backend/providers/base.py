"""データプロバイダの共通インターフェース。

戻り値の DataFrame 仕様:
  - 列: open, high, low, close, volume
  - index: tz-naive の DatetimeIndex
      日足   … 日付(00:00)
      分足   … JSTの壁時計時刻
将来 J-Quants に差し替える場合もこのインターフェースを実装するだけでよい。
"""
import pandas as pd


class DataProvider:
    name = "base"
    is_demo = False

    def daily(self, code: str, years: int = 10) -> pd.DataFrame:
        raise NotImplementedError

    def intraday(self, code: str, interval: str) -> pd.DataFrame:
        """interval: '5m' or '15m'"""
        raise NotImplementedError

    def bulk_daily(self, codes: list[str], period: str = "1y") -> dict[str, pd.DataFrame]:
        """一括更新用。デフォルトは1銘柄ずつ daily() を呼ぶ。"""
        out = {}
        for c in codes:
            try:
                out[c] = self.daily(c, years=2)
            except Exception:
                out[c] = pd.DataFrame()
        return out
