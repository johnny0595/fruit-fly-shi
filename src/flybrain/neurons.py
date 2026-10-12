"""Real BANC neurons used as the trading fly's senses and muscles.

Every group is selected from the published BANC annotations; nothing is hand-picked by id.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .connectome import Connectome

# What each sense is told about the market (see trader.senses).
# Smell (olfactory receptor neurons) and wind (Johnston's organ) were tried and dropped:
# in this LIF model the antennal lobe's reciprocal excitation runs away into a seizure.
INPUTS = {
    "sugar": "Labellum sugar taste: 3-candle momentum up",
    "bitter": "Labellum bitter taste: 3-candle momentum down",
    "looming": "LC4/LPLC2 looming vision: a crash candle",
    "leg_sugar": "Leg sugar taste: 24-candle trend up",
    "leg_bitter": "Leg bitter taste: 24-candle trend down",
}
# What each output means for the position
OUTPUTS = {
    "mn9": "MN9 proboscis motor neuron: feeding, buy",
    "proboscis": "all proboscis motor neurons",
    "giant_fibre": "DNp01 Giant Fibre: escape command",
    "ttmn": "TTMn jump-muscle motor neuron: takeoff, sell everything",
    "mdn": "MDN moonwalker neurons: walk backwards, cut position",
    "p9": "DNp09: walk forward",
}


@dataclass
class Circuit:
    groups: dict[str, np.ndarray]  # every named population, inputs and outputs
    descending: np.ndarray  # all descending neurons (brain -> nerve cord)
    motor: np.ndarray  # all motor neurons (CNS -> muscles)

    def __getitem__(self, name: str) -> np.ndarray:
        return self.groups[name]

    @classmethod
    def build(cls, c: Connectome) -> "Circuit":
        m = c.meta
        fn = m["function_detail"].fillna("")
        sub = m["cell_sub_class"].fillna("")
        labellum, leg = sub.str.startswith("labellum"), sub.str.contains("_leg_taste")
        typ = m["cell_type"]
        groups = {
            "sugar": c.where(labellum & fn.str.startswith("sugar")),
            "bitter": c.where(labellum & fn.str.startswith("bitter")),
            "looming": c.where(typ.isin(["LC4", "LPLC2"])),
            "leg_sugar": c.where(leg & fn.str.startswith("sugar")),
            "leg_bitter": c.where(leg & fn.str.startswith("bitter")),
            "mn9": c.where(typ == "MN9"),
            "proboscis": c.where(m["cell_function"] == "proboscis_motor"),
            "giant_fibre": c.where(typ == "DNp01"),
            "ttmn": c.where(m["cell_function"] == "jump_escape"),  # TTMn
            "mdn": c.where(typ == "MDN"),
            "p9": c.where(typ == "DNp09"),
        }
        empty = [k for k, v in groups.items() if len(v) == 0]
        if empty:
            raise ValueError(f"no neurons found for {empty}")
        return cls(
            groups=groups,
            descending=c.where(m["super_class"] == "descending"),
            motor=c.where(m["super_class"] == "motor"),
        )
