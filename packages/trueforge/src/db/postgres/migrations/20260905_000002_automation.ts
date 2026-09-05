import { sql, type Kysely } from 'kysely';

/**
 * Event-driven automations: `automation` + `automation_run`.
 *
 * - `automation`: one row per event binding. Spec lives in Zod-validated `manifest`
 *   jsonb (same pattern as `schedule`). Bound by agent name with the same composite FK
 *   `(tenant_id, agent_name)` → `agent(tenant_id, name)` ON DELETE CASCADE.
 * - `automation_run`: one row per coalesce window, pending or historical.
 *
 * Index choices:
 * - `automation_run_coalescing_uq` is the coalesce window as a constraint: AT MOST ONE
 *   open (`coalescing`) run per (automation, subject). A burst of events lands on one row.
 * - `automation_run_due_idx` is PARTIAL on `status = 'coalescing'`; the dispatch loop polls
 *   it every few seconds and the table is overwhelmingly terminal rows.
 * - `automation_run_lane_idx` is PARTIAL on the two in-flight statuses; the lane check is
 *   an existence probe on it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await db.schema
    .createTable('automation')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('agent_id', 'text', col => col.notNull())
    .addColumn('agent_name', 'text', col => col.notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('manifest', 'jsonb', col => col.notNull())
    .addColumn('status', 'text', col => col.notNull())
    .addColumn('created_by_subject', 'jsonb', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('automation_pkey', ['id'])
    .addForeignKeyConstraint(
      'automation_agent_name_fk',
      ['tenant_id', 'agent_name'],
      'agent',
      ['tenant_id', 'name'],
      cb => cb.onDelete('cascade'),
    )
    .execute();

  await db.schema.createIndex('automation_name_uq').on('automation').columns(['tenant_id', 'name']).unique().execute();
  await db.schema.createIndex('automation_agent_idx').on('automation').columns(['tenant_id', 'agent_name']).execute();
  await sql`CREATE INDEX automation_active_idx ON automation (tenant_id) WHERE status = 'active'`.execute(db);

  await db.schema
    .createTable('automation_run')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('automation_id', 'text', col => col.notNull().references('automation.id').onDelete('cascade'))
    .addColumn('subject_key', 'text', col => col.notNull())
    .addColumn('lane_key', 'text')
    .addColumn('status', sql`varchar(16)`, col => col.notNull())
    .addColumn('mode', 'text', col => col.notNull())
    .addColumn('event_ids', 'jsonb', col => col.notNull())
    .addColumn('session_id', 'text')
    .addColumn('scheduled_for', 'timestamptz', col => col.notNull())
    .addColumn('triggered_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('outcome', 'jsonb')
    .addColumn('created_by_subject', 'jsonb', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('automation_run_pkey', ['id'])
    .execute();

  // A run row takes a few small bounded updates in its life; leave HOT headroom.
  await sql`ALTER TABLE automation_run SET (fillfactor = 85)`.execute(db);

  await sql`
    CREATE UNIQUE INDEX automation_run_coalescing_uq
      ON automation_run (automation_id, subject_key)
      WHERE status = 'coalescing'
  `.execute(db);

  await sql`
    CREATE INDEX automation_run_due_idx
      ON automation_run (scheduled_for)
      WHERE status = 'coalescing'
  `.execute(db);

  await sql`
    CREATE INDEX automation_run_lane_idx
      ON automation_run (tenant_id, lane_key)
      WHERE status IN ('triggered', 'waiting')
  `.execute(db);

  await sql`
    CREATE INDEX automation_run_open_idx
      ON automation_run (updated_at)
      WHERE status IN ('triggered', 'waiting')
  `.execute(db);

  // Run history: newest first within one automation.
  await sql`CREATE INDEX automation_run_list_idx ON automation_run (automation_id, created_at DESC)`.execute(db);
  await sql`CREATE INDEX automation_run_session_idx ON automation_run (session_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('automation_run').ifExists().cascade().execute();
  await db.schema.dropTable('automation').ifExists().cascade().execute();
}
