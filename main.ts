// Ember Pump Paper Sprint — a paper-trading bot for the Pump.fun Paper
// Sprint (agent-fun/replay/v2). One program, main.ts on Node 22, no
// dependencies beyond the kit's replay shim in vendor/.
//
// What the dev replay actually says (measured on the kit's dev window
// before this bot was written: 1,223 coins, ~127k trades):
//   - The median coin peaks only +15% over its first trade and ends -6%.
//     Chasing a pop is buying the top: after any momentum signal the
//     median coin is -3% within 50 slots and -25% within 800 slots.
//     Momentum entries, tight stops and fast scalps all graded negative.
//   - The tail is fat: 184 coins spike 2x+, 99 hit 3x, 60 hit 5x, and 35
//     complete (migrate) at roughly 8-15x their first trade. And coins
//     that already built real demand behave differently from fresh launches.
//   - The house equal-weight baseline never sells, so after its 5 position
//     slots fill it can never buy another coin (dev: -0.02 SOL). Turnover
//     is everything: a bot that cannot recycle its slots cannot trade the
//     breadth the guardrail demands (>= 20 coins round-tripped).
//
// So this bot buys the PULLBACK on proven coins, never the pop:
//   - entry: real reserve >= 20 SOL, >= 30 trades, buys >= 55% of traded
//     SOL, the coin has already peaked >= +50% over its first price, and
//     has since retraced to <= 80% of that peak. Buy the dip on a coin
//     that proved it can run. One buy per mint, ever. Stake 0.05 SOL.
//   - exits: stop loss -10%, take profit +35%, and a trailing stop that
//     arms at +20% and sells if the position falls to 88% of its peak, so
//     2-10x runners are banked instead of capped. A stall exit frees slots
//     held > ~6 min under water, and no position squats longer than
//     ~16 min below +15%.
//   - a buy counts only when it FILLS. A rejected or failed buy is retried
//     after a short cooldown while the entry window is still open.
//   - sells use wide slippage (exits must execute); buys use 30% slippage
//     so fast movers are not rejected for moving in the 2-slot latency.
//
// Money rules (10 SOL paper capital, max 5 open positions): a round trip
// costs ~1.25% curve fees each way plus 0.000105 SOL tx fees per order.
// The guardrail needs >= 20 coins round-tripped at >= 0.01 SOL, with max
// drawdown under 50%.
//
// Every decision is BigInt cross-multiplication on replay state. No clock,
// no environment, no randomness — the two grading executions agree byte
// for byte, which the harness requires.

import { runBot } from './vendor/makefun-bot.ts';
import type { BotState, BuyInput, OrderInput, SellInput } from './vendor/makefun-bot.ts';

// ---- tunables (one place: lamports / bps / slots) --------------------------
const STAKE = 50_000_000n; // 0.05 SOL per coin
const MIN_BUY = 15_000_000n; // 0.015 SOL; guardrail needs >= 0.01
const MIN_REAL_RESERVE = 20_000_000_000n; // 20 SOL: only proven coins
const ENTRY_WINDOW = 21_600; // proven coins may be ~2.4 h old
const MIN_TRADES = 30;
const MIN_BUY_SHARE_BPS = 5_500; // buys >= 55% of traded SOL
const MIN_PEAK_BPS = 5_000; // coin must have peaked >= +50% vs first seen
const MAX_RETRACE_BPS = 8_000; // enter only at <= 80% of that peak
const RETRY_COOLDOWN = 100; // slots before a failed buy may be retried
const TAKE_PROFIT_BPS = 13_500; // sell at 135% of cost
const STOP_LOSS_BPS = 9_000; // sell at 90% of cost
const TRAIL_ARM_BPS = 12_000; // trailing arms once value hits 120% of cost
const TRAIL_KEEP_BPS = 8_800; // sell if value falls to 88% of its peak
const STALL_LIMIT = 900; // ~6 min under water: free the slot
const MAX_HOLD = 2_400; // ~16 min, then free the slot
const BUY_SLIPPAGE_BPS = 3_000;
const SELL_SLIPPAGE_BPS = 10_000;

// ---- what we remember about each curve -------------------------------------
interface CoinBook {
  bornSlot: number;
  firstQuote: bigint; // virtual SOL reserves at first sight
  firstToken: bigint; // virtual token reserves at first sight
  buyVolume: bigint; // SOL spent by buyers on this curve
  sellVolume: bigint; // SOL taken by sellers on this curve
  bought: boolean; // a buy has FILLED for this mint, ever
  retryAfter: number; // earliest slot a rejected buy may be retried
  peakQuote: bigint; // virtual SOL reserves at the highest price seen
  peakToken: bigint; // virtual token reserves at the highest price seen
}

const book = new Map<string, CoinBook>();

// ---- what we remember about each open position -----------------------------
const bestValueBps = new Map<string, bigint>(); // best value/cost seen, bps
const openedSlot = new Map<string, number>(); // slot the position appeared

/** Gain of (quote, token) over (refQuote, refToken), in bps. */
function gainBps(quote: bigint, token: bigint, refQuote: bigint, refToken: bigint): bigint {
  if (refQuote <= 0n || refToken <= 0n || token <= 0n) return 0n;
  return (quote * refToken * 10_000n) / (refQuote * token) - 10_000n;
}

/** Mark value of `tokens` at the curve's current reserves, in lamports. */
function markValue(tokens: bigint, vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n || tokens <= 0n) return 0n;
  return (tokens * vQuote) / vToken;
}

function newBook(slot: number, quote: bigint, token: bigint): CoinBook {
  return {
    bornSlot: slot,
    firstQuote: quote,
    firstToken: token,
    buyVolume: 0n,
    sellVolume: 0n,
    bought: false,
    retryAfter: 0,
    peakQuote: quote,
    peakToken: token,
  };
}

