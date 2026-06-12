/**
 * Reference Fastify host wiring.
 *
 * NOT shipped with the package — this is a documentation artifact only.
 * Copy/adapt into the kickbacks backend.
 *
 * Things the host owns (NOT the engine):
 *   - HTTP framework + route definitions
 *   - Wire-format conversion: snake_case JSON ↔ camelCase domain
 *   - Schema validation (Fastify's JSON Schema is a natural fit here)
 *   - Authentication, rate limiting, CORS, structured logging
 *   - In-memory CampaignIndex refresh (LISTEN/NOTIFY or polling)
 *
 * Things the engine owns:
 *   - The Vickrey auction itself
 *   - Token sign/verify
 *   - Settlement math + idempotency
 *
 * Everything below is the host's concern. The engine is imported as
 * a library and called from inside the route handlers.
 */

import Fastify from 'fastify';
import { createEngine, dollarsToMicros } from '@kickbacks/auction-engine';
import { createHmacTokenSigner } from '@kickbacks/auction-engine';
import {
  createRedisPacingStore,
  createRedisIdempotencyStore,
} from '@kickbacks/auction-engine/adapters/redis';
import { createPostgresLedgerRepo } from '@kickbacks/auction-engine/adapters/postgres';
import {
  memoryCampaignIndex,
  realClock,
  memoryRng,
} from '@kickbacks/auction-engine/adapters/memory';
import IORedis from 'ioredis';
import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// 1. Build the engine.
// ---------------------------------------------------------------------------

const redis = new IORedis(process.env['REDIS_URL']!);
const pool = new Pool({ connectionString: process.env['POSTGRES_URL']! });

// Host owns this index. In production: refresh on a 5s interval from
// Postgres (or LISTEN/NOTIFY), keyed by (surfaceId, surfaceVersion, geo).
// For the example we stub it.
const campaignIndex = memoryCampaignIndex(() => []);

const engine = createEngine(
  {
    campaignIndex,
    pacing: createRedisPacingStore(redis as never, {
      capacity: 1000,
      refillPerSec: 10,
    }),
    idempotency: createRedisIdempotencyStore(redis as never),
    ledger: createPostgresLedgerRepo(pool as never),
    token: createHmacTokenSigner(Buffer.from(process.env['AUCTION_SECRET']!, 'utf8')),
    clock: realClock(),
    rng: memoryRng,
  },
  {
    reserveMicros: dollarsToMicros(0.01),
    rankingMode: 'pure',
    queueTtlMs: 60_000,
    rotationIntervalMs: 5_000,
    viewThresholdMs: 3_000,
    tokenLifetimeMs: 120_000,
    idempotencyTtlSec: 600,
    userShareBps: 5000,
    clickWeight: 50,
  },
);

// ---------------------------------------------------------------------------
// 2. Wire the routes. snake_case in/out, camelCase inside.
// ---------------------------------------------------------------------------

const app = Fastify({ logger: true });

app.post<{
  Body: {
    user_id: string;
    surface_id: number;
    surface_version: number;
    geo: string;
    mode: 'live' | 'demo';
    queue_depth: number;
  };
}>('/v1/portfolio', async (req) => {
  const result = await engine.runPortfolio({
    userId: req.body.user_id,
    surfaceId: req.body.surface_id,
    surfaceVersion: req.body.surface_version,
    geo: req.body.geo,
    mode: req.body.mode,
    queueDepth: req.body.queue_depth,
  });
  return {
    queue: result.queue.map((ad) => ({
      campaign_id: ad.campaignId,
      clearing_price_micros: ad.clearingPriceMicros,
      session_token: ad.sessionToken,
    })),
    ttl_ms: result.ttlMs,
    rotation_interval_ms: result.rotationIntervalMs,
    view_threshold_ms: result.viewThresholdMs,
    balances: {
      user_id: result.balances.userId,
      credit_micros: result.balances.creditMicros,
      settled_at_ms: result.balances.settledAtMs,
    },
  };
});

app.post<{
  Body: {
    session_token: string;
    event_id: string;
    kind: 'impression' | 'click';
    viewed_ms?: number;
    user_id: string;
  };
}>('/v1/metrics', async (req, reply) => {
  const result = await engine.settleEvent({
    token: req.body.session_token,
    eventId: req.body.event_id,
    kind: req.body.kind,
    ...(req.body.viewed_ms !== undefined ? { viewedMs: req.body.viewed_ms } : {}),
    userId: req.body.user_id,
  });
  if (result.status === 'rejected') reply.code(400);
  return result;
});

app.post('/v1/metrics/demo', async (req, reply) => {
  // Same handler as /v1/metrics, but the token's payload already carries
  // mode='demo' so the engine routes the ledger entry automatically.
  return (app as never as { __metrics: typeof app.inject })['__metrics'];
});

app.listen({ port: 3000 });
