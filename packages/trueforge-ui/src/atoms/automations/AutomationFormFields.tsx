'use client';

import { Icon } from '../../icons/Icon.js';
import type {
  AutomationCondition,
  AutomationLanePart,
  AutomationMode,
  ConditionOperator,
  EventSource,
} from '../../server/types.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { PopoverSelect } from '../primitives/PopoverSelect.js';
import {
  CONDITION_OPERATOR_OPTIONS,
  formatConditionValue,
  GITHUB_CONDITION_FIELDS,
  GITHUB_EVENT_KINDS,
  GITHUB_LANE_FIELDS,
  operatorNeedsValue,
  parseConditionValue,
} from './triggerLabels.js';

/** Form state: values stay as the user typed them; parsing happens on save. */
export type AutomationFormValues = {
  name: string;
  task: string;
  sourceId: string;
  kind: string;
  conditions: Array<{ field: string; op: ConditionOperator; value: string }>;
  coalesceSeconds: string;
  lane: AutomationLanePart[];
  emit: string;
  mode: AutomationMode;
};

export function defaultAutomationFormValues(): AutomationFormValues {
  return {
    name: '',
    task: '',
    sourceId: '',
    kind: '',
    conditions: [],
    coalesceSeconds: '30',
    lane: [],
    emit: '',
    mode: 'shadow',
  };
}

export function conditionsFromForm(conditions: AutomationFormValues['conditions']): AutomationCondition[] {
  return conditions
    .filter(condition => condition.field.trim().length > 0)
    .map(condition => {
      const value = parseConditionValue(condition.op, condition.value);
      return value === undefined
        ? { field: condition.field.trim(), op: condition.op }
        : { field: condition.field.trim(), op: condition.op, value };
    });
}

export function conditionsToForm(conditions: readonly AutomationCondition[]): AutomationFormValues['conditions'] {
  return conditions.map(condition => ({
    field: condition.field,
    op: condition.op,
    value: formatConditionValue(condition.value),
  }));
}