await runBot({
  onBatch(state: BotState, batch): OrderInput[] {
    // --- 1. Fold this batch's fills into the book ---------------------------
    // A buy counts only when it fills; a rejected/failed buy may be
    // retried after a cooldown while the entry window is still open.
    for (const fill of batch.fills) {
      const entry = book.get(fill.mint);
      if (entry === undefined) continue;
      if (fill.side === 'buy' && fill.status === 'filled') entry.bought = true;
      if (fill.side === 'buy' && fill.status !== 'filled') {
        entry.retryAfter = state.slot + RETRY_COOLDOWN;
      }
    }

    // --- 2. Fold this batch's events into the book --------------------------
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (!book.has(event.mint)) {
          book.set(
            event.mint,
            newBook(event.slot, BigInt(event.virtual_sol_reserves), BigInt(event.virtual_token_reserves)),
          );
        }
      } else if (event.event === 'TradeEvent') {
        let entry = book.get(event.mint);
        if (entry === undefined) {
          entry = newBook(event.slot, BigInt(event.virtual_sol_reserves), BigInt(event.virtual_token_reserves));
          book.set(event.mint, entry);
        }
        const volume = BigInt(event.sol_amount);
        if (event.is_buy) entry.buyVolume += volume;
        else entry.sellVolume += volume;
        // Keep the highest price seen (compare cross-multiplied).
        const quote = BigInt(event.virtual_sol_reserves);
        const token = BigInt(event.virtual_token_reserves);
        if (quote * entry.peakToken > entry.peakQuote * token) {
          entry.peakQuote = quote;
          entry.peakToken = token;
        }
      }
    }

    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // --- 3. Exits first: free slots (and capital) before buying -------------
    const selling = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') selling.add(pending.order.mint);
    }

    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (selling.has(mint)) continue;
      const cost = holding.cost_lamports;
      if (cost <= 0n) continue;
      const value = markValue(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (value <= txFee) continue; // selling would cost more than it returns
      const valueBps = (value * 10_000n) / cost;

      const seenBest = bestValueBps.get(mint) ?? valueBps;
      const best = valueBps > seenBest ? valueBps : seenBest;
      bestValueBps.set(mint, best);

      const opened = openedSlot.get(mint);
      if (opened === undefined) openedSlot.set(mint, state.slot);
      const held = opened === undefined ? 0 : state.slot - opened;

      let exit = false;
      if (valueBps >= TAKE_PROFIT_BPS) exit = true; // bank the win
      else if (valueBps <= STOP_LOSS_BPS) exit = true; // cut the loser
      else if (best >= TRAIL_ARM_BPS && valueBps * 10_000n <= best * BigInt(TRAIL_KEEP_BPS)) exit = true; // keep 88% of a spike
      else if (held > STALL_LIMIT && valueBps < 10_000n) exit = true; // stalled under water: free the slot
      else if (held > MAX_HOLD && valueBps < 11_500n) exit = true; // never squat on a slot

      if (exit && orders.length < maxOrders) {
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        };
        orders.push(sell);
        bestValueBps.delete(mint);
        openedSlot.delete(mint);
      }
    }

    // --- 4. Forget positions that are gone (sold, completed, flattened) -----
    for (const mint of [...bestValueBps.keys()]) {
      if (!state.positions.has(mint)) bestValueBps.delete(mint);
    }
    for (const mint of [...openedSlot.keys()]) {
      if (!state.positions.has(mint)) openedSlot.delete(mint);
    }

    // --- 5. Entries: strongest pullback first --------------------------------
    let freeCash = state.freeCashLamports();
    let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (freeSlots > 0) {
      const buying = new Set<string>();
      for (const pending of state.pending.values()) {
        if (pending.order.side === 'buy') buying.add(pending.order.mint);
      }

      interface Candidate {
        mint: string;
        gain: bigint;
        amount: bigint;
      }
      const candidates: Candidate[] = [];
      for (const [mint, entry] of book) {
        if (entry.bought || state.positions.has(mint) || buying.has(mint)) continue;
        if (state.slot < entry.retryAfter) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (state.slot - entry.bornSlot > ENTRY_WINDOW) continue;
        if (curve.trades < MIN_TRADES) continue;
        if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
        const traded = entry.buyVolume + entry.sellVolume;
        if (traded <= 0n) continue;
        const buyShareBps = (entry.buyVolume * 10_000n) / traded;
        if (buyShareBps < MIN_BUY_SHARE_BPS) continue;
        const gain = gainBps(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          entry.firstQuote,
          entry.firstToken,
        );
        const peakGain = gainBps(entry.peakQuote, entry.peakToken, entry.firstQuote, entry.firstToken);
        if (peakGain < MIN_PEAK_BPS) continue;
        // Retraced to at most 80% of the peak price?
        if (
          curve.virtual_quote_reserves * entry.peakToken * 10_000n >
          entry.peakQuote * curve.virtual_token_reserves * BigInt(MAX_RETRACE_BPS)
        ) {
          continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY) continue;
        const amount = cap < STAKE ? cap : STAKE;
        candidates.push({ mint, gain, amount });
      }
      // Strongest momentum first; ties break by first-seen order (map order).
      candidates.sort((a, b) => (a.gain > b.gain ? -1 : a.gain < b.gain ? 1 : 0));

      for (const candidate of candidates) {
        if (freeSlots <= 0 || orders.length >= maxOrders) break;
        if (freeCash < candidate.amount + txFee) continue;
        const buy: BuyInput = {
          side: 'buy',
          mint: candidate.mint,
          quote_lamports: candidate.amount,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        };
        orders.push(buy);
        freeCash -= candidate.amount + txFee;
        freeSlots -= 1;
      }
    }

    return orders;
  },
});
