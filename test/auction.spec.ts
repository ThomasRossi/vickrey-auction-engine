import { describe, expect, it } from 'vitest';
import { clearOneSlot, clearPortfolio } from '../src/engine/auction.js';
import { xorshift32 } from '../src/engine/rng.js';
import type { CandidateBid } from '../src/engine/types.js';

function bid(
  campaignId: number,
  cpmMicros: number,
  opts: Partial<Omit<CandidateBid, 'campaignId' | 'cpmMicros'>> = {},
): CandidateBid {
  return {
    campaignId,
    advertiserId: opts.advertiserId ?? campaignId * 10,
    cpmMicros,
    qualityFactor: opts.qualityFactor ?? 1,
    remainingImpressions: opts.remainingImpressions ?? 1000,
  };
}

describe('clearOneSlot', () => {
  it('returns null when there are no candidates', () => {
    expect(clearOneSlot([], 0, xorshift32(1))).toBeNull();
  });

  it('returns null when all candidates are below the reserve', () => {
    const candidates = [bid(1, 100), bid(2, 200)];
    expect(clearOneSlot(candidates, 500, xorshift32(1))).toBeNull();
  });

  it('clears at the reserve with a single eligible bidder', () => {
    const candidates = [bid(1, 800)];
    const result = clearOneSlot(candidates, 500, xorshift32(1));
    expect(result).toEqual({
      winnerCampaignId: 1,
      advertiserId: 10,
      clearingPriceMicros: 500,
    });
  });

  it('clears at the second-highest bid when above reserve', () => {
    const candidates = [bid(1, 1000), bid(2, 800), bid(3, 300)];
    const result = clearOneSlot(candidates, 500, xorshift32(1));
    expect(result).toEqual({
      winnerCampaignId: 1,
      advertiserId: 10,
      clearingPriceMicros: 800,
    });
  });

  it('clears at the reserve when only the winner is above it', () => {
    const candidates = [bid(1, 1000), bid(2, 400)];
    const result = clearOneSlot(candidates, 500, xorshift32(1));
    expect(result?.clearingPriceMicros).toBe(500);
  });

  it('skips candidates with no remaining impressions', () => {
    const candidates = [
      bid(1, 1000, { remainingImpressions: 0 }),
      bid(2, 800),
      bid(3, 600),
    ];
    const result = clearOneSlot(candidates, 100, xorshift32(1));
    expect(result?.winnerCampaignId).toBe(2);
    expect(result?.clearingPriceMicros).toBe(600);
  });

  it('respects the excluded bitmap', () => {
    const candidates = [bid(1, 1000), bid(2, 800), bid(3, 600)];
    const excluded = new Uint8Array([1, 0, 0]); // exclude #1
    const result = clearOneSlot(candidates, 100, xorshift32(1), excluded);
    expect(result?.winnerCampaignId).toBe(2);
    expect(result?.clearingPriceMicros).toBe(600);
  });

  it('uses eCPM ordering when qualityFactor varies', () => {
    // raw CPMs: 1000, 800. quality: 0.5, 1.0 → eff 500, 800 → #2 wins.
    const candidates = [
      bid(1, 1000, { qualityFactor: 0.5 }),
      bid(2, 800, { qualityFactor: 1.0 }),
    ];
    const result = clearOneSlot(candidates, 100, xorshift32(1));
    expect(result?.winnerCampaignId).toBe(2);
    // Second-highest eff is 500 → clearing price floors to 500.
    expect(result?.clearingPriceMicros).toBe(500);
  });

  it('tie-break is deterministic given a fixed seed', () => {
    const candidates = [bid(1, 1000), bid(2, 1000), bid(3, 500)];
    const a = clearOneSlot(candidates, 100, xorshift32(42));
    const b = clearOneSlot(candidates, 100, xorshift32(42));
    expect(a).toEqual(b);
  });

  it('tie-break eventually picks both winners across different seeds', () => {
    // xorshift32 has a cold-start bias for tiny seeds (its first output is
    // always near zero for seeds < ~50_000). Production seeds come from
    // deriveSeed which yields full uint32 values, so test with that range.
    const candidates = [bid(1, 1000), bid(2, 1000)];
    const winners = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const seed = ((i + 1) * 2654435761) >>> 0; // Knuth multiplicative hash
      const r = clearOneSlot(candidates, 100, xorshift32(seed));
      if (r) winners.add(r.winnerCampaignId);
    }
    expect(winners).toEqual(new Set([1, 2]));
  });

  it('property: winner is always the argmax of eligible effective bids', () => {
    for (let trial = 0; trial < 50; trial++) {
      const seed = trial + 1;
      const rng = xorshift32(seed);
      const n = 2 + Math.floor(rng() * 20);
      const reserveMicros = Math.floor(rng() * 500);
      const candidates: CandidateBid[] = [];
      for (let i = 0; i < n; i++) {
        candidates.push(bid(i + 1, 100 + Math.floor(rng() * 10000)));
      }
      const result = clearOneSlot(candidates, reserveMicros, xorshift32(seed));
      if (result === null) {
        const eligible = candidates.filter(c => c.cpmMicros >= reserveMicros);
        expect(eligible.length).toBe(0);
        continue;
      }
      const eligible = candidates.filter(c => c.cpmMicros >= reserveMicros);
      const maxEff = Math.max(...eligible.map(c => c.cpmMicros));
      const winner = candidates.find(c => c.campaignId === result.winnerCampaignId)!;
      expect(winner.cpmMicros).toBe(maxEff);
    }
  });

  it('property: clearing price is always max(secondHighest, reserve)', () => {
    for (let trial = 0; trial < 50; trial++) {
      const seed = trial + 100;
      const rng = xorshift32(seed);
      const n = 2 + Math.floor(rng() * 20);
      const reserveMicros = Math.floor(rng() * 500);
      const candidates: CandidateBid[] = [];
      for (let i = 0; i < n; i++) {
        candidates.push(bid(i + 1, 100 + Math.floor(rng() * 10000)));
      }
      const result = clearOneSlot(candidates, reserveMicros, xorshift32(seed));
      if (result === null) continue;
      const eligibleSorted = candidates
        .filter(c => c.cpmMicros >= reserveMicros)
        .map(c => c.cpmMicros)
        .sort((a, b) => b - a);
      const second = eligibleSorted[1] ?? -Infinity;
      const expected = Math.max(second, reserveMicros);
      expect(result.clearingPriceMicros).toBe(expected);
    }
  });
});

