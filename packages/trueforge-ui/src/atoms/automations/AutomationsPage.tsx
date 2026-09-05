'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToasterOptional } from '../../containers/ToasterContainer.js';
import { Icon } from '../../icons/Icon.js';
import { useAutomationServer, useServer } from '../../server/ServerContext.js';
import { libraryAgentId } from '../../server/ShellModeContext.js';
import type { Automation, AutomationRun } from '../../server/types.js';
import { EmptyScreen } from '../EmptyScreen.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { searchAllAgents } from '../lib/useSearchAgentsList.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';
import { DropdownMenu, DropdownMenuItem } from '../primitives/DropdownMenu.js';
import { PopoverSelect } from '../primitives/PopoverSelect.js';
import SearchInput from '../primitives/SearchInput.js';
import { Skeleton } from '../primitives/Skeleton.js';
import {
  DEFAULT_TABLE_PAGE_SIZE,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableTokenPagination,
} from '../primitives/Table.js';
import { AutomationFormDrawer } from './AutomationFormDrawer.js';
import { AutomationLastRunsCell } from './AutomationLastRunsCell.js';
import { AutomationModeBadge } from './AutomationModeBadge.js';
import { formatTriggerSummary } from './triggerLabels.js';

type AgentOption = { agentId: string; name: string };

type DrawerState = { kind: 'closed' } | { kind: 'create'; agentId?: string } | { kind: 'edit'; automation: Automation };

type ModeFilter = 'all' | 'shadow' | 'armed' | 'paused';

const MODE_FILTER_OPTIONS: Array<{ value: ModeFilter; label: string }> = [
  { value: 'all', label: 'All modes' },
  { value: 'armed', label: 'Armed' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'paused', label: 'Paused' },
];

const PAGE_SIZE_OPTIONS = [10, 25] as const;

function clampPageSize(size: number): number {
  return Math.min(Math.max(size, 1), 25);
}

function AutomationRowActions({
  automation,
  onTest,
  onEdit,
  onTogglePause,
  onDelete,
}: {
  automation: Automation;
  onTest: () => void;
  onEdit: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="inline-flex items-center justify-end gap-1.5">
      <button
        type="button"
        aria-label={`Test ${automation.name}`}
        className={auiButtonClass({ variant: 'outline', size: 'sm' })}
        onClick={onTest}
      >
        <Icon name="play" className="size-3.5" />
        Test
      </button>
      <DropdownMenu
        align="end"
        trigger={
          <button
            type="button"
            className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
            aria-label={`Actions for ${automation.name}`}
          >
            <Icon name="ellipsis" className="size-4" />
          </button>
        }
      >
        <DropdownMenuItem onClick={onEdit}>
          <Icon name="pencil" className="size-3.5" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onTogglePause}>
          <Icon name={automation.status === 'active' ? 'pause' : 'play'} className="size-3.5" />
          {automation.status === 'active' ? 'Pause' : 'Resume'}
        </DropdownMenuItem>
        <DropdownMenuItem className="text-failure-bg focus:text-failure-bg" onClick={onDelete}>
          <Icon name="trash" className="size-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenu>
    </div>
  );
}

