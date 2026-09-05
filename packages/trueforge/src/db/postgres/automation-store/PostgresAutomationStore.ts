import type { TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import {
  decodeOffsetPageToken,
  paginateOffsetRows,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
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
import { json, now } from '../sqlExpressions';
import type { AutomationRunTable, AutomationTable, Database } from '../types';

const EventIdsSchema = z.array(z.string());

function toAutomationRecord(row: Selectable<AutomationTable>): AutomationRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    name: row.name,
    manifest: parseStoredAutomationManifest(row.manifest),
    status: row.status,
    created_by_subject: parseStoredCreatedBySubject(row.created_by_subject),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toRunRecord(row: Selectable<AutomationRunTable>): AutomationRunRecord {
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
    scheduled_for: row.scheduled_for.toISOString(),
    triggered_at: row.triggered_at === null ? null : row.triggered_at.toISOString(),
    finished_at: row.finished_at === null ? null : row.finished_at.toISOString(),
    outcome: row.outcome,
    created_by_subject: parseStoredCreatedBySubject(row.created_by_subject),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const OPEN_STATUSES = ['triggered', 'waiting'] as const;

export class PostgresAutomationStore implements IAutomationStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getAutomation(
    input: GetAutomationInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('automation')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAutomationRecord(row);
  }

  async createAutomation(input: CreateAutomationInput, transaction?: Transaction<Database>): Promise<AutomationRecord> {
    const db = transaction ?? this.#db;
    try {
      const row = await db
        .insertInto('automation')
        .values({
          id: newId(),
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          agent_name: input.agent_name,
          name: input.name,
          manifest: json(input.manifest),
          status: input.manifest.status,
          created_by_subject: json(input.created_by_subject),
          created_at: now(),
          updated_at: now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAutomationRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AutomationNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
  }

  async updateAutomation(
    input: UpdateAutomationInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRecord | undefined> {
    const db = transaction ?? this.#db;
    try {
      const row = await db
        .updateTable('automation')
        .set({
          name: input.name,
          manifest: json(input.manifest),
          status: input.manifest.status,
          updated_at: now(),
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.id)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toAutomationRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AutomationNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
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
    let query = db.selectFrom('automation').selectAll().where('tenant_id', '=', input.tenant_id);
    if (input.agent_names !== undefined) {
      query = query.where('agent_name', 'in', [...input.agent_names]);
    }
    if (input.created_by_subject_id !== undefined) {
      query = query.where(sql`created_by_subject->>'subject_id'`, '=', input.created_by_subject_id);
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
      .selectAll()
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
    const row = await db
      .insertInto('automation_run')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        automation_id: input.automation_id,
        subject_key: input.subject_key,
        lane_key: input.lane_key,
        status: 'coalescing',
        mode: input.mode,
        event_ids: json([input.event_id]),
        session_id: null,
        scheduled_for: input.scheduled_for,
        triggered_at: null,
        finished_at: null,
        outcome: null,
        created_by_subject: json(input.created_by_subject),
        created_at: now(),
        updated_at: now(),
      })
      // Targets the partial unique index: one open window per (automation, subject). The
      // predicate must be a literal so the planner can match it to the index definition.
      .onConflict(oc =>
        oc
          .columns(['automation_id', 'subject_key'])
          .where(sql<boolean>`status = 'coalescing'`)
          .doUpdateSet({
            event_ids: sql`automation_run.event_ids || excluded.event_ids`,
            scheduled_for: input.scheduled_for,
            updated_at: now(),
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRunRecord(row);
  }

  async createImmediateRun(
    input: CreateImmediateRunInput,
    transaction?: Transaction<Database>,
  ): Promise<AutomationRunRecord> {
    const db = transaction ?? this.#db;
    const row = await db
      .insertInto('automation_run')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        automation_id: input.automation_id,
        subject_key: input.subject_key,
        lane_key: input.lane_key,
        status: 'coalescing',
        mode: input.mode,
        event_ids: json([...input.event_ids]),
        session_id: null,
        scheduled_for: input.now,
        triggered_at: null,
        finished_at: null,
        outcome: null,
        created_by_subject: json(input.created_by_subject),
        created_at: now(),
        updated_at: now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRunRecord(row);
  }

  async listDueRuns(input: ListDueRunsInput, transaction?: Transaction<Database>): Promise<AutomationRunRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('automation_run')
      .selectAll()
      .where('status', '=', 'coalescing')
      .where('scheduled_for', '<=', input.until)
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
    const row = await db
      .updateTable('automation_run')
      .set({ status: 'triggered', session_id: input.session_id, triggered_at: input.at, updated_at: now() })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .where('status', '=', 'coalescing')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async listOpenRuns(input: { limit: number }, transaction?: Transaction<Database>): Promise<AutomationRunRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('automation_run')
      .selectAll()
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
    const row = await db
      .updateTable('automation_run')
      .set({
        status: input.status,
        outcome: input.outcome === null ? null : json(input.outcome),
        finished_at: input.status === 'waiting' ? null : input.at,
        updated_at: now(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async getRun(input: GetRunInput, transaction?: Transaction<Database>): Promise<AutomationRunRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('automation_run')
      .selectAll()
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
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('automation_id', '=', input.automation_id)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .execute();
    return rows.map(toRunRecord);
  }
}
