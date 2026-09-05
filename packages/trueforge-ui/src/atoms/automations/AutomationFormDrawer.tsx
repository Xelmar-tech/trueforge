'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { useToasterOptional } from '../../containers/ToasterContainer.js';
import { Icon } from '../../icons/Icon.js';
import { useAutomationServer, useServer } from '../../server/ServerContext.js';
import { libraryAgentId } from '../../server/ShellModeContext.js';
import type { AgentLibraryEntry, Automation, EventSource, SaveAutomationRequest } from '../../server/types.js';
import { searchAllAgents } from '../lib/useSearchAgentsList.js';
import { Button } from '../primitives/Button.js';
import { SideDrawer } from '../primitives/SideDrawer.js';
import {
  AutomationFormFields,
  conditionsFromForm,
  conditionsToForm,
  defaultAutomationFormValues,
  emitFromForm,
  type AutomationFormValues,
} from './AutomationFormFields.js';
import { TestAutomationScreen } from './TestAutomationScreen.js';

export type AutomationFormDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  automation?: Automation;
  initialAgentId?: string;
  /** Open straight on the Test screen (edit mode only). */
  initialView?: 'form' | 'test';
  onSaved?: () => void;
};

type DrawerView = { kind: 'form'; saved?: Automation } | { kind: 'test'; automation: Automation };

function formFromAutomation(automation: Automation): AutomationFormValues {
  return {
    name: automation.name,
    task: automation.task,
    sourceId: automation.trigger.sourceId,
    kind: automation.trigger.kind,
    conditions: conditionsToForm(automation.trigger.conditions),
    coalesceSeconds: String(automation.coalesceSeconds),
    lane: automation.lane,
    emit: automation.emit.join(', '),
    mode: automation.mode,
  };
}

function requestFromForm(
  form: AutomationFormValues,
  agentId: string,
  status: Automation['status'],
): SaveAutomationRequest {
  const coalesce = Number(form.coalesceSeconds);
  return {
    agentId,
    name: form.name.trim(),
    task: form.task.trim(),
    trigger: {
      sourceId: form.sourceId,
      kind: form.kind.trim(),
      conditions: conditionsFromForm(form.conditions),
    },
    coalesceSeconds: Number.isFinite(coalesce) && coalesce >= 0 ? Math.floor(coalesce) : 30,
    lane: form.lane.filter(part =>
      part.type === 'field' ? part.path.trim().length > 0 : part.value.trim().length > 0,
    ),
    emit: emitFromForm(form.emit),
    mode: form.mode,
    status,
  };
}

