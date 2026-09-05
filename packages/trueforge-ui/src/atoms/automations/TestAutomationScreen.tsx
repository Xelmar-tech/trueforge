'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useToasterOptional } from '../../containers/ToasterContainer.js';
import { Icon } from '../../icons/Icon.js';
import { useAutomationServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import type { Automation, AutomationRun, LedgerEvent } from '../../server/types.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { PopoverSelect } from '../primitives/PopoverSelect.js';
import { AutomationModeBadge } from './AutomationModeBadge.js';
import { AutomationRunChip } from './AutomationRunChip.js';
import {
  describeOutcome,
  formatRunDuration,
  formatRunInstant,
  isTerminalRun,
  runStatusLabel,
} from './automationRuns.js';
import { formatCondition, formatLane } from './triggerLabels.js';

export type TestAutomationScreenProps = {
  automation: Automation;
  agentName: string;
  onEditConfiguration: () => void;
};

/** How often the replay run is re-read while it is still open. */
const RUN_POLL_INTERVAL_MS = 3000;
/** Give up polling after this long; the run stays visible in the runs list. */
const RUN_POLL_MAX_MS = 5 * 60 * 1000;

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
      <span className="text-text-secondary shrink-0 text-[10px] font-semibold tracking-wide uppercase">{label}</span>
      <div className="min-w-0 text-right text-sm text-text-primary">{children}</div>
    </div>
  );
}

function eventLabel(event: LedgerEvent): string {
  const when = formatRunInstant(event.receivedAt);
  const subject = event.summary.number != null ? `#${String(event.summary.number)}` : event.subjectKey;
  const title = event.summary.title ?? event.summary.label ?? event.kind;
  return `${when} · ${subject} · ${title}`;
}

