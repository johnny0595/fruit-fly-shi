"""
uv run flybrain probe                         # verify the circuits work
uv run flybrain backtest BTC-USD --gran 3600  # replay recent candles through the fly
uv run flybrain live ETH-USD --gran 300       # paper-trade new candles as they close
uv run flybrain export                        # write dashboard/data.json
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import pandas as pd

from . import export, market, probe
from .trader import Config, FlyTrader, backtest, senses, summarize

RESULTS = Path(__file__).resolve().parents[2] / "results"


def cmd_backtest(a: argparse.Namespace) -> None:
    cfg = Config(brain_ms=a.brain_ms)
    df = market.candles(a.product, a.gran, a.candles + cfg.vol_window + 1)
    print(f"{a.product}: {len(df)} candles of {a.gran}s, {df.index[0]} -> {df.index[-1]}")
    out = backtest(df, cfg)
    s = summarize(out, periods_per_year=365 * 86400 / a.gran)

    print(f"\n  {'':16s}{'fly':>10s}{'hodl':>10s}")
    print(f"  {'return':16s}{s['fly_return']:>10.2%}{s['hodl_return']:>10.2%}")
    print(f"  {'sharpe':16s}{s['fly_sharpe']:>10.2f}{s['hodl_sharpe']:>10.2f}")
    print(f"  {'max drawdown':16s}{s['fly_max_drawdown']:>10.2%}{s['hodl_max_drawdown']:>10.2%}")
    print(f"\n  time in market {s['time_in_market']:.0%} | trades {s['trades']} | "
          f"feeds {s['feeds']} | escapes {s['escapes']}")

    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"backtest_{a.product}_{a.gran}.csv"
    out.to_csv(path)
    print(f"  per-candle log: {path}")


def cmd_live(a: argparse.Namespace) -> None:
    cfg = Config(brain_ms=a.brain_ms)
    fly = FlyTrader(cfg)
    RESULTS.mkdir(exist_ok=True)
    log = RESULTS / f"live_{a.product}_{a.gran}.csv"
    cash, coins, last_seen = a.cash, 0.0, None
    print(f"paper trading {a.product} every {a.gran}s with ${cash:,.2f}. ctrl-c to stop.")
    while True:
        df = market.candles(a.product, a.gran, cfg.vol_window + 5)
        t = df.index[-1]
        if t != last_seen:
            last_seen = t
            x = senses(df, cfg).iloc[-1]
            d = fly.think(x.sugar_hz, x.bitter_hz, x.looming_hz)
            price = float(df["close"].iloc[-1])
            if d["position"] > 0 and coins == 0:
                coins, cash = cash * (1 - cfg.fee) / price, 0.0
            elif d["position"] == 0 and coins > 0:
                cash, coins = coins * price * (1 - cfg.fee), 0.0
            equity = cash + coins * price
            row = {"time": t, "price": price, **x.to_dict(), **d, "equity": equity}
            pd.DataFrame([row]).to_csv(log, mode="a", header=not log.exists(), index=False)
            print(f"{t:%Y-%m-%d %H:%M}  ${price:>10,.2f}  sugar {x.sugar_hz:5.0f}Hz bitter {x.bitter_hz:5.0f}Hz "
                  f"loom {x.looming_hz:5.0f}Hz -> MN9 {d['mn9_hz']:5.0f}Hz GF {d['giant_fibre_spikes']:3d}  "
                  f"{d['action']:6s}  equity ${equity:,.2f}")
        time.sleep(max(5.0, a.gran - (time.time() % a.gran) + 3))


def main() -> None:
    p = argparse.ArgumentParser(prog="flybrain", description="A real fruit fly connectome that trades crypto (on paper).")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe", help="check sugar->MN9, bitter, looming->Giant Fibre circuits")
    for name in ("backtest", "live"):
        sp = sub.add_parser(name)
        sp.add_argument("product", nargs="?", default="BTC-USD")
        sp.add_argument("--gran", type=int, default=3600, help="candle size in seconds")
        sp.add_argument("--brain-ms", type=float, default=100.0, help="brain time per candle")
        if name == "backtest":
            sp.add_argument("--candles", type=int, default=500)
        else:
            sp.add_argument("--cash", type=float, default=10_000.0)
    ex = sub.add_parser("export", help="write dashboard/data.json (experiments + backtest + brain map)")
    ex.add_argument("product", nargs="?", default="BTC-USD")
    ex.add_argument("--gran", type=int, default=3600)
    ex.add_argument("--candles", type=int, default=500)
    a = p.parse_args()
    {
        "probe": lambda _: probe.main(),
        "backtest": cmd_backtest,
        "live": cmd_live,
        "export": lambda a: export.main(RESULTS.parent / "dashboard" / "data.json", a.product, a.gran, a.candles),
    }[a.cmd](a)


if __name__ == "__main__":
    main()
