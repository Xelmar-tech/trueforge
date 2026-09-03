import { sql, type Kysely } from 'kysely';
import { SCHEDULE_AGENT_ID_IDX } from '../../indexes';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`ALTER TABLE schedule ADD COLUMN agent_id text`.execute(trx);
    await sql`
      UPDATE schedule AS s
      SET agent_id = a.id
      FROM agent AS a
      WHERE a.tenant_id = s.tenant_id AND a.name = s.agent_name
    `.execute(trx);
    await sql`ALTER TABLE schedule ALTER COLUMN agent_id SET NOT NULL`.execute(trx);
    await sql`
      ALTER TABLE schedule
      ADD CONSTRAINT schedule_agent_id_fk
      FOREIGN KEY (agent_id) REFERENCES agent(id) ON DELETE CASCADE
    `.execute(trx);
    await sql`
      CREATE INDEX ${sql.raw(SCHEDULE_AGENT_ID_IDX)}
      ON schedule (tenant_id, agent_id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`DROP INDEX IF EXISTS ${sql.raw(SCHEDULE_AGENT_ID_IDX)}`.execute(trx);
    await sql`ALTER TABLE schedule DROP CONSTRAINT schedule_agent_id_fk`.execute(trx);
    await sql`ALTER TABLE schedule DROP COLUMN agent_id`.execute(trx);
  });
}
