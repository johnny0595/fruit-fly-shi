"""Quick check that the port reproduces the known circuits before trusting it with trades."""

from __future__ import annotations

import time

from .brain import Brain
from .connectome import load
from .neurons import Circuit


def main(ms: float = 300.0) -> None:
    t0 = time.time()
    c = load()
    circ = Circuit.build(c)
    print(f"connectome: {c.n_neurons:,} neurons, {c.n_edges:,} connections ({time.time() - t0:.1f}s)")
    print(f"sugar={len(circ.sugar)} bitter={len(circ.bitter)} looming={len(circ.looming)} "
          f"mn9={len(circ.mn9)} giant_fibre={len(circ.giant_fibre)}")

    def trial(name, inputs, lesion=None):
        b = Brain(c, seed=1)
        if inputs:
            import numpy as np
            idx = np.concatenate([i for i, _ in inputs])
            rates = np.concatenate([np.full(len(i), r) for i, r in inputs])
            b.set_input(idx=idx, rates=rates)
        if lesion is not None:
            b.silence(lesion)
        t = time.time()
        counts = b.run(ms)
        hz = lambda ix: counts[ix].sum() / len(ix) / (ms / 1000)  # noqa: E731
        print(f"{name:28s} MN9 {hz(circ.mn9):6.1f} Hz   GiantFibre {hz(circ.giant_fibre):6.1f} Hz"
              f"   active neurons {int((counts > 0).sum()):6d}   ({time.time() - t:.1f}s)")

    trial("silence", [])
    trial("sugar 100Hz", [(circ.sugar, 100)])
    trial("sugar 100Hz + bitter 100Hz", [(circ.sugar, 100), (circ.bitter, 100)])
    trial("bitter 100Hz", [(circ.bitter, 100)])
    trial("looming 150Hz", [(circ.looming, 150)])
    trial("looming 150Hz, LC4/LPLC2 cut", [(circ.looming, 150)], lesion=circ.looming)


if __name__ == "__main__":
    main()
