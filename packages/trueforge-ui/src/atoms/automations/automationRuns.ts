import type { AutomationRun, AutomationRunStatus } from '../../server/types.js';

export type RunChipKind = 'success' | 'failed' | 'shadowed' | 'waiting' | 'running' | 'pending';

export function runChipKind(status: AutomationRunStatus): RunChipKind {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'shadowed':
      return 'shadowed';
    case 'waiting':
      return 'waiting';
    case 'triggered':
      return 'running';
    case 'coalescing':
      return 'pending';
  }
}

export function runStatusLabel(status: AutomationRunStatus): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'shadowed':
      return 'Shadowed';
    case 'waiting':
      return 'Waiting for approval';
    case 'triggered':
      return 'Running';
    case 'coalescing':
      return 'Collecting events';
  }
}

export function isTerminalRun(status: AutomationRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'shadowed';
}

/** Newest-first API rows → up to `limit` runs that have started, oldest on the left. */
export function lastStartedRuns(runs: readonly AutomationRun[], limit = 5): AutomationRun[] {
  return runs
    .filter(run => run.status !== 'coalescing')
    .slice(0, limit)
    .reverse();
}

export function formatRunInstant(iso: string | null): string {
  if (iso == null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** `5m 47s` between two instants; `—` when either is missing. */
export function formatRunDuration(run: AutomationRun): string {
  if (run.triggeredAt == null || run.finishedAt == null) return '—';
  const ms = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.triggeredAt));
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes > 0 ? `${String(minutes)}m ${String(seconds).padStart(2, '0')}s` : `${String(seconds)}s`;
}

/** Human summary of a terminal outcome: emitted events, pending actions, or the error. */
export function describeOutcome(run: AutomationRun): string | null {
  const outcome = run.outcome;
  if (outcome == null) return null;
  const emitted = outcome['emitted_event_ids'];
  if (Array.isArray(emitted)) {
    return emitted.length === 0 ? 'Finished; nothing emitted' : `Emitted ${String(emitted.length)} event(s)`;
  }
  const required = outcome['required_actions'];
  if (Array.isArray(required)) {
    const names = required
      .map(action => (typeof action === 'object' && action !== null ? action : {}))
      .map(action => {
        const record: Record<string, unknown> = action;
        const name = record['toolName'] ?? record['tool_name'] ?? record['type'];
        return typeof name === 'string' ? name : null;
      })
      .filter((name): name is string => name != null);
    return names.length === 0 ? `Paused on ${String(required.length)} action(s)` : `Paused before ${names.join(', ')}`;
  }
  const error = outcome['error'];
  if (typeof error === 'string') return error;
  return null;
}
