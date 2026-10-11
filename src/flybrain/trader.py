"""The trading fly.

  price rising      -> sugar GRNs      (it tastes good)
  price falling     -> bitter GRNs     (it tastes bad)
  crash candle      -> LC4 / LPLC2     (something big is coming at it)
        |
        v   ~138k LIF neurons, 15M real connections, nothing trained
        |
  MN9 fires         -> feeding  -> be long
  Giant Fibre fires -> escape   -> dump everything, go flat
  neither           -> flat

The brain persists across candles: each candle is `brain_ms` of simulated brain time.
Decisions use data up to candle close t and are applied to the return t -> t+1.
Paper trading only.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .brain import Brain
from .connectome import Connectome, load
from .neurons import Circuit


@dataclass(frozen=True)
class Config:
    brain_ms: float = 100.0  # simulated brain time per candle
    max_hz: float = 150.0  # sensory firing rate at full stimulus (Shiu used 100-200 Hz)
    momentum_window: int = 3  # candles of return that make up the "taste"
    vol_window: int = 48  # candles used to normalize returns
    taste_z: float = 2.0  # momentum z-score that saturates sugar/bitter
    crash_z: float = 2.0  # single-candle drop (in sigmas) where looming starts
    mn9_hz: float = 10.0  # MN9 rate that counts as "feeding"
    fee: float = 0.001  # per side


def senses(df: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    """Turn candles into sensory firing rates (Hz)."""
    r = np.log(df["close"]).diff()
    sigma = r.rolling(cfg.vol_window).std()
    mom_z = r.rolling(cfg.momentum_window).sum() / (sigma * np.sqrt(cfg.momentum_window))
    crash_z = -r / sigma
    return pd.DataFrame({
        "ret": r,
        "momentum_z": mom_z,
        "sugar_hz": cfg.max_hz * (mom_z / cfg.taste_z).clip(0, 1),
        "bitter_hz": cfg.max_hz * (-mom_z / cfg.taste_z).clip(0, 1),
        "looming_hz": cfg.max_hz * ((crash_z - cfg.crash_z) / cfg.crash_z).clip(0, 1),
    }, index=df.index)


class FlyTrader:
    def __init__(self, cfg: Config = Config(), connectome: Connectome | None = None, seed: int = 0):
        self.cfg = cfg
        c = connectome or load()
        self.circ = Circuit.build(c)
        self.brain = Brain(c, seed=seed)
        self._inputs = np.concatenate([self.circ.sugar, self.circ.bitter, self.circ.looming])
        self._watch = np.concatenate([self.circ.mn9, self.circ.giant_fibre])

    def think(self, sugar_hz: float, bitter_hz: float, looming_hz: float) -> dict:
        c = self.circ
        rates = np.concatenate([
            np.full(len(c.sugar), sugar_hz),
            np.full(len(c.bitter), bitter_hz),
            np.full(len(c.looming), looming_hz),
        ])
        self.brain.set_input(idx=self._inputs, rates=rates)
        self.last_counts = self.brain.run(self.cfg.brain_ms)
        counts = self.last_counts[self._watch]
        sec = self.cfg.brain_ms / 1000
        mn9_hz = counts[: len(c.mn9)].sum() / len(c.mn9) / sec
        gf_spikes = int(counts[len(c.mn9):].sum())
        if gf_spikes > 0:
            action, position = "ESCAPE", 0.0
        elif mn9_hz >= self.cfg.mn9_hz:
            action, position = "FEED", 1.0
        else:
            action, position = "idle", 0.0
        return {"mn9_hz": mn9_hz, "giant_fibre_spikes": gf_spikes, "action": action, "position": position}


def backtest(df: pd.DataFrame, cfg: Config = Config(), progress: bool = True,
             record: list | None = None) -> pd.DataFrame:
    """If `record` is given, the (neuron indices, spike counts) of every candle are appended to it."""
    s = senses(df, cfg).dropna()
    fly = FlyTrader(cfg)
    rows = []
    for i, (t, x) in enumerate(s.iterrows()):
        rows.append({"time": t, **fly.think(x.sugar_hz, x.bitter_hz, x.looming_hz)})
        if record is not None:
            nz = np.flatnonzero(fly.last_counts)
            record.append((nz, fly.last_counts[nz]))
        if progress and (i % 25 == 0 or i == len(s) - 1):
            print(f"\r  thinking... {i + 1}/{len(s)} candles", end="", flush=True)
    if progress:
        print()
    out = s.join(pd.DataFrame(rows).set_index("time"))
    out["close"] = df["close"]

    held = out["position"].shift(1).fillna(0.0)  # decided at close t-1, held through candle t
    turnover = out["position"].diff().abs().fillna(out["position"].abs())
    out["fly_ret"] = held * out["ret"] - turnover.shift(1).fillna(0.0) * cfg.fee
    out["fly_equity"] = np.exp(out["fly_ret"].cumsum())
    out["hodl_equity"] = np.exp(out["ret"].cumsum())
    return out


def summarize(out: pd.DataFrame, periods_per_year: float) -> dict:
    def stats(r: pd.Series) -> tuple[float, float, float]:
        eq = np.exp(r.cumsum())
        total = eq.iloc[-1] - 1
        sharpe = r.mean() / r.std() * np.sqrt(periods_per_year) if r.std() > 0 else 0.0
        mdd = (eq / eq.cummax() - 1).min()
        return total, sharpe, mdd

    fly, hodl = stats(out["fly_ret"]), stats(out["ret"])
    return {
        "candles": len(out),
        "from": out.index[0], "to": out.index[-1],
        "fly_return": fly[0], "fly_sharpe": fly[1], "fly_max_drawdown": fly[2],
        "hodl_return": hodl[0], "hodl_sharpe": hodl[1], "hodl_max_drawdown": hodl[2],
        "time_in_market": out["position"].mean(),
        "trades": int((out["position"].diff().abs() > 0).sum()),
        "feeds": int((out["action"] == "FEED").sum()),
        "escapes": int((out["action"] == "ESCAPE").sum()),
    }
