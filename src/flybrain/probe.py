"""Check the circuits reproduce known biology before trusting the flies with trades."""

from __future__ import annotations

import time

from .connectome import load
from .dashdata import experiments
from .neurons import OUTPUTS, Circuit


def main() -> None:
    t0 = time.time()
    c = load()
    circ = Circuit.build(c)
    print(f"BANC brain + nerve cord: {c.n_neurons:,} neurons, {c.n_edges:,} connections ({time.time() - t0:.1f}s)")
    print("  " + "  ".join(f"{k}={len(v)}" for k, v in circ.groups.items()))
    rows = experiments(c, circ)
    print(f"\n  {'':20s}" + "".join(f"{g:>12s}" for g in OUTPUTS) + f"{'active':>9s}")
    for e in rows:
        print(f"  {e['name']:20s}" + "".join(f"{e['hz'][g]:10.1f}Hz" for g in OUTPUTS) + f"{e['active']:9d}")


if __name__ == "__main__":
    main()
