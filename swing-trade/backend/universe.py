"""監視ユニバース(銘柄リスト)の読み込み。

data/universe.csv: code,name,sector
同梱リストは主要銘柄(JPX日経400の代表格・約130銘柄)。
フルのJPX400へは scripts/update_universe.py で更新できる(要ネット接続)。
"""
import csv
from functools import lru_cache

from . import config


@lru_cache(maxsize=1)
def load() -> list[dict]:
    rows = []
    with open(config.UNIVERSE_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            code = r["code"].strip()
            if code:
                rows.append(
                    {"code": code, "name": r["name"].strip(), "sector": r.get("sector", "").strip()}
                )
    return rows


def by_code() -> dict[str, dict]:
    return {r["code"]: r for r in load()}


def codes() -> list[str]:
    return [r["code"] for r in load()]
