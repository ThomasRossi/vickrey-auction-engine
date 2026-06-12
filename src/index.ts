/**
 * Public API of the Kickbacks auction engine.
 *
 * The host backend constructs an engine by passing implementations of
 * each port. Tests use `adapters/memory`; production uses Redis +
 * Postgres adapters.
 *
 * Usage:
 *   const engine = createEngine(
 *     {
 *       campaignIndex,
 *       pacing: createRedisPacingStore(redis, { capacity: 1000, refillPerSec: 10 }),
 *       idempotency: createRedisIdempotencyStore(redis),
 *       ledger: createPostgresLedgerRepo(pool),
 *       token: createHmacTokenSigner(secret),
 *       clock: realClock(),
 *       rng: memoryRng,
 *     },
 *     {
 *       reserveMicros: dollarsToMicros(0.01),
 *       rankingMode: 'pure',
 *       queueTtlMs: 60_000,
 *       rotationIntervalMs: 5_000,
 *       viewThresholdMs: 3_000,
 *       tokenLifetimeMs: 120_000,
 *       idempotencyTtlSec: 600,
 *       userShareBps: 5000,
 *       clickWeight: 50,
 *     },
 *   );
 *
 *   app.post('/v1/portfolio', (req) => engine.runPortfolio(toDomain(req.body)));
 *   app.post('/v1/metrics',   (req) => engine.settleEvent(toDomain(req.body)));
 *
 * The host owns wire-format conversion (snake_case ↔ camelCase) and
 * schema validation. The engine deals only in domain types.
 */

import { makeRunPortfolio } from './engine/portfolio.js';
import { makeSettleEvent } from './engine/settlement.js';
import type { EnginePorts } from './engine/ports.js';
import type {
  EngineConfig,
  PortfolioRequest,
  PortfolioResult,
  SettleRequest,
  SettleResult,
} from './engine/types.js';

export interface AuctionEngine {
  runPortfolio(req: PortfolioRequest): Promise<PortfolioResult>;
  settleEvent(req: SettleRequest): Promise<SettleResult>;
}

export function createEngine(deps: EnginePorts, cfg: EngineConfig): AuctionEngine {
  return {
    runPortfolio: makeRunPortfolio(deps, cfg),
    settleEvent: makeSettleEvent(deps, cfg),
  };
}

export type {
  EngineConfig,
  PortfolioRequest,
  PortfolioResult,
  ServedAd,
  BalancesSnapshot,
  SettleRequest,
  SettleResult,
  SettleRejectReason,
  CandidateBid,
  ClearingResult,
  TokenPayload,
  Mode,
  EventKind,
} from './engine/types.js';

export type {
  CampaignIndex,
  PacingStore,
  IdempotencyStore,
  LedgerRepo,
  LedgerTx,
  TokenSigner,
  Clock,
  Rng,
  EnginePorts,
} from './engine/ports.js';

export { clearOneSlot, clearPortfolio } from './engine/auction.js';
export { createHmacTokenSigner } from './engine/token.js';
export {
  dollarsToMicros,
  microsToDollars,
  toCandidateBid,
  userCreditMicros,
  settleDebitMicros,
} from './engine/pricing.js';
export {
  isCampaignLive,
  isEligible,
  matchesTargeting,
} from './engine/eligibility.js';
export type { CampaignRow, TargetingSpec, TargetingRequest } from './engine/eligibility.js';
export { defaultRng, xorshift32, fnv1a32, deriveSeed } from './engine/rng.js';
