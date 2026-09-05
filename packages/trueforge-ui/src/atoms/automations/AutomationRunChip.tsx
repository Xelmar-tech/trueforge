'use client';

import { Icon } from '../../icons/Icon.js';
import type { AutomationRun } from '../../server/types.js';
import { cn } from '../lib/cn.js';
import { Tooltip } from '../primitives/Tooltip.js';
import {
  describeOutcome,
  formatRunDuration,
  formatRunInstant,
  runChipKind,
  runStatusLabel,
  type RunChipKind,
} from './automationRuns.js';

const CHIP_STYLES: Record<RunChipKind, string> = {
  success:
    'border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-300',
  failed: 'border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-400/35 dark:bg-red-500/15 dark:text-red-300',
  shadowed:
    'border-indigo-600/30 bg-indigo-500/10 text-indigo-700 dark:border-indigo-400/35 dark:bg-indigo-500/15 dark:text-indigo-300',
  waiting:
    'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-300',
  running: 'border-sky-600/30 bg-sky-500/10 text-sky-700 dark:border-sky-400/35 dark:bg-sky-500/15 dark:text-sky-300',
  pending: 'border-border bg-secondary-bg text-text-secondary',
};

const CHIP_ICONS: Record<RunChipKind, string> = {
  success: 'check',
  failed: 'triangle-exclamation',
  shadowed: 'circle-check',
  waiting: 'circle-exclamation',
  running: 'play',
  pending: 'clock-rotate-left',
};

function RunTooltip({ run }: { run: AutomationRun }) {
  const outcome = describeOutcome(run);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium">
        {runStatusLabel(run.status)} · {run.mode}
      </span>
      <span className="text-text-secondary">{run.subjectKey}</span>
      <span className="text-text-secondary">
        {formatRunInstant(run.triggeredAt ?? run.scheduledFor)} · {formatRunDuration(run)} ·{' '}
        {String(run.eventIds.length)} event(s)
      </span>
      {outcome != null ? <span>{outcome}</span> : null}
    </div>
  );
}

export function AutomationRunChip({ run }: { run: AutomationRun }) {
  const kind = runChipKind(run.status);
  const when = formatRunInstant(run.triggeredAt ?? run.scheduledFor);
  return (
    <Tooltip content={<RunTooltip run={run} />} side="top">
      <span
        className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-md border', CHIP_STYLES[kind])}
        aria-label={`${runStatusLabel(run.status)} run at ${when}`}
      >
        <Icon name={CHIP_ICONS[kind]} className="size-3.5" />
      </span>
    </Tooltip>
  );
}
