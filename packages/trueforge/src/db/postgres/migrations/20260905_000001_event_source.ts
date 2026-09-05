import { sql, type Kysely } from 'kysely';

/**
 * Event sources and the event ledger: `event_source` + `event`.
 *
 * - `event_source`: one row per connected provider (a GitHub App). Public identity in the
 *   Zod-validated `manifest` jsonb; credentials in `secrets` jsonb, read only by the
 *   connector. `manifest_state` is the one-time nonce of an in-flight GitHub manifest flow.
 * - `event`: one row per accepted webhook delivery. `payload` is the raw provider body;
 *   `summary` is the handful of fields a listing needs, so lists never touch payloads.
 *
 * Index choices:
 * - `event_delivery_uq` makes a redelivery idempotent: one provider delivery id maps to
 *   exactly one row per source.
 * - `event_unrouted_idx` is PARTIAL on `routed_at IS NULL`. The coalesce loop polls it every
 *   few seconds and the table is overwhelmingly routed history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await db.schema
    .createTable('event_source')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('kind', 'text', col => col.notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('status', 'text', col => col.notNull())
    .addColumn('manifest', 'jsonb', col => col.notNull())
    .addColumn('secrets', 'jsonb')
    .addColumn('manifest_state', 'text')
    .addColumn('last_delivery_at', 'timestamptz')
    .addColumn('created_by_subject', 'jsonb', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('event_source_pkey', ['id'])
    .execute();

  await db.schema
    .createIndex('event_source_name_uq')
    .on('event_source')
    .columns(['tenant_id', 'name'])
    .unique()
    .execute();

  await sql`
    CREATE UNIQUE INDEX event_source_state_uq
      ON event_source (manifest_state)
      WHERE manifest_state IS NOT NULL
  `.execute(db);

  await db.schema
    .createTable('event')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('source_id', 'text', col => col.notNull().references('event_source.id').onDelete('cascade'))
    .addColumn('kind', 'text', col => col.notNull())
    .addColumn('subject_key', 'text', col => col.notNull())
    .addColumn('delivery_id', 'text', col => col.notNull())
    .addColumn('summary', 'jsonb', col => col.notNull())
    .addColumn('payload', 'jsonb', col => col.notNull())
    .addColumn('received_at', 'timestamptz', col => col.notNull())
    .addColumn('routed_at', 'timestamptz')
    .addPrimaryKeyConstraint('event_pkey', ['id'])
    .execute();

  await db.schema.createIndex('event_delivery_uq').on('event').columns(['source_id', 'delivery_id']).unique().execute();

  // Listings: newest first per tenant, optionally narrowed by source and kind.
  await sql`CREATE INDEX event_list_idx ON event (tenant_id, received_at DESC)`.execute(db);
  await sql`CREATE INDEX event_kind_idx ON event (tenant_id, source_id, kind, received_at DESC)`.execute(db);
  await sql`CREATE INDEX event_subject_idx ON event (tenant_id, subject_key, received_at DESC)`.execute(db);

  await sql`
    CREATE INDEX event_unrouted_idx
      ON event (received_at)
      WHERE routed_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('event').ifExists().cascade().execute();
  await db.schema.dropTable('event_source').ifExists().cascade().execute();
}
