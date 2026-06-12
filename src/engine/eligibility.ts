/**
 * Pure eligibility predicates.
 *
 * The hot auction path assumes the CampaignIndex has already applied
 * targeting and active/killed/budget filters — this file exists so
 * the host's index-refresh code and the test fakes can share the same
 * predicates, eliminating drift between "what the index considers
 * eligible" and "what the engine assumed."
 */

import type { Mode } from './types.js';

export interface CampaignRow {
  readonly id: number;
  readonly advertiserId: number;
  readonly active: boolean;
  readonly killed: boolean;
  readonly maxCpmMicros: number;
  readonly qualityFactor: number;
  readonly remainingImpressions: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly mode: Mode;
  readonly targeting: TargetingSpec;
}

export interface TargetingSpec {
  /** Empty means "all surfaces." */
  readonly surfaceIds: readonly number[];
  /** [min, max] inclusive; null on either end means unbounded. */
  readonly surfaceVersionRange: readonly [number | null, number | null];
  /** ISO country codes. Empty means "all geos." */
  readonly geos: readonly string[];
}

export interface TargetingRequest {
  readonly surfaceId: number;
  readonly surfaceVersion: number;
  readonly geo: string;
  readonly mode: Mode;
}

export function isCampaignLive(c: CampaignRow, nowMs: number): boolean {
  if (!c.active || c.killed) return false;
  if (nowMs < c.startsAtMs || nowMs >= c.endsAtMs) return false;
  if (c.remainingImpressions <= 0) return false;
  return true;
}

export function matchesTargeting(c: CampaignRow, req: TargetingRequest): boolean {
  if (c.mode !== req.mode) return false;
  if (c.targeting.surfaceIds.length > 0 && !c.targeting.surfaceIds.includes(req.surfaceId)) {
    return false;
  }
  const [lo, hi] = c.targeting.surfaceVersionRange;
  if (lo !== null && req.surfaceVersion < lo) return false;
  if (hi !== null && req.surfaceVersion > hi) return false;
  if (c.targeting.geos.length > 0 && !c.targeting.geos.includes(req.geo)) return false;
  return true;
}

export function isEligible(c: CampaignRow, req: TargetingRequest, nowMs: number): boolean {
  return isCampaignLive(c, nowMs) && matchesTargeting(c, req);
}
