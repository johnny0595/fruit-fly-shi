"""
uv run flybrain                        # how the live swarm is doing right now
uv run flybrain probe                  # check the circuits reproduce known biology
uv run flybrain export                 # backtest the swarm, write dashboard/{brain,swarm}.json
uv run flybrain live                   # trade forever in this terminal, dashboard on :8765
uv run flybrain install                # run `live` as a background service (login, crash, reboot safe)
uv run flybrain status | uninstall
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from . import market, probe
from .connectome import load
from .dashdata import DASHBOARD, brain_map, experiments, swarm_payload, write
from .neurons import Circuit
from .trader import Config, backtest

ROOT = Path(__file__).resolve().parents[2]
COINS = ["BTC-USD", "ETH-USD", "SOL-USD", "DOGE-USD", "XRP-USD", "AVAX-USD"]
LABEL = "com.flybrain.swarm"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def cmd_export(a: argparse.Namespace) -> None:
    c = load()
    circ = Circuit.build(c)
    print("brain map + experiments ...")
    write(DASHBOARD / "brain.json", {"brain": brain_map(c, circ), "experiments": experiments(c, circ)})
    cfg = Config()
    need = a.candles + cfg.vol_window + cfg.trend_window
    frames = {p: market.candles(p, a.gran, need) for p in a.products}
    print(f"backtest: {len(frames)} flies x {a.candles} candles of {a.gran}s")
    logs, spikes = backtest(frames, cfg)
    write(DASHBOARD / "swarm.json", swarm_payload(logs, spikes, cfg, a.gran, live=False))
    for p, out in logs.items():
        print(f"  {p:9s} fly {out['fly_equity'].iloc[-1] - 1:+7.2%}   hodl {out['hodl_equity'].iloc[-1] - 1:+7.2%}   "
              f"escapes {(out['action'] == 'ESCAPE').sum():3d}   in market {(out['pos'] > 0).mean():.0%}")
    print(f"wrote {DASHBOARD}/brain.json and swarm.json")


def cmd_live(a: argparse.Namespace) -> None:
    from .live import Live, serve
    serve(a.port)
    Live(a.products, a.gran).forever()


def cmd_install(a: argparse.Namespace) -> None:
    uv = subprocess.run(["which", "uv"], capture_output=True, text=True).stdout.strip() or "uv"
    args = [uv, "run", "--project", str(ROOT), "flybrain", "live", *a.products, "--gran", str(a.gran), "--port", str(a.port)]
    (ROOT / "results").mkdir(exist_ok=True)
    log = ROOT / "results" / "swarm.log"
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array>{''.join(f'<string>{x}</string>' for x in args)}</array>
  <key>WorkingDirectory</key><string>{ROOT}</string>
  <key>EnvironmentVariables</key><dict><key>PYTHONUNBUFFERED</key><string>1</string><key>PATH</key><string>{os.environ.get('PATH', '/usr/bin:/bin')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
""")
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST)], check=True)
    print(f"installed {PLIST}\n  trading {', '.join(a.products)} every {a.gran}s, forever\n"
          f"  dashboard http://localhost:{a.port}/   log {log}")


def cmd_uninstall(_: argparse.Namespace) -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    PLIST.unlink(missing_ok=True)
    print("stopped and removed the swarm service (its trade log in results/live is kept)")


def cmd_status(_: argparse.Namespace) -> None:
    r = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], capture_output=True, text=True)
    if r.returncode:
        print("not installed")
        return
    for line in r.stdout.splitlines():
        if any(k in line for k in ("state =", "pid =", "last exit code")):
            print(line.strip())
    log = ROOT / "results" / "swarm.log"
    if log.exists():
        print("--- last log lines ---")
        sys.stdout.writelines(log.read_text().splitlines(keepends=True)[-8:])


def cmd_overview(_: argparse.Namespace) -> None:
    """Bare `flybrain`: a one-screen report on the live swarm."""
    import pandas as pd

    from .live import LIVE
    from .trader import Config, account

    r = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], capture_output=True, text=True)
    running = r.returncode == 0 and "state = running" in r.stdout
    print(f"service   {'running' if running else 'not running (uv run flybrain install)'}"
          f"{'   dashboard http://localhost:8765/' if running else ''}")
    log_path = LIVE / "decisions.csv"
    if not log_path.exists():
        print("no live trades yet")
    else:
        log = pd.read_csv(log_path, parse_dates=["time"])
        n = log["time"].nunique()
        print(f"candles   {n} since {log['time'].min():%b %d %H:%M} UTC, last {log['time'].max():%b %d %H:%M} UTC\n")
        print(f"  {'coin':9s}{'price':>13s}  {'now':8s}{'pos':>5s}{'MN9':>8s}{'GF':>7s}{'fly':>9s}{'hodl':>9s}")
        tot_fly = tot_hodl = 0.0
        for p_, rows in log.groupby("product", sort=False):
            rows = rows.set_index("time").sort_index()
            out = account(rows.drop(columns=["product", "open", "high", "low", "close", "volume"]),
                          rows[["open", "high", "low", "close", "volume"]], Config())
            last = out.iloc[-1]
            fly, hodl = last.fly_equity - 1, last.hodl_equity - 1
            tot_fly += fly; tot_hodl += hodl
            print(f"  {p_:9s}{last.close:>13,.4f}  {last.action:8s}{last.pos:>5.2f}{last.out_mn9:>6.0f}Hz{last.out_giant_fibre:>5.0f}Hz"
                  f"{fly:>+9.2%}{hodl:>+9.2%}")
        k = log["product"].nunique()
        print(f"  {'swarm':9s}{'':13s}  {'':8s}{'':5s}{'':8s}{'':7s}{tot_fly / k:>+9.2%}{tot_hodl / k:>+9.2%}")
    print("\ncommands  probe · export · live · install · status · uninstall   (uv run flybrain -h)")


def main() -> None:
    p = argparse.ArgumentParser(prog="flybrain", description="A swarm of real fruit fly CNS connectomes paper-trading crypto.")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("probe", help="check sugar->MN9, bitter, looming->Giant Fibre->TTMn")
    for name, gran in (("export", 3600), ("live", 300), ("install", 300)):
        sp = sub.add_parser(name)
        sp.add_argument("products", nargs="*", default=COINS)
        sp.add_argument("--gran", type=int, default=gran, help="candle size in seconds")
        if name == "export":
            sp.add_argument("--candles", type=int, default=300)
        else:
            sp.add_argument("--port", type=int, default=8765)
    sub.add_parser("uninstall")
    sub.add_parser("status")
    a = p.parse_args()
    {None: cmd_overview, "probe": lambda _: probe.main(), "export": cmd_export, "live": cmd_live, "install": cmd_install,
     "uninstall": cmd_uninstall, "status": cmd_status}[a.cmd](a)


if __name__ == "__main__":
    main()
