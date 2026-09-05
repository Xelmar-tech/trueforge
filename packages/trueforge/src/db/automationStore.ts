/**
 * DB-backed automations and their runs: one `automation` row per event binding, plus an
 * `automation_run` row per coalesce window (pending or historical).
 *
 * The coalesce window is a constraint, not code: `automation_run_coalescing_uq` allows at
 * most one `coalescing` run per (automation, subject). A second event for the same subject
 * appends to that row and pushes `scheduled_for` out; it can never open a second window.
 *
 * Transactions are route-owned (see `WithTransaction`): a store method never opens one.
 *
 * Implementations: PostgresAutomationStore and SqliteAutomationStore.
 */
import type { CreatedBySubject, TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import type { JsonObject } from '../connectors/types';
import {
  AutomationManifestSchema,
  type AutomationManifest,
  type AutomationMode,
  type AutomationRunStatus,
  type AutomationStatus,
} from '../schemas/automation';

export interface AutomationRecord {
  id: string;
  tenant_id: string;
  /** Immutable FK to `agent.id`. */
  agent_id: string;
  /** Create-time snapshot of registry agent name. */
  agent_name: string;
  /** Slug-shaped label, unique per tenant (`automation_name_uq`). */
  name: string;
  manifest: AutomationManifest;
  /** Mirrors `manifest.status`; indexed for the coalesce loop. */
  status: AutomationStatus;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

export interface AutomationRunRecord {
  id: string;
  tenant_id: string;
  automation_id: string;
  subject_key: string;
  lane_key: string | null;
  status: AutomationRunStatus;
  mode: AutomationMode;
  /** Ledger event ids coalesced into this run, oldest first. */
  event_ids: string[];
  session_id: string | null;
  /** ISO-8601 UTC instant the coalesce window closes. */
  scheduled_for: string;
  triggered_at: string | null;
  finished_at: string | null;
  outcome: JsonObject | null;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

/** A due run plus the automation that owns it. */
export interface AutomationDispatchItem {
  run: AutomationRunRecord;
  automation: AutomationRecord;
}

/** Re-parse persisted manifest JSON so schema defaults materialize. */
export function parseStoredAutomationManifest(manifest: unknown): AutomationManifest {
  return AutomationManifestSchema.parse(manifest);
}

/** Automation name already taken for this tenant — violates `automation_name_uq`. */
export class AutomationNameConflictError extends Error {
  readonly tenant_id: string;
  readonly automation_name: string;

  constructor({ tenant_id, name }: { tenant_id: string; name: string }, options?: ErrorOptions) {
    super(`Automation name already exists: ${name}`, options);
    this.name = 'AutomationNameConflictError';
    this.tenant_id = tenant_id;
    this.automation_name = name;
  }
}

export interface ListAutomationsInput {
  tenant_id: string;
  limit: number;
  page_token: string | undefined;
  agent_names: readonly string[] | undefined;
  created_by_subject_id?: string | undefined;
}

export interface GetAutomationInput {
  tenant_id: string;
  id: string;
}

export interface CreateAutomationInput {
  tenant_id: string;
  agent_id: string;
  agent_name: string;
  name: string;
  manifest: AutomationManifest;
  created_by_subject: CreatedBySubject;
}

/** Replaces `name` + `manifest` for an existing automation keyed by immutable id. */
export interface UpdateAutomationInput {
  tenant_id: string;
  id: string;
  name: string;
  manifest: AutomationManifest;
}

export interface UpsertCoalescingRunInput {
  tenant_id: string;
  automation_id: string;
  subject_key: string;
  lane_key: string | null;
  mode: AutomationMode;
  event_id: string;
  /** New window close; on an existing window this replaces the old value (the window slides). */
  scheduled_for: Date;
  created_by_subject: CreatedBySubject;
}

/** A run created outside the ledger flow — replay — that is due immediately. */
export interface CreateImmediateRunInput {
  tenant_id: string;
  automation_id: string;
  subject_key: string;
  lane_key: string | null;
  mode: AutomationMode;
  event_ids: readonly string[];
  created_by_subject: CreatedBySubject;
  now: Date;
}

export interface ListDueRunsInput {
  until: Date;
  limit: number;
}

export interface MarkTriggeredInput {
  tenant_id: string;
  id: string;
  session_id: string;
  at: Date;
}

export interface FinishRunInput {
  tenant_id: string;
  id: string;
  status: Extract<AutomationRunStatus, 'waiting' | 'completed' | 'shadowed' | 'failed'>;
  outcome: JsonObject | null;
  at: Date;
}

export interface GetRunInput {
  tenant_id: string;
  id: string;
}

export interface IAutomationStore<TTransaction = never> {
  // --- automation ---
  getAutomation(input: GetAutomationInput, transaction?: TTransaction): Promise<AutomationRecord | undefined>;
  /** Throws {@link AutomationNameConflictError} on a duplicate name. */
  createAutomation(input: CreateAutomationInput, transaction?: TTransaction): Promise<AutomationRecord>;
  /** Returns undefined if the automation is gone. */
  updateAutomation(input: UpdateAutomationInput, transaction?: TTransaction): Promise<AutomationRecord | undefined>;
  /** Deletes by immutable id; runs cascade. Idempotent if already missing. */
  deleteAutomation(input: GetAutomationInput, transaction?: TTransaction): Promise<void>;
  listAutomations(
    input: ListAutomationsInput,
    transaction?: TTransaction,
  ): Promise<{ data: AutomationRecord[]; pagination: TokenPagination }>;
  /** Every `active` automation of one tenant — the coalesce loop's match candidates. */
  listActiveAutomations(input: { tenant_id: string }, transaction?: TTransaction): Promise<AutomationRecord[]>;

  // --- automation_run ---
  /**
   * Opens a coalesce window for (automation, subject) or, when one is already open,
   * appends `event_id` and slides `scheduled_for`. Never creates a second open window.
   */
  upsertCoalescingRun(input: UpsertCoalescingRunInput, transaction?: TTransaction): Promise<AutomationRunRecord>;
  /** Inserts a `coalescing` run that is already due. Used by replay. */
  createImmediateRun(input: CreateImmediateRunInput, transaction?: TTransaction): Promise<AutomationRunRecord>;
  /** `coalescing` runs whose window has closed (`scheduled_for <= until`), oldest first. */
  listDueRuns(input: ListDueRunsInput, transaction?: TTransaction): Promise<AutomationRunRecord[]>;
  /** True when another run holding this lane key is `triggered` or `waiting`. */
  isLaneBusy(input: { tenant_id: string; lane_key: string }, transaction?: TTransaction): Promise<boolean>;
  /** `coalescing` → `triggered`, stamping the session. Returns undefined when the row is gone. */
  markTriggered(input: MarkTriggeredInput, transaction?: TTransaction): Promise<AutomationRunRecord | undefined>;
  /** Runs the finalize loop must inspect: `triggered` and `waiting`, oldest first. */
  listOpenRuns(input: { limit: number }, transaction?: TTransaction): Promise<AutomationRunRecord[]>;
  /** Terminal (or `waiting`) transition with the recorded outcome. */
  finishRun(input: FinishRunInput, transaction?: TTransaction): Promise<AutomationRunRecord | undefined>;
  getRun(input: GetRunInput, transaction?: TTransaction): Promise<AutomationRunRecord | undefined>;
  /** Runs of one automation (any status), newest first. */
  listRuns(
    input: { tenant_id: string; automation_id: string },
    transaction?: TTransaction,
  ): Promise<AutomationRunRecord[]>;
}
