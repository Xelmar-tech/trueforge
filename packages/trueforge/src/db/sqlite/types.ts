/**
 * Live app schema for the SQLite-backed session store.
 * Migrations must not use this type — use `Kysely<unknown>` instead.
 *
 * JSON payload columns are BLOB JSONB on disk. Reads must project `json(column)`;
 * `ParseJSONResultsPlugin` (configured in createSqliteDb) parses those top-level columns only.
 */
import type {
  AgentSpec,
  CreatedBySubject,
  PersistedTurnEvent,
  SessionMetadata,
  SessionMetrics,
  TurnInputItem,
  TurnState,
} from '@truefoundry/trueforge-core/agent-session';
import type {
  AgentInfo,
  AgentParent,
  ContextMessage,
  JsonValue,
  MCPServerInitInfo,
  SandboxInfo,
  SubAgentCompletionMarker,
} from '@truefoundry/trueforge-core/core';
import type { CurrentContextUsage } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';
import type { JsonObject } from '../../connectors/types';
import type {
  AutomationManifest,
  AutomationMode,
  AutomationRunStatus,
  AutomationStatus,
} from '../../schemas/automation';
import type { EventSummary } from '../../schemas/event';
import type {
  EventSourceKind,
  EventSourceManifest,
  EventSourceSecrets,
  EventSourceStatus,
} from '../../schemas/eventSource';
import type { McpServerManifest } from '../../schemas/mcpServer';
import type { ModelProviderManifest } from '../../schemas/modelProvider';
import type { SandboxBuildMetadata, SandboxBuildStatus, SandboxProviderManifest } from '../../schemas/sandboxProvider';
import type { ScheduleManifest, ScheduleRunStatus, ScheduleStatus } from '../../schemas/schedule';
import type { SkillManifest } from '../../schemas/skill';
import type { OAuthClient, OAuthPendingAuthorizationData, OAuthServer, OAuthToken } from '../mcpServerStore';

/**
 * Trace-level state for one thread at one turn (`turn_thread.checkpoint`).
 * Total types: `completion` is explicitly null until set — no optional keys.
 */
export interface TurnThreadCheckpoint {
  parent: AgentParent | null;
  completion: SubAgentCompletionMarker | null;
}

/** Turn-level checkpoint — threads live in `turn_thread`; only owned top-level keys remain. */
export interface TurnCheckpoint {
  mcp_servers: Record<string, MCPServerInitInfo> | null;
  sandbox_info: SandboxInfo | null;
}

/** Insert via `jsonbBind()`; select via `jsonText()` (parsed at top-level only). */
type JsonbColumn<T extends object | null> = JSONColumnType<T, T | string, T | string>;

/**
 * PRIMARY KEY (session_id)
 * CREATE INDEX session_list_idx ON session (tenant_id, created_at, session_id)
 */
export interface SessionTable {
  tenant_id: string;
  session_id: string;
  /** Caller identity that created the session (immutable after create). */
  created_by_subject: JsonbColumn<CreatedBySubject>;
  /** Named registry binding; XOR with `agent_spec`. */
  agent_id: string | null;
  /**
   * Create-time snapshot of registry agent name for ref bindings.
   * Null for value sessions and orphan/legacy refs after a missed backfill.
   */
  agent_name: string | null;
  /** Inline spec binding; XOR with `agent_id`. */
  agent_spec: JsonbColumn<AgentSpec> | null;
  title: string | null;
  last_turn_id: string | null;
  /** Optional unique key within `tenant_id` when set. */
  external_id: string | null;
  custom: JsonbColumn<Record<string, unknown>> | null;
  metadata: JsonbColumn<SessionMetadata>;
  metrics: JsonbColumn<SessionMetrics>;
  created_at: string;
  updated_at: string;
  last_activity_timestamp_ms: number;
}

/**
 * PRIMARY KEY (session_id, turn_id)
 * CREATE INDEX turn_list_idx ON turn (session_id, created_at, turn_id)
 */
