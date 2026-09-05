import { sql, type Kysely } from 'kysely';

/**
 * Event sources and the event ledger for SQLite — mirrors
 * db/postgres/migrations/20260905_000001_event_source.ts, including the partial
 * indexes.
 *
 * SQLite differences: JSON columns are BLOB JSONB, timestamps are ISO TEXT, tables are
 * STRICT. The migration owns its own transaction because Kysely's Migrator does not
 * wrap SQLite migrations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE event_source (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (length(status) <= 16),
        manifest BLOB NOT NULL,
        secrets BLOB,
        manifest_state TEXT,
        last_delivery_at TEXT,
        created_by_subject BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE UNIQUE INDEX event_source_name_uq
        ON event_source (tenant_id, name)
    `.execute(trx);

    await sql`
      CREATE UNIQUE INDEX event_source_state_uq
        ON event_source (manifest_state)
        WHERE manifest_state IS NOT NULL
    `.execute(trx);

    await sql`
      CREATE TABLE event (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES event_source (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        summary BLOB NOT NULL,
        payload BLOB NOT NULL,
        received_at TEXT NOT NULL,
        routed_at TEXT,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE UNIQUE INDEX event_delivery_uq
        ON event (source_id, delivery_id)
    `.execute(trx);

    await sql`CREATE INDEX event_list_idx ON event (tenant_id, received_at DESC)`.execute(trx);
    await sql`CREATE INDEX event_kind_idx ON event (tenant_id, source_id, kind, received_at DESC)`.execute(trx);
    await sql`CREATE INDEX event_subject_idx ON event (tenant_id, subject_key, received_at DESC)`.execute(trx);

    // Partial: the coalesce loop polls this and the table is overwhelmingly routed history.
    await sql`
      CREATE INDEX event_unrouted_idx
        ON event (received_at)
        WHERE routed_at IS NULL
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS event`.execute(trx);
    await sql`DROP TABLE IF EXISTS event_source`.execute(trx);
  });
}
