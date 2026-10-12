# flybrain: a swarm of real fruit-fly nervous systems paper-trading crypto

Each fly is the **BANC** connectome (Bates et al., Nature 2026): one female *Drosophila*'s whole
central nervous system, brain **and** ventral nerve cord, with 169,078 neurons and 13.6M connections.
Every neuron is a leaky integrate-and-fire unit from [Shiu et al. 2024](https://github.com/philshiu/Drosophila_brain_model).
Six flies trade six coins at once, one brain each, simulated together. Nothing is trained.

```
3-candle momentum up   -> 90 labellum sugar neurons ┐                        ┌> MN9 rate      -> position size
3-candle momentum down -> 48 labellum bitter        │                        ├> MDN fires     -> halve it
24-candle trend up/down-> 367 leg taste neurons     ├> 169,078 LIF neurons ──┤
crash candle           -> 294 LC4/LPLC2 looming     ┘   brain + nerve cord   └> Giant Fibre   -> sell everything
                                                                                (-> TTMn jump muscle in the nerve cord)
```

## Run

```sh
uv run flybrain probe        # check sugar->MN9, bitter suppression, looming->Giant Fibre->TTMn, lesion
uv run flybrain export       # 6-coin backtest -> dashboard/brain.json + swarm.json (~12 min)
uv run flybrain install      # trade forever as a background service; dashboard at http://localhost:8765
uv run flybrain status       # is it running, last log lines
uv run flybrain uninstall    # stop it (the trade log in results/live/ is kept)
uv run pytest
```

The first run downloads about 420 MB of BANC data from Harvard Dataverse into `data/banc/`.

The service runs `flybrain live` under launchd. It starts at login, restarts within 30 s if it crashes,
and replays any 5-minute candles it missed while the Mac was asleep. Every decision of every fly is appended
to `results/live/decisions.csv`.

## Model notes

- **Transmitter signs** come from, in order: BANC's verified transmitter, Shiu's FAFB sign for the matched
  neuron, then BANC's prediction. Predictions alone leave the GABAergic APL neuron excitatory and the olfactory
  system seizes.
- **Smell and wind inputs were dropped.** Even with corrected signs, the antennal lobe's reciprocal excitation
  runs away into a self-sustaining seizure in this model, because LIF neurons never tire. `Params(adapt=...)`
  adds spike-frequency adaptation for experiments. It is off by default, so the model stays pure Shiu.
- **Each candle is a fresh 150 ms trial from rest**, so a runaway can never carry into later trades.
- **Speed:** one candle for all six flies (6 × 150 ms of brain time) takes about 2.3 s on an M1 Max CPU, which is
  plenty for 5-minute candles. No GPU needed.

## Results so far

Backtest on 324 hourly candles ending Oct 11 2026: every fly lost money (−1.5% to −5.8%). In a falling market,
5 of 6 lost less than buy-and-hold because they sat in cash about 88% of the time. It is a momentum filter built from
a fly. Don't trade with it.
