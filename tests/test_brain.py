import numpy as np

from flybrain.brain import Brain
from flybrain.connectome import Connectome


def chain(weight: float) -> Connectome:
    """Neuron 0 -> neuron 1 with `weight` signed synapses; neuron 2 is unconnected."""
    return Connectome(
        root_ids=np.array([10, 11, 12]),
        indptr=np.array([0, 1, 1, 1]),
        targets=np.array([1], dtype=np.int32),
        weights=np.array([weight], dtype=np.float32),
    )


def drive(c: Connectome, lesion: bool = False) -> np.ndarray:
    b = Brain(c, seed=0)
    b.set_input([[(np.array([0]), 200.0)]])
    if lesion:
        b.silence(np.array([0]))
    return b.run(200.0)[0]


def test_silent_brain_stays_silent():
    assert Brain(chain(50), seed=0).run(100.0).sum() == 0


def test_flies_in_a_swarm_are_independent():
    b = Brain(chain(50), n_flies=3, seed=0)
    b.set_input([[], [(np.array([0]), 200.0)], []])
    counts = b.run(200.0)
    assert counts[0].sum() == 0 and counts[2].sum() == 0
    assert counts[1, 0] > 0 and counts[1, 1] > 0


def test_reset_returns_to_rest():
    b = Brain(chain(50), seed=0)
    b.set_input([[(np.array([0]), 200.0)]])
    b.run(50.0)
    b.reset()
    b.set_input(None)
    assert b.run(50.0).sum() == 0


def test_adaptation_slows_a_driven_neuron():
    from flybrain.brain import Params
    plain = Brain(chain(50), seed=0)
    tired = Brain(chain(50), params=Params(adapt=5.0), seed=0)
    for b in (plain, tired):
        b.set_input([[(np.array([0]), 400.0)]])
    assert tired.run(200.0)[0, 1] < plain.run(200.0)[0, 1]


def test_poisson_input_forces_spikes_at_rate():
    counts = drive(chain(50))
    assert 25 <= counts[0] <= 60  # ~40 expected at 200 Hz for 200 ms


def test_strong_excitatory_connection_propagates():
    counts = drive(chain(50))  # 50 synapses * 0.275 mV = 13.75 mV kick, threshold is 7 mV above rest
    assert counts[1] > 0
    assert counts[2] == 0


def test_weak_connection_does_not_propagate():
    assert drive(chain(2))[1] == 0  # 0.55 mV per spike leaks away


def test_inhibitory_connection_does_not_propagate():
    assert drive(chain(-50))[1] == 0


def test_lesion_cuts_output_but_not_firing():
    counts = drive(chain(50), lesion=True)
    assert counts[0] > 0
    assert counts[1] == 0