export function TestAutomationScreen({ automation, agentName, onEditConfiguration }: TestAutomationScreenProps) {
  const automationServer = useAutomationServer();
  const shell = useOptionalShellMode();
  const toaster = useToasterOptional();
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventId, setEventId] = useState('');
  const [replaying, setReplaying] = useState(false);
  const [run, setRun] = useState<AutomationRun | null>(null);
  const pollRef = useRef<{ timer: number | undefined; startedAt: number }>({ timer: undefined, startedAt: 0 });

  useEffect(() => {
    let cancelled = false;
    setEventsLoading(true);
    void automationServer
      .listEvents({ sourceId: automation.trigger.sourceId, kind: automation.trigger.kind, limit: 25 })
      .then(page => {
        if (cancelled) return;
        setEvents(page.data);
        setEventId(current => (current === '' ? (page.data[0]?.id ?? '') : current));
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [automationServer, automation.trigger.sourceId, automation.trigger.kind]);

  const stopPolling = useCallback(() => {
    if (pollRef.current.timer !== undefined) {
      window.clearTimeout(pollRef.current.timer);
      pollRef.current.timer = undefined;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollRun = useCallback(
    (runId: string) => {
      const tick = async () => {
        try {
          const runs = await automationServer.listAutomationRuns({ automationId: automation.id });
          const latest = runs.find(candidate => candidate.id === runId);
          if (latest !== undefined) {
            setRun(latest);
            if (isTerminalRun(latest.status)) {
              stopPolling();
              return;
            }
          }
        } catch {
          // Keep polling; a transient error should not end the test view.
        }
        if (Date.now() - pollRef.current.startedAt > RUN_POLL_MAX_MS) {
          stopPolling();
          return;
        }
        pollRef.current.timer = window.setTimeout(() => void tick(), RUN_POLL_INTERVAL_MS);
      };
      stopPolling();
      pollRef.current.startedAt = Date.now();
      pollRef.current.timer = window.setTimeout(() => void tick(), RUN_POLL_INTERVAL_MS);
    },
    [automationServer, automation.id, stopPolling],
  );

  const handleReplay = async () => {
    if (eventId === '') return;
    setReplaying(true);
    try {
      const created = await automationServer.replayAutomation({ automationId: automation.id, eventId });
      setRun(created);
      pollRun(created.id);
      toaster?.showSuccess({ title: 'Replay started', description: 'Shadow mode: nothing is written.' });
    } catch (caught) {
      toaster?.showError(caught);
    } finally {
      setReplaying(false);
    }
  };

  const eventOptions = useMemo(() => events.map(event => ({ value: event.id, label: eventLabel(event) })), [events]);
  const outcome = run == null ? null : describeOutcome(run);
  const canOpenSession = run?.sessionId != null && shell != null;

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="rounded-lg border border-border">
        <DetailRow label="Trigger">
          <span className="font-mono text-xs">{automation.trigger.kind}</span>
          {automation.trigger.conditions.map((condition, index) => (
            <div key={index} className="text-text-secondary text-xs">
              {formatCondition(condition)}
            </div>
          ))}
        </DetailRow>
        <DetailRow label="Agent">{agentName}</DetailRow>
        <DetailRow label="Coalesce">{String(automation.coalesceSeconds)}s</DetailRow>
        <DetailRow label="Lane">
          <span className="font-mono text-xs">{formatLane(automation.lane)}</span>
        </DetailRow>
        <DetailRow label="Mode">
          <AutomationModeBadge mode={automation.mode} status={automation.status} />
        </DetailRow>
      </div>

      <div className="block">
        <span className="mb-1.5 block text-sm font-medium">Replay against</span>
        <PopoverSelect
          aria-label="Event to replay"
          placeholder={
            eventsLoading
              ? 'Loading events…'
              : events.length === 0
                ? 'No recorded events of this kind yet'
                : 'Pick an event'
          }
          value={eventId}
          options={eventOptions}
          onValueChange={setEventId}
          disabled={eventsLoading || events.length === 0}
        />
        <span className="text-text-secondary mt-1 block text-xs">
          The latest {String(events.length)} recorded {automation.trigger.kind} events from this source. Conditions are
          applied when the run starts.
        </span>
      </div>

      <Button
        type="button"
        className="w-full"
        disabled={eventId === '' || replaying}
        onClick={() => void handleReplay()}
      >
        <Icon name={replaying ? 'loader' : 'play'} className={cn('size-3.5', replaying && 'animate-spin')} />
        Replay in shadow
      </Button>

      {run != null ? (
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-text-secondary text-[10px] font-semibold tracking-wide uppercase">Replay run</span>
            <span className="flex items-center gap-2 text-xs text-text-secondary">
              <AutomationRunChip run={run} />
              {runStatusLabel(run.status)}
              {run.finishedAt != null ? ` · ${formatRunDuration(run)}` : null}
            </span>
          </div>
          <DetailRow label="Subject">
            <span className="font-mono text-xs">{run.subjectKey}</span>
          </DetailRow>
          <DetailRow label="Lane">
            <span className="font-mono text-xs">{run.laneKey ?? 'none'}</span>
          </DetailRow>
          <DetailRow label="Session">
            {run.sessionId == null ? (
              <span className="text-text-secondary">not started yet</span>
            ) : (
              <span className="font-mono text-xs">{run.sessionId}</span>
            )}
          </DetailRow>
          {outcome != null ? <DetailRow label="Outcome">{outcome}</DetailRow> : null}
          {canOpenSession && run.sessionId != null ? (
            <div className="flex justify-end px-3 py-2">
              <button
                type="button"
                className={auiButtonClass({ variant: 'outline', size: 'sm' })}
                onClick={() => shell.openHistorySession({ sessionId: run.sessionId ?? '', isMutable: false })}
              >
                Open session
                <Icon name="square-arrow-out-up-right" className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="text-text-secondary text-xs">
        Leave the automation in shadow and it keeps running on live events, pausing before every tool call. Arm it when
        the outcomes look right.
      </p>

      <button
        type="button"
        className={auiButtonClass({ variant: 'outline', size: 'sm' })}
        onClick={onEditConfiguration}
      >
        <Icon name="pencil" className="size-3.5" />
        Edit configuration
      </button>
    </div>
  );
}
