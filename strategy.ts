// Established-tape trailer: a Sharpe-first pump.fun paper bot (agent-fun/replay/v2).
//
// Finding that drives this design (measured on the dev window, not guessed):
// the typical pump.fun coin bleeds after its early pump — the median forward
// return from any entry point is 0.54-0.83x over the next 600 slots. Buying
// dips, chasing pumps, or sniping early all lose money on this data (the
// house's own momentum/sniper/reversion pilots lose -0.5 to -9.4 SOL here),
// and a 2-slot execution latency destroys any edge that depends on instant
// fills. The cohort that survives is the established tape: coins that have
// already attracted >= 60 trades, >= 50 distinct buyers and >= 12 SOL of
// cumulative buys. From the moment a coin first reaches that tape, a fast
// trailing exit (arm +10%, sell on an 8% pullback from the peak, hard stop
// -3%, at most 200 slots held) is net positive — and the optimum is flat,
// not a spike: stake 0.02-0.03 SOL, hold 200-300 slots, tape 50-60 trades
// all score +0.03 to +0.08 SOL with hourly-Sharpe proxy 0.17-0.24, stable
// across failed-tx draws and strongly positive on the first half of the
// window (the second half is near zero, a regime effect shared by every
// variant tested).
//
// Entry (checked on the batch where the coin last traded; a coin is decided
// once, at the first batch where all of this holds):
//   - tape: >= 60 trades, >= 50 distinct buyers, cumulative buy SOL >= 12,
//     cumulative sell SOL >= 4 (a real two-sided market, not a dev pump);
//   - real SOL reserve in [1.5, 80] (deep enough to absorb a 0.03 SOL buy
//     inside the 1%-of-reserve size cap);
//   - creator's own cumulative buys <= 10 SOL;
//   - flow: at least 6 buys among the last 20 trades (buyers still there).
//   - buy slippage is tight (200 bps): a fill that ran away from the
//     decision price in the 2 latency slots is rejected for free, so the
//     bot never chases a spike.
//
// Sizing: one fixed stake (0.03 SOL) per coin, one buy per coin ever, at most
// 5 open positions. The stake is small enough that one bad coin cannot move
// hourly equity much — the score is the hourly Sharpe ratio, so steady
// small hours beat a lucky moonshot — yet big enough that the fixed
// 105,000-lamport tx fee stays ~0.35% of it.
//
// Exit (checked every batch for every holding; the cost basis is the actual
// fill price, inferred from the fill's quote over tokens received, never the
// decision price, which the latency can move by percent):
//   - trailing: once the price is >= entry * 1.10, remember the peak; sell
//     everything when the price falls 8% below the peak;
//   - hard take-profit: price >= entry * 2.50 -> sell everything;
//   - stop-loss: price <= entry * 0.97 -> sell everything;
//   - time stop: held longer than 200 slots -> sell (the cohort's edge
//     decays fast; do not ride the bleed);
//   - stale: no trade on the coin for 1000 slots -> sell.
//
// Fees: a round trip pays ~1.25% curve fee each way plus 105,000 lamports
// per tx, so break-even is a ~3.5% price move on a 0.03 SOL stake. The
// trailing stop banks the +10%-and-better runs that pay for the -3% cuts;
// the measured win rate is ~40% with a max drawdown of 0.006.
//
// Determinism: no clock, no environment, no Math.random. All state derives
// from the batches the harness delivers, in delivery order.

