"""Export everything the dashboard needs into one JSON file.

  - neuron positions (FlyWire annotations) and super class for the brain map
  - spike rasters for the probe experiments (every spike, 0.1 ms resolution)
  - a backtest with per-candle whole-brain spike counts, plus the trade list
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import market
from .brain import Brain
from .connectome import annotations, load
from .neurons import Circuit
from .trader import Config, backtest, summarize

DEMO_MS = 300.0
EXPERIMENTS = [
    ("Resting", "No input", []),
    ("Sugar", "Sugar taste neurons at 100 Hz", [("sugar", 100)]),
    ("Sugar + bitter", "Sugar and bitter neurons at 100 Hz each", [("sugar", 100), ("bitter", 100)]),
    ("Bitter", "Bitter taste neurons at 100 Hz", [("bitter", 100)]),
    ("Looming", "LC4 and LPLC2 looming neurons at 150 Hz", [("looming", 150)]),
    ("Looming, lesioned", "Looming at 150 Hz with LC4/LPLC2 outputs cut", [("looming", 150)]),
]


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def neuron_map(c, circ: Circuit) -> dict:
    a = annotations().drop_duplicates("root_id").set_index("root_id")
    a = a.reindex(c.root_ids)
    x, y = a["pos_x"].to_numpy(float), a["pos_y"].to_numpy(float)
    ok = np.isfinite(x) & np.isfinite(y)
    lo_x, hi_x = np.nanpercentile(x, [0.05, 99.95])
    lo_y, hi_y = np.nanpercentile(y, [0.05, 99.95])
    span = max(hi_x - lo_x, hi_y - lo_y)
    qx = np.where(ok, np.clip((x - lo_x) / span, 0, 1) * 65000, 65535).astype(np.uint16)
    qy = np.where(ok, np.clip((y - lo_y) / span, 0, 1) * 65000, 65535).astype(np.uint16)
    classes = a["super_class"].fillna("unknown").astype(str)
    names = sorted(classes.unique())
    code = classes.map({n: i for i, n in enumerate(names)}).to_numpy(np.uint8)
    return {
        "n": int(c.n_neurons), "n_edges": int(c.n_edges),
        "aspect": float((hi_y - lo_y) / span), "width": float((hi_x - lo_x) / span),
        "x": b64(qx), "y": b64(qy), "cls": b64(code), "classes": names,
        "groups": {k: getattr(circ, k).tolist() for k in ("sugar", "bitter", "looming", "mn9", "giant_fibre")},
    }


def experiments(c, circ: Circuit) -> list[dict]:
    out = []
    for name, desc, inputs in EXPERIMENTS:
        b = Brain(c, seed=1)
        if inputs:
            idx = np.concatenate([getattr(circ, g) for g, _ in inputs])
            rates = np.concatenate([np.full(len(getattr(circ, g)), r) for g, r in inputs])
            b.set_input(idx=idx, rates=rates)
        if "lesion" in name:
            b.silence(circ.looming)
        steps, neurons = [], []
        for _ in range(int(DEMO_MS / b.p.dt)):
            t = b.step_count
            s = b.step()
            if s.size:
                steps.append(np.full(s.size, t, np.uint16))
                neurons.append(s.astype(np.uint32))
        st = np.concatenate(steps) if steps else np.empty(0, np.uint16)
        nu = np.concatenate(neurons) if neurons else np.empty(0, np.uint32)
        hz = lambda ix: float(np.isin(nu, ix).sum() / len(ix) / (DEMO_MS / 1000))  # noqa: E731
        out.append({
            "name": name, "desc": desc, "inputs": [g for g, _ in inputs],
            "ms": DEMO_MS, "dt": b.p.dt, "spikes": int(nu.size), "active": int(np.unique(nu).size),
            "mn9_hz": hz(circ.mn9), "gf_hz": hz(circ.giant_fibre),
            "steps": b64(st), "neurons": b64(nu),
        })
        print(f"  {name:20s} {nu.size:7d} spikes, {np.unique(nu).size:6d} neurons")
    return out


def trades(out: pd.DataFrame, fee: float) -> list[dict]:
    rows, entry = [], None
    pos = out["position"].to_numpy()
    for i in range(len(out)):
        prev = pos[i - 1] if i else 0.0
        if pos[i] > 0 and prev == 0:
            entry = i
        elif pos[i] == 0 and prev > 0 and entry is not None:
            p0, p1 = out["close"].iloc[entry], out["close"].iloc[i]
            rows.append({
                "entry": out.index[entry].isoformat(), "exit": out.index[i].isoformat(),
                "entry_price": float(p0), "exit_price": float(p1),
                "candles": i - entry, "reason": out["action"].iloc[i],
                "ret": float(p1 / p0 * (1 - fee) ** 2 - 1),
            })
            entry = None
    if entry is not None:
        p0, p1 = out["close"].iloc[entry], out["close"].iloc[-1]
        rows.append({
            "entry": out.index[entry].isoformat(), "exit": None,
            "entry_price": float(p0), "exit_price": float(p1),
            "candles": len(out) - 1 - entry, "reason": "open",
            "ret": float(p1 / p0 * (1 - fee) - 1),
        })
    return rows


def run_backtest(product: str, gran: int, n: int) -> dict:
    cfg = Config()
    df = market.candles(product, gran, n + cfg.vol_window + 1)
    record: list = []
    out = backtest(df, cfg, record=record)
    s = summarize(out, periods_per_year=365 * 86400 / gran)
    idx = np.concatenate([r[0] for r in record]).astype(np.uint32)
    cnt = np.concatenate([r[1] for r in record]).clip(0, 65535).astype(np.uint16)
    off = np.cumsum([0] + [len(r[0]) for r in record]).astype(np.uint32)
    candles = [{
        "t": t.isoformat(), "close": float(r.close), "mz": float(r.momentum_z),
        "sugar": float(r.sugar_hz), "bitter": float(r.bitter_hz), "loom": float(r.looming_hz),
        "mn9": float(r.mn9_hz), "gf": int(r.giant_fibre_spikes), "action": r.action,
        "pos": float(r.position), "fly": float(r.fly_equity), "hodl": float(r.hodl_equity),
    } for t, r in out.iterrows()]
    summary = {k: (v.isoformat() if hasattr(v, "isoformat") else float(v)) for k, v in s.items()}
    return {
        "product": product, "granularity": gran, "brain_ms": cfg.brain_ms, "fee": cfg.fee,
        "candles": candles, "summary": summary, "trades": trades(out, cfg.fee),
        "act_idx": b64(idx), "act_cnt": b64(cnt), "act_off": b64(off),
    }


def main(path: Path, product: str = "BTC-USD", gran: int = 3600, n: int = 500) -> None:
    c = load()
    circ = Circuit.build(c)
    print("brain map ...")
    data = {"brain": neuron_map(c, circ)}
    print("experiments ...")
    data["experiments"] = experiments(c, circ)
    print(f"backtest {product} ...")
    data["backtest"] = run_backtest(product, gran, n)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")
