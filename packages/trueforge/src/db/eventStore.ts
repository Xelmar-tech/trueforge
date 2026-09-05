/**
 * The event ledger: one `event` row per accepted provider delivery. The coalesce loop
 * reads unrouted rows oldest first and stamps `routed_at` once every matching
 * automation has seen them.
 *
 * Implementations: PostgresEventStore and SqliteEventStore.
 */
import type { TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import type { JsonObject, NormalizedEvent } from '../connectors/types';
import { EventSummarySchema, type EventSummary } from '../schemas/event';
import type { EventSourceKind } from '../schemas/eventSource';

export interface EventRecord {
  id: string;
  tenant_id: string;
  source_id: string;
  source_kind: EventSourceKind;
  kind: string;
  subject_key: string;
  delivery_id: string;
  summary: EventSummary;
  /** ISO-8601 UTC instant. */
  received_at: string;
  routed_at: string | null;
}

export interface EventWithPayloadRecord extends EventRecord {
  payload: JsonObject;
}

export function parseStoredEventSummary(summary: unknown): EventSummary {
  return EventSummarySchema.parse(summary);
}

export interface InsertEventInput {
  tenant_id: string;
  source_id: string;
  source_kind: EventSourceKind;
  event: NormalizedEvent;
  received_at: Date;
}

export interface GetEventInput {
  tenant_id: string;
  id: string;
}

export interface ListEventsInput {
  tenant_id: string;
  limit: number;
  page_token: string | undefined;
  source_id?: string | undefined;
  kind?: string | undefined;
  subject_key?: string | undefined;
  /** Only events received at or after this instant. */
  since?: Date | undefined;
}

export interface IEventStore<TTransaction = never> {
  /**
   * Inserts one delivery. A repeated `delivery_id` for the same source returns the
   * existing row with `created: false` — a redelivery never doubles an event.
   */
  insertEvent(input: InsertEventInput, transaction?: TTransaction): Promise<{ event: EventRecord; created: boolean }>;
  getEvent(input: GetEventInput, transaction?: TTransaction): Promise<EventWithPayloadRecord | undefined>;
  /** Newest first. Never loads payloads. */
  listEvents(
    input: ListEventsInput,
    transaction?: TTransaction,
  ): Promise<{ data: EventRecord[]; pagination: TokenPagination }>;
  /** Unrouted events, oldest first, with payloads — the coalesce loop's input. */
  listUnrouted(input: { limit: number }, transaction?: TTransaction): Promise<EventWithPayloadRecord[]>;
  markRouted(input: { ids: readonly string[]; at: Date }, transaction?: TTransaction): Promise<void>;
}