import type { BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL staked per coin (lamports). */
  stakeLamports: bigint;
  /** Minimum tape depth at entry. */
  minTrades: number;
  minBuyers: number;
  minBuySol: number;
  minSellSol: number;
  /** Real SOL reserve range at entry. */
  minReserveSol: number;
  maxReserveSol: number;
  /** Creator's own cumulative buys, SOL cap. */
  maxCreatorBuySol: number;
  /** A single sell this big (share of real reserve, bps) blocks entry. */
  bigSellBps: number;
  bigSellQuietSlots: number;
  /** Flow window (last N trades) for the entry check. */
  flowTrades: number;
  minFlowBuys: number;
  /** Max price range (high-low)/low over the flow window, in bps (0 = off):
      only enter a quiet, consolidating tape so the 2-slot latency cannot
      move the fill far from the decision price. */
  maxRangeBps: number;
  /** Arm the trailing stop once the price is this far above entry (bps). */
  trailArmBps: number;
  /** Sell when the price falls this far below the peak (bps). */
  trailDropBps: number;
  /** Hard take-profit / stop-loss, in bps from the entry price. */
  tpBps: number;
  slBps: number;
  /** Sell after holding this long, in slots. */
  maxHoldSlots: number;
  /** Sell when the coin has not traded for this long, in slots. */
  staleSlots: number;
  /** Slippage tolerance for buys (bps). Sells use 10000: exits must get out. */
  slippageBps: number;
  /** Rolling window (trades) kept per coin for the flow check. */
  windowTrades: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 30_000_000n,
  minTrades: 60,
  minBuyers: 50,
  minBuySol: 12,
  minSellSol: 4,
  minReserveSol: 1.5,
  maxReserveSol: 80,
  maxCreatorBuySol: 10,
  bigSellBps: 2500,
  bigSellQuietSlots: 0,
  flowTrades: 20,
  minFlowBuys: 6,
  maxRangeBps: 0,
  trailArmBps: 1000,
  trailDropBps: 800,
  tpBps: 15000,
  slBps: 300,
  maxHoldSlots: 200,
  staleSlots: 1000,
  slippageBps: 200,
  windowTrades: 160,
};

interface TapeTrade {
  slot: number;
  price: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface CoinTape {
  createdSlot: number;
  creator: string;
  trades: TapeTrade[];
  buyers: Set<string>;
  buySol: number;
  sellSol: number;
  creatorBuySol: number;
  lastBigSellSlot: number;
  lastTradeSlot: number;
}

interface Held {
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
  lastTradeSlot: number;
  exiting: boolean;
}

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const vt = Number(curve.virtual_token_reserves);
  if (vt <= 0) return 0;
  return Number(curve.virtual_quote_reserves) / vt;
}

