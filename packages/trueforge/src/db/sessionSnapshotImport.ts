/**
 * Ops-only session snapshot import. Postgres historical backfill — not ISessionStore.
 */
export interface ImportSessionTurnThread {
  thread_id: string;
  context: unknown[];
  current_context_usage: unknown;
  parent: unknown | null;
  completion: unknown | null;
  agent_info: unknown | null;
  capability_state: Record<string, unknown> | null;
}

export interface ImportSessionTurnEvent {
  id: string;
  created_at: string;
  [key: string]: unknown;
}

export interface ImportSessionTurn {
  turn_id: string;
  first_turn_id: string;
  previous_turn_id: string | null;
  ancestor_ids: string[];
  input: unknown[];
  state: unknown;
  checkpoint: { mcp_servers: unknown | null; sandbox_info: unknown | null };
  custom: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  threads: ImportSessionTurnThread[];
  events: ImportSessionTurnEvent[];
}

export interface ImportSessionSnapshotSession {
  session_id: string;
  tenant_id: string;
  created_by: string;
  agent_spec: Record<string, unknown>;
  title: string | null;
  last_turn_id: string | null;
  custom: Record<string, unknown> | null;
  last_activity_timestamp_ms: number;
  created_at: string;
  updated_at: string;
}

export interface ImportSessionSnapshotInput {
  session: ImportSessionSnapshotSession;
  turns: ImportSessionTurn[];
}

export interface ImportSessionSnapshotResult {
  imported: boolean;
  session_id: string;
}

export interface ISessionSnapshotImporter {
  importSessionSnapshot(input: ImportSessionSnapshotInput): Promise<ImportSessionSnapshotResult>;
}

export function isContextPrefix(prefix: unknown[], full: unknown[]): boolean {
  if (prefix.length > full.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (JSON.stringify(prefix[i]) !== JSON.stringify(full[i])) {
      return false;
    }
  }
  return true;
}
