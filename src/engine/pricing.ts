/**
 * Money math. Integer micros (CPM × 1e6) is the canonical unit; floats
 * appear only as the qualityFactor multiplier and are floored back to
 * micros before any ledger write.
 *
 * Pricing helpers live here so they're shared between the auction core,
 * the index loader, and the settlement path — three places where a
 * one-cent rounding difference would be a billing bug.
 */

import type { CandidateBid, EngineConfig } from './types.js';
import type { CampaignRow } from './eligibility.js';

const MICROS_PER_DOLLAR = 1_000_000;

export function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * MICROS_PER_DOLLAR);
}

export function microsToDollars(micros: number): number {
  return micros / MICROS_PER_DOLLAR;
}

/**
 * Build a hot-path CandidateBid from a CampaignRow, applying the
 * configured ranking mode. In 'pure' mode the qualityFactor is
 * forced to 1 so eff === cpmMicros exactly and the auction sort
 * stays in integer space.
 */
export function toCandidateBid(c: CampaignRow, cfg: EngineConfig): CandidateBid {
  return {
    campaignId: c.id,
    advertiserId: c.advertiserId,
    cpmMicros: c.maxCpmMicros,
    qualityFactor: cfg.rankingMode === 'pure' ? 1 : c.qualityFactor,
    remainingImpressions: c.remainingImpressions,
  };
}

/**
 * The user's credit for a settled event, given the advertiser's debit.
 * basis points: 5000 → 50%. Floors to integer micros so the ledger
 * stays balanced (advertiser debit always >= user credit).
 */
export function userCreditMicros(debitMicros: number, cfg: EngineConfig): number {
  if (cfg.userShareBps <= 0) return 0;
  if (cfg.userShareBps >= 10_000) return debitMicros;
  return Math.floor((debitMicros * cfg.userShareBps) / 10_000);
}

/**
 * Effective charge for a settled event, given the stamped clearing price.
 * Impressions charge at clearing price; clicks charge clickWeight × that.
 */
export function settleDebitMicros(
  clearingPriceMicros: number,
  kind: 'impression' | 'click',
  cfg: EngineConfig,
): number {
  return kind === 'click' ? clearingPriceMicros * cfg.clickWeight : clearingPriceMicros;
}
