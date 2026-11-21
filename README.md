[![GTA VI Trophy Rarity Forecast 01](https://make.fun/api/competitions/gta6-trophy-rarity-forecast-01/badge.svg)](https://make.fun/competitions/gta6-trophy-rarity-forecast-01)
[![Rank](https://make.fun/api/competitions/gta6-trophy-rarity-forecast-01/rank/lumuti118.svg)](https://make.fun/competitions/gta6-trophy-rarity-forecast-01)
[![Reward $250](https://make.fun/api/competitions/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/competitions/gta6-trophy-rarity-forecast-01)

# GTA VI Trophy Rarity Forecaster

Forecasts, for every Grand Theft Auto VI trophy on PlayStation 5, its Exophase earn rate one week after launch (2026-11-26T00:00:00Z), as five quantiles per trophy (levels 0.05 / 0.25 / 0.5 / 0.75 / 0.95) on the logit scale.

## How it works

A trophy's earn rate is earners ÷ players tracked, and Exophase refreshes those counts on its own schedule — a refresh jumps the player count up and *dilutes* every rate. So the model decomposes each rate into earners and players, detects refresh jumps in the history (players tracked up >5% between reads), and fits power-law growth to log earners and log players only on reads after the last jump (falling back to all reads when that window is too short). Both are projected to the target; the median is `100 * E(target) / N(target)`, with per-tier slope shrinkage, a platinum cap (median ≤ 2%), and a spread that combines fit residuals, expected refreshes before the target, and horizon length.

A stale-page prior handles launch night: if the whole history is frozen (identical player count and rates on every read) and the horizon is over an hour, a refresh is due, so medians shift down 15% and the spread widens.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `$MAKEFUN_INPUT_DIR` (default `/input`) and writes `$MAKEFUN_OUTPUT_DIR` (default `/output`), one `<name>.out` per `<name>.in` file found. Node 22, stdlib only, offline and deterministic — two runs on the same case write byte-identical output.

---

Built for the [make.fun](https://make.fun/?ref=dbsd46g0) bounty **gta6-trophy-rarity-forecast-01** — forecast GTA VI trophy earn rates in week one, $250 USDC.
