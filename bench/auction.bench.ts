import { bench, describe } from 'vitest';
import { clearOneSlot, clearPortfolio } from '../src/engine/auction.js';
import { xorshift32 } from '../src/engine/rng.js';
import type { CandidateBid } from '../src/engine/types.js';

function makeCandidates(n: number): CandidateBid[] {
  const r = xorshift32(0xc0ffee);
  const arr: CandidateBid[] = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      campaignId: i + 1,
      advertiserId: (i + 1) * 10,
      cpmMicros: 100 + Math.floor(r() * 10_000),
      qualityFactor: 1,
      remainingImpressions: 10_000,
    });
  }
  return arr;
}

const c50 = makeCandidates(50);
const c200 = makeCandidates(200);
const c1000 = makeCandidates(1000);
const rng = xorshift32(1);

describe('clearOneSlot', () => {
  bench('N=50', () => {
    clearOneSlot(c50, 100, rng);
  });
  bench('N=200', () => {
    clearOneSlot(c200, 100, rng);
  });
  bench('N=1000', () => {
    clearOneSlot(c1000, 100, rng);
  });
});

describe('clearPortfolio depth=5', () => {
  bench('N=50', () => {
    clearPortfolio(c50, 100, rng, 5);
  });
  bench('N=200', () => {
    clearPortfolio(c200, 100, rng, 5);
  });
  bench('N=1000', () => {
    clearPortfolio(c1000, 100, rng, 5);
  });
});
