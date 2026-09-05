import type { Kysely, Selectable, Transaction } from 'kysely';
import { INTERNAL_SOURCE_NAME, type EventSourceSecrets } from '../../../schemas/eventSource';
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
import { json, now } from '../sqlExpressions';
import type { Database, EventSourceTable } from '../types';

/** Every column except `secrets`, so a listing can never leak credentials. */
const PUBLIC_COLUMNS = [
  'id',
  'tenant_id',
  'kind',
  'name',
  'status',
  'manifest',
  'manifest_state',
  'last_delivery_at',
  'created_by_subject',
  'created_at',
  'updated_at',
] as const;

type PublicRow = Pick<Selectable<EventSourceTable>, (typeof PUBLIC_COLUMNS)[number]>;

function toRecord(row: PublicRow): EventSourceRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    manifest: parseStoredEventSourceManifest(row.manifest),
    manifest_state: row.manifest_state,
    last_delivery_at: row.last_delivery_at === null ? null : row.last_delivery_at.toISOString(),
    created_by_subject: parseStoredCreatedBySubject(row.created_by_subject),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export class PostgresEventSourceStore implements IEventSourceStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async createPendingGithubSource(
    input: CreatePendingGithubSourceInput,
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord> {
    const db = transaction ?? this.#db;
    try {
      const row = await db
        .insertInto('event_source')
        .values({
          id: newId(),
          tenant_id: input.tenant_id,
          kind: 'github',
          name: input.name,
          status: 'pending',
          manifest: json({ kind: 'github', app: null }),
          secrets: null,
          manifest_state: input.manifest_state,
          last_delivery_at: null,
          created_by_subject: json(input.created_by_subject),
          created_at: now(),
          updated_at: now(),
        })
        .returning(PUBLIC_COLUMNS)
        .executeTakeFirstOrThrow();
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EventSourceNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
  }

  async getSource(
    input: GetEventSourceInput,
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('event_source')
      .select(PUBLIC_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getSourceById(id: string, transaction?: Transaction<Database>): Promise<EventSourceRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db.selectFrom('event_source').select(PUBLIC_COLUMNS).where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getSourceByManifestState(
    state: string,
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('event_source')
      .select(PUBLIC_COLUMNS)
      .where('manifest_state', '=', state)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getSecrets(id: string, transaction?: Transaction<Database>): Promise<EventSourceSecrets> {
    const db = transaction ?? this.#db;
    const row = await db.selectFrom('event_source').select('secrets').where('id', '=', id).executeTakeFirst();
    return parseStoredEventSourceSecrets(row?.secrets ?? null);
  }

  async activateGithubSource(
    input: ActivateGithubSourceInput,
    transaction?: Transaction<Database>,
  ): Promise<EventSourceRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('event_source')
      .set({
        status: 'active',
        manifest: json({ kind: 'github', app: input.app }),
        secrets: json({ kind: 'github', github: input.secrets }),
        manifest_state: null,
        updated_at: now(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .returning(PUBLIC_COLUMNS)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async listSources(input: { tenant_id: string }, transaction?: Transaction<Database>): Promise<EventSourceRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('event_source')
      .select(PUBLIC_COLUMNS)
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
      .set({ last_delivery_at: input.at, status: input.status, updated_at: now() })
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
      .select(PUBLIC_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('kind', '=', 'trueforge')
      .executeTakeFirst();
    if (existing !== undefined) {
      return toRecord(existing);
    }
    // Two loops racing here both insert; the name index lets exactly one win.
    await db
      .insertInto('event_source')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        kind: 'trueforge',
        name: INTERNAL_SOURCE_NAME,
        status: 'active',
        manifest: json({ kind: 'trueforge' }),
        secrets: null,
        manifest_state: null,
        last_delivery_at: null,
        created_by_subject: json(INTERNAL_SOURCE_SUBJECT),
        created_at: now(),
        updated_at: now(),
      })
      .onConflict(oc => oc.columns(['tenant_id', 'name']).doNothing())
      .execute();
    const row = await db
      .selectFrom('event_source')
      .select(PUBLIC_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('kind', '=', 'trueforge')
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }
}
