# Ember Pump Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/pranatakripto95/ember-pump-paper-sprint/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/pranatakripto95/ember-pump-paper-sprint/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the Pump.fun Paper Sprint: it trades 10 SOL of
paper money on a 6-hour replay of pump.fun bonding-curve activity. No real
funds, no real trades — the house replay scorer runs this bot over recorded
chain data and scores what it would have made.

## The idea

Most pump.fun coins die within minutes. In the dev window (1,223 coins,
~127k trades) the median coin peaks only +15% over its first trade and ends
-6% down — and after any momentum signal the median coin is -3% within 50
slots and -25% within 800. Chasing pops loses, however the exits are tuned:
momentum entries, tight stops and fast scalps all graded negative.

But the tail is fat: 184 coins spike 2x or more, 99 hit 3x, 60 hit 5x, and
35 complete (migrate) at roughly 8–15x their first trade. And coins that
have already built real demand behave differently from fresh launches. So
this bot buys the **pullback on proven coins, not the pop**.

## Strategy

**Entry** — all must hold:

- real SOL reserve at least 20 SOL (proven liquidity and demand)
- at least 30 trades, with buys at least 55% of traded SOL
- the coin has peaked at least +50% over its first price — it proved it
  can run
- price has since retraced to at most 80% of that peak — buy the dip on
  a proven runner, not the top
- one buy per mint, ever — breadth beats doubling down

Stake is 0.05 SOL per coin.

**Exits** — checked every batch for every held position:

- stop loss at -10% of cost — cut the loser
- take profit at +35% of cost
- trailing stop: once a position peaks at +20%, sell if it falls to 88%
  of that peak — 2–10x runners are banked, not capped
- stall exit: held over ~6 minutes and still under water — sell and free
  the slot for the next coin
- no position squats longer than ~16 minutes below +15%

A buy counts only when it fills; a rejected or failed buy is retried after
a short cooldown while the entry window is still open. Sells use wide
slippage so exits execute; buys use 30% slippage so fast movers are not
rejected for moving in the 2-slot latency.

Round-trip cost is ~1.25% curve fees each way plus 0.000105 SOL in
transaction fees per order. The guardrail needs at least 20 coins
round-tripped at 0.01 SOL or more, with max drawdown under 50%.

## Results

Graded with the kit's own grader (`grade-local`, process driver) on the
dev window, and on rebuilt stress copies of it. The variant shipped here
was picked for the best stress median, not the luckiest dev score.

| variant | dev net PnL | stress median (10 copies) | stress p10 / p90 | coins | win rate | max drawdown |
|---|---|---|---|---|---|---|
| **v1 (this bot)** | **−0.034 SOL** | **−0.06 SOL** | −0.18 / −0.01 | 72 | 31.9% | 1.34% |
| v2 trail keep 92% | −0.054 SOL | −0.07 SOL | −0.19 / −0.01 | 72 | 31.9% | 1.45% |

v2 was tried and rejected on evidence: worse on dev and worse on stress.
The shipped bot is v1 with the rejected experiment documented in
`main.ts`. Guardrails met with room to spare (72 round trips ≥ 0.01 SOL,
drawdown 1.34% vs the 50% cap), and the two grading executions reproduce
byte for byte. Honest expectation: dev is breakeven and 9 of 10 stress
copies lose money — the final 6-hour window is a lottery over fresh
coins, and this is the most robust variant found, not the luckiest.

## Determinism

Every decision is pure integer (BigInt) math on the replay state. No clock,
no environment, no randomness — the two grading runs agree byte for byte.

## Layout

- `main.ts` — the whole strategy (hand-written, zero dependencies)
- `vendor/makefun-bot.ts` — the kit's replay shim, copied byte-identical
  from the competition kit (`sdk/ts/makefun-bot.ts`)

Run locally with the kit's grader:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```