export function createStrategy(p: Params) {
  const tapes = new Map<string, CoinTape>();
  const decided = new Set<string>();
  const held = new Map<string, Held>();
  const pendingBuyPrice = new Map<string, number>();

  function recordTrade(mint: string, slot: number, price: number, buy: boolean, sol: number, user: string, creator: string, reserveSol: number): void {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: slot,
        creator,
        trades: [],
        buyers: new Set(),
        buySol: 0,
        sellSol: 0,
        creatorBuySol: 0,
        lastBigSellSlot: -1e9,
        lastTradeSlot: slot,
      };
      tapes.set(mint, t);
    }
    t.trades.push({ slot, price, buy, sol, user });
    if (t.trades.length > p.windowTrades + 40) t.trades.splice(0, t.trades.length - (p.windowTrades + 40));
    if (buy) {
      t.buyers.add(user);
      t.buySol += sol;
      if (user === creator) t.creatorBuySol += sol;
    } else {
      t.sellSol += sol;
      if (reserveSol > 0 && sol >= (reserveSol * p.bigSellBps) / 10000) t.lastBigSellSlot = slot;
    }
    t.lastTradeSlot = slot;
  }

  function entryOk(mint: string, now: number, reserveSol: number): boolean {
    const t = tapes.get(mint);
    if (t === undefined) return false;
    if (t.trades.length < p.minTrades) return false;
    if (t.buyers.size < p.minBuyers) return false;
    if (t.buySol < p.minBuySol || t.sellSol < p.minSellSol) return false;
    if (reserveSol < p.minReserveSol || reserveSol > p.maxReserveSol) return false;
    if (t.creatorBuySol > p.maxCreatorBuySol) return false;
    if (now - t.lastBigSellSlot < p.bigSellQuietSlots) return false;
    const flow = t.trades.slice(-p.flowTrades);
    let buys = 0;
    let low = Infinity;
    let high = 0;
    for (const tr of flow) {
      if (tr.buy) buys += 1;
      if (tr.price < low) low = tr.price;
      if (tr.price > high) high = tr.price;
    }
    if (buys < p.minFlowBuys) return false;
    if (p.maxRangeBps > 0 && low > 0 && (high - low) / low > p.maxRangeBps / 10000) return false;
    return true;
  }

  return {
    onBatch(state: BotState, batch: { events: any[]; fills?: any[] }): OrderInput[] {
      const orders: OrderInput[] = [];
      const now = state.slot;
      const txFee = state.txFeeLamports();

      // Fold fills: a buy that landed opens a held record at its decision
      // price; a sell that landed closes it. A rejected/failed buy leaves
      // the coin eligible again; a rejected/failed sell clears `exiting`
      // so the exit is retried next batch instead of stranding the coin.
      for (const f of batch.fills ?? []) {
        if (f.status !== 'filled') {
          if (f.side === 'buy') {
            pendingBuyPrice.delete(f.mint);
            decided.delete(f.mint);
          } else {
            const h = held.get(f.mint);
            if (h !== undefined) h.exiting = false;
          }
          continue;
        }
        if (f.side === 'buy') {
          // True cost basis from the fill itself (quote spent net of the
          // 1.25% curve fee, over tokens received) — NOT the decision
          // price: the fill lands 2 slots later, often several percent
          // away, and exits must be measured from what was actually paid.
          const spent = Number(f.quote_lamports);
          const tokens = Number(f.token_amount);
          // Lamports per token, same units as priceOf(): quote net of the
          // 1.25% curve fee, over tokens received.
          const ep = tokens > 0 ? (spent * (10000 / 10125)) / tokens : 0;
          pendingBuyPrice.delete(f.mint);
          if (!held.has(f.mint) && ep > 0) {
            held.set(f.mint, { entryPrice: ep, peakPrice: ep, entrySlot: f.slot, lastTradeSlot: f.slot, exiting: false });
          }
        } else {
          held.delete(f.mint);
        }
      }
      // Positions the harness closed for us (complete / flatten) vanish
      // from the account; drop their records too.
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) held.delete(mint);
      }

      // Fold this batch's events into the tapes.
      const traded = new Set<string>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!tapes.has(e.mint)) {
            tapes.set(e.mint, {
              createdSlot: e.slot,
              creator: e.creator,
              trades: [],
              buyers: new Set(),
              buySol: 0,
              sellSol: 0,
              creatorBuySol: 0,
              lastBigSellSlot: -1e9,
              lastTradeSlot: e.slot,
            });
          }
        } else if (e.event === 'TradeEvent') {
          const curve = state.curves.get(e.mint);
          const reserveSol = curve === undefined ? 0 : Number(curve.real_quote_reserves) / 1e9;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          recordTrade(e.mint, e.slot, price, e.is_buy, Number(e.sol_amount) / 1e9, e.user, e.creator, reserveSol);
          traded.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          decided.add(e.mint);
        }
      }

      // Exits first: bank or cut every holding whose rule fired.
      for (const [mint, h] of held) {
        if (h.exiting) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        const price = priceOf(curve);
        if (price <= 0) continue;
        const tape = tapes.get(mint);
        if (tape !== undefined) h.lastTradeSlot = tape.lastTradeSlot;
        if (price > h.peakPrice) h.peakPrice = price;
        let sell = false;
        if (price >= h.entryPrice * (1 + p.tpBps / 10000)) sell = true;
        else if (price <= h.entryPrice * (1 - p.slBps / 10000)) sell = true;
        else if (h.peakPrice >= h.entryPrice * (1 + p.trailArmBps / 10000) && price <= h.peakPrice * (1 - p.trailDropBps / 10000)) sell = true;
        else if (now - h.entrySlot > p.maxHoldSlots) sell = true;
        else if (now - h.lastTradeSlot > p.staleSlots) sell = true;
        if (sell) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          h.exiting = true;
        }
      }

      // Entries: coins that traded in this batch, in first-seen order.
      let free = state.freeCashLamports();
      let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        if (decided.has(mint) || held.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const reserveSol = Number(curve.real_quote_reserves) / 1e9;
        if (!entryOk(mint, now, reserveSol)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < 30_000_000n) continue;
        const amount = p.stakeLamports < cap ? p.stakeLamports : cap;
        if (free < amount + txFee) continue;
        decided.add(mint);
        pendingBuyPrice.set(mint, priceOf(curve));
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.slippageBps });
        free -= amount + txFee;
        slots -= 1;
      }
      return orders;
    },
  };
}
