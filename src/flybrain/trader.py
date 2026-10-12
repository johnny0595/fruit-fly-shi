"""A swarm of trading flies: one whole-CNS brain per coin, simulated together.

  3-candle momentum up    -> labellum sugar neurons    (it tastes good)
  3-candle momentum down  -> labellum bitter neurons   (it tastes bad)
  24-candle trend up      -> leg sugar neurons         (the ground is sweet)
  24-candle trend down    -> leg bitter neurons        (the ground is bitter)
  crash candle            -> LC4 / LPLC2 looming       (something big is coming)
        |
        v   ~169k LIF neurons, brain + nerve cord, 13.6M real connections, nothing trained
        |
  MN9 rate               -> position size (feeding harder = bigger position)
  MDN fires              -> halve it (walking backwards)
  Giant Fibre fires      -> sell everything (escape; TTMn is the jump muscle it drives)

Each candle is one independent `brain_ms` trial from rest, like Shiu et al.'s trials.
Decisions use data up to candle close t and are applied to the return t -> t+1.
Paper trading only.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .brain import Brain
from .connectome import Connectome, load
from .neurons import INPUTS, OUTPUTS, Circuit


@dataclass(frozen=True)
class Config:
    brain_ms: float = 150.0  # simulated brain time per candle
    vol_window: int = 48  # candles used to normalize returns
    momentum_window: int = 3
    trend_window: int = 24
    saturate_z: float = 2.0  # z-score at which a taste is at full strength
    crash_z: float = 2.0  # single-candle drop (in sigmas) where looming starts
    max_hz: tuple = (("sugar", 200.0), ("bitter", 200.0), ("looming", 150.0), ("leg_sugar", 150.0), ("leg_bitter", 150.0))
    mn9_full_hz: float = 40.0  # MN9 rate that means a full position
    fee: float = 0.001  # per unit of position traded

    def hz(self, name: str) -> float:
        return dict(self.max_hz)[name]


def senses(df: pd.DataFrame, cfg: Config = Config()) -> pd.DataFrame:
    """Turn candles into sensory firing rates (Hz), one column per input group."""
    r = np.log(df["close"]).diff()
    sigma = r.rolling(cfg.vol_window).std()
    z = lambda n: r.rolling(n).sum() / (sigma * np.sqrt(n))  # noqa: E731
    mom, trend, crash = z(cfg.momentum_window), z(cfg.trend_window), -r / sigma
    sat = lambda x: (x / cfg.saturate_z).clip(0, 1)  # noqa: E731
    return pd.DataFrame({
        "ret": r, "momentum_z": mom, "trend_z": trend,
        "sugar": cfg.hz("sugar") * sat(mom),
        "bitter": cfg.hz("bitter") * sat(-mom),
        "leg_sugar": cfg.hz("leg_sugar") * sat(trend),
        "leg_bitter": cfg.hz("leg_bitter") * sat(-trend),
        "looming": cfg.hz("looming") * ((crash - cfg.crash_z) / cfg.crash_z).clip(0, 1),
    }, index=df.index)


def decide(out: dict[str, float], cfg: Config) -> tuple[str, float]:
    """Motor output -> (action, target fraction of the account in the coin)."""
    if out["giant_fibre"] > 0:
        return "ESCAPE", 0.0
    size = min(1.0, out["mn9"] / cfg.mn9_full_hz)
    if out["mdn"] > 0:
        size /= 2
    size = np.floor(size * 4) / 4  # quarter steps, so noise doesn't churn fees
    if size > 0:
        return "FEED", float(size)
    return ("RETREAT" if out["mdn"] > 0 else "idle"), 0.0


class Swarm:
    def __init__(self, n_flies: int, cfg: Config = Config(), connectome: Connectome | None = None, seed: int = 0):
        self.cfg = cfg
        self.c = connectome or load()
        self.circ = Circuit.build(self.c)
        self.brain = Brain(self.c, n_flies=n_flies, seed=seed)

    def think(self, sense_rows: list) -> tuple[list[dict], np.ndarray]:
        """One candle for every fly. Returns per-fly decisions and spike counts (n_flies, N)."""
        self.brain.reset()
        self.brain.set_input([[(self.circ[g], float(row[g])) for g in INPUTS] for row in sense_rows])
        counts = self.brain.run(self.cfg.brain_ms)
        sec = self.cfg.brain_ms / 1000
        decisions = []
        for f in range(len(sense_rows)):
            out = {g: float(counts[f, self.circ[g]].sum() / len(self.circ[g]) / sec) for g in OUTPUTS}
            out["dn_active"] = int((counts[f, self.circ.descending] > 0).sum())
            out["motor_active"] = int((counts[f, self.circ.motor] > 0).sum())
            out["active"] = int((counts[f] > 0).sum())
            action, target = decide(out, self.cfg)
            decisions.append({"out": out, "action": action, "pos": target})
        return decisions, counts


def sparse_top(counts: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """The k most active neurons of one fly's counts, for the dashboard."""
    nz = np.flatnonzero(counts)
    if nz.size > k:
        nz = nz[np.argpartition(-counts[nz], k)[:k]]
    return nz.astype(np.uint32), np.minimum(counts[nz], 255).astype(np.uint8)


