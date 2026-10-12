"""Load the BANC connectome (Bates et al. 2026, Nature): a whole female fly CNS,
brain and ventral nerve cord in one volume, ~169k neurons and 13.6M connections.

Weights are signed synapse counts:  w[pre, post] = n_synapses * sign(pre)
The sign of each presynaptic neuron (GABA / glutamate / histamine inhibit, everything
else excites, as in Shiu et al. 2024) is taken from, in order of trust:
  1. BANC's experimentally verified transmitter (first listed)
  2. the sign Shiu et al. used for the matched neuron in the FAFB brain
  3. BANC's predicted transmitter
Raw predictions alone miss e.g. the GABAergic APL neuron, and the resulting
excitatory loop sends the olfactory system into a self-sustaining seizure.
"""

from __future__ import annotations

import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.sparse as sp

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "banc"
DATAVERSE = "https://dataverse.harvard.edu/api/access/datafile/{}"  # doi:10.7910/DVN/7WTH1N
SHIU_FAFB = Path(__file__).resolve().parents[2] / "data" / "Connectivity_783.parquet"
SHIU_FAFB_URL = "https://github.com/philshiu/Drosophila_brain_model/raw/main/Connectivity_783.parquet"
SOURCES = {
    "banc_888_meta.feather": 14033740,
    "banc_888_edgelist_simple_v3.feather": 13918810,
}
INHIBITORY = {"gaba", "glutamate", "histamine"}
META_COLUMNS = {
    "super_class": "super_class", "cell_class": "cell_class", "cell_sub_class": "cell_sub_class",
    "cell_type": "cell_type", "cell_function": "cell_function",
    "cell_function_detailed": "function_detail", "body_part_effector": "effector",
    "side": "side", "region": "region", "neurotransmitter_predicted": "nt",
}


@dataclass
class Connectome:
    root_ids: np.ndarray  # (N,) BANC v888 id of each simulator index
    indptr: np.ndarray  # CSR: outgoing edges of neuron i are indptr[i]:indptr[i+1]
    targets: np.ndarray  # postsynaptic index of each edge
    weights: np.ndarray  # signed synapse count of each edge
    meta: pd.DataFrame = field(default_factory=pd.DataFrame)  # one row per index

    @property
    def n_neurons(self) -> int:
        return len(self.root_ids)

    @property
    def n_edges(self) -> int:
        return len(self.targets)

    def where(self, mask) -> np.ndarray:
        """Simulator indices of the neurons where `mask` (over self.meta) is true."""
        return np.flatnonzero(np.asarray(mask, dtype=bool))


def download(data_dir: Path = DATA_DIR) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    for name, file_id in SOURCES.items():
        path = data_dir / name
        if not path.exists():
            print(f"downloading {name} from Harvard Dataverse ...")
            urllib.request.urlretrieve(DATAVERSE.format(file_id), path)
    if not SHIU_FAFB.exists():
        print("downloading Shiu et al. FAFB connectivity (for transmitter signs) ...")
        urllib.request.urlretrieve(SHIU_FAFB_URL, SHIU_FAFB)


def signs(raw: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Per-neuron sign (+1 / -1) and which source decided it."""
    verified = raw["neurotransmitter_verified"].str.split(",").str[0]
    shiu = pd.read_parquet(SHIU_FAFB, columns=["Presynaptic_ID", "Excitatory"])
    shiu = shiu.drop_duplicates("Presynaptic_ID").set_index("Presynaptic_ID")["Excitatory"]
    fafb = pd.to_numeric(raw["fafb_match"], errors="coerce").map(shiu)
    predicted = raw["neurotransmitter_predicted"]

    sign = np.where(predicted.isin(INHIBITORY), -1.0, 1.0)
    source = np.where(predicted.notna(), "predicted", "default").astype(object)
    has = fafb.notna().to_numpy()
    sign[has], source[has] = fafb[has].to_numpy(), "fafb"
    has = verified.notna().to_numpy()
    sign[has], source[has] = np.where(verified[has].isin(INHIBITORY), -1.0, 1.0), "verified"
    return sign.astype(np.float32), source


def load(data_dir: Path = DATA_DIR) -> Connectome:
    cache_csr, cache_meta = data_dir / "csr.npz", data_dir / "meta.parquet"
    if cache_csr.exists() and cache_meta.exists():
        z = np.load(cache_csr)
        return Connectome(z["root_ids"], z["indptr"], z["targets"], z["weights"], pd.read_parquet(cache_meta))

    download(data_dir)
    edges = pd.read_feather(data_dir / "banc_888_edgelist_simple_v3.feather", columns=["pre", "post", "count"])
    raw = pd.read_feather(data_dir / "banc_888_meta.feather").drop_duplicates("banc_888_id").set_index("banc_888_id")

    ids = pd.Index(pd.unique(np.concatenate([edges["pre"].to_numpy(), edges["post"].to_numpy()]))).sort_values()
    pre, post = ids.get_indexer(edges["pre"]), ids.get_indexer(edges["post"])

    raw = raw.reindex(ids)
    sign, source = signs(raw)
    meta = raw[list(META_COLUMNS)].rename(columns=META_COLUMNS)
    meta["sign"], meta["sign_source"] = sign, source
    pos = raw["root_position_nm"].fillna(raw["position"])
    xyz = pos.str.split(",", expand=True).astype(float)
    meta["x"], meta["y"], meta["z"] = xyz[0].to_numpy(), xyz[1].to_numpy(), xyz[2].to_numpy()
    meta = meta.reset_index(drop=True)

    w = edges["count"].to_numpy(np.float32) * sign[pre]
    mat = sp.coo_matrix((w, (pre, post)), shape=(len(ids), len(ids))).tocsr()
    mat.sum_duplicates()
    mat.eliminate_zeros()

    c = Connectome(
        root_ids=ids.to_numpy().astype(np.int64),
        indptr=mat.indptr.astype(np.int64),
        targets=mat.indices.astype(np.int32),
        weights=mat.data.astype(np.float32),
        meta=meta,
    )
    np.savez(cache_csr, root_ids=c.root_ids, indptr=c.indptr, targets=c.targets, weights=c.weights)
    meta.to_parquet(cache_meta)
    return c
