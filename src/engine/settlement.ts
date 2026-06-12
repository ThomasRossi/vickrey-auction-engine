/**
 * Settlement: turn a confirmed /v1/metrics event into a ledger transaction.
 *
 * Steps, in order:
 *   1. Verify token MAC + expiry. Reject on bad token.
 *   2. Verify the user posting the event matches the token's bound user.
 *      Compare the cheap fnv1a32 hash; collisions are a non-issue because
 *      the MAC binds the full payload anyway.
 *   3. For impression events, require viewedMs >= viewThresholdMs.
 *   4. Claim an idempotency key on `(tokenHash, eventId)`. If already
 *      claimed, return 'duplicate' — no ledger write.
 *   5. Compute debit/credit and post a single ACID ledger transaction
 *      (which writes an outbox row in the same tx — the adapter's job,
 *      not ours).
 *
 * Demo mode skips the user credit but still debits the (demo) advertiser
 * so spend modeling matches production. Same code path; the LedgerRepo
 * implementation routes by `tx.mode`.
 */

import type { EnginePorts } from './ports.js';
import { fnv1a32 } from './rng.js';
import { settleDebitMicros, userCreditMicros } from './pricing.js';
import type { EngineConfig, SettleRequest, SettleResult } from './types.js';

export function makeSettleEvent(deps: EnginePorts, cfg: EngineConfig) {
  return async function settleEvent(req: SettleRequest): Promise<SettleResult> {
    const nowMs = deps.clock.nowMs();
    const payload = deps.token.verify(req.token, nowMs, cfg.tokenLifetimeMs);
    if (payload === null) {
      // Could be a bad MAC or an expired token; from the client's
      // perspective the distinction doesn't matter — both should drop
      // the queue and refetch.
      return { status: 'rejected', reason: 'bad_token' };
    }

    if (payload.userIdHash !== fnv1a32(req.userId)) {
      return { status: 'rejected', reason: 'user_mismatch' };
    }

    if (req.kind === 'impression') {
      if ((req.viewedMs ?? 0) < cfg.viewThresholdMs) {
        return { status: 'rejected', reason: 'below_view_threshold' };
      }
    }

    const tokenHashHex = deps.token.hash(req.token);
    const idemKey = `${payload.mode}:${tokenHashHex}:${req.eventId}`;
    const claimed = await deps.idempotency.claim(idemKey, cfg.idempotencyTtlSec);
    if (!claimed) {
      return { status: 'duplicate' };
    }

    const debitMicros = settleDebitMicros(payload.clearingPriceMicros, req.kind, cfg);
    const creditMicros =
      payload.mode === 'demo' ? 0 : userCreditMicros(debitMicros, cfg);

    await deps.ledger.postEvent({
      advertiserId: payload.advertiserId,
      userId: req.userId,
      debitMicros,
      creditMicros,
      eventKind: req.kind,
      mode: payload.mode,
      sourceTokenHashHex: tokenHashHex,
      eventId: req.eventId,
      tsMs: nowMs,
    });

    return { status: 'posted', debitMicros, creditMicros };
  };
}
