import { sql, type Kysely } from 'kysely';
import { SESSION_SOURCE_IDX } from '../../indexes';

/**
 * Add nullable JSONB `source` on session. Mirrors
 * db/postgres/migrations/20260904_000002_session_source.ts.
 * Nullable ADD COLUMN needs no table rebuild.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE session ADD COLUMN source BLOB`.execute(db);
  await sql`
    CREATE INDEX ${sql.raw(SESSION_SOURCE_IDX)}
      ON session (tenant_id, json_extract(source, '$.type'), json_extract(source, '$.id'))
      WHERE source IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS ${sql.raw(SESSION_SOURCE_IDX)}`.execute(db);
  await sql`ALTER TABLE session DROP COLUMN source`.execute(db);
}
