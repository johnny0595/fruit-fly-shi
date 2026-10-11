# flybrain — a real fruit fly connectome that trades crypto (on paper)

The whole adult *Drosophila* brain (FlyWire v783: 138,639 neurons, 15M connections,
signed synapse counts) running as leaky integrate-and-fire neurons, a numpy port of
[Shiu et al. 2024](https://github.com/philshiu/Drosophila_brain_model). Nothing is trained.
Market data is fed into real sensory neurons, and trades are read from real motor and
descending neurons.

```
price rising   -> 20 sugar GRNs   ─┐                          ┌─> MN9 (proboscis / feeding)  -> long
price falling  -> 42 bitter GRNs  ─┼─> 138,639 LIF neurons ───┤
crash candle   -> 314 LC4/LPLC2   ─┘   real FlyWire wiring     └─> DNp01 Giant Fibre (escape) -> flat
```

## Run

```sh
uv run flybrain probe                              # check the circuits reproduce known biology
uv run flybrain backtest BTC-USD --gran 3600       # replay 500 hourly candles (~3 min)
uv run flybrain live ETH-USD --gran 300 --cash 1000  # paper-trade new candles as they close
uv run pytest
```

The first run downloads about 135 MB into `data/`. Results go to `results/`.

## Sanity check (`flybrain probe`, 300 ms per trial)

| stimulus | MN9 | Giant Fibre |
|---|---|---|
| nothing | 0 Hz | 0 Hz |
| sugar 100 Hz | 70 Hz | 0 |
| sugar + bitter | 0 Hz | 0 |
| looming 150 Hz | 0 | 267 Hz |
| looming, LC4/LPLC2 output lesioned | 0 | 0 |

## What's real and what's made up

- **Real:** the wiring, synapse counts, neurotransmitter signs, and neuron identities. The sugar to MN9 and looming to Giant Fibre pathways come from the connectome.
- **Model (Shiu et al.):** identical LIF neurons, 0.275 mV per synapse, no plasticity, no neuromodulation.
- **Made up by me:** the market-to-sensory encoding in `trader.py` (`senses`) and the action mapping (MN9 means long, Giant Fibre means flat).

In practice the fly works as a momentum filter. It feeds once 3-candle momentum is above about +1σ
and flees on sharp drops. The filter is built from biology rather than tuned. **There is no reason to
expect it to make money.** On the first BTC hourly backtest (Sep 18 to Oct 11 2026) it lost 3.4% gross
and 10.6% after 0.1% fees, while buy-and-hold made 3.1%.
