import type { CreatedBySubject, TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import {
  decodeOffsetPageToken,
  paginateOffsetRows,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import { sql, type ExpressionBuilder, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { JsonObject } from '../../../connectors/types';
import type {
  AutomationManifest,
  AutomationMode,
  AutomationRunStatus,
  AutomationStatus,
} from '../../../schemas/automation';
import { newId } from '../../../utils/id';
import {
  AutomationNameConflictError,
  parseStoredAutomationManifest,
  type AutomationRecord,
  type AutomationRunRecord,
  type CreateAutomationInput,
  type CreateImmediateRunInput,
  type FinishRunInput,
  type GetAutomationInput,
  type GetRunInput,
  type IAutomationStore,
  type ListAutomationsInput,
  type ListDueRunsInput,
  type MarkTriggeredInput,
  type UpdateAutomationInput,
  type UpsertCoalescingRunInput,
} from '../../automationStore';
import { parseStoredCreatedBySubject } from '../../createdBySubject';
import { isUniqueViolation } from '../client';
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

const EventIdsSchema = z.array(z.string());

/** Column list projecting JSONB as parsed JSON (see JSON_RESULT_COLUMNS). */
function automationColumns(eb: ExpressionBuilder<Database, 'automation'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'agent_id' as const,
    'agent_name' as const,
    'name' as const,
    jsonText<AutomationManifest>(eb.ref('manifest')).as('manifest'),
    'status' as const,
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'created_at' as const,
    'updated_at' as const,
  ];
}

function runColumns(eb: ExpressionBuilder<Database, 'automation_run'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'automation_id' as const,
    'subject_key' as const,
    'lane_key' as const,
    'status' as const,
    'mode' as const,
    jsonText<string[]>(eb.ref('event_ids')).as('event_ids'),
    'session_id' as const,
    'scheduled_for' as const,
    'triggered_at' as const,
    'finished_at' as const,
    jsonText<JsonObject | null>(eb.ref('outcome')).as('outcome'),
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'created_at' as const,
    'updated_at' as const,
  ];
}

interface AutomationRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_name: string;
  name: string;
  manifest: AutomationManifest;
  status: AutomationStatus;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  tenant_id: string;
  automation_id: string;
  subject_key: string;
  lane_key: string | null;
  status: AutomationRunStatus;
  mode: AutomationMode;
  event_ids: string[];
  session_id: string | null;
  scheduled_for: string;
  triggered_at: string | null;
  finished_at: string | null;
  outcome: JsonObject | null;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

function toAutomationRecord(row: AutomationRow): AutomationRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    name: row.name,
    manifest: parseStoredAutomationManifest(row.manifest),
    status: row.status,
    created_by_subject: parseStoredCreatedBySubject(row.created_by_subject),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRunRecord(row: RunRow): AutomationRunRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    automation_id: row.automation_id,
    subject_key: row.subject_key,
    lane_key: row.lane_key,
    status: row.status,
    mode: row.mode,
    event_ids: EventIdsSchema.parse(row.event_ids),
    session_id: row.session_id,
    scheduled_for: row.scheduled_for,
    triggered_at: row.triggered_at,
    finished_at: row.finished_at,
    outcome: row.outcome,
    created_by_subject: parseStoredCreatedBySubject(row.created_by_subject),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const OPEN_STATUSES = ['triggered', 'waiting'] as const;

export class SqliteAutomationStore implements IAutomationStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async #getRunById(
    id: string,
    db: Kysely<Database> | Transaction<Database>,
  ): Promise<AutomationRunRecord | undefined> {
    const row = await db.selectFrom('automation_run').select(runColumns).where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async getAutomation(
    input: GetAutomationInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('automation')
      .select(automationColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAutomationRecord(row);
  }

  async createAutomation(input: CreateAutomationInput, transaction?: Transaction<Database>): Promise<AutomationRecord> {
    const db = transaction ?? this.#db;
    const id = newId();
    const timestamp = nowIso();
    try {
      await db
        .insertInto('automation')
        .values({
          id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          agent_name: input.agent_name,
          name: input.name,
          manifest: jsonbBind(input.manifest),
          status: input.manifest.status,
          created_by_subject: jsonbBind(input.created_by_subject),
          created_at: timestamp,
          updated_at: timestamp,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AutomationNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
    const created = await this.getAutomation({ tenant_id: input.tenant_id, id }, transaction);
    if (created === undefined) {
      throw new Error(`Automation ${id} vanished after insert`);
    }
    return created;
  }

  async updateAutomation(
    input: UpdateAutomationInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRecord | undefined> {
    const db = transaction ?? this.#db;
    try {
      await db
        .updateTable('automation')
        .set({
          name: input.name,
          manifest: jsonbBind(input.manifest),
          status: input.manifest.status,
          updated_at: nowIso(),
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.id)
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AutomationNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
    return this.getAutomation({ tenant_id: input.tenant_id, id: input.id }, transaction);
  }

  async deleteAutomation(input: GetAutomationInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db.deleteFrom('automation').where('tenant_id', '=', input.tenant_id).where('id', '=', input.id).execute();
  }

  async listAutomations(
    input: ListAutomationsInput,
    transaction?: Transaction<Database>,
  ): Promise<{ data: AutomationRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    const db = transaction ?? this.#db;
    let query = db.selectFrom('automation').select(automationColumns).where('tenant_id', '=', input.tenant_id);
    if (input.agent_names !== undefined) {
      query = query.where('agent_name', 'in', [...input.agent_names]);
    }
    if (input.created_by_subject_id !== undefined) {
      query = query.where(sql`created_by_subject->>'$.subject_id'`, '=', input.created_by_subject_id);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(input.limit + 1)
      .offset(offset)
      .execute();
    const { data, pagination } = paginateOffsetRows(rows, input.limit, offset);
    return { data: data.map(toAutomationRecord), pagination };
  }

  async listActiveAutomations(
    input: { tenant_id: string },
    transaction?: Transaction<Database>,
  ): Promise<AutomationRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('automation')
      .select(automationColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('status', '=', 'active')
      .orderBy('created_at')
      .execute();
    return rows.map(toAutomationRecord);
  }

  async upsertCoalescingRun(
    input: UpsertCoalescingRunInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRunRecord> {
    const db = transaction ?? this.#db;
    const id = newId();
    const timestamp = nowIso();
    const scheduledFor = input.scheduled_for.toISOString();
    await db
      .insertInto('automation_run')
      .values({
        id,
        tenant_id: input.tenant_id,
        automation_id: input.automation_id,
        subject_key: input.subject_key,
        lane_key: input.lane_key,
        status: 'coalescing',
        mode: input.mode,
        event_ids: jsonbBind([input.event_id]),
        session_id: null,
        scheduled_for: scheduledFor,
        triggered_at: null,
        finished_at: null,
        outcome: null,
        created_by_subject: jsonbBind(input.created_by_subject),
        created_at: timestamp,
        updated_at: timestamp,
      })
      // Targets the partial unique index: one open window per (automation, subject). The
      // predicate must be a literal so SQLite can match it to the index definition.
      .onConflict(oc =>
        oc
          .columns(['automation_id', 'subject_key'])
          .where(sql<boolean>`status = 'coalescing'`)
          .doUpdateSet({
            event_ids: sql`jsonb_insert(automation_run.event_ids, '$[#]', ${input.event_id})`,
            scheduled_for: scheduledFor,
            updated_at: timestamp,
          }),
      )
      .execute();
    const row = await db
      .selectFrom('automation_run')
      .select(runColumns)
      .where('automation_id', '=', input.automation_id)
      .where('subject_key', '=', input.subject_key)
      .where('status', '=', 'coalescing')
      .executeTakeFirstOrThrow();
    return toRunRecord(row);
  }

  async createImmediateRun(
    input: CreateImmediateRunInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRunRecord> {
    const db = transaction ?? this.#db;
    const id = newId();
    const timestamp = nowIso();
    await db
      .insertInto('automation_run')
      .values({
        id,
        tenant_id: input.tenant_id,
        automation_id: input.automation_id,
        subject_key: input.subject_key,
        lane_key: input.lane_key,
        status: 'coalescing',
        mode: input.mode,
        event_ids: jsonbBind([...input.event_ids]),
        session_id: null,
        scheduled_for: input.now.toISOString(),
        triggered_at: null,
        finished_at: null,
        outcome: null,
        created_by_subject: jsonbBind(input.created_by_subject),
        created_at: timestamp,
        updated_at: timestamp,
      })
      .execute();
    const created = await this.#getRunById(id, db);
    if (created === undefined) {
      throw new Error(`Automation run ${id} vanished after insert`);
    }
    return created;
  }

  async listDueRuns(input: ListDueRunsInput, transaction?: Transaction<Database>): Promise<AutomationRunRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('automation_run')
      .select(runColumns)
      .where('status', '=', 'coalescing')
      .where('scheduled_for', '<=', input.until.toISOString())
      .orderBy('scheduled_for')
      .orderBy('id')
      .limit(input.limit)
      .execute();
    return rows.map(toRunRecord);
  }

  async isLaneBusy(
    input: { tenant_id: string; lane_key: string },
    transaction?: Transaction<Database>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('automation_run')
      .select('id')
      .where('tenant_id', '=', input.tenant_id)
      .where('lane_key', '=', input.lane_key)
      .where('status', 'in', [...OPEN_STATUSES])
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async markTriggered(
    input: MarkTriggeredInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRunRecord | undefined> {
    const db = transaction ?? this.#db;
    const result = await db
      .updateTable('automation_run')
      .set({
        status: 'triggered',
        session_id: input.session_id,
        triggered_at: input.at.toISOString(),
        updated_at: nowIso(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .where('status', '=', 'coalescing')
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      return undefined;
    }
    return this.#getRunById(input.id, db);
  }

  async listOpenRuns(input: { limit: number }, transaction?: Transaction<Database>): Promise<AutomationRunRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('automation_run')
      .select(runColumns)
      .where('status', 'in', [...OPEN_STATUSES])
      .orderBy('updated_at')
      .orderBy('id')
      .limit(input.limit)
      .execute();
    return rows.map(toRunRecord);
  }

  async finishRun(
    input: FinishRunInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRunRecord | undefined> {
    const db = transaction ?? this.#db;
    const result = await db
      .updateTable('automation_run')
      .set({
        status: input.status,
        outcome: input.outcome === null ? null : jsonbBind(input.outcome),
        finished_at: input.status === 'waiting' ? null : input.at.toISOString(),
        updated_at: nowIso(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      return undefined;
    }
    return this.#getRunById(input.id, db);
  }

  async getRun(input: GetRunInput, transaction?: Transaction<Database>): Promise<AutomationRunRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('automation_run')
      .select(runColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async listRuns(
    input: { tenant_id: string; automation_id: string },
    transaction?: Transaction<Database>,
  ): Promise<AutomationRunRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('automation_run')
      .select(runColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('automation_id', '=', input.automation_id)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .execute();
    return rows.map(toRunRecord);
  }
}
