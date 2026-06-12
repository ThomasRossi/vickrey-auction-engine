import { describe, expect, it } from 'vitest';
import { deriveSeed, fnv1a32, xorshift32 } from '../src/engine/rng.js';

describe('xorshift32', () => {
  it('is deterministic for a given seed', () => {
    const a = xorshift32(42);
    const b = xorshift32(42);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces a different sequence for a different seed', () => {
    const a = xorshift32(42);
    const b = xorshift32(43);
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 10; i++) {
      seqA.push(a());
      seqB.push(b());
    }
    expect(seqA).not.toEqual(seqB);
  });

  it('survives zero seed without locking at 0', () => {
    const r = xorshift32(0);
    const values = Array.from({ length: 16 }, () => r());
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it('stays in [0, 1)', () => {
    const r = xorshift32(7);
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('fnv1a32', () => {
  it('is deterministic', () => {
    expect(fnv1a32('user-123')).toBe(fnv1a32('user-123'));
  });

  it('differs for different inputs', () => {
    expect(fnv1a32('user-123')).not.toBe(fnv1a32('user-124'));
  });

  it('matches known FNV-1a vectors', () => {
    // Reference: http://isthe.com/chongo/tech/comp/fnv/
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
});

describe('deriveSeed', () => {
  it('is deterministic across calls', () => {
    expect(deriveSeed('u', 1, 1000)).toBe(deriveSeed('u', 1, 1000));
  });
  it('changes when any input changes', () => {
    const base = deriveSeed('u', 1, 1000);
    expect(deriveSeed('v', 1, 1000)).not.toBe(base);
    expect(deriveSeed('u', 2, 1000)).not.toBe(base);
    expect(deriveSeed('u', 1, 1001)).not.toBe(base);
  });
});
