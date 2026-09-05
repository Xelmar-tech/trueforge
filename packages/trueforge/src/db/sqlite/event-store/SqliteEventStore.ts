import type { TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import {
  decodeOffsetPageToken,
  paginateOffsetRows,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import type { ExpressionBuilder, Kysely, Transaction } from 'kysely';
import type { JsonObject } from '../../../connectors/types';
import type { EventSummary } from '../../../schemas/event';
import type { EventSourceKind } from '../../../schemas/eventSource';
import { newId } from '../../../utils/id';
import {
  parseStoredEventSummary,
  type EventRecord,
  type EventWithPayloadRecord,
  type GetEventInput,
  type IEventStore,
  type InsertEventInput,
  type ListEventsInput,
} from '../../eventStore';
import { jsonbBind, jsonText } from '../sqlExpressions';
import type { Database } from '../types';

type Joined = ExpressionBuilder<Database, 'event' | 'event_source'>;

/** Listing columns: everything but `payload`, plus the owning source's kind. */
function listColumns(eb: Joined) {
  return [
    'event.id as id' as const,
    'event.tenant_id as tenant_id' as const,
    'event.source_id as source_id' as const,
    'event_source.kind as source_kind' as const,
    'event.kind as kind' as const,
    'event.subject_key as subject_key' as const,
    'event.delivery_id as delivery_id' as const,
    jsonText<EventSummary>(eb.ref('event.summary')).as('summary'),
    'event.received_at as received_at' as const,
    'event.routed_at as routed_at' as const,
  ];
}

function detailColumns(eb: Joined) {
  return [...listColumns(eb), jsonText<JsonObject>(eb.ref('event.payload')).as('payload')];
}

interface EventRow {
  id: string;
  tenant_id: string;
  source_id: string;
  source_kind: EventSourceKind;
  kind: string;
  subject_key: string;
  delivery_id: string;
  summary: EventSummary;
  received_at: string;
  routed_at: string | null;
}

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    source_id: row.source_id,
    source_kind: row.source_kind,
    kind: row.kind,
    subject_key: row.subject_key,
    delivery_id: row.delivery_id,
    summary: parseStoredEventSummary(row.summary),
    received_at: row.received_at,
    routed_at: row.routed_at,
  };
}

function toRecordWithPayload(row: EventRow & { payload: JsonObject }): EventWithPayloadRecord {
  return { ...toRecord(row), payload: row.payload };
}

export class SqliteEventStore implements IEventStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  #joined(db: Kysely<Database> | Transaction<Database>) {
    return db.selectFrom('event').innerJoin('event_source', 'event_source.id', 'event.source_id');
  }

  async insertEvent(
    input: InsertEventInput,
    transaction?: Transaction<Database>,
  ): Promise<{ event: EventRecord; created: boolean }> {
    const db = transaction ?? this.#db;
    const inserted = await db
      .insertInto('event')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        source_id: input.source_id,
        kind: input.event.kind,
        subject_key: input.event.subject_key,
        delivery_id: input.event.delivery_id,
        summary: jsonbBind(input.event.summary),
        payload: jsonbBind(input.event.payload),
        received_at: input.received_at.toISOString(),
        routed_at: null,
      })
      .onConflict(oc => oc.columns(['source_id', 'delivery_id']).doNothing())
      .returning('id')
      .executeTakeFirst();

    const row = await this.#joined(db)
      .select(listColumns)
      .where('event.source_id', '=', input.source_id)
      .where('event.delivery_id', '=', input.event.delivery_id)
      .executeTakeFirstOrThrow();
    return { event: toRecord(row), created: inserted !== undefined };
  }

  async getEvent(
    input: GetEventInput,
    transaction?: Transaction<Database>,
  ): Promise<EventWithPayloadRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await this.#joined(db)
      .select(detailColumns)
      .where('event.tenant_id', '=', input.tenant_id)
      .where('event.id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecordWithPayload(row);
  }

  async listEvents(
    input: ListEventsInput,
    transaction?: Transaction<Database>,
  ): Promise<{ data: EventRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    const db = transaction ?? this.#db;
    let query = this.#joined(db).select(listColumns).where('event.tenant_id', '=', input.tenant_id);
    if (input.source_id !== undefined) {
      query = query.where('event.source_id', '=', input.source_id);
    }
    if (input.kind !== undefined) {
      query = query.where('event.kind', '=', input.kind);
    }
    if (input.subject_key !== undefined) {
      query = query.where('event.subject_key', '=', input.subject_key);
    }
    if (input.since !== undefined) {
      query = query.where('event.received_at', '>=', input.since.toISOString());
    }
    const rows = await query
      .orderBy('event.received_at', 'desc')
      .orderBy('event.id')
      .limit(input.limit + 1)
      .offset(offset)
      .execute();
    const { data, pagination } = paginateOffsetRows(rows, input.limit, offset);
    return { data: data.map(toRecord), pagination };
  }

  async listUnrouted(input: { limit: number }, transaction?: Transaction<Database>): Promise<EventWithPayloadRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await this.#joined(db)
      .select(detailColumns)
      .where('event.routed_at', 'is', null)
      .orderBy('event.received_at', 'asc')
      .orderBy('event.id')
      .limit(input.limit)
      .execute();
    return rows.map(toRecordWithPayload);
  }

  async markRouted(input: { ids: readonly string[]; at: Date }, transaction?: Transaction<Database>): Promise<void> {
    if (input.ids.length === 0) {
      return;
    }
    const db = transaction ?? this.#db;
    await db
      .updateTable('event')
      .set({ routed_at: input.at.toISOString() })
      .where('id', 'in', [...input.ids])
      .where('routed_at', 'is', null)
      .execute();
  }
}
