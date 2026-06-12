/**
 * Portfolio orchestration: filter → clear N slots → pace winners → mint tokens.
 *
 * Hot-path cost per request:
 *   - 1 sync call into CampaignIndex (in-memory, host-managed cache)
 *   - 1 O(depth × N) clearing loop with no allocations beyond a small bitmap
 *   - 1 Redis round-trip for batched pacing reservation of the *winners* only
 *   - depth HMAC signs (each ~1µs)
 *   - 1 Postgres read for balances (could be served from a cache by the host)
 *
 * Pacing is consulted AFTER ranking — we only reserve budget for slots we
 * actually intend to serve. If a winner's bucket is empty we drop that slot
 * and the queue ships shorter. The alternative (pace at eligibility) requires
 * refund logic for losers and creates cascade-elevation effects that are
 * hard to reason about. Revisit if pacing fidelity becomes a problem.
 */

import { clearPortfolio } from './auction.js';
import type { EnginePorts } from './ports.js';
import { fnv1a32, deriveSeed } from './rng.js';
import type {
  EngineConfig,
  PortfolioRequest,
  PortfolioResult,
  ServedAd,
} from './types.js';

export function makeRunPortfolio(deps: EnginePorts, cfg: EngineConfig) {
  return async function runPortfolio(req: PortfolioRequest): Promise<PortfolioResult> {
    const nowMs = req.nowMs ?? deps.clock.nowMs();
    const seed = req.rngSeed ?? deriveSeed(req.userId, req.surfaceId, nowMs >>> 10);
    const rng = deps.rng.seed(seed);

    const candidates = deps.campaignIndex.candidatesFor(req);

    const clearings = clearPortfolio(candidates, cfg.reserveMicros, rng, req.queueDepth);

    let pacedClearings = clearings;
    if (clearings.length > 0) {
      const ids = clearings.map(c => c.winnerCampaignId);
      const grants = await deps.pacing.tryReserveBatch(ids);
      pacedClearings = clearings.filter((_, i) => grants[i] === 1);
    }

    const userIdHash = fnv1a32(req.userId);
    const queue: ServedAd[] = pacedClearings.map(c => ({
      campaignId: c.winnerCampaignId,
      clearingPriceMicros: c.clearingPriceMicros,
      sessionToken: deps.token.sign({
        campaignId: c.winnerCampaignId,
        advertiserId: c.advertiserId,
        clearingPriceMicros: c.clearingPriceMicros,
        userIdHash,
        mode: req.mode,
        surfaceId: req.surfaceId,
        issuedAtMs: nowMs,
      }),
    }));

    const balances = await deps.ledger.readBalances(req.userId);

    return {
      queue,
      ttlMs: cfg.queueTtlMs,
      rotationIntervalMs: cfg.rotationIntervalMs,
      viewThresholdMs: cfg.viewThresholdMs,
      balances,
    };
  };
}
