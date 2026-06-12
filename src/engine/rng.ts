import type { Rng } from './ports.js';

/**
 * Allocation-free, deterministic xorshift32. Used for tie-break in the
 * auction core and for derived seeds in tests.
 *
 * Returns a generator closure that, given the same seed, produces the
 * same sequence forever. NOT cryptographically secure — do not use for
 * token nonces.
 */
export function xorshift32(seed: number): () => number {
  // Avoid zero state which would lock the generator at 0.
  let s = (seed | 0) || 0x9e3779b9;
  return function next(): number {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // Convert signed int32 to unsigned-uniform [0, 1).
    return ((s >>> 0) / 0x100000000);
  };
}

export const defaultRng: Rng = {
  seed: xorshift32,
};

/**
 * FNV-1a 32-bit hash. Used to compress userId strings into a uint32
 * for inclusion in the token payload — the token is a compact binary
 * blob and we don't want to spend bytes on a full user id.
 *
 * NOT a security primitive; collisions are tolerable because the HMAC
 * binds the full payload anyway.
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, done with adds/shifts to stay in int32 range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
  }
  return h >>> 0;
}

/**
 * Cheap, deterministic seed derived from a request's identifying fields.
 * Used when the caller does not supply an explicit rngSeed.
 */
export function deriveSeed(userId: string, surfaceId: number, bucketMs: number): number {
  return (fnv1a32(userId) ^ (surfaceId * 0x9e3779b1) ^ (bucketMs * 0x85ebca6b)) >>> 0;
}
