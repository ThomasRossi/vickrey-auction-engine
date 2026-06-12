import { describe, expect, it } from 'vitest';
import { isCampaignLive, isEligible, matchesTargeting } from '../src/engine/eligibility.js';
import type { CampaignRow, TargetingRequest } from '../src/engine/eligibility.js';

function row(over: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: 1,
    advertiserId: 10,
    active: true,
    killed: false,
    maxCpmMicros: 1000,
    qualityFactor: 1,
    remainingImpressions: 100,
    startsAtMs: 0,
    endsAtMs: Number.MAX_SAFE_INTEGER,
    mode: 'live',
    targeting: { surfaceIds: [], surfaceVersionRange: [null, null], geos: [] },
    ...over,
  };
}

const req: TargetingRequest = {
  surfaceId: 1,
  surfaceVersion: 5,
  geo: 'US',
  mode: 'live',
};

describe('isCampaignLive', () => {
  it.each([
    ['active', {}, true],
    ['inactive', { active: false }, false],
    ['killed', { killed: true }, false],
    ['no budget', { remainingImpressions: 0 }, false],
    ['before start', { startsAtMs: 1000, endsAtMs: 2000 }, false],
    ['after end', { startsAtMs: 0, endsAtMs: 100 }, false],
  ])('%s → %s', (_, over, expected) => {
    const c = row(over as Partial<CampaignRow>);
    const now = 500;
    expect(isCampaignLive(c, now)).toBe(expected);
  });
});

describe('matchesTargeting', () => {
  it('matches when targeting is fully open', () => {
    expect(matchesTargeting(row(), req)).toBe(true);
  });

  it('rejects on mode mismatch', () => {
    expect(matchesTargeting(row({ mode: 'demo' }), req)).toBe(false);
  });

  it('rejects on surface mismatch', () => {
    const c = row({ targeting: { surfaceIds: [2, 3], surfaceVersionRange: [null, null], geos: [] } });
    expect(matchesTargeting(c, req)).toBe(false);
  });

  it('accepts when surfaceId is in the list', () => {
    const c = row({ targeting: { surfaceIds: [1, 2], surfaceVersionRange: [null, null], geos: [] } });
    expect(matchesTargeting(c, req)).toBe(true);
  });

  it('rejects on surface version below range', () => {
    const c = row({ targeting: { surfaceIds: [], surfaceVersionRange: [10, null], geos: [] } });
    expect(matchesTargeting(c, req)).toBe(false);
  });

  it('rejects on surface version above range', () => {
    const c = row({ targeting: { surfaceIds: [], surfaceVersionRange: [null, 3], geos: [] } });
    expect(matchesTargeting(c, req)).toBe(false);
  });

  it('rejects on geo mismatch', () => {
    const c = row({ targeting: { surfaceIds: [], surfaceVersionRange: [null, null], geos: ['CA'] } });
    expect(matchesTargeting(c, req)).toBe(false);
  });
});

describe('isEligible', () => {
  it('combines liveness and targeting', () => {
    expect(isEligible(row(), req, 500)).toBe(true);
    expect(isEligible(row({ killed: true }), req, 500)).toBe(false);
    expect(isEligible(row({ mode: 'demo' }), req, 500)).toBe(false);
  });
});
