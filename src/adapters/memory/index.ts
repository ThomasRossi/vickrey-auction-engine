/**
 * In-memory adapters. Used by tests, the reference Fastify example,
 * and any host that wants to run the engine without external dependencies
 * (e.g. local development or unit tests in the friend's repo).
 *
 * These are NOT production-grade. The Redis and Postgres adapters live
 * in their own subdirectories.
 */

import type {
  CampaignIndex,
  Clock,
  IdempotencyStore,
  LedgerRepo,
  LedgerTx,
  PacingStore,
  Rng,
} from '../../engine/ports.js';
import { defaultRng } from '../../engine/rng.js';
import type { BalancesSnapshot, CandidateBid, PortfolioRequest } from '../../engine/types.js';

export function memoryCampaignIndex(
  resolver: (req: PortfolioRequest) => readonly CandidateBid[],
): CampaignIndex {
  return { candidatesFor: resolver };
}

export function memoryPacingStore(opts: { grant?: (id: number) => boolean } = {}): PacingStore {
  const grant = opts.grant ?? (() => true);
  return {
    async tryReserveBatch(ids) {
      const out = new Uint8Array(ids.length);
      for (let i = 0; i < ids.length; i++) out[i] = grant(ids[i]!) ? 1 : 0;
      return out;
    },
    async refund() {
      /* no-op */
    },
  };
}

export function memoryIdempotencyStore(): IdempotencyStore {
  const claimed = new Map<string, number>();
  return {
    async claim(key, ttlSec) {
      const now = Date.now();
      const exp = claimed.get(key);
      if (exp !== undefined && exp > now) return false;
      claimed.set(key, now + ttlSec * 1000);
      return true;
    },
  };
}

export interface MemoryLedger {
  readonly repo: LedgerRepo;
  readonly entries: readonly LedgerTx[];
  /** Reset for tests. */
  reset(): void;
}

export function memoryLedgerRepo(): MemoryLedger {
  let entries: LedgerTx[] = [];
  const repo: LedgerRepo = {
    async postEvent(tx) {
      entries.push(tx);
    },
    async readBalances(userId): Promise<BalancesSnapshot> {
      let creditMicros = 0;
      for (const e of entries) {
        if (e.mode === 'live' && e.userId === userId) creditMicros += e.creditMicros;
      }
      return { userId, creditMicros, settledAtMs: Date.now() };
    },
  };
  return {
    repo,
    get entries() {
      return entries;
    },
    reset() {
      entries = [];
    },
  };
}

export function fixedClock(nowMs: number): Clock {
  return { nowMs: () => nowMs };
}

export function realClock(): Clock {
  return { nowMs: () => Date.now() };
}

export const memoryRng: Rng = defaultRng;
