import { describe, expect, it } from 'vitest';
import { makeRunPortfolio } from '../src/engine/portfolio.js';
import { makeSettleEvent } from '../src/engine/settlement.js';
import { createHmacTokenSigner } from '../src/engine/token.js';
import { derivePuzzle, solve } from '../src/pow/index.js';
import {
  fixedClock,
  memoryCampaignIndex,
  memoryIdempotencyStore,
  memoryLedgerRepo,
  memoryPacingStore,
  memoryRng,
} from '../src/adapters/memory/index.js';
import type { EngineConfig, CandidateBid } from '../src/engine/types.js';

const cfg: EngineConfig = {
  reserveMicros: 100,
  rankingMode: 'pure',
  queueTtlMs: 60_000,
  rotationIntervalMs: 5_000,
  viewThresholdMs: 3_000,
  tokenLifetimeMs: 120_000,
  idempotencyTtlSec: 600,
  userShareBps: 5000,
  clickWeight: 50,
  // Difficulty stays low in tests so solving is sub-ms.
  powDifficultyBits: 8,
  powMinElapsedMs: 0,
};

function solveFor(token: string, eventId: string, difficultyBits = cfg.powDifficultyBits): string {
  return solve(derivePuzzle(`${token}:${eventId}`, difficultyBits)).solution;
}

function build(overrides: { candidates?: CandidateBid[]; pacingGrants?: Set<number> } = {}) {
  const candidates: CandidateBid[] = overrides.candidates ?? [
    { campaignId: 1, advertiserId: 10, cpmMicros: 1000, qualityFactor: 1, remainingImpressions: 100 },
    { campaignId: 2, advertiserId: 20, cpmMicros: 800, qualityFactor: 1, remainingImpressions: 100 },
    { campaignId: 3, advertiserId: 30, cpmMicros: 600, qualityFactor: 1, remainingImpressions: 100 },
  ];
  const grants = overrides.pacingGrants;
  const ledger = memoryLedgerRepo();
  const deps = {
    campaignIndex: memoryCampaignIndex(() => candidates),
    pacing: memoryPacingStore({ grant: id => (grants ? grants.has(id) : true) }),
    idempotency: memoryIdempotencyStore(),
    ledger: ledger.repo,
    token: createHmacTokenSigner(Buffer.from('test-secret-must-be-long-enough-1234')),
    clock: fixedClock(1_700_000_000_000),
    rng: memoryRng,
  };
  return { deps, ledger, candidates };
}

describe('runPortfolio', () => {
  it('returns a ranked queue of distinct winners with stamped clearing prices', async () => {
    const { deps } = build();
    const run = makeRunPortfolio(deps, cfg);
    const result = await run({
      userId: 'u1',
      surfaceId: 1,
      surfaceVersion: 1,
      geo: 'US',
      mode: 'live',
      queueDepth: 3,
    });
    expect(result.queue.map(a => a.campaignId)).toEqual([1, 2, 3]);
    expect(result.queue[0]?.clearingPriceMicros).toBe(800);
    expect(result.queue[1]?.clearingPriceMicros).toBe(600);
    expect(result.queue[2]?.clearingPriceMicros).toBe(100); // single bidder left → reserve
    expect(result.ttlMs).toBe(cfg.queueTtlMs);
  });

  it('drops paced-out winners from the queue', async () => {
    const { deps } = build({ pacingGrants: new Set([1, 3]) });
    const run = makeRunPortfolio(deps, cfg);
    const result = await run({
      userId: 'u1',
      surfaceId: 1,
      surfaceVersion: 1,
      geo: 'US',
      mode: 'live',
      queueDepth: 3,
    });
    expect(result.queue.map(a => a.campaignId)).toEqual([1, 3]);
  });

  it('emits tokens that decode to the stamped clearing price', async () => {
    const { deps } = build();
    const run = makeRunPortfolio(deps, cfg);
    const result = await run({
      userId: 'u1',
      surfaceId: 1,
      surfaceVersion: 1,
      geo: 'US',
      mode: 'live',
      queueDepth: 1,
    });
    const decoded = deps.token.verify(result.queue[0]!.sessionToken, 1_700_000_000_500, cfg.tokenLifetimeMs);
    expect(decoded?.campaignId).toBe(1);
    expect(decoded?.clearingPriceMicros).toBe(800);
    expect(decoded?.mode).toBe('live');
  });
});