def returns(pos: pd.Series, ret: pd.Series, fee: float) -> pd.Series:
    """Per-candle strategy log return: hold the previous decision, pay fees on changes."""
    held = pos.shift(1).fillna(0.0)
    traded = pos.diff().abs().fillna(pos.abs()).shift(1).fillna(0.0)
    return held * ret - traded * fee


def backtest(frames: dict[str, pd.DataFrame], cfg: Config = Config(), keep_top: int = 600,
             progress: bool = True) -> tuple[dict[str, pd.DataFrame], list]:
    """Run the swarm over aligned candles. Returns per-product logs and per-candle sparse spikes."""
    products = list(frames)
    sense = {p: senses(df, cfg) for p, df in frames.items()}
    times = sorted(set.intersection(*(set(s.dropna().index) for s in sense.values())))
    swarm = Swarm(len(products), cfg)
    rows = {p: [] for p in products}
    spikes = []
    for i, t in enumerate(times):
        sr = [sense[p].loc[t] for p in products]
        decisions, counts = swarm.think(sr)
        spikes.append([sparse_top(counts[f], keep_top) for f in range(len(products))])
        for p, x, d in zip(products, sr, decisions):
            rows[p].append({"time": t, **x.to_dict(), **{f"out_{k}": v for k, v in d["out"].items()},
                            "action": d["action"], "pos": d["pos"]})
        if progress and (i % 10 == 0 or i == len(times) - 1):
            print(f"\r  swarm thinking... {i + 1}/{len(times)} candles", end="", flush=True)
    if progress:
        print()
    return {p: account(pd.DataFrame(rows[p]).set_index("time"), frames[p], cfg) for p in products}, spikes


def account(log: pd.DataFrame, candles: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    """Attach prices and equity curves to a per-candle decision log."""
    out = log.join(candles[["open", "high", "low", "close", "volume"]])
    out["ret"] = np.log(out["close"]).diff().fillna(0.0)
    out["fly_ret"] = returns(out["pos"], out["ret"], cfg.fee)
    out["fly_equity"] = np.exp(out["fly_ret"].cumsum())
    out["hodl_equity"] = out["close"] / out["close"].iloc[0]
    return out


def trades(out: pd.DataFrame) -> list[dict]:
    """Stretches where the fly held any position."""
    rows, entry = [], None
    pos = out["pos"].to_numpy()

    def row(i_end: int, reason: str, exit_time) -> dict:
        seg = out.iloc[entry + 1: i_end + 1]
        return {
            "entry": out.index[entry].isoformat(), "exit": exit_time,
            "entry_price": float(out["close"].iloc[entry]), "exit_price": float(out["close"].iloc[i_end]),
            "candles": i_end - entry, "reason": reason, "max_pos": float(pos[entry:max(i_end, entry + 1)].max()),
            "ret": float(np.exp(seg["fly_ret"].sum()) - 1),
        }

    for i in range(len(out)):
        prev = pos[i - 1] if i else 0.0
        if pos[i] > 0 and prev == 0:
            entry = i
        elif pos[i] == 0 and prev > 0 and entry is not None:
            rows.append(row(i, out["action"].iloc[i], out.index[i].isoformat()))
            entry = None
    if entry is not None:
        rows.append(row(len(out) - 1, "open", None))
    return rows


def summarize(out: pd.DataFrame) -> dict:
    eq, hodl = out["fly_equity"], out["hodl_equity"]
    return {
        "fly_return": float(eq.iloc[-1] - 1), "hodl_return": float(hodl.iloc[-1] - 1),
        "fly_max_drawdown": float((eq / eq.cummax() - 1).min()),
        "hodl_max_drawdown": float((hodl / hodl.cummax() - 1).min()),
        "time_in_market": float((out["pos"] > 0).mean()), "avg_position": float(out["pos"].mean()),
        "escapes": int((out["action"] == "ESCAPE").sum()), "feeds": int((out["action"] == "FEED").sum()),
    }
