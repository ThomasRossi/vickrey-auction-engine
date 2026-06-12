/**
 * Postgres LedgerRepo. Settles one event per call:
 *   - Insert into impressions/clicks (or no-op on UNIQUE conflict).
 *   - Insert one ledger_entries row.
 *   - Insert one outbox row.
 * All in a single transaction.
 *
 * The Redis idempotency check already drops most replays before we get
 * here; the UNIQUE constraints on (token_hash, event_id) are belt-and-
 * suspenders for the case where Redis state is lost.
 *
 * Designed against the `pg` driver's structural interface so the friend
 * can swap in Drizzle, Slonik, or his own pool wrapper without touching
 * the engine.
 */

import type { LedgerRepo, LedgerTx } from '../../engine/ports.js';
import type { BalancesSnapshot } from '../../engine/types.js';

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PgClientLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export function createPostgresLedgerRepo(pool: PgPoolLike): LedgerRepo {
  return {
    async postEvent(tx: LedgerTx) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const eventTable = tx.eventKind === 'impression' ? 'impressions' : 'clicks';
        if (tx.eventKind === 'impression') {
          await client.query(
            `INSERT INTO ${eventTable} (token_hash, event_id, viewed_ms)
             VALUES ($1, $2, $3)
             ON CONFLICT (token_hash, event_id) DO NOTHING`,
            [tx.sourceTokenHashHex, tx.eventId, 0],
          );
        } else {
          await client.query(
            `INSERT INTO ${eventTable} (token_hash, event_id)
             VALUES ($1, $2)
             ON CONFLICT (token_hash, event_id) DO NOTHING`,
            [tx.sourceTokenHashHex, tx.eventId],
          );
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ledger_entries
             (ts_ms, advertiser_id, user_id, debit_micros, credit_micros,
              event_kind, mode, source_token_hash, event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (source_token_hash, event_id, event_kind) DO NOTHING
           RETURNING id`,
          [
            tx.tsMs,
            tx.advertiserId,
            tx.userId,
            tx.debitMicros,
            tx.creditMicros,
            tx.eventKind,
            tx.mode,
            tx.sourceTokenHashHex,
            tx.eventId,
          ],
        );
        if (inserted.rows.length > 0) {
          await client.query(
            `INSERT INTO outbox (payload)
             VALUES ($1::jsonb)`,
            [
              JSON.stringify({
                kind: 'ledger_entry',
                ledger_id: inserted.rows[0]!.id,
                user_id: tx.userId,
                advertiser_id: tx.advertiserId,
                credit_micros: tx.creditMicros,
                debit_micros: tx.debitMicros,
                mode: tx.mode,
                ts_ms: tx.tsMs,
              }),
            ],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async readBalances(userId: string): Promise<BalancesSnapshot> {
      const result = await pool.query<{ credit_micros: string; settled_at_ms: string }>(
        `SELECT credit_micros, settled_at_ms
         FROM balances
         WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) return { userId, creditMicros: 0, settledAtMs: Date.now() };
      return {
        userId,
        creditMicros: Number(row.credit_micros),
        settledAtMs: Number(row.settled_at_ms),
      };
    },
  };
}
