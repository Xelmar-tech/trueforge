'use client';

import type { AutomationMode, AutomationStatus } from '../../server/types.js';
import { cn } from '../lib/cn.js';

/** Paused wins over mode: a paused automation matches nothing whatever its mode. */
export function AutomationModeBadge({ mode, status }: { mode: AutomationMode; status: AutomationStatus }) {
  const paused = status === 'paused';
  const armed = mode === 'armed';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        paused
          ? 'border-border bg-secondary-bg text-text-secondary'
          : armed
            ? 'border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-300'
            : 'border-indigo-600/30 bg-indigo-500/10 text-indigo-700 dark:border-indigo-400/35 dark:bg-indigo-500/15 dark:text-indigo-300',
      )}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          paused
            ? 'bg-text-secondary'
            : armed
              ? 'bg-emerald-600 dark:bg-emerald-400'
              : 'bg-indigo-600 dark:bg-indigo-400',
        )}
        aria-hidden
      />
      {paused ? 'Paused' : armed ? 'Armed' : 'Shadow'}
    </span>
  );
}