export function emitFromForm(emit: string): string[] {
  return emit
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

export type AutomationFormFieldsProps = {
  values: AutomationFormValues;
  onChange: (next: AutomationFormValues) => void;
  agentId: string;
  onAgentIdChange?: (agentId: string) => void;
  agentOptions: Array<{ agentId: string; name: string }>;
  agentPickerDisabled?: boolean;
  sources: EventSource[];
  /** Event kinds the ledger has already seen for the chosen source, merged with the defaults. */
  observedKinds: readonly string[];
};

const FIELD_LIST_ID = 'automation-condition-fields';
const KIND_LIST_ID = 'automation-event-kinds';
const LANE_LIST_ID = 'automation-lane-fields';

export function AutomationFormFields({
  values,
  onChange,
  agentId,
  onAgentIdChange,
  agentOptions,
  agentPickerDisabled = false,
  sources,
  observedKinds,
}: AutomationFormFieldsProps) {
  const set = <K extends keyof AutomationFormValues>(key: K, value: AutomationFormValues[K]) => {
    onChange({ ...values, [key]: value });
  };

  const kindOptions = Array.from(new Set([...observedKinds, ...GITHUB_EVENT_KINDS])).sort();

  const updateCondition = (index: number, patch: Partial<AutomationFormValues['conditions'][number]>) => {
    set(
      'conditions',
      values.conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
    );
  };

  const updateLanePart = (index: number, part: AutomationLanePart) => {
    set(
      'lane',
      values.lane.map((current, i) => (i === index ? part : current)),
    );
  };

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <datalist id={FIELD_LIST_ID}>
        {GITHUB_CONDITION_FIELDS.map(field => (
          <option key={field} value={field} />
        ))}
      </datalist>
      <datalist id={KIND_LIST_ID}>
        {kindOptions.map(kind => (
          <option key={kind} value={kind} />
        ))}
      </datalist>
      <datalist id={LANE_LIST_ID}>
        {GITHUB_LANE_FIELDS.map(field => (
          <option key={field} value={field} />
        ))}
      </datalist>

      <div className="block">
        <span className="mb-1.5 block text-sm font-medium">Agent</span>
        <PopoverSelect
          aria-label="Agent"
          placeholder="Select an agent"
          value={agentId}
          options={agentOptions.map(agent => ({ value: agent.agentId, label: agent.name }))}
          onValueChange={value => onAgentIdChange?.(value)}
          disabled={agentPickerDisabled || onAgentIdChange == null}
        />
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Name</span>
        <input
          value={values.name}
          onChange={e => set('name', e.target.value)}
          placeholder="plan-mission"
          className={auiInputClass('h-9')}
          required
        />
      </label>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">Trigger</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="block">
            <span className="text-text-secondary mb-1 block text-xs font-medium">Source</span>
            <PopoverSelect
              aria-label="Event source"
              placeholder={sources.length === 0 ? 'Connect a source in Settings' : 'Select a source'}
              value={values.sourceId}
              options={sources.map(source => ({
                value: source.id,
                label: source.kind === 'trueforge' ? 'TrueForge (internal)' : `${source.name} · GitHub`,
              }))}
              onValueChange={value => set('sourceId', value)}
              disabled={sources.length === 0}
            />
          </div>
          <label className="block">
            <span className="text-text-secondary mb-1 block text-xs font-medium">Event</span>
            <input
              value={values.kind}
              onChange={e => set('kind', e.target.value)}
              list={KIND_LIST_ID}
              placeholder="issues.labeled"
              className={auiInputClass('h-9 font-mono text-xs')}
              required
            />
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-text-secondary text-xs font-medium">When</span>
          {values.conditions.length === 0 ? (
            <p className="text-text-secondary text-xs">
              Every {values.kind || 'event'} matches. Add a condition to narrow it.
            </p>
          ) : null}
          {values.conditions.map((condition, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <span className="text-text-secondary w-8 shrink-0 text-right text-xs">{index === 0 ? '' : 'and'}</span>
              <input
                aria-label={`Condition ${String(index + 1)} field`}
                value={condition.field}
                onChange={e => updateCondition(index, { field: e.target.value })}
                list={FIELD_LIST_ID}
                placeholder="label.name"
                className={auiInputClass('h-8 min-w-0 flex-1 font-mono text-xs')}
              />
              <PopoverSelect
                aria-label={`Condition ${String(index + 1)} operator`}
                className="w-32 shrink-0"
                value={condition.op}
                options={CONDITION_OPERATOR_OPTIONS.map(option => ({ value: option.value, label: option.label }))}
                onValueChange={value => updateCondition(index, { op: value })}
              />
              {operatorNeedsValue(condition.op) ? (
                <input
                  aria-label={`Condition ${String(index + 1)} value`}
                  value={condition.value}
                  onChange={e => updateCondition(index, { value: e.target.value })}
                  placeholder={condition.op === 'in' || condition.op === 'not_in' ? 'a, b, c' : 'ready-for-planning'}
                  className={auiInputClass('h-8 min-w-0 flex-1 text-xs')}
                />
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              <button
                type="button"
                aria-label={`Remove condition ${String(index + 1)}`}
                className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
                onClick={() =>
                  set(
                    'conditions',
                    values.conditions.filter((_, i) => i !== index),
                  )
                }
              >
                <Icon name="xmark" className="size-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={cn(auiButtonClass({ variant: 'outline', size: 'sm' }), 'self-start')}
            onClick={() => set('conditions', [...values.conditions, { field: '', op: 'eq', value: '' }])}
          >
            <Icon name="plus" className="size-3.5" />
            Add condition
          </button>
        </div>
      </fieldset>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Task</span>
        <textarea
          value={values.task}
          onChange={e => set('task', e.target.value)}
          rows={3}
          placeholder="Plan the mission: read the events below, decompose the PRD into tickets and publish them as drafts."
          className={auiInputClass('resize-y py-2')}
          required
        />
        <span className="text-text-secondary mt-1 block text-xs">
          The coalesced events, with their full payloads, are appended to this message.
        </span>
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Coalesce window</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={3600}
              value={values.coalesceSeconds}
              onChange={e => set('coalesceSeconds', e.target.value)}
              className={auiInputClass('h-9 w-28')}
            />
            <span className="text-text-secondary text-sm">seconds</span>
          </div>
          <span className="text-text-secondary mt-1 block text-xs">
            Events about one subject arriving within this window share one run.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Emit on completion</span>
          <input
            value={values.emit}
            onChange={e => set('emit', e.target.value)}
            placeholder="plan.published"
            className={auiInputClass('h-9 font-mono text-xs')}
          />
          <span className="text-text-secondary mt-1 block text-xs">
            Comma-separated event kinds other automations can trigger on.
          </span>
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">Lane</legend>
        {values.lane.length === 0 ? (
          <p className="text-text-secondary text-xs">No lane: runs execute in parallel.</p>
        ) : null}
        {values.lane.map((part, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <PopoverSelect
              aria-label={`Lane part ${String(index + 1)} type`}
              className="w-28 shrink-0"
              value={part.type}
              options={[
                { value: 'field', label: 'Field' },
                { value: 'literal', label: 'Text' },
              ]}
              onValueChange={value =>
                updateLanePart(index, value === 'field' ? { type: 'field', path: '' } : { type: 'literal', value: '' })
              }
            />
            {part.type === 'field' ? (
              <input
                aria-label={`Lane part ${String(index + 1)} field`}
                value={part.path}
                onChange={e => updateLanePart(index, { type: 'field', path: e.target.value })}
                list={LANE_LIST_ID}
                placeholder="repository.full_name"
                className={auiInputClass('h-8 min-w-0 flex-1 font-mono text-xs')}
              />
            ) : (
              <input
                aria-label={`Lane part ${String(index + 1)} text`}
                value={part.value}
                onChange={e => updateLanePart(index, { type: 'literal', value: e.target.value })}
                placeholder="planning"
                className={auiInputClass('h-8 min-w-0 flex-1 text-xs')}
              />
            )}
            <button
              type="button"
              aria-label={`Remove lane part ${String(index + 1)}`}
              className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
              onClick={() =>
                set(
                  'lane',
                  values.lane.filter((_, i) => i !== index),
                )
              }
            >
              <Icon name="xmark" className="size-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={cn(auiButtonClass({ variant: 'outline', size: 'sm' }), 'self-start')}
          onClick={() => set('lane', [...values.lane, { type: 'field', path: '' }])}
        >
          <Icon name="plus" className="size-3.5" />
          Add lane part
        </button>
        <span className="text-text-secondary text-xs">
          Runs with the same rendered lane key execute one at a time. Built from event fields and text, never a template
          string.
        </span>
      </fieldset>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Mode</legend>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1">
          {(
            [
              { value: 'shadow', label: 'Shadow' },
              { value: 'armed', label: 'Armed' },
            ] as const
          ).map(option => {
            const selected = values.mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={cn(
                  'rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                  selected
                    ? 'border border-primary-button-bg/40 bg-primary-button-bg/10 text-primary-button-bg'
                    : 'text-text-secondary hover:bg-ghost-button-hover border border-transparent',
                )}
                aria-pressed={selected}
                onClick={() => set('mode', option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <span className="text-text-secondary mt-1 block text-xs">
          Shadow runs on live events but pauses before any tool call, so you see what it would have done. Armed lets the
          agent act.
        </span>
      </fieldset>
    </div>
  );
}
