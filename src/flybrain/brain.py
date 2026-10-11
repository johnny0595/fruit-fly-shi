"""Leaky integrate-and-fire simulation of a whole fly CNS, for a swarm of flies at once.

A numpy port of Shiu et al. 2024 (Nature, "A Drosophila computational brain model
reveals sensorimotor processing"), originally written in Brian2:

    dv/dt = (v_0 - v + g) / t_mbr      (frozen while refractory)
    dg/dt = -g / tau                   (frozen while refractory)
    v > v_th  ->  spike;  v = v_rst, g = 0, refractory for t_rfc
    presynaptic spike  ->  g_post += n_syn * sign * w_syn   after t_dly

Sensory neurons are driven by Poisson inputs whose every event kicks v by
w_syn * f_poi = 68.75 mV, i.e. each input event forces a spike (as in Shiu).

Every fly gets an identical copy of the connectome and its own state. State is
stored flat, fly-major: neuron i of fly f lives at f * N + i.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .connectome import Connectome


@dataclass(frozen=True)
class Params:
    dt: float = 0.1  # ms
    v_0: float = -52.0  # mV resting potential
    v_rst: float = -52.0  # mV reset potential
    v_th: float = -45.0  # mV spike threshold
    t_mbr: float = 20.0  # ms membrane time constant
    tau: float = 5.0  # ms synaptic decay
    t_rfc: float = 2.2  # ms refractory period
    t_dly: float = 1.8  # ms synaptic delay
    w_syn: float = 0.275  # mV per synapse -- the model's one free parameter
    f_poi: float = 250.0  # Poisson input scale (w_syn * f_poi = 68.75 mV kick)


class Brain:
    def __init__(self, connectome: Connectome, n_flies: int = 1, params: Params = Params(), seed: int | None = 0):
        self.c = connectome
        self.p = params
        self.F = n_flies
        self.N = connectome.n_neurons
        self.rng = np.random.default_rng(seed)
        size = self.F * self.N

        self.weights = connectome.weights * np.float32(params.w_syn)  # mV
        self.v = np.full(size, params.v_0, dtype=np.float32)
        self.g = np.zeros(size, dtype=np.float32)
        self.step_count = 0

        self._mbr = np.float32(params.dt / params.t_mbr)
        self._decay = np.float32(np.exp(-params.dt / params.tau))
        self._rfc_steps = int(round(params.t_rfc / params.dt))
        self._delay_steps = int(round(params.t_dly / params.dt))
        empty = np.empty(0, np.int64)
        self._pending = [empty] * self._delay_steps  # spikes in flight, by arrival slot
        self._refractory = [empty] * self._rfc_steps  # spikes of the last t_rfc, by slot
        self._poisson_target = np.zeros(size, dtype=bool)  # Poisson targets have rfc = 0 in Shiu

        self._stim_idx = empty
        self._stim_p = np.empty(0, np.float64)
        self._silenced = np.zeros(self.N, dtype=bool)

    # ---- inputs -------------------------------------------------------------
    def set_input(self, drives: list[list[tuple[np.ndarray, float]]] | None) -> None:
        """drives[f] = [(neuron indices, rate Hz), ...] for fly f. None clears all input."""
        if not drives:
            self._stim_idx, self._stim_p = np.empty(0, np.int64), np.empty(0, np.float64)
            return
        idx, p = [], []
        for f, groups in enumerate(drives):
            for neurons, hz in groups:
                if hz > 0 and len(neurons):
                    idx.append(np.asarray(neurons, np.int64) + f * self.N)
                    p.append(np.full(len(neurons), hz * self.p.dt / 1000.0))
        self._stim_idx = np.concatenate(idx) if idx else np.empty(0, np.int64)
        self._stim_p = np.concatenate(p) if p else np.empty(0, np.float64)
        self._poisson_target[self._stim_idx] = True

    def silence(self, idx: np.ndarray) -> None:
        """Lesion (in every fly): the neurons still spike, but their outgoing synapses carry nothing."""
        self._silenced[np.asarray(idx)] = True

    # ---- dynamics -----------------------------------------------------------
    def _deliver(self, spiked: np.ndarray) -> None:
        fly, nrn = np.divmod(spiked, self.N)
        keep = ~self._silenced[nrn]
        fly, nrn = fly[keep], nrn[keep]
        if nrn.size == 0:
            return
        ip = self.c.indptr
        starts = ip[nrn]
        lens = ip[nrn + 1] - starts
        total = int(lens.sum())
        if total == 0:
            return
        # flat edge ids for every outgoing edge of every spiking neuron
        edges = np.repeat(starts - np.cumsum(lens) + lens, lens) + np.arange(total)
        dest = self.c.targets[edges] + np.repeat(fly * self.N, lens)
        np.add.at(self.g, dest, self.weights[edges])

    def step(self) -> np.ndarray:
        """Advance dt; return flat indices (f * N + i) of the neurons that spiked."""
        p, t = self.p, self.step_count
        refractory = np.concatenate(self._refractory)
        frozen_v, frozen_g = self.v[refractory], self.g[refractory]

        dv = self.g - self.v
        dv += p.v_0
        dv *= self._mbr
        self.v += dv
        self.g *= self._decay
        self.v[refractory], self.g[refractory] = frozen_v, frozen_g

        if self._stim_idx.size:
            hits = self._stim_idx[self.rng.random(self._stim_idx.size) < self._stim_p]
            self.v[hits] += p.w_syn * p.f_poi

        spiked = np.flatnonzero(self.v > p.v_th)
        if spiked.size:
            self.v[spiked] = p.v_rst
            self.g[spiked] = 0.0
        self._refractory[t % self._rfc_steps] = spiked[~self._poisson_target[spiked]]

        slot = t % self._delay_steps  # spikes emitted t_dly ago arrive now
        if self._pending[slot].size:
            self._deliver(self._pending[slot])
        self._pending[slot] = spiked

        self.step_count += 1
        return spiked

    def run(self, ms: float, raster: list | None = None) -> np.ndarray:
        """Advance every fly by `ms`; return spike counts, shape (n_flies, N).
        If `raster` is a list, (step, flat spiked indices) pairs are appended to it."""
        counts = np.zeros(self.F * self.N, dtype=np.int32)
        for _ in range(int(round(ms / self.p.dt))):
            t = self.step_count
            spiked = self.step()
            if spiked.size:
                counts[spiked] += 1
                if raster is not None:
                    raster.append((t, spiked))
        return counts.reshape(self.F, self.N)
