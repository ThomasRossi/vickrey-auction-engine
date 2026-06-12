/**
 * Session token: fixed-layout binary payload + HMAC-SHA256, base64url-encoded.
 *
 * The token is the only thing /v1/metrics trusts to determine which
 * campaign cleared at what price. There is intentionally NO server-side
 * served-tokens lookup on the hot ingest path — the MAC is the auth,
 * and an idempotency key drops replays. Async outbox writes a copy to
 * `served_tokens` for forensics, but settlement does not block on it.
 *
 * Layout (64 bytes):
 *   offset  size  field
 *   0       4     campaignId       (uint32 LE)
 *   4       4     advertiserId     (uint32 LE)
 *   8       8     clearingMicros   (uint64 LE)
 *   16      4     userIdHash       (uint32 LE)  — fnv1a32(userId)
 *   20      1     mode             (0=live, 1=demo)
 *   21      1     surfaceId        (uint8)
 *   22      2     reserved         (zero)
 *   24      8     issuedAtMs       (uint64 LE)
 *   32      32    HMAC-SHA256(payload, secret)
 *
 * Encoded length: ceil(64 / 3) * 4 = 88 base64 chars, no padding (base64url).
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { TokenSigner } from './ports.js';
import type { Mode, TokenPayload } from './types.js';
import { fnv1a32 } from './rng.js';

const PAYLOAD_LEN = 32;
const MAC_LEN = 32;
const TOTAL_LEN = PAYLOAD_LEN + MAC_LEN;

function modeToByte(m: Mode): number {
  return m === 'demo' ? 1 : 0;
}
function byteToMode(b: number): Mode | null {
  if (b === 0) return 'live';
  if (b === 1) return 'demo';
  return null;
}

export function createHmacTokenSigner(secret: Buffer): TokenSigner {
  if (secret.length < 16) {
    throw new Error('HMAC secret must be at least 16 bytes');
  }

  function pack(payload: TokenPayload): Buffer {
    const buf = Buffer.allocUnsafe(TOTAL_LEN);
    // Zero the reserved region only — everything else is fully overwritten.
    buf[22] = 0;
    buf[23] = 0;
    buf.writeUInt32LE(payload.campaignId >>> 0, 0);
    buf.writeUInt32LE(payload.advertiserId >>> 0, 4);
    buf.writeBigUInt64LE(BigInt(payload.clearingPriceMicros), 8);
    buf.writeUInt32LE(payload.userIdHash >>> 0, 16);
    buf.writeUInt8(modeToByte(payload.mode), 20);
    buf.writeUInt8(payload.surfaceId & 0xff, 21);
    buf.writeBigUInt64LE(BigInt(payload.issuedAtMs), 24);
    const mac = createHmac('sha256', secret).update(buf.subarray(0, PAYLOAD_LEN)).digest();
    mac.copy(buf, PAYLOAD_LEN);
    return buf;
  }

  function unpack(buf: Buffer): TokenPayload | null {
    if (buf.length !== TOTAL_LEN) return null;
    const expected = createHmac('sha256', secret).update(buf.subarray(0, PAYLOAD_LEN)).digest();
    const got = buf.subarray(PAYLOAD_LEN, TOTAL_LEN);
    if (!timingSafeEqual(expected, got)) return null;

    const mode = byteToMode(buf.readUInt8(20));
    if (mode === null) return null;
    return {
      campaignId: buf.readUInt32LE(0),
      advertiserId: buf.readUInt32LE(4),
      clearingPriceMicros: Number(buf.readBigUInt64LE(8)),
      userIdHash: buf.readUInt32LE(16),
      mode,
      surfaceId: buf.readUInt8(21),
      issuedAtMs: Number(buf.readBigUInt64LE(24)),
    };
  }

  return {
    sign(payload) {
      return pack(payload).toString('base64url');
    },
    verify(token, nowMs, lifetimeMs) {
      let buf: Buffer;
      try {
        buf = Buffer.from(token, 'base64url');
      } catch {
        return null;
      }
      const payload = unpack(buf);
      if (payload === null) return null;
      if (nowMs - payload.issuedAtMs > lifetimeMs) return null;
      // Allow small clock skew (1s) without rejecting.
      if (payload.issuedAtMs - nowMs > 1_000) return null;
      return payload;
    },
    hash(token) {
      return createHash('sha256').update(token).digest('hex');
    },
  };
}

export const tokenInternals = { PAYLOAD_LEN, MAC_LEN, TOTAL_LEN, fnv1a32 };
