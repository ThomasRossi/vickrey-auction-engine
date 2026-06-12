/**
 * Redis idempotency store. One round-trip per settled event.
 *
 * `SET key '1' NX EX ttl` returns 'OK' if the key was created and null
 * if it already existed. That's our entire defense against replays on
 * the /v1/metrics path — combined with the token MAC, this means any
 * adversary trying to double-bill an advertiser either needs to forge
 * a MAC or replay within the idempotency TTL.
 */

import type { IdempotencyStore } from '../../engine/ports.js';

interface RedisLike {
  set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<string | null>;
}

export function createRedisIdempotencyStore(redis: RedisLike): IdempotencyStore {
  return {
    async claim(key, ttlSec) {
      const result = await redis.set(`idem:${key}`, '1', 'EX', ttlSec, 'NX');
      return result === 'OK';
    },
  };
}
