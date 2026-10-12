"""Serialize brains, experiments and swarm runs into the JSON the dashboard reads.

  dashboard/brain.json   neuron map + stimulus experiments (written by `flybrain export`)
  dashboard/swarm.json   a backtest of the swarm               (written by `flybrain export`)
  dashboard/live.json    the live swarm, same schema as swarm  (written by `flybrain live`)
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

from .brain import Brain
from .neurons import INPUTS, OUTPUTS, Circuit
from .trader import Config, summarize, trades

DASHBOARD = Path(__file__).resolve().parents[2] / "dashboard"

EXPERIMENTS = [
    ("Resting", "No input. Every neuron sits at rest.", []),
    ("Sugar", "Labellum sugar neurons at 200 Hz: the taste of a rising price.", [("sugar", 200)]),
    ("Sugar + bitter", "The same sugar plus bitter at 200 Hz: a choppy market.", [("sugar", 200), ("bitter", 200)]),
    ("Sweet ground", "Leg sugar neurons at 150 Hz: a long uptrend.", [("leg_sugar", 150)]),
    ("Looming", "LC4 and LPLC2 at 150 Hz: a crash candle rushing at the fly.", [("looming", 150)]),
    ("Looming, lesioned", "Looming with LC4/LPLC2 outputs cut.", [("looming", 150)]),
]


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def write(path: Path, data: dict) -> None:
    """Atomic write, so the dashboard never reads half a file."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    os.replace(tmp, path)


def brain_map(c, circ: Circuit) -> dict:
    m = c.meta
    x, y = m["x"].to_numpy(float), m["y"].to_numpy(float)
    ok = np.isfinite(x) & np.isfinite(y)
    lo_x, hi_x = np.nanpercentile(x, [0.02, 99.98])
    lo_y, hi_y = np.nanpercentile(y, [0.02, 99.98])
    span = max(hi_x - lo_x, hi_y - lo_y)
    q = lambda v, lo: np.where(ok, np.clip((v - lo) / span, 0, 1) * 65000, 65535).astype(np.uint16)  # noqa: E731
    region = m["super_class"].fillna("unknown").astype(str)
    names = sorted(region.unique())
    return {
        "dataset": "BANC v888 (Bates et al. 2026)", "n": int(c.n_neurons), "n_edges": int(c.n_edges),
        "synapses": int(np.abs(c.weights).sum()),
        "width": float((hi_x - lo_x) / span), "height": float((hi_y - lo_y) / span),
        "x": b64(q(x, lo_x)), "y": b64(q(y, lo_y)),
        "cls": b64(region.map({n: i for i, n in enumerate(names)}).to_numpy(np.uint8)), "classes": names,
        "groups": {k: v.tolist() for k, v in circ.groups.items()},
        "n_descending": int(len(circ.descending)), "n_motor": int(len(circ.motor)),
        "inputs": INPUTS, "outputs": OUTPUTS,
    }


def experiments(c, circ: Circuit, ms: float = 200.0) -> list[dict]:
    def run(exps, lesion=None):
        b = Brain(c, n_flies=len(exps), seed=1)
        b.set_input([[(circ[g], hz) for g, hz in inputs] for _, _, inputs in exps])
        if lesion is not None:
            b.silence(lesion)
        raster: list = []
        b.run(ms, raster=raster)
        return b, raster

    plain, lesioned = EXPERIMENTS[:-1], EXPERIMENTS[-1:]
    out = []
    for exps, (b, raster) in ((plain, run(plain)), (lesioned, run(lesioned, circ["looming"]))):
        steps = np.concatenate([np.full(s.size, t, np.uint16) for t, s in raster]) if raster else np.empty(0, np.uint16)
        flat = np.concatenate([s for _, s in raster]) if raster else np.empty(0, np.int64)
        fly, nrn = np.divmod(flat, c.n_neurons)
        for f, (name, desc, inputs) in enumerate(exps):
            sel = fly == f
            st, nu = steps[sel], nrn[sel].astype(np.uint32)
            hz = {g: float(np.isin(nu, circ[g]).sum() / len(circ[g]) / (ms / 1000)) for g in OUTPUTS}
            out.append({
                "name": name, "desc": desc, "inputs": [g for g, _ in inputs], "ms": ms, "dt": b.p.dt,
                "spikes": int(nu.size), "active": int(np.unique(nu).size), "hz": hz,
                "steps": b64(st), "neurons": b64(nu),
            })
            print(f"  {name:20s} {nu.size:8d} spikes {np.unique(nu).size:7d} neurons")
    return out


def swarm_payload(logs: dict[str, pd.DataFrame], spikes: list, cfg: Config, gran: int, live: bool,
                  started: str | None = None) -> dict:
    """spikes[j][f] = (neuron idx, counts) for candle j, fly f (aligned to the last len(spikes) candles)."""
    flies = []
    n = len(next(iter(logs.values())))
    for f, (product, out) in enumerate(logs.items()):
        candles = [{
            "t": t.isoformat(), "o": r.open, "h": r.high, "l": r.low, "c": r.close, "v": r.volume,
            "mz": None if pd.isna(r.momentum_z) else round(float(r.momentum_z), 3),
            "tz": None if pd.isna(r.trend_z) else round(float(r.trend_z), 3),
            "in": {g: round(float(r[g]), 1) for g in INPUTS},
            "out": {k[4:]: round(float(r[k]), 1) for k in out.columns if k.startswith("out_")},
            "action": r.action, "pos": float(r.pos), "eq": float(r.fly_equity), "hodl": float(r.hodl_equity),
        } for t, r in out.iterrows()]
        idx = [s[f][0] for s in spikes]
        cnt = [s[f][1] for s in spikes]
        off = np.cumsum([0] + [len(a) for a in idx]).astype(np.uint32)
        flies.append({
            "product": product, "candles": candles, "trades": trades(out), "summary": summarize(out),
            "spikes": {
                "from": n - len(spikes),
                "idx": b64(np.concatenate(idx) if idx else np.empty(0, np.uint32)),
                "cnt": b64(np.concatenate(cnt) if cnt else np.empty(0, np.uint8)),
                "off": b64(off),
            },
        })
    return {
        "live": live, "started": started, "updated": pd.Timestamp.now(tz="UTC").isoformat(),
        "granularity": gran, "brain_ms": cfg.brain_ms, "fee": cfg.fee, "start_cash": 10_000,
        "flies": flies,
    }
