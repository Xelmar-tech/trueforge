import { z } from '@hono/zod-openapi';
import { CreatedBySubjectSchema, TokenPaginationSchema } from '@truefoundry/trueforge-core/agent-session';
import { NameSchema } from './common';

// --- Trigger conditions: typed field / operator / value, never an expression string ---

export const ConditionOperatorSchema = z
  .enum(['eq', 'neq', 'in', 'not_in', 'contains', 'exists', 'not_exists'])
  .openapi('ConditionOperator');

const ConditionScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const ConditionValueSchema = z
  .union([ConditionScalarSchema, z.array(z.union([z.string(), z.number()])).max(64)])
  .openapi('ConditionValue');

export const ConditionSchema = z
  .object({
    field: z.string().min(1).max(200).describe('Dotted path into the event payload, e.g. `label.name`.'),
    op: ConditionOperatorSchema,
    value: ConditionValueSchema.optional().describe('Comparison value; omitted for `exists` / `not_exists`.'),
  })
  .strict()
  .openapi('Condition');

/** Every condition must hold (logical AND). An empty list matches every event of the kind. */
export const WhenSchema = z
  .object({
    all: z.array(ConditionSchema).max(16).default([]),
  })
  .strict()
  .openapi('When');

export const EventTriggerSchema = z
  .object({
    type: z.literal('event'),
    source_id: z.string().min(1).describe('Event source the events come from.'),
    kind: z.string().min(1).max(128).describe('Connector event kind, e.g. `issues.labeled`.'),
    when: WhenSchema.default(() => ({ all: [] })),
  })
  .strict()
  .openapi('EventTrigger');

export const TriggerSchema = z.discriminatedUnion('type', [EventTriggerSchema]).openapi('Trigger');

// --- Lane key: field references and literals, not a template string ---

export const LanePartSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('field'),
        path: z.string().min(1).max(200).describe('Dotted path into the event payload.'),
      })
      .strict(),
    z.object({ type: z.literal('literal'), value: z.string().min(1).max(64) }).strict(),
  ])
  .openapi('LanePart');

export const AutomationModeSchema = z.enum(['shadow', 'armed']).openapi('AutomationMode');
export const AutomationStatusSchema = z.enum(['active', 'paused']).openapi('AutomationStatus');

/** Minimum gap the coalesce window can be; 0 wakes on the first event. */
export const MAX_COALESCE_SECONDS = 3600;

/**
 * Automation document persisted as `automation.manifest`.
 */
export const AutomationManifestObjectSchema = z
  .object({
    trigger: TriggerSchema,
    coalesce_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_COALESCE_SECONDS)
      .default(30)
      .describe('Events about one subject arriving within this window share one run.'),
    lane: z
      .array(LanePartSchema)
      .max(8)
      .default([])
      .describe('Runs with the same rendered lane key execute one at a time. Empty = no lane.'),
    task: z
      .string()
      .trim()
      .min(1)
      .describe('First user message sent to the agent. The coalesced events are appended as JSON.'),
    emit: z
      .array(z.string().min(1).max(64))
      .max(8)
      .default([])
      .describe('Event kinds written to the internal source when a run completes.'),
    mode: AutomationModeSchema.default('shadow'),
    status: AutomationStatusSchema.default('active'),
  })
  .strict();

export const AutomationManifestSchema = AutomationManifestObjectSchema.openapi('AutomationManifest');

/** Wire ISO-8601 instant. */
const IsoTimestamp = z.iso.datetime().openapi({ type: 'string', format: 'date-time' });
const NullableIsoTimestamp = z.iso
  .datetime()
  .nullable()
  .openapi({ type: ['string', 'null'], format: 'date-time' });

export const AutomationSchema = z
  .object({
    id: z.string(),
    agent_name: NameSchema,
    name: NameSchema,
    manifest: AutomationManifestSchema,
    created_by_subject: CreatedBySubjectSchema,
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .strict()
  .openapi('Automation');

export const CreateAutomationRequestSchema = z
  .object({
    agent_name: NameSchema,
    name: NameSchema,
    manifest: AutomationManifestSchema,
  })
  .strict()
  .openapi('CreateAutomationRequest');

export const UpdateAutomationRequestSchema = z
  .object({
    name: NameSchema,
    manifest: AutomationManifestSchema,
  })
  .strict()
  .openapi('UpdateAutomationRequest');

export const GetAutomationResponseSchema = z.object({ data: AutomationSchema }).openapi('GetAutomationResponse');
export const ListAutomationsResponseSchema = z
  .object({
    data: z.array(AutomationSchema),
    pagination: TokenPaginationSchema,
  })
  .openapi('ListAutomationsResponse');
export const DeleteAutomationResponseSchema = z.object({}).openapi('DeleteAutomationResponse');

/**
 * Run lifecycle.
 * - `coalescing`  open window collecting events for one subject; due at `scheduled_for`
 * - `triggered`   handed to the agent; `session_id` set
 * - `waiting`     the armed run paused on a required action a human must resolve
 * - `completed`   the turn finished; `emit` events were written
 * - `shadowed`    a shadow run paused at its first gated tool call; `outcome` holds it
 * - `failed`      hand-off or turn error
 */
export const AutomationRunStatusSchema = z
  .enum(['coalescing', 'triggered', 'waiting', 'completed', 'shadowed', 'failed'])
  .openapi('AutomationRunStatus');

export const AutomationRunSchema = z
  .object({
    id: z.string(),
    automation_id: z.string(),
    subject_key: z.string(),
    lane_key: z.string().nullable(),
    status: AutomationRunStatusSchema,
    mode: AutomationModeSchema,
    event_ids: z.array(z.string()).describe('Ledger events coalesced into this run, oldest first.'),
    session_id: z.string().nullable(),
    scheduled_for: IsoTimestamp.describe('When the coalesce window closes and the run may start.'),
    triggered_at: NullableIsoTimestamp,
    finished_at: NullableIsoTimestamp,
    outcome: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('Terminal details: required actions for a shadowed run, emitted event ids, or the error.'),
    created_by_subject: CreatedBySubjectSchema,
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .strict()
  .openapi('AutomationRun');

export const ListAutomationRunsResponseSchema = z
  .object({ data: z.array(AutomationRunSchema) })
  .openapi('ListAutomationRunsResponse');

/** Replay one recorded event through an automation, always in shadow mode. */
export const ReplayAutomationRequestSchema = z
  .object({
    event_id: z.string().min(1).describe('Ledger event to replay.'),
  })
  .strict()
  .openapi('ReplayAutomationRequest');

export const ReplayAutomationResponseSchema = z
  .object({ data: AutomationRunSchema })
  .openapi('ReplayAutomationResponse');

export type ConditionOperator = z.infer<typeof ConditionOperatorSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type When = z.infer<typeof WhenSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type LanePart = z.infer<typeof LanePartSchema>;
export type AutomationMode = z.infer<typeof AutomationModeSchema>;
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;
export type AutomationManifest = z.infer<typeof AutomationManifestSchema>;
export type Automation = z.infer<typeof AutomationSchema>;
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequestSchema>;
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequestSchema>;
export type ReplayAutomationRequest = z.infer<typeof ReplayAutomationRequestSchema>;
