/**
 * DB-backed event sources: one `event_source` row per connected provider (a GitHub App
 * today). Credentials live in the `secrets` column and are read only through
 * {@link IEventSourceStore.getSecrets}; every other read omits them.
 *
 * Implementations: PostgresEventSourceStore and SqliteEventSourceStore.
 */
import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import {
  EventSourceManifestSchema,
  EventSourceSecretsSchema,
  type EventSourceKind,
  type EventSourceManifest,
  type EventSourceSecrets,
  type EventSourceStatus,
  type GithubAppConfig,
  type GithubSourceSecrets,
} from '../schemas/eventSource';

export interface EventSourceRecord {
  id: string;
  tenant_id: string;
  kind: EventSourceKind;
  /** Slug-shaped label, unique per tenant (`event_source_name_uq`). */
  name: string;
  status: EventSourceStatus;
  manifest: EventSourceManifest;
  /** One-time nonce while the GitHub manifest flow is in progress; null afterwards. */
  manifest_state: string | null;
  /** ISO-8601 UTC instant of the last accepted delivery. */
  last_delivery_at: string | null;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

/** Creator recorded on the per-tenant internal source; no person made it. */
export const INTERNAL_SOURCE_SUBJECT: CreatedBySubject = {
  subject_id: 'trueforge',
  subject_type: 'system',
  subject_display_name: 'TrueForge',
};

/** Re-parse persisted JSON so schema defaults materialize and readers validate on read. */
export function parseStoredEventSourceManifest(manifest: unknown): EventSourceManifest {
  return EventSourceManifestSchema.parse(manifest);
}

export function parseStoredEventSourceSecrets(secrets: unknown): EventSourceSecrets {
  return EventSourceSecretsSchema.parse(secrets);
}

/** Source name already taken for this tenant — violates `event_source_name_uq`. */
export class EventSourceNameConflictError extends Error {
  readonly tenant_id: string;
  readonly source_name: string;

  constructor({ tenant_id, name }: { tenant_id: string; name: string }, options?: ErrorOptions) {
    super(`Event source name already exists: ${name}`, options);
    this.name = 'EventSourceNameConflictError';
    this.tenant_id = tenant_id;
    this.source_name = name;
  }
}

export interface CreatePendingGithubSourceInput {
  tenant_id: string;
  name: string;
  manifest_state: string;
  created_by_subject: CreatedBySubject;
}

export interface GetEventSourceInput {
  tenant_id: string;
  id: string;
}

export interface ActivateGithubSourceInput {
  tenant_id: string;
  id: string;
  app: GithubAppConfig;
  secrets: GithubSourceSecrets;
}

export interface MarkDeliveryInput {
  id: string;
  at: Date;
  status: EventSourceStatus;
}

export interface IEventSourceStore<TTransaction = never> {
  /** Inserts a `pending` GitHub source holding the manifest-flow nonce. */
  createPendingGithubSource(
    input: CreatePendingGithubSourceInput,
    transaction?: TTransaction,
  ): Promise<EventSourceRecord>;
  getSource(input: GetEventSourceInput, transaction?: TTransaction): Promise<EventSourceRecord | undefined>;
  /** Tenant-less lookup for the unauthenticated webhook route; the row carries its tenant. */
  getSourceById(id: string, transaction?: TTransaction): Promise<EventSourceRecord | undefined>;
  getSourceByManifestState(state: string, transaction?: TTransaction): Promise<EventSourceRecord | undefined>;
  /** Credentials for the connector. `null` while the source is still pending. */
  getSecrets(id: string, transaction?: TTransaction): Promise<EventSourceSecrets>;
  /** Stores the created App, clears the nonce and moves the source to `active`. */
  activateGithubSource(
    input: ActivateGithubSourceInput,
    transaction?: TTransaction,
  ): Promise<EventSourceRecord | undefined>;
  listSources(input: { tenant_id: string }, transaction?: TTransaction): Promise<EventSourceRecord[]>;
  /** Deletes by immutable id; events cascade. Idempotent if already missing. */
  deleteSource(input: GetEventSourceInput, transaction?: TTransaction): Promise<void>;
  /** Stamps `last_delivery_at` and the resulting status after a webhook delivery. */
  markDelivery(input: MarkDeliveryInput, transaction?: TTransaction): Promise<void>;
  /**
   * The tenant's internal `trueforge` source, created on first use. Automations emit
   * completion events into it so other automations can trigger on them.
   */
  ensureInternalSource(input: { tenant_id: string }, transaction?: TTransaction): Promise<EventSourceRecord>;
}
