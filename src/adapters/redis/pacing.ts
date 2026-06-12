/**
 * Redis-backed token-bucket pacing.
 *
 * One Lua script, one round-trip per portfolio request regardless of how
 * many campaigns are in the batch. The bucket math runs atomically on the
 * Redis side, which closes the race where two concurrent requests would
 * both see "1 token left" and both serve.
 *
 * Keys: `pace:{campaignId}` → hash { t: tokens, r: last_refill_ms }
 * Caller passes capacity and refill rate as ARGV; for v1 these are global
 * (engine-level config), per-campaign overrides are easy to add later by
 * extending ARGV and indexing into it inside the script.
 *
 * Requires the ioredis peer dependency; only import this module if you
 * actually need Redis-backed pacing.
 */

import type { PacingStore } from '../../engine/ports.js';

// Minimal structural type so we don't need ioredis at type-check time.
interface RedisLike {
  defineCommand(
    name: string,
    opts: { numberOfKeys?: number; lua: string },
  ): void;
  // After defineCommand, the dynamic method is on the instance.
  [key: string]: unknown;
}

const PACING_LUA = `
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local ttl      = tonumber(ARGV[4])
local out = {}
for i = 1, #KEYS do
  local key = KEYS[i]
  local data = redis.call('HMGET', key, 't', 'r')
  local tokens = tonumber(data[1])
  local last   = tonumber(data[2])
  if tokens == nil then
    tokens = capacity
    last = now
  end
  local elapsed = (now - last) / 1000.0
  if elapsed > 0 then
    tokens = math.min(capacity, tokens + elapsed * refill)
  end
  local granted = 0
  if tokens >= 1 then
    tokens = tokens - 1
    granted = 1
  end
  redis.call('HMSET', key, 't', tokens, 'r', now)
  redis.call('EXPIRE', key, ttl)
  out[i] = tostring(granted)
end
return table.concat(out, '')
`;

const REFUND_LUA = `
local now = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local key = KEYS[1]
local data = redis.call('HMGET', key, 't', 'r')
local tokens = tonumber(data[1]) or capacity
tokens = math.min(capacity, tokens + count)
redis.call('HMSET', key, 't', tokens, 'r', now)
redis.call('EXPIRE', key, ttl)
return 1
`;

export interface RedisPacingOptions {
  /** Bucket capacity in tokens (impressions). */
  capacity: number;
  /** Refill rate in tokens per second. */
  refillPerSec: number;
  /** Key TTL — must comfortably exceed the longest idle window. */
  keyTtlSec?: number;
}

export function createRedisPacingStore(
  redis: RedisLike,
  opts: RedisPacingOptions,
): PacingStore {
  redis.defineCommand('pacingReserve', { lua: PACING_LUA });
  redis.defineCommand('pacingRefund', { numberOfKeys: 1, lua: REFUND_LUA });
  const ttl = opts.keyTtlSec ?? 3600;

  return {
    async tryReserveBatch(campaignIds) {
      if (campaignIds.length === 0) return new Uint8Array(0);
      const keys = campaignIds.map(id => `pace:${id}`);
      const reserve = redis['pacingReserve'] as (
        keyCount: number,
        ...rest: (string | number)[]
      ) => Promise<string>;
      const raw = await reserve(
        keys.length,
        ...keys,
        opts.capacity,
        opts.refillPerSec,
        Date.now(),
        ttl,
      );
      const out = new Uint8Array(campaignIds.length);
      for (let i = 0; i < raw.length && i < out.length; i++) {
        out[i] = raw.charCodeAt(i) === 49 /* '1' */ ? 1 : 0;
      }
      return out;
    },
    async refund(campaignId, count) {
      const refund = redis['pacingRefund'] as (
        key: string,
        ...rest: (string | number)[]
      ) => Promise<number>;
      await refund(`pace:${campaignId}`, Date.now(), count, opts.capacity, ttl);
    },
  };
}
