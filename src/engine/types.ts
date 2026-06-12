/**
 * Internal domain types for the auction engine.
 *
 * These are NOT wire types. The host backend maps between these and
 * the `@kickbacks/contracts` snake_case wire types at the route layer.
 *
 * Money is represented as integer "micros" (CPM × 1e6) everywhere on
 * the hot path. Never `number` representing dollars or cents — that
 * way drift between auction price and ledger debit is structurally
 * impossible.
 */

export type Mode = 'live' | 'demo';

export type EventKind = 'impression' | 'click';

/**
 * A candidate bid in a single portfolio request. Targeting has already
 * been resolved by the CampaignIndex; the auction core trusts these.
 *
 * Allocated once per index refresh and reused across requests — do
 * NOT mutate within the engine.
 */
export interface CandidateBid {
  readonly campaignId: number;
  readonly advertiserId: number;
  /** Advertiser's standing max CPM in integer micros. */
  readonly cpmMicros: number;
  /** Multiplier for eCPM ranking. 1.0 in pure-CPM mode. */
  readonly qualityFactor: number;
  /** Snapshot of remaining impressions from the campaign block. */
  readonly remainingImpressions: number;
}

/**
 * Result of clearing a single slot. Null if no candidate cleared the reserve.
 */
export interface ClearingResult {
  readonly winnerCampaignId: number;
  readonly advertiserId: number;
  /** max(secondHighest, reserve), in micros. */
  readonly clearingPriceMicros: number;
}

export interface PortfolioRequest {
  readonly userId: string;
  readonly surfaceId: number;
  readonly surfaceVersion: number;
  readonly geo: string;
  readonly mode: Mode;
  /** Number of ranked slots to return. */
  readonly queueDepth: number;
  /** Optional override; defaults to the host Clock. Useful for tests. */
  readonly nowMs?: number;
  /** Optional override seed for tie-break RNG. Defaults to a derived seed. */
  readonly rngSeed?: number;
}

export interface ServedAd {
  readonly campaignId: number;
  readonly clearingPriceMicros: number;
  /** Opaque signed blob bound to (campaign, price, user, surface, mode, issuedAt). */
  readonly sessionToken: string;
}

export interface BalancesSnapshot {
  readonly userId: string;
  readonly creditMicros: number;
  /** Whether the snapshot includes outbox-pending entries. */
  readonly settledAtMs: number;
}

export interface PortfolioResult {
  readonly queue: readonly ServedAd[];
  readonly ttlMs: number;
  readonly rotationIntervalMs: number;
  readonly viewThresholdMs: number;
  readonly balances: BalancesSnapshot;
}

/**
 * Payload encoded into the session token. Reconstructed at /v1/metrics
 * after HMAC verification. All fields except the secret are recoverable
 * from the token itself — there is no server-side token table on the hot path.
 */
export interface TokenPayload {
  readonly campaignId: number;
  readonly advertiserId: number;
  readonly clearingPriceMicros: number;
  readonly userIdHash: number;
  readonly mode: Mode;
  readonly surfaceId: number;
  readonly issuedAtMs: number;
}

export interface SettleRequest {
  readonly token: string;
  readonly eventId: string;
  readonly kind: EventKind;
  /** Only meaningful for impressions; settle rejects if below view threshold. */
  readonly viewedMs?: number;
  readonly userId: string;
}

export type SettleResult =
  | { readonly status: 'posted'; readonly debitMicros: number; readonly creditMicros: number }
  | { readonly status: 'duplicate' }
  | { readonly status: 'rejected'; readonly reason: SettleRejectReason };

export type SettleRejectReason =
  | 'bad_token'
  | 'token_expired'
  | 'user_mismatch'
  | 'below_view_threshold';

export interface EngineConfig {
  /** Reserve price for the auction, in micros. */
  readonly reserveMicros: number;
  /** Quality-factor mode: 'pure' ignores qualityFactor (forces 1.0); 'ecpm' uses it. */
  readonly rankingMode: 'pure' | 'ecpm';
  /** TTL of the served portfolio queue, in ms. */
  readonly queueTtlMs: number;
  /** Interval at which the client rotates to the next queued ad, in ms. */
  readonly rotationIntervalMs: number;
  /** Minimum view duration for an impression to count. */
  readonly viewThresholdMs: number;
  /** TTL on token lifetime; settlement rejects events arriving after this. */
  readonly tokenLifetimeMs: number;
  /** TTL of idempotency keys; should comfortably exceed queueTtlMs + tokenLifetimeMs. */
  readonly idempotencyTtlSec: number;
  /** User's share of advertiser spend, in basis points (e.g. 5000 = 50%). */
  readonly userShareBps: number;
  /** A click is worth this many impression-equivalents. */
  readonly clickWeight: number;
}