describe('settleEvent', () => {
  async function setupServed(opts: { mode?: 'live' | 'demo' } = {}) {
    const { deps, ledger } = build();
    const run = makeRunPortfolio(deps, cfg);
    const result = await run({
      userId: 'u1',
      surfaceId: 1,
      surfaceVersion: 1,
      geo: 'US',
      mode: opts.mode ?? 'live',
      queueDepth: 1,
    });
    return { deps, ledger, token: result.queue[0]!.sessionToken };
  }

  it('posts a ledger entry for a valid impression', async () => {
    const { deps, ledger, token } = await setupServed();
    const settle = makeSettleEvent(deps, cfg);
    const r = await settle({
      token, eventId: 'e1', kind: 'impression', viewedMs: 3500, userId: 'u1',
      powSolution: solveFor(token, 'e1'),
    });
    expect(r.status).toBe('posted');
    expect(ledger.entries.length).toBe(1);
    expect(ledger.entries[0]!.debitMicros).toBe(800);
    expect(ledger.entries[0]!.creditMicros).toBe(400);
  });

  it('weights a click at 50× an impression', async () => {
    const { deps, ledger, token } = await setupServed();
    const settle = makeSettleEvent(deps, cfg);
    const r = await settle({
      token, eventId: 'e1', kind: 'click', userId: 'u1',
      powSolution: solveFor(token, 'e1'),
    });
    expect(r.status).toBe('posted');
    expect(ledger.entries[0]!.debitMicros).toBe(800 * 50);
    expect(ledger.entries[0]!.creditMicros).toBe((800 * 50) / 2);
  });

  it('rejects below view threshold', async () => {
    const { deps, token } = await setupServed();
    const settle = makeSettleEvent(deps, cfg);
    const r = await settle({
      token, eventId: 'e1', kind: 'impression', viewedMs: 1500, userId: 'u1',
      powSolution: solveFor(token, 'e1'),
    });
    expect(r).toEqual({ status: 'rejected', reason: 'below_view_threshold' });
  });

  it('is idempotent on (token, eventId)', async () => {
    const { deps, ledger, token } = await setupServed();
    const settle = makeSettleEvent(deps, cfg);
    const args = {
      token, eventId: 'e1', kind: 'impression' as const, viewedMs: 3500, userId: 'u1',
      powSolution: solveFor(token, 'e1'),
    };
    const a = await settle(args);
    const b = await settle(args);
    expect(a.status).toBe('posted');
    expect(b.status).toBe('duplicate');
    expect(ledger.entries.length).toBe(1);
  });

  it('rejects tokens posted by the wrong user', async () => {
    const { deps, token } = await setupServed();
    const settle = makeSettleEvent(deps, cfg);
    const r = await settle({
      token, eventId: 'e1', kind: 'impression', viewedMs: 3500, userId: 'other-user',
      powSolution: solveFor(token, 'e1'),
    });
    expect(r).toEqual({ status: 'rejected', reason: 'user_mismatch' });
  });

  it('routes demo events to the demo ledger with zero user credit', async () => {
    const { deps, ledger, token } = await setupServed({ mode: 'demo' });
    const settle = makeSettleEvent(deps, cfg);
    const r = await settle({
      token, eventId: 'e1', kind: 'impression', viewedMs: 3500, userId: 'u1',
      powSolution: solveFor(token, 'e1'),
    });
    expect(r.status).toBe('posted');
    expect(ledger.entries[0]!.mode).toBe('demo');
    expect(ledger.entries[0]!.creditMicros).toBe(0);
    expect(ledger.entries[0]!.debitMicros).toBe(800);
  });

  it('rejects garbage tokens', async () => {
    const { deps } = build();
    const settle = makeSettleEvent(deps, cfg);
    const r = await settle({ token: 'garbage', eventId: 'e1', kind: 'click', userId: 'u1' });
    expect(r).toEqual({ status: 'rejected', reason: 'bad_token' });
  });

  it('rejects events missing a valid PoW solution', async () => {
    const { deps, ledger, token } = await setupServed();
    const settle = makeSettleEvent(deps, cfg);
    const r = await settle({
      token, eventId: 'e1', kind: 'impression', viewedMs: 3500, userId: 'u1',
    });
    expect(r).toEqual({ status: 'rejected', reason: 'bad_pow' });
    expect(ledger.entries.length).toBe(0);
  });

  it('rejects a solution bound to a different eventId (per-event binding)', async () => {
    const { deps, token } = await setupServed();
    const settle = makeSettleEvent(deps, cfg);
    const stolenSolution = solveFor(token, 'e1');
    const r = await settle({
      token, eventId: 'e2', kind: 'impression', viewedMs: 3500, userId: 'u1',
      powSolution: stolenSolution,
    });
    expect(r).toEqual({ status: 'rejected', reason: 'bad_pow' });
  });

  it('rejects events that beat the minimum-elapsed floor', async () => {
    const { deps, token } = await setupServed();
    const strictCfg = { ...cfg, powMinElapsedMs: 60_000 };
    const settle = makeSettleEvent(deps, strictCfg);
    const r = await settle({
      token, eventId: 'e1', kind: 'impression', viewedMs: 3500, userId: 'u1',
      powSolution: solveFor(token, 'e1'),
    });
    expect(r).toEqual({ status: 'rejected', reason: 'pow_too_fast' });
  });
});
