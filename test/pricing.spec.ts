import { describe, expect, it } from 'vitest';
import {
  dollarsToMicros,
  microsToDollars,
  settleDebitMicros,
  toCandidateBid,
  userCreditMicros,
} from '../src/engine/pricing.js';
import type { EngineConfig } from '../src/engine/types.js';

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
};

describe('money conversions', () => {
  it('round-trips small dollar amounts via micros', () => {
    expect(dollarsToMicros(1)).toBe(1_000_000);
    expect(microsToDollars(1_000_000)).toBe(1);
    expect(dollarsToMicros(0.01)).toBe(10_000);
  });
});

describe('toCandidateBid', () => {
  const baseRow = {
    id: 1,
    advertiserId: 10,
    active: true,
    killed: false,
    maxCpmMicros: 5000,
    qualityFactor: 0.7,
    remainingImpressions: 100,
    startsAtMs: 0,
    endsAtMs: 1,
    mode: 'live' as const,
    targeting: { surfaceIds: [], surfaceVersionRange: [null, null] as [null, null], geos: [] },
  };

  it('forces qualityFactor to 1 in pure mode', () => {
    const c = toCandidateBid(baseRow, { ...cfg, rankingMode: 'pure' });
    expect(c.qualityFactor).toBe(1);
  });

  it('keeps qualityFactor in ecpm mode', () => {
    const c = toCandidateBid(baseRow, { ...cfg, rankingMode: 'ecpm' });
    expect(c.qualityFactor).toBe(0.7);
  });
});

describe('userCreditMicros', () => {
  it('returns 0 when share is 0', () => {
    expect(userCreditMicros(1000, { ...cfg, userShareBps: 0 })).toBe(0);
  });
  it('returns full debit at 10000 bps', () => {
    expect(userCreditMicros(1000, { ...cfg, userShareBps: 10_000 })).toBe(1000);
  });
  it('returns half at 5000 bps', () => {
    expect(userCreditMicros(1000, { ...cfg, userShareBps: 5000 })).toBe(500);
  });
  it('floors fractional shares', () => {
    expect(userCreditMicros(999, { ...cfg, userShareBps: 5000 })).toBe(499);
  });
});

describe('settleDebitMicros', () => {
  it('charges clearing price for an impression', () => {
    expect(settleDebitMicros(800, 'impression', cfg)).toBe(800);
  });
  it('charges 50× clearing price for a click', () => {
    expect(settleDebitMicros(800, 'click', cfg)).toBe(40_000);
  });
});
