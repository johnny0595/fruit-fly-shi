"""Public Coinbase candles (no API key, read-only)."""

from __future__ import annotations

import json
import time
import urllib.request

import pandas as pd

URL = "https://api.exchange.coinbase.com/products/{product}/candles?granularity={g}&start={s}&end={e}"
MAX_PER_REQUEST = 300


def _get(url: str) -> list:
    req = urllib.request.Request(url, headers={"User-Agent": "flybrain/0.1"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def candles(product: str = "BTC-USD", granularity: int = 3600, count: int = 500) -> pd.DataFrame:
    """Most recent `count` closed candles, oldest first. granularity in seconds
    (60, 300, 900, 3600, 21600, 86400)."""
    end = int(time.time()) // granularity * granularity  # drop the still-open candle
    rows: list = []
    while len(rows) < count:
        start = end - MAX_PER_REQUEST * granularity
        batch = _get(URL.format(product=product, g=granularity,
                                s=pd.Timestamp(start, unit="s").isoformat(),
                                e=pd.Timestamp(end - 1, unit="s").isoformat()))
        if not batch:
            break
        rows.extend(batch)
        end = start
    df = pd.DataFrame(rows, columns=["time", "low", "high", "open", "close", "volume"])
    df = df.drop_duplicates("time").sort_values("time").tail(count)
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
    return df.set_index("time")
