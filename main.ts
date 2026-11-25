// Steady base-rider: a Sharpe-first pump.fun paper bot (agent-fun/replay/v2).
// The strategy lives in strategy.ts; this file only wires it to the harness.
//
// Final design (measured on the dev window): trade only the established
// tape (>= 60 trades, >= 50 buyers, >= 12 SOL buys), 0.03 SOL per coin,
// tight buy slippage (200 bps) so a fill that ran away in the 2-slot
// latency is rejected for free, exits by trailing stop (arm +10%, drop 8%),
// hard stop -3%, hard take-profit +150%, at most 200 slots held. Dev
// grade-local: net +0.0715 SOL, 146 coins, 40.4% win rate, max drawdown
// 0.0064, guardrails met.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