describe('clearPortfolio', () => {
  it('returns up to `depth` distinct winners in rank order', () => {
    const candidates = [bid(1, 1000), bid(2, 800), bid(3, 600), bid(4, 400)];
    const result = clearPortfolio(candidates, 100, xorshift32(1), 3);
    expect(result.map(r => r.winnerCampaignId)).toEqual([1, 2, 3]);
  });

  it('stops early when the pool runs out', () => {
    const candidates = [bid(1, 1000), bid(2, 800)];
    const result = clearPortfolio(candidates, 100, xorshift32(1), 5);
    expect(result.length).toBe(2);
  });

  it('returns empty for depth 0', () => {
    expect(clearPortfolio([bid(1, 1000)], 0, xorshift32(1), 0)).toEqual([]);
  });

  it('each slot uses the next-down clearing price', () => {
    const candidates = [bid(1, 1000), bid(2, 800), bid(3, 600), bid(4, 400)];
    const result = clearPortfolio(candidates, 100, xorshift32(1), 3);
    // Slot 1: winner #1, clearing = 800. Slot 2: #1 excluded, winner #2, clearing = 600. Slot 3: winner #3, clearing = 400.
    expect(result[0]?.clearingPriceMicros).toBe(800);
    expect(result[1]?.clearingPriceMicros).toBe(600);
    expect(result[2]?.clearingPriceMicros).toBe(400);
  });
});
