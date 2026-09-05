import { sql, type Kysely } from 'kysely';

/**
 * Event-driven automations for SQLite — mirrors
 * db/postgres/migrations/20260905_000002_automation.ts, including the composite FK to
 * `agent(tenant_id, name)` and every partial index.
 *
 * SQLite differences: JSON columns are BLOB JSONB, timestamps are ISO TEXT, tables are
 * STRICT. The migration owns its own transaction because Kysely's Migrator does not
 * wrap SQLite migrations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE automation (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        name TEXT NOT NULL,
        manifest BLOB NOT NULL,
        status TEXT NOT NULL CHECK (length(status) <= 16),
        created_by_subject BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id),
        FOREIGN KEY (tenant_id, agent_name) REFERENCES agent (tenant_id, name) ON DELETE CASCADE
      ) STRICT
    `.execute(trx);

    await sql`CREATE UNIQUE INDEX automation_name_uq ON automation (tenant_id, name)`.execute(trx);
    await sql`CREATE INDEX automation_agent_idx ON automation (tenant_id, agent_name)`.execute(trx);
    await sql`CREATE INDEX automation_active_idx ON automation (tenant_id) WHERE status = 'active'`.execute(trx);

    await sql`
      CREATE TABLE automation_run (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
        subject_key TEXT NOT NULL,
        lane_key TEXT,
        status TEXT NOT NULL CHECK (length(status) <= 16),
        mode TEXT NOT NULL,
        event_ids BLOB NOT NULL,
        session_id TEXT,
        scheduled_for TEXT NOT NULL,
        triggered_at TEXT,
        finished_at TEXT,
        outcome BLOB,
        created_by_subject BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    // The coalesce window as a constraint: at most one open run per (automation, subject).
    await sql`
      CREATE UNIQUE INDEX automation_run_coalescing_uq
        ON automation_run (automation_id, subject_key)
        WHERE status = 'coalescing'
    `.execute(trx);

    await sql`
      CREATE INDEX automation_run_due_idx
        ON automation_run (scheduled_for)
        WHERE status = 'coalescing'
    `.execute(trx);

    await sql`
      CREATE INDEX automation_run_lane_idx
        ON automation_run (tenant_id, lane_key)
        WHERE status IN ('triggered', 'waiting')
    `.execute(trx);

    await sql`
      CREATE INDEX automation_run_open_idx
        ON automation_run (updated_at)
        WHERE status IN ('triggered', 'waiting')
    `.execute(trx);

    await sql`CREATE INDEX automation_run_list_idx ON automation_run (automation_id, created_at DESC)`.execute(trx);
    await sql`CREATE INDEX automation_run_session_idx ON automation_run (session_id)`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS automation_run`.execute(trx);
    await sql`DROP TABLE IF EXISTS automation`.execute(trx);
  });
}
