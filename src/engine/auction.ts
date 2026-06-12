import type { CandidateBid, ClearingResult } from './types.js';

/**
 * Clear a single Vickrey slot.
 *
 * Single O(N) pass, no sorting, no allocations beyond locals. Winner is
 * the candidate with the highest effective bid above the reserve;
 * clearing price is `max(secondHighestEligible, reserve)`. Ties between
 * the top two are broken with the supplied RNG so delivery is fair and
 * reproducible in tests.
 *
 * @param candidates Borrowed input — NOT mutated. Targeting and basic
 *   eligibility (active, not killed, surface match) is assumed already
 *   applied by the CampaignIndex.
 * @param reserveMicros Floor in micros. Anything below is dropped.
 * @param rng Uniform-[0,1) generator. Allocation-free.
 * @param excluded Optional bitmap aligned with `candidates`. Positions
 *   with `excluded[i] === 1` are skipped. Used by `clearPortfolio` to
 *   prevent the same campaign from winning multiple slots in a row.
 */
export function clearOneSlot(
  candidates: readonly CandidateBid[],
  reserveMicros: number,
  rng: () => number,
  excluded?: Uint8Array,
): ClearingResult | null {
  let bestIdx = -1;
  let bestEff = -1;
  let secondEff = -1;

  for (let i = 0; i < candidates.length; i++) {
    if (excluded !== undefined && excluded[i] === 1) continue;
    const c = candidates[i]!;
    if (c.remainingImpressions <= 0) continue;

    // Integer micros × float qualityFactor. In pure mode qualityFactor === 1
    // and eff === cpmMicros exactly. In eCPM mode we still compare floats,
    // which is fine for ordering; clearing price is snapped back to micros
    // below.
    const eff = c.cpmMicros * c.qualityFactor;
    if (eff < reserveMicros) continue;

    if (eff > bestEff) {
      secondEff = bestEff;
      bestEff = eff;
      bestIdx = i;
    } else if (eff === bestEff) {
      // Tie — flip a coin. The loser becomes second; the second of the
      // previous best stays runner-up only if it was > eff (it isn't,
      // by definition of tie), so we always overwrite secondEff.
      if (rng() < 0.5) {
        secondEff = bestEff;
        bestEff = eff;
        bestIdx = i;
      } else {
        secondEff = eff;
      }
    } else if (eff > secondEff) {
      secondEff = eff;
    }
  }

  if (bestIdx < 0) return null;

  // Snap clearing price back to an integer to avoid fractional micros.
  // Math.floor on the second-price floor protects against rounding up
  // into the winner's bid; for pure mode this is a no-op since
  // secondEff === second.cpmMicros (an integer).
  const second = secondEff >= reserveMicros ? Math.floor(secondEff) : reserveMicros;
  const winner = candidates[bestIdx]!;
  return {
    winnerCampaignId: winner.campaignId,
    advertiserId: winner.advertiserId,
    clearingPriceMicros: second,
  };
}

/**
 * Clear `depth` distinct slots in rank order.
 *
 * Iterates `clearOneSlot` `depth` times, excluding each winner from the
 * next pass. Uses a single Uint8Array bitmap; no per-slot allocations
 * beyond the result array.
 *
 * Total compute: O(depth × N). For typical depth=5, N=200 this is ~1000
 * comparisons — well under 10µs on modern hardware.
 */
export function clearPortfolio(
  candidates: readonly CandidateBid[],
  reserveMicros: number,
  rng: () => number,
  depth: number,
): ClearingResult[] {
  const out: ClearingResult[] = [];
  if (depth <= 0 || candidates.length === 0) return out;

  const excluded = new Uint8Array(candidates.length);
  for (let slot = 0; slot < depth; slot++) {
    const result = clearOneSlotWithIdx(candidates, reserveMicros, rng, excluded);
    if (result === null) break;
    excluded[result.winnerIdx] = 1;
    out.push(result.clearing);
  }
  return out;
}

/** Internal variant of clearOneSlot that also returns the winner's index. */
function clearOneSlotWithIdx(
  candidates: readonly CandidateBid[],
  reserveMicros: number,
  rng: () => number,
  excluded: Uint8Array,
): { clearing: ClearingResult; winnerIdx: number } | null {
  let bestIdx = -1;
  let bestEff = -1;
  let secondEff = -1;

  for (let i = 0; i < candidates.length; i++) {
    if (excluded[i] === 1) continue;
    const c = candidates[i]!;
    if (c.remainingImpressions <= 0) continue;
    const eff = c.cpmMicros * c.qualityFactor;
    if (eff < reserveMicros) continue;

    if (eff > bestEff) {
      secondEff = bestEff;
      bestEff = eff;
      bestIdx = i;
    } else if (eff === bestEff) {
      if (rng() < 0.5) {
        secondEff = bestEff;
        bestEff = eff;
        bestIdx = i;
      } else {
        secondEff = eff;
      }
    } else if (eff > secondEff) {
      secondEff = eff;
    }
  }

  if (bestIdx < 0) return null;
  const second = secondEff >= reserveMicros ? Math.floor(secondEff) : reserveMicros;
  const winner = candidates[bestIdx]!;
  return {
    clearing: {
      winnerCampaignId: winner.campaignId,
      advertiserId: winner.advertiserId,
      clearingPriceMicros: second,
    },
    winnerIdx: bestIdx,
  };
}
