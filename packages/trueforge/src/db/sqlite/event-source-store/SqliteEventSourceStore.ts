import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { ExpressionBuilder, Kysely, Transaction } from 'kysely';
import {
  INTERNAL_SOURCE_NAME,
  type EventSourceKind,
  type EventSourceManifest,
  type EventSourceSecrets,
  type EventSourceStatus,
} from '../../../schemas/eventSource';
import { newId } from '../../../utils/id';
import { parseStoredCreatedBySubject } from '../../createdBySubject';
import {
  EventSourceNameConflictError,
  INTERNAL_SOURCE_SUBJECT,
  parseStoredEventSourceManifest,
  parseStoredEventSourceSecrets,
  type ActivateGithubSourceInput,
  type CreatePendingGithubSourceInput,
  type EventSourceRecord,
  type GetEventSourceInput,
  type IEventSourceStore,
  type MarkDeliveryInput,
} from '../../eventSourceStore';
import { isUniqueViolation } from '../client';
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

/** Every column except `secrets`, projecting JSONB as parsed JSON (see JSON_RESULT_COLUMNS). */
function publicColumns(eb: ExpressionBuilder<Database, 'event_source'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'kind' as const,
    'name' as const,
    'status' as const,
    jsonText<EventSourceManifest>(eb.ref('manifest')).as('manifest'),
    'manifest_state' as const,
    'last_delivery_at' as const,
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'created_at' as const,
    'updated_at' as const,
  ];
}

interface PublicRow {
  id: string;
  tenant_id: string;
  kind: EventSourceKind;
  name: string;
  status: EventSourceStatus;
  manifest: EventSourceManifest;
  manifest_state: string | null;
  last_delivery_at: string | null;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

function toRecord(row: PublicRow): EventSourceRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    manifest: parseStoredEventSourceManifest(row.manifest),
    manifest_state: row.manifest_state,
    last_delivery_at: row.last_delivery_at,
    created_by_subject: parseStoredCreatedBySubject(row.created_by_subject),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SqliteEventSourceStore implements IEventSourceStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async #getById(id: string, db: Kysely<Database> | Transaction<Database>): Promise<EventSourceRecord | undefined> {
    const row = await db.selectFrom('event_source').select(publicColumns).where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async createPendingGithubSource(
    input: CreatePendingGithubSourceInput,
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord> {
    const db = transaction ?? this.#db;
    const id = newId();
    const timestamp = nowIso();
    try {
      await db
        .insertInto('event_source')
        .values({
          id,
          tenant_id: input.tenant_id,
          kind: 'github',
          name: input.name,
          status: 'pending',
          manifest: jsonbBind({ kind: 'github', app: null }),
          secrets: null,
          manifest_state: input.manifest_state,
          last_delivery_at: null,
          created_by_subject: jsonbBind(input.created_by_subject),
          created_at: timestamp,
          updated_at: timestamp,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EventSourceNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
    const created = await this.#getById(id, db);
    if (created === undefined) {
      throw new Error(`Event source ${id} vanished after insert`);
    }
    return created;
  }

  async getSource(
    input: GetEventSourceInput,
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('event_source')
      .select(publicColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getSourceById(id: string, transaction?: Transaction<Database>): Promise<EventSourceRecord | undefined> {
    return this.#getById(id, transaction ?? this.#db);
  }

  async getSourceByManifestState(
    state: string,
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('event_source')
      .select(publicColumns)
      .where('manifest_state', '=', state)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getSecrets(id: string, transaction?: Transaction<Database>): Promise<EventSourceSecrets> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('event_source')
      .select(eb => [jsonText<EventSourceSecrets>(eb.ref('secrets')).as('secrets')])
      .where('id', '=', id)
      .executeTakeFirst();
    return parseStoredEventSourceSecrets(row?.secrets ?? null);
  }

  async activateGithubSource(
    input: ActivateGithubSourceInput,
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord | undefined> {
    const db = transaction ?? this.#db;
    await db
      .updateTable('event_source')
      .set({
        status: 'active',
        manifest: jsonbBind({ kind: 'github', app: input.app }),
        secrets: jsonbBind({ kind: 'github', github: input.secrets }),
        manifest_state: null,
        updated_at: nowIso(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .execute();
    return this.getSource({ tenant_id: input.tenant_id, id: input.id }, transaction);
  }

  async listSources(input: { tenant_id: string }, transaction?: Transaction<Database>): Promise<EventSourceRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('event_source')
      .select(publicColumns)
      .where('tenant_id', '=', input.tenant_id)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .execute();
    return rows.map(toRecord);
  }

  async deleteSource(input: GetEventSourceInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db.deleteFrom('event_source').where('tenant_id', '=', input.tenant_id).where('id', '=', input.id).execute();
  }

  async markDelivery(input: MarkDeliveryInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db
      .updateTable('event_source')
      .set({ last_delivery_at: input.at.toISOString(), status: input.status, updated_at: nowIso() })
      .where('id', '=', input.id)
      .execute();
  }

  async ensureInternalSource(
    input: { tenant_id: string },
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord> {
    const db = transaction ?? this.#db;
    const existing = await db
      .selectFrom('event_source')
      .select(publicColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('kind', '=', 'trueforge')
      .executeTakeFirst();
    if (existing !== undefined) {
      return toRecord(existing);
    }
    const timestamp = nowIso();
    await db
      .insertInto('event_source')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        kind: 'trueforge',
        name: INTERNAL_SOURCE_NAME,
        status: 'active',
        manifest: jsonbBind({ kind: 'trueforge' }),
        secrets: null,
        manifest_state: null,
        last_delivery_at: null,
        created_by_subject: jsonbBind(INTERNAL_SOURCE_SUBJECT),
        created_at: timestamp,
        updated_at: timestamp,
      })
      .onConflict(oc => oc.columns(['tenant_id', 'name']).doNothing())
      .execute();
    const row = await db
      .selectFrom('event_source')
      .select(publicColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('kind', '=', 'trueforge')
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }
}