export function AutomationsPage() {
  const automationServer = useAutomationServer();
  const server = useServer();
  const toaster = useToasterOptional();

  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runsById, setRunsById] = useState<Record<string, AutomationRun[]>>({});
  const [runsLoading, setRunsLoading] = useState(false);
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nameQuery, setNameQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [drawer, setDrawer] = useState<DrawerState>({ kind: 'closed' });
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);
  const [pageSize, setPageSize] = useState(() => clampPageSize(DEFAULT_TABLE_PAGE_SIZE));
  const [pageToken, setPageToken] = useState<string | undefined>(undefined);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [prevTokenStack, setPrevTokenStack] = useState<string[]>([]);
  const loadGenRef = useRef(0);

  const loadRuns = useCallback(
    async ({ rows, gen }: { rows: Automation[]; gen: number }) => {
      if (rows.length === 0) {
        if (gen === loadGenRef.current) setRunsById({});
        return;
      }
      setRunsLoading(true);
      try {
        const results = await Promise.allSettled(
          rows.map(automation => automationServer.listAutomationRuns({ automationId: automation.id })),
        );
        if (gen !== loadGenRef.current) return;
        setRunsById(
          Object.fromEntries(
            rows.map((automation, index) => {
              const result = results[index];
              return [automation.id, result?.status === 'fulfilled' ? result.value : []] as const;
            }),
          ),
        );
      } finally {
        if (gen === loadGenRef.current) setRunsLoading(false);
      }
    },
    [automationServer],
  );

  const loadAutomations = useCallback(
    async ({ token, size, agentId }: { token: string | undefined; size: number; agentId: string }) => {
      const gen = ++loadGenRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await automationServer.listAutomations({
          limit: clampPageSize(size),
          ...(token === undefined || token === '' ? {} : { pageToken: token }),
          ...(agentId === 'all' ? {} : { agentId }),
        });
        if (gen !== loadGenRef.current) return;
        setAutomations(page.data);
        setNextPageToken(page.nextPageToken);
        void loadRuns({ rows: page.data, gen });
      } catch (caught) {
        if (gen !== loadGenRef.current) return;
        setError(caught instanceof Error ? caught.message : 'Failed to load automations');
        setAutomations([]);
        setRunsById({});
        setNextPageToken(undefined);
      } finally {
        if (gen === loadGenRef.current) setLoading(false);
      }
    },
    [automationServer, loadRuns],
  );

  const reload = useCallback(() => {
    void loadAutomations({ token: pageToken, size: pageSize, agentId: agentFilter });
  }, [loadAutomations, pageToken, pageSize, agentFilter]);

  const resetToFirstPage = useCallback(() => {
    setPageToken(undefined);
    setPrevTokenStack([]);
    void loadAutomations({ token: undefined, size: pageSize, agentId: agentFilter });
  }, [loadAutomations, pageSize, agentFilter]);

  useEffect(() => {
    void loadAutomations({ token: pageToken, size: pageSize, agentId: agentFilter });
  }, [agentFilter, pageSize, pageToken, loadAutomations]);

  useEffect(() => {
    let cancelled = false;
    void searchAllAgents(server)
      .then(rows => {
        if (cancelled) return;
        setAgentOptions(rows.map(agent => ({ agentId: libraryAgentId(agent), name: agent.name })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [server]);

  // Name + mode filters are client-side on the current server page only.
  const filtered = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    return automations.filter(automation => {
      if (modeFilter === 'paused' && automation.status !== 'paused') return false;
      if (
        (modeFilter === 'armed' || modeFilter === 'shadow') &&
        (automation.status === 'paused' || automation.mode !== modeFilter)
      ) {
        return false;
      }
      if (q.length > 0 && !automation.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [automations, nameQuery, modeFilter]);

  const hasPageNav = prevTokenStack.length > 0 || nextPageToken != null;

  const handleTogglePause = async (automation: Automation) => {
    try {
      await automationServer.updateAutomation({
        id: automation.id,
        name: automation.name,
        task: automation.task,
        trigger: automation.trigger,
        coalesceSeconds: automation.coalesceSeconds,
        lane: automation.lane,
        emit: automation.emit,
        mode: automation.mode,
        status: automation.status === 'active' ? 'paused' : 'active',
      });
      reload();
    } catch (caught) {
      toaster?.showError(caught);
    }
  };

  const handleDelete = async (automation: Automation) => {
    setPendingDelete(null);
    try {
      await automationServer.deleteAutomation({ id: automation.id });
      resetToFirstPage();
    } catch (caught) {
      toaster?.showError(caught);
    }
  };

  const goNext = () => {
    if (nextPageToken == null) return;
    setPrevTokenStack(stack => [...stack, pageToken ?? '']);
    setPageToken(nextPageToken);
  };

  const goPrev = () => {
    if (prevTokenStack.length === 0) return;
    const stack = [...prevTokenStack];
    const prev = stack.pop();
    setPrevTokenStack(stack);
    setPageToken(prev === '' ? undefined : prev);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-primary-bg">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="zap" className="text-text-primary size-4" />
          <h1 className="text-text-primary truncate text-md font-semibold">Automations</h1>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-56">
            <SearchInput query={nameQuery} setQuery={setNameQuery} placeholder="Search automations by name" />
          </div>
          <PopoverSelect
            value={modeFilter}
            onValueChange={setModeFilter}
            options={MODE_FILTER_OPTIONS}
            className="sm:w-40"
            aria-label="Filter by mode"
          />
          <PopoverSelect
            value={agentFilter}
            onValueChange={value => {
              setAgentFilter(value);
              setPageToken(undefined);
              setPrevTokenStack([]);
            }}
            options={[
              { value: 'all', label: 'All agents' },
              ...agentOptions.map(agent => ({ value: agent.agentId, label: agent.name })),
            ]}
            className="sm:w-40"
            aria-label="Filter by agent"
          />
          <Button
            type="button"
            onClick={() => setDrawer({ kind: 'create', agentId: agentFilter !== 'all' ? agentFilter : undefined })}
          >
            <Icon name="plus" className="size-3.5" />
            New Automation
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 md:px-6">
        {loading ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading automations">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : error != null ? (
          <p className="text-failure-bg px-3 py-8 text-center text-sm">{error}</p>
        ) : automations.length === 0 ? (
          <EmptyScreen
            title="No Automations Yet"
            description="Connect an event source in Settings, then create one to wake an agent when something happens."
            className="min-h-full"
          />
        ) : filtered.length === 0 ? (
          <EmptyScreen
            title="No Automations Found"
            description="No automations match your filters."
            className="min-h-full"
          />
        ) : (
          <div className="rounded-lg border border-border">
            <Table className="min-w-[52rem]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Last 5 runs</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(automation => (
                  <TableRow key={automation.id}>
                    <TableCell className="text-text-primary font-medium">
                      <button
                        type="button"
                        className="text-primary-button-bg text-left hover:underline"
                        onClick={() => setDrawer({ kind: 'edit', automation })}
                      >
                        {automation.name}
                      </button>
                      <div className="text-text-secondary text-xs">
                        coalesce {String(automation.coalesceSeconds)}s{automation.lane.length > 0 ? ' · lane' : ''}
                        {automation.emit.length > 0 ? ` · emits ${automation.emit.join(', ')}` : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={cn('font-mono text-xs', 'text-text-primary')}>
                        {formatTriggerSummary(automation.trigger)}
                      </span>
                    </TableCell>
                    <TableCell>{automation.agentName}</TableCell>
                    <TableCell>
                      <AutomationModeBadge mode={automation.mode} status={automation.status} />
                    </TableCell>
                    <TableCell>
                      {runsLoading ? (
                        <span className="text-text-secondary text-sm">…</span>
                      ) : (
                        <AutomationLastRunsCell runs={runsById[automation.id] ?? []} />
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <AutomationRowActions
                        automation={automation}
                        onTest={() => setDrawer({ kind: 'edit', automation })}
                        onEdit={() => setDrawer({ kind: 'edit', automation })}
                        onTogglePause={() => void handleTogglePause(automation)}
                        onDelete={() => setPendingDelete(automation)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasPageNav ? (
              <TableTokenPagination
                pageSize={pageSize}
                rowCount={filtered.length}
                canPrev={prevTokenStack.length > 0}
                canNext={nextPageToken != null}
                onPrev={goPrev}
                onNext={goNext}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={size => {
                  setPageSize(clampPageSize(size));
                  setPageToken(undefined);
                  setPrevTokenStack([]);
                }}
              />
            ) : null}
          </div>
        )}
      </div>

      <AutomationFormDrawer
        open={drawer.kind !== 'closed'}
        onOpenChange={open => {
          if (!open) setDrawer({ kind: 'closed' });
        }}
        mode={drawer.kind === 'edit' ? 'edit' : 'create'}
        {...(drawer.kind === 'edit' ? { automation: drawer.automation } : {})}
        {...(drawer.kind === 'create' && drawer.agentId != null ? { initialAgentId: drawer.agentId } : {})}
        onSaved={reload}
      />

      <Dialog open={pendingDelete != null} onOpenChange={open => (open ? undefined : setPendingDelete(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete automation?</DialogTitle>
          </DialogHeader>
          <p className="text-text-secondary text-sm">
            {pendingDelete?.name} and its run history will be removed. Sessions already started keep running.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (pendingDelete != null) void handleDelete(pendingDelete);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