export function AutomationFormDrawer({
  open,
  onOpenChange,
  mode,
  automation,
  initialAgentId = '',
  initialView = 'form',
  onSaved,
}: AutomationFormDrawerProps) {
  const automationServer = useAutomationServer();
  const server = useServer();
  const toaster = useToasterOptional();
  const [form, setForm] = useState<AutomationFormValues>(defaultAutomationFormValues);
  const [agentId, setAgentId] = useState(initialAgentId);
  const [agents, setAgents] = useState<AgentLibraryEntry[]>([]);
  const [sources, setSources] = useState<EventSource[]>([]);
  const [observedKinds, setObservedKinds] = useState<string[]>([]);
  const [view, setView] = useState<DrawerView>({ kind: 'form' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = mode === 'edit' && automation != null;
  const savedAutomation = view.kind === 'form' ? view.saved : view.automation;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void searchAllAgents(server)
      .then(rows => {
        if (!cancelled) setAgents(rows);
      })
      .catch(() => undefined);
    void automationServer
      .listEventSources()
      .then(rows => {
        if (cancelled) return;
        setSources(rows);
        // Default to the only real source so a first automation needs one click less.
        const external = rows.filter(source => source.kind !== 'trueforge');
        if (external.length === 1 && external[0] !== undefined) {
          const only = external[0];
          setForm(current => (current.sourceId === '' ? { ...current, sourceId: only.id } : current));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, server, automationServer]);

  // Kinds the ledger has already seen for the chosen source feed the event picker.
  useEffect(() => {
    if (!open || form.sourceId === '') {
      setObservedKinds([]);
      return;
    }
    let cancelled = false;
    void automationServer
      .listEvents({ sourceId: form.sourceId, limit: 25 })
      .then(page => {
        if (cancelled) return;
        setObservedKinds(Array.from(new Set(page.data.map(event => event.kind))));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, form.sourceId, automationServer]);

  useEffect(() => {
    if (!open) {
      setForm(defaultAutomationFormValues());
      setAgentId(initialAgentId);
      setError(null);
      setView({ kind: 'form' });
      return;
    }
    if (isEdit && automation != null) {
      setForm(formFromAutomation(automation));
      setAgentId(automation.agentId);
      setView(initialView === 'test' ? { kind: 'test', automation } : { kind: 'form' });
      return;
    }
    setForm(defaultAutomationFormValues());
    setAgentId(initialAgentId);
    setView({ kind: 'form' });
  }, [open, isEdit, automation, initialAgentId, initialView]);

  const agentOptions = useMemo(
    () => agents.map(agent => ({ agentId: libraryAgentId(agent), name: agent.name })),
    [agents],
  );
  const agentLabel =
    agents.find(agent => libraryAgentId(agent) === agentId)?.name ??
    savedAutomation?.agentName ??
    automation?.agentName ??
    agentId;

  const canSubmit =
    form.name.trim().length > 0 &&
    form.task.trim().length > 0 &&
    form.sourceId.length > 0 &&
    form.kind.trim().length > 0 &&
    agentId.length > 0;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const existing = savedAutomation ?? (isEdit ? automation : undefined);
      const status = existing?.status ?? 'active';
      const request = requestFromForm(form, agentId, status);
      const saved =
        existing !== undefined
          ? await automationServer.updateAutomation({ id: existing.id, ...request })
          : await automationServer.createAutomation(request);
      onSaved?.();
      if (isEdit && savedAutomation === undefined) {
        onOpenChange(false);
        return;
      }
      setView({ kind: 'test', automation: saved });
      toaster?.showSuccess({
        title: saved.mode === 'shadow' ? 'Saved in shadow mode' : 'Saved',
        description: `${saved.trigger.kind} → ${saved.agentName}`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save automation');
    } finally {
      setSaving(false);
    }
  };

  const handleArm = async () => {
    if (view.kind !== 'test') return;
    setSaving(true);
    setError(null);
    try {
      const current = view.automation;
      const armed = await automationServer.updateAutomation({
        id: current.id,
        name: current.name,
        task: current.task,
        trigger: current.trigger,
        coalesceSeconds: current.coalesceSeconds,
        lane: current.lane,
        emit: current.emit,
        mode: 'armed',
        status: 'active',
      });
      onSaved?.();
      toaster?.showSuccess({ title: 'Automation armed', description: `${armed.name} now acts on live events.` });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to arm automation');
    } finally {
      setSaving(false);
    }
  };

  const title =
    view.kind === 'test' ? 'Test Automation' : isEdit || savedAutomation ? 'Edit Automation' : 'New Automation';
  const description =
    view.kind === 'test'
      ? `Replay a recorded event through ${agentLabel} before you arm it.`
      : isEdit || savedAutomation
        ? 'Update the trigger, task and mode.'
        : 'Wake an agent when something happens.';

  let footer: ReactNode;
  if (view.kind === 'test') {
    footer = (
      <div className="flex flex-col gap-2">
        {error != null ? <p className="text-failure-bg text-sm">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Stay in shadow
          </Button>
          <Button type="button" disabled={saving || view.automation.mode === 'armed'} onClick={() => void handleArm()}>
            <Icon name="zap" className="size-3.5" />
            Arm automation
          </Button>
        </div>
      </div>
    );
  } else {
    footer = (
      <div className="flex flex-col gap-2">
        {error != null ? <p className="text-failure-bg text-sm">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="automation-form" disabled={!canSubmit || saving}>
            {isEdit && savedAutomation === undefined ? 'Save' : 'Save and test'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SideDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      anchor="right"
      size="lg"
      headerIcon={
        <span className="text-primary-button-bg inline-flex size-8 items-center justify-center">
          <Icon name="zap" className="size-5" />
        </span>
      }
      footer={footer}
    >
      {view.kind === 'test' ? (
        <TestAutomationScreen
          automation={view.automation}
          agentName={agentLabel}
          onEditConfiguration={() => {
            setError(null);
            setForm(formFromAutomation(view.automation));
            setView({ kind: 'form', saved: view.automation });
          }}
        />
      ) : (
        <form id="automation-form" onSubmit={event => void handleSave(event)}>
          <AutomationFormFields
            values={form}
            onChange={setForm}
            agentId={agentId}
            onAgentIdChange={isEdit || savedAutomation ? undefined : setAgentId}
            agentOptions={agentOptions}
            agentPickerDisabled={isEdit || savedAutomation !== undefined}
            sources={sources}
            observedKinds={observedKinds}
          />
        </form>
      )}
    </SideDrawer>
  );
}
