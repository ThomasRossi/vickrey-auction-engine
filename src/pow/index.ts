/**
 * Tiny SHA-256 hash-cash proof of work.
 *
 * Given a puzzle `{ nonce, difficultyBits }`, find a `solution` such that
 *   sha256(nonceBytes || solutionBytes)
 * has at least `difficultyBits` leading zero bits.
 *
 * The library is intentionally generic — it does not know about auctions,
 * session tokens, or events. Whoever wires it in chooses what to bind the
 * puzzle to. In the auction engine the binding is `(sessionToken, eventId)`,
 * which makes the cost scale per-event rather than per-token.
 *
 * No I/O, no state. Verification is one SHA-256 — fits the /v1/metrics
 * hot path. Solving is meant to run client-side (or in tests).
 */

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

export interface PowPuzzle {
  /** 16 hex chars (8 random / derived bytes). */
  readonly nonce: string;
  /** Number of leading zero BITS the hash must have. 0 disables the check. */
  readonly difficultyBits: number;
}

const NONCE_BYTES = 8;
const SOLUTION_BYTES = 8;
const HEX = /^[0-9a-f]*$/i;

/** Max difficulty we accept anywhere. 32 bits = ~4B expected hashes — a hard upper bound. */
export const MAX_DIFFICULTY_BITS = 32;

function assertDifficulty(d: number): void {
  if (!Number.isInteger(d) || d < 0 || d > MAX_DIFFICULTY_BITS) {
    throw new Error(`difficultyBits must be an integer in [0, ${MAX_DIFFICULTY_BITS}]`);
  }
}

function hexToBytes(hex: string, expectedLen: number): Buffer | null {
  if (hex.length !== expectedLen * 2) return null;
  if (!HEX.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

function leadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i]!;
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let b = byte;
    while ((b & 0x80) === 0) {
      bits += 1;
      b <<= 1;
    }
    return bits;
  }
  return bits;
}

/** Generate a fresh random puzzle. */
export function issuePuzzle(
  difficultyBits: number,
  randomBytes: (n: number) => Buffer = cryptoRandomBytes,
): PowPuzzle {
  assertDifficulty(difficultyBits);
  return {
    nonce: randomBytes(NONCE_BYTES).toString('hex'),
    difficultyBits,
  };
}

/**
 * Derive a puzzle deterministically from a binding string.
 *
 * The nonce becomes a stable function of the binding. The caller is
 * responsible for the binding being unpredictable to attackers ahead of
 * time (e.g. it must include something HMAC-signed by the server, like a
 * session token).
 */
export function derivePuzzle(binding: string, difficultyBits: number): PowPuzzle {
  assertDifficulty(difficultyBits);
  const digest = createHash('sha256').update(binding).digest();
  return {
    nonce: digest.subarray(0, NONCE_BYTES).toString('hex'),
    difficultyBits,
  };
}

/** Verify a hex solution against a puzzle. One SHA-256. */
export function verify(puzzle: PowPuzzle, solution: string): boolean {
  if (puzzle.difficultyBits === 0) return true;
  const nonceBytes = hexToBytes(puzzle.nonce, NONCE_BYTES);
  const solBytes = hexToBytes(solution, SOLUTION_BYTES);
  if (nonceBytes === null || solBytes === null) return false;
  const h = createHash('sha256').update(nonceBytes).update(solBytes).digest();
  return leadingZeroBits(h) >= puzzle.difficultyBits;
}

/**
 * Solve a puzzle by counter iteration. Intended for clients and tests; the
 * server never calls this on the hot path.
 */
export function solve(puzzle: PowPuzzle): {
  readonly solution: string;
  readonly elapsedMs: number;
  readonly hashes: number;
} {
  const nonceBytes = hexToBytes(puzzle.nonce, NONCE_BYTES);
  if (nonceBytes === null) {
    throw new Error('puzzle nonce must be 16 hex chars');
  }
  const sol = Buffer.alloc(SOLUTION_BYTES);
  const start = performance.now();

  if (puzzle.difficultyBits === 0) {
    return { solution: sol.toString('hex'), elapsedMs: performance.now() - start, hashes: 0 };
  }

  // 2^30 is well above expected cost for any sane difficulty (32 bits → ~4B).
  // We never get there in practice; the cap exists only to bound a runaway.
  const cap = 1 << 30;
  let counter = 0n;
  for (let i = 0; i < cap; i++) {
    sol.writeBigUInt64LE(counter);
    const h = createHash('sha256').update(nonceBytes).update(sol).digest();
    if (leadingZeroBits(h) >= puzzle.difficultyBits) {
      return {
        solution: sol.toString('hex'),
        elapsedMs: performance.now() - start,
        hashes: i + 1,
      };
    }
    counter += 1n;
  }
  throw new Error('exceeded solve attempt cap — difficulty too high');
}

export const powInternals = { NONCE_BYTES, SOLUTION_BYTES, leadingZeroBits };
