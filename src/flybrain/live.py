"""Trade forever: the swarm paper-trades every new candle, survives restarts, and
serves the dashboard locally with live data.

State lives in results/live/:
  state.json      settings and when the run started
  decisions.csv   one row per fly per candle: the full sensory -> motor log
The dashboard's live.json is rebuilt from these after every candle.

A fresh run first replays the last `WARMUP` closed candles (24 h of 5-minute candles),
so there is trade history from the start. If the Mac sleeps or the service is down,
missed candles are replayed in order on the next start (up to 300), so the record has no gaps.
"""

from __future__ import annotations

import functools
import http.server
import json
import threading
import time
import traceback
from pathlib import Path

import pandas as pd

from . import market
from .dashdata import DASHBOARD, swarm_payload, write
from .trader import Config, Swarm, account, senses, sparse_top

LIVE = Path(__file__).resolve().parents[2] / "results" / "live"
SHOW_CANDLES = 500  # candles per fly in live.json
SHOW_SPIKES = 48  # candles of brain activity per fly in live.json
WARMUP = 288  # candles replayed when a run starts from scratch


def serve(port: int) -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DASHBOARD))
    handler.log_message = lambda *a: None  # type: ignore[method-assign]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"dashboard: http://localhost:{port}/", flush=True)


class Live:
    def __init__(self, products: list[str], gran: int, cfg: Config = Config()):
        LIVE.mkdir(parents=True, exist_ok=True)
        self.cfg, self.gran = cfg, gran
        self.state_path, self.log_path = LIVE / "state.json", LIVE / "decisions.csv"
        state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        if state and (state["products"] != products or state["granularity"] != gran):
            raise SystemExit(f"results/live holds a run of {state['products']} @ {state['granularity']}s. "
                             "Move that folder away to start a different run.")
        self.state = state or {"products": products, "granularity": gran,
                               "started": pd.Timestamp.now(tz="UTC").isoformat()}
        self.state_path.write_text(json.dumps(self.state, indent=2))
        self.products = products
        self.log = pd.read_csv(self.log_path, parse_dates=["time"]) if self.log_path.exists() else pd.DataFrame()
        self.spikes: list = []  # recent candles' sparse brain activity, in memory only
        self.swarm = Swarm(len(products), cfg)

    def last_seen(self) -> pd.Timestamp | None:
        return None if self.log.empty else self.log["time"].max()

    def step(self) -> int:
        """Process every closed candle not yet seen. Returns how many were processed."""
        need = self.cfg.vol_window + self.cfg.trend_window + 5
        frames = {p: market.candles(p, self.gran, need + 300) for p in self.products}
        sense = {p: senses(df, self.cfg) for p, df in frames.items()}
        times = sorted(set.intersection(*(set(s.dropna().index) for s in sense.values())))
        last = self.last_seen()
        todo = [t for t in times if last is None or t > last]
        if last is None:
            todo = todo[-WARMUP:]
            print(f"fresh run: replaying the last {len(todo)} candles first", flush=True)
        for n, t in enumerate(todo, 1):
            rows = [sense[p].loc[t] for p in self.products]
            decisions, counts = self.swarm.think(rows)
            new = []
            for f, (p, x, d) in enumerate(zip(self.products, rows, decisions)):
                c = frames[p].loc[t]
                new.append({"time": t, "product": p, "open": c.open, "high": c.high, "low": c.low,
                            "close": c.close, "volume": c.volume, **x.to_dict(),
                            **{f"out_{k}": v for k, v in d["out"].items()}, "action": d["action"], "pos": d["pos"]})
                print(f"{t:%Y-%m-%d %H:%M} {p:9s} ${c.close:>11,.4f}  {d['action']:7s} pos {d['pos']:.2f}  "
                      f"MN9 {d['out']['mn9']:5.1f}Hz  GF {d['out']['giant_fibre']:5.1f}Hz  "
                      f"{d['out']['active']:6d} neurons", flush=True)
            new_df = pd.DataFrame(new)
            new_df.to_csv(self.log_path, mode="a", header=not self.log_path.exists(), index=False)
            self.log = pd.concat([self.log, new_df], ignore_index=True)
            self.spikes = (self.spikes + [[sparse_top(counts[f], 600) for f in range(len(self.products))]])[-SHOW_SPIKES:]
            if n % 24 == 0 and n < len(todo):
                self.publish()  # let the dashboard fill in while a long catch-up runs
        if todo or not (DASHBOARD / "live.json").exists():
            self.publish()
        return len(todo)

    def publish(self) -> None:
        logs = {}
        for p in self.products:
            rows = self.log[self.log["product"] == p].set_index("time").sort_index()
            candles = rows[["open", "high", "low", "close", "volume"]]
            log = rows.drop(columns=["product", "open", "high", "low", "close", "volume"])
            logs[p] = account(log, candles, self.cfg).tail(SHOW_CANDLES)
        n = len(next(iter(logs.values())))
        payload = swarm_payload(logs, self.spikes[-n:], self.cfg, self.gran, live=True, started=self.state["started"])
        write(DASHBOARD / "live.json", payload)

    def forever(self) -> None:
        print(f"trading {', '.join(self.products)} on {self.gran}s candles, forever. "
              f"{len(self.log) // max(1, len(self.products))} candles already in the log.", flush=True)
        while True:
            try:
                self.step()
                wait = self.gran - (time.time() % self.gran) + 5  # just after the next close
            except Exception:  # network blips, exchange hiccups: log, back off, keep going
                traceback.print_exc()
                wait = 30
            time.sleep(wait)
