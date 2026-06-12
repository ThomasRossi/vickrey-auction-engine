/**
 * Narrow ports the engine uses to reach the outside world. All I/O,
 * persistence, crypto, and clock concerns live behind one of these.
 *
 * The engine is constructed with a struct of implementations; tests
 * use in-memory fakes from `adapters/memory`. The host wires real
 * adapters from `adapters/redis` and `adapters/postgres`.
 */

import type {
  BalancesSnapshot,
  CandidateBid,
  EventKind,
  Mode,
  PortfolioRequest,
  TokenPayload,
} from './types.js';

/**
 * Returns the already-targeted, in-memory candidate set for a request.
 *
 * THROUGHPUT NOTE: this is the hot-path linchpin. The host should keep
 * an in-memory map keyed by (surfaceId, surfaceVersion, geo) refreshed
 * from Postgres asynchronously (LISTEN/NOTIFY or polling). The returned
 * array MUST NOT be mutated by the engine.
 */
export interface CampaignIndex {
  candidatesFor(req: PortfolioRequest): readonly CandidateBid[];
}

/**
 * Batched pacing reservation. One Redis round-trip regardless of N,
 * implemented via a Lua token-bucket script.
 *
 * Returns a bitmap of grants aligned with the input array:
 * `result[i] === 1` means the reservation for `campaignIds[i]` succeeded.
 */
export interface PacingStore {
  tryReserveBatch(campaignIds: readonly number[]): Promise<Uint8Array>;
  /** Refund a reservation if the slot is never served (e.g. queue trimmed). */
  refund(campaignId: number, count: number): Promise<void>;
}

/**
 * `SET key NX EX ttl` semantics. Returns true if the caller now owns the key.
 * Used at /v1/metrics to dedupe duplicate event submissions.
 */
export interface IdempotencyStore {
  claim(key: string, ttlSec: number): Promise<boolean>;
}

export interface LedgerTx {
  readonly advertiserId: number;
  readonly userId: string;
  readonly debitMicros: number;
  readonly creditMicros: number;
  readonly eventKind: EventKind;
  readonly mode: Mode;
  readonly sourceTokenHashHex: string;
  readonly eventId: string;
  readonly tsMs: number;
}

export interface LedgerRepo {
  /** Posts the tx and writes an outbox row in the same Postgres transaction. */
  postEvent(tx: LedgerTx): Promise<void>;
  /** Reads the balances projection for the portfolio response. */
  readBalances(userId: string): Promise<BalancesSnapshot>;
}

export interface TokenSigner {
  sign(payload: TokenPayload): string;
  /** Returns null on bad MAC, malformed input, or expired token. */
  verify(token: string, nowMs: number, lifetimeMs: number): TokenPayload | null;
  /** Stable hex-encoded hash of the token, suitable for ledger source linkage. */
  hash(token: string): string;
}

export interface Clock {
  nowMs(): number;
}

export interface Rng {
  /** Returns a deterministic, allocation-free uniform-[0,1) generator. */
  seed(s: number): () => number;
}

export interface EnginePorts {
  readonly campaignIndex: CampaignIndex;
  readonly pacing: PacingStore;
  readonly idempotency: IdempotencyStore;
  readonly ledger: LedgerRepo;
  readonly token: TokenSigner;
  readonly clock: Clock;
  readonly rng: Rng;
}