export interface TurnTable {
  session_id: string;
  turn_id: string;
  first_turn_id: string;
  previous_turn_id: string | null;
  /** JSONB array of turn ids — topology only; not a SQL join key. */
  ancestor_ids: JsonbColumn<string[]>;
  input: JsonbColumn<TurnInputItem[]>;
  state: JsonbColumn<TurnState>;
  checkpoint: JsonbColumn<TurnCheckpoint>;
  custom: JsonbColumn<Record<string, unknown>> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Complete state of one thread at one turn.
 * Context order lives in `turn_thread_context` (no context_ids column).
 * PRIMARY KEY (session_id, turn_id, thread_id)
 */
export interface TurnThreadTable {
  session_id: string;
  turn_id: string;
  thread_id: string;
  checkpoint: JsonbColumn<TurnThreadCheckpoint>;
  agent_info: JsonbColumn<AgentInfo> | null;
  current_context_usage: JsonbColumn<CurrentContextUsage>;
  updated_at: string;
}

/**
 * Ordered mapping from a turn_thread to append-only log rows.
 * PRIMARY KEY (session_id, turn_id, thread_id, pos)
 */
export interface TurnThreadContextTable {
  session_id: string;
  turn_id: string;
  thread_id: string;
  pos: number;
  append_id: number;
}

/**
 * Pure immutable client-facing event log.
 * PRIMARY KEY (session_id, turn_id, event_id)
 */
export interface SessionEventTable {
  session_id: string;
  turn_id: string;
  event_id: string;
  event: JsonbColumn<PersistedTurnEvent>;
  created_at: string;
}

/**
 * Pure immutable content; no state → no checkpoint field.
 * PRIMARY KEY (append_id) AUTOINCREMENT
 */
export interface ThreadContextLogTable {
  append_id: Generated<number>;
  session_id: string;
  thread_id: string;
  turn_id: string;
  body: JsonbColumn<ContextMessage>;
  created_at: string;
}

/**
 * Per-turn KV snapshot, latest-wins per (turn, thread, key).
 * PRIMARY KEY (session_id, turn_id, thread_id, key)
 */
export interface ThreadCapabilityStateTable {
  session_id: string;
  turn_id: string;
  thread_id: string;
  key: string;
  /** JSONB JsonValue, or SQL NULL if cleared. */
  state: ColumnType<JsonValue | null, JsonValue | null | string, JsonValue | null | string>;
  updated_at: string;
}

/**
 * Configured model providers — mirrors the Postgres `model_provider` table.
 * PRIMARY KEY (tenant_id, name)
 */
export interface ModelProviderTable {
  tenant_id: string;
  name: string;
  /** ModelProviderManifest document; replaced whole on every upsert */
  manifest: JsonbColumn<ModelProviderManifest>;
  created_at: string;
  updated_at: string;
}

/**
 * Configured skills — mirrors the Postgres `skill` table.
 * PRIMARY KEY (tenant_id, name)
 */
export interface SkillTable {
  tenant_id: string;
  /** key: natural key within tenant; also duplicated inside `manifest` */
  name: string;
  /** SkillManifest document; replaced whole on every upsert */
  manifest: JsonbColumn<SkillManifest>;
  created_at: string;
  updated_at: string;
}

/**
 * Configured sandbox provider — mirrors the Postgres `sandbox_provider` table.
 * PRIMARY KEY (tenant_id) — at most one row per tenant.
 */
export interface SandboxProviderTable {
  tenant_id: string;
  /** SandboxProviderManifest document; replaced whole on every upsert */
  manifest: JsonbColumn<SandboxProviderManifest>;
  /** Last persisted build status of the release sandbox image. */
  status: SandboxBuildStatus;
  /** Human-readable detail for `status`; null when ready. */
  status_reason: string | null;
  /** SandboxBuildMetadata document (opaque string map); null when the provider has none. */
  build_metadata: JsonbColumn<SandboxBuildMetadata> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Configured agents — mirrors the Postgres `agent` table.
 * PRIMARY KEY (id); UNIQUE (tenant_id, name).
 */
export interface AgentTable {
  /** application-generated (ulid); never re-derived from tenant_id/name */
  id: string;
  tenant_id: string;
  /** natural uniqueness target within a tenant */
  name: string;
  /** AgentSpec document; replaced whole on every upsert */
  manifest: JsonbColumn<AgentSpec>;
  external_id: string | null;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  created_at: string;
  updated_at: string;
}

/**
 * Configured schedules.
 * PRIMARY KEY (id).
 * FK (agent_id) → agent(id) ON DELETE CASCADE.
 */
export interface ScheduleTable {
  /** application-generated (ulid); FK target for schedule_run */
  id: string;
  tenant_id: string;
  /** FK → agent(id). Immutable. */
  agent_id: string;
  /** Create-time snapshot of registry agent name. */
  agent_name: string;
  /** Display label; not unique. */
  name: string;
  /** ScheduleManifest document ({ task, cron, timezone }); replaced whole on update */
  manifest: JsonbColumn<ScheduleManifest>;
  /** `paused` stops triggering and drops the pending run; in-flight runs continue */
  status: ScheduleStatus;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  created_at: string;
  updated_at: string;
}

/**
 * One row per schedule run, pending or historical — mirrors the Postgres `schedule_run`
 * PRIMARY KEY (id); UNIQUE (tenant_id, schedule_id, name).
 */
export interface ScheduleRunTable {
  /** application-generated (ulid) */
  id: string;
  tenant_id: string;
  /** FK -> schedule.id, ON DELETE CASCADE */
  schedule_id: string;
  /** the run name: `sched-<unixSeconds>` for cron, `manual-<token>` for run-now */
  name: string;
  scheduled_for: string;
  /** `scheduled` | `triggered` | `failed` | `missed` — length ≤ 16 */
  status: ScheduleRunStatus;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * PRIMARY KEY (id)
 * UNIQUE (tenant_id, name) — the natural lookup key;
 */
export interface McpServerTable {
  /** application-generated (ulid); FK target, never re-derived from tenant_id/name */
  id: string;
  tenant_id: string;
  /** the uniqueness target; also duplicated inside `manifest` */
  name: string;
  manifest: JsonbColumn<McpServerManifest>;
  /**
   * Both null until the first successful DCR registration, written together in that one call;
   * always null when `manifest.auth` is absent. Two columns rather than one blob: different
   * source HTTP response (metadata discovery vs. registration), and only `oauth_client` carries
   * a secret.
   */
  oauth_server: JsonbColumn<OAuthServer> | null;
  oauth_client: JsonbColumn<OAuthClient> | null;
  created_at: string;
  updated_at: string;
}

/**
 * PRIMARY KEY (oauth_server_id, user_id)
 * No `tenant_id` — already scoped to tenant via the FK. Tokens are per harness user
 * (`user_id` = `RequestContext.subject.id`); any tenant-scoped read resolves `oauth_server_id`
 * through mcp_server (by tenant_id + name) first.
 */
export interface OAuthTokenTable {
  /** FK -> mcp_server.id, ON DELETE CASCADE */
  oauth_server_id: string;
  user_id: string;
  token: JsonbColumn<OAuthToken>;
  updated_at: string;
}

/**
 * PRIMARY KEY (id) ( used for callback state.)
 */
export interface OAuthPendingAuthorizationTable {
  id: string;
  /** FK -> mcp_server.id, ON DELETE CASCADE */
  oauth_server_id: string;
  user_id: string;
  /** { mcp_server_url, code_verifier, return_to } — same writer/lifecycle, so merged into one column */
  auth_data: JsonbColumn<OAuthPendingAuthorizationData>;
  created_at: string;
}

/**
 * One connected provider (a GitHub App).
 * PRIMARY KEY (id); UNIQUE (tenant_id, name)
 */
export interface EventSourceTable {
  /** application-generated (ulid) */
  id: string;
  tenant_id: string;
  kind: EventSourceKind;
  name: string;
  /** `pending` | `active` | `error` — length ≤ 16 */
  status: EventSourceStatus;
  /** EventSourceManifest document; `app` is null while pending */
  manifest: JsonbColumn<EventSourceManifest>;
  /** Connector credentials; SQL NULL while pending. Never selected by listings. */
  secrets: JsonbColumn<EventSourceSecrets> | null;
  /** One-time GitHub manifest-flow nonce; unique while set */
  manifest_state: string | null;
  last_delivery_at: string | null;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  created_at: string;
  updated_at: string;
}

/**
 * One accepted webhook delivery.
 * PRIMARY KEY (id); UNIQUE (source_id, delivery_id); FK (source_id) → event_source(id) ON DELETE CASCADE
 */
export interface EventTable {
  /** application-generated (ulid) */
  id: string;
  tenant_id: string;
  source_id: string;
  /** connector event kind, e.g. `issues.labeled` */
  kind: string;
  subject_key: string;
  delivery_id: string;
  summary: JsonbColumn<EventSummary>;
  payload: JsonbColumn<JsonObject>;
  received_at: string;
  /** set once the coalesce loop has matched the event; NULL = unrouted */
  routed_at: string | null;
}

/**
 * One event-driven automation.
 * PRIMARY KEY (id); UNIQUE (tenant_id, name); FK (tenant_id, agent_name) → agent(tenant_id, name) ON DELETE CASCADE
 */
export interface AutomationTable {
  /** application-generated (ulid) */
  id: string;
  tenant_id: string;
  /** FK → agent(id). Immutable. */
  agent_id: string;
  /** Create-time snapshot of registry agent name. */
  agent_name: string;
  name: string;
  /** AutomationManifest document; replaced whole on update */
  manifest: JsonbColumn<AutomationManifest>;
  /** mirrors manifest.status; `paused` stops matching new events — length ≤ 16 */
  status: AutomationStatus;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  created_at: string;
  updated_at: string;
}

/**
 * One coalesce window, pending or historical.
 * PRIMARY KEY (id); UNIQUE (automation_id, subject_key) WHERE status = 'coalescing'
 */
export interface AutomationRunTable {
  /** application-generated (ulid) */
  id: string;
  tenant_id: string;
  /** FK → automation.id, ON DELETE CASCADE */
  automation_id: string;
  subject_key: string;
  lane_key: string | null;
  /** coalescing | triggered | waiting | completed | shadowed | failed — length ≤ 16 */
  status: AutomationRunStatus;
  mode: AutomationMode;
  /** ledger event ids, oldest first */
  event_ids: JsonbColumn<string[]>;
  session_id: string | null;
  scheduled_for: string;
  triggered_at: string | null;
  finished_at: string | null;
  outcome: JsonbColumn<JsonObject> | null;
  created_by_subject: JsonbColumn<CreatedBySubject>;
  created_at: string;
  updated_at: string;
}

export interface Database {
  session: SessionTable;
  turn: TurnTable;
  turn_thread: TurnThreadTable;
  turn_thread_context: TurnThreadContextTable;
  session_event: SessionEventTable;
  thread_context_log: ThreadContextLogTable;
  thread_capability_state: ThreadCapabilityStateTable;
  model_provider: ModelProviderTable;
  skill: SkillTable;
  sandbox_provider: SandboxProviderTable;
  agent: AgentTable;
  schedule: ScheduleTable;
  schedule_run: ScheduleRunTable;
  event_source: EventSourceTable;
  event: EventTable;
  automation: AutomationTable;
  automation_run: AutomationRunTable;
  mcp_server: McpServerTable;
  oauth_token: OAuthTokenTable;
  oauth_pending_authorization: OAuthPendingAuthorizationTable;
}
