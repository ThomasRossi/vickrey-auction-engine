import { describe, expect, it } from 'vitest';
import { createHmacTokenSigner } from '../src/engine/token.js';
import { fnv1a32 } from '../src/engine/rng.js';
import type { TokenPayload } from '../src/engine/types.js';

const secret = Buffer.from('test-secret-must-be-long-enough-1234');
const signer = createHmacTokenSigner(secret);

const samplePayload: TokenPayload = {
  campaignId: 12345,
  advertiserId: 9876,
  clearingPriceMicros: 1_234_567,
  userIdHash: fnv1a32('user-abc'),
  mode: 'live',
  surfaceId: 7,
  issuedAtMs: 1_700_000_000_000,
};

describe('HMAC token signer', () => {
  it('roundtrips a payload exactly', () => {
    const token = signer.sign(samplePayload);
    const verified = signer.verify(token, samplePayload.issuedAtMs + 1000, 60_000);
    expect(verified).toEqual(samplePayload);
  });

  it('encodes to base64url with no padding', () => {
    const token = signer.sign(samplePayload);
    expect(token).not.toContain('=');
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
  });

  it('rejects an expired token', () => {
    const token = signer.sign(samplePayload);
    expect(signer.verify(token, samplePayload.issuedAtMs + 120_000, 60_000)).toBeNull();
  });

  it('rejects a token from the future beyond clock skew', () => {
    const token = signer.sign(samplePayload);
    expect(signer.verify(token, samplePayload.issuedAtMs - 5_000, 60_000)).toBeNull();
  });

  it('accepts a token within 1s of clock skew', () => {
    const token = signer.sign(samplePayload);
    expect(signer.verify(token, samplePayload.issuedAtMs - 500, 60_000)).not.toBeNull();
  });

  it('rejects a tampered payload byte', () => {
    const token = signer.sign(samplePayload);
    const buf = Buffer.from(token, 'base64url');
    // flip a bit in the campaignId field
    buf[0] = buf[0]! ^ 0x01;
    const tampered = buf.toString('base64url');
    expect(signer.verify(tampered, samplePayload.issuedAtMs + 1000, 60_000)).toBeNull();
  });

  it('rejects a tampered clearing price', () => {
    const token = signer.sign(samplePayload);
    const buf = Buffer.from(token, 'base64url');
    buf[8] = (buf[8]! + 1) & 0xff; // bump clearing price lowest byte
    const tampered = buf.toString('base64url');
    expect(signer.verify(tampered, samplePayload.issuedAtMs + 1000, 60_000)).toBeNull();
  });

  it('rejects a tampered MAC', () => {
    const token = signer.sign(samplePayload);
    const buf = Buffer.from(token, 'base64url');
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01;
    const tampered = buf.toString('base64url');
    expect(signer.verify(tampered, samplePayload.issuedAtMs + 1000, 60_000)).toBeNull();
  });

  it('rejects truncated tokens', () => {
    const token = signer.sign(samplePayload);
    const truncated = token.slice(0, token.length - 4);
    expect(signer.verify(truncated, samplePayload.issuedAtMs + 1000, 60_000)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(signer.verify('not-a-token', Date.now(), 60_000)).toBeNull();
    expect(signer.verify('', Date.now(), 60_000)).toBeNull();
  });

  it('handles demo mode round-trip', () => {
    const demo = { ...samplePayload, mode: 'demo' as const };
    const token = signer.sign(demo);
    const verified = signer.verify(token, demo.issuedAtMs + 1000, 60_000);
    expect(verified?.mode).toBe('demo');
  });

  it('produces a deterministic hash for the same token', () => {
    const token = signer.sign(samplePayload);
    expect(signer.hash(token)).toBe(signer.hash(token));
    expect(signer.hash(token)).toHaveLength(64);
  });

  it('refuses to construct with a short secret', () => {
    expect(() => createHmacTokenSigner(Buffer.from('short'))).toThrow();
  });
});
