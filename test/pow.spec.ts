import { describe, expect, it } from 'vitest';
import {
  MAX_DIFFICULTY_BITS,
  derivePuzzle,
  issuePuzzle,
  powInternals,
  solve,
  verify,
} from '../src/pow/index.js';

describe('pow primitives', () => {
  it('verifies a freshly solved puzzle', () => {
    const puzzle = issuePuzzle(10);
    const { solution } = solve(puzzle);
    expect(verify(puzzle, solution)).toBe(true);
  });

  it('treats difficulty=0 as no-op (always verifies)', () => {
    const puzzle = issuePuzzle(0);
    expect(verify(puzzle, '0000000000000000')).toBe(true);
    // Still passes even with a malformed solution — the check is skipped wholesale.
    expect(verify(puzzle, '')).toBe(true);
  });

  it('rejects a solution that does not meet difficulty', () => {
    const puzzle: { nonce: string; difficultyBits: number } = {
      nonce: '0123456789abcdef',
      difficultyBits: 20,
    };
    expect(verify(puzzle, '0000000000000000')).toBe(false);
  });

  it('rejects malformed solutions', () => {
    const puzzle = issuePuzzle(8);
    expect(verify(puzzle, '')).toBe(false);
    expect(verify(puzzle, 'zz')).toBe(false);
    expect(verify(puzzle, 'abcd')).toBe(false); // wrong length
  });

  it('rejects solutions bound to a different nonce', () => {
    const a = issuePuzzle(8);
    const b = issuePuzzle(8);
    const { solution } = solve(a);
    expect(verify(a, solution)).toBe(true);
    expect(verify(b, solution)).toBe(false);
  });

  it('derives a deterministic puzzle from a binding string', () => {
    const p1 = derivePuzzle('token-xyz:event-1', 8);
    const p2 = derivePuzzle('token-xyz:event-1', 8);
    const p3 = derivePuzzle('token-xyz:event-2', 8);
    expect(p1).toEqual(p2);
    expect(p1.nonce).not.toBe(p3.nonce);
  });

  it('rejects out-of-range difficulty', () => {
    expect(() => issuePuzzle(-1)).toThrow();
    expect(() => issuePuzzle(MAX_DIFFICULTY_BITS + 1)).toThrow();
    expect(() => derivePuzzle('x', -1)).toThrow();
  });

  it('counts leading zero bits correctly', () => {
    const { leadingZeroBits } = powInternals;
    expect(leadingZeroBits(Buffer.from([0xff]))).toBe(0);
    expect(leadingZeroBits(Buffer.from([0x7f]))).toBe(1);
    expect(leadingZeroBits(Buffer.from([0x00, 0x80]))).toBe(8);
    expect(leadingZeroBits(Buffer.from([0x00, 0x00, 0x01]))).toBe(23);
  });

  it('solve reports work done (hashes > 0 for nontrivial difficulty)', () => {
    const puzzle = issuePuzzle(12);
    const out = solve(puzzle);
    expect(out.hashes).toBeGreaterThan(0);
    expect(verify(puzzle, out.solution)).toBe(true);
  });
});
