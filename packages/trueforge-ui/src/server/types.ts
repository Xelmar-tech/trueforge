/**
 * Host-facing server contract — re-exported from `@truefoundry/assistant-ui-runtime/server`
 * so hosts never import the runtime package directly.
 *
 * Canonical definitions live in the runtime; this module is aliases + pass-through only.
 * Use the `/server` entry (not package root) so port types are not shadowed by
 * converter helpers that share names (e.g. `UserMessageContent`).
 */

export type {
  AgentBuilderCapabilitiesResponse,
  AgentBuilderServer,
  AgentCapabilityConfig,
  AgentChatServer,
  AgentCompactionConfig,
  AgentDetail,
  AgentInputTokensCompactionTrigger,
  AgentLibraryEntry,
  AgentMetricChartData,
  AgentMetricChartDataRequest,
  AgentMetricChartDefinition,
  AgentMetricChartType,
  AgentMetricGraph,
  AgentMetricGraphLine,
  AgentMetricMeter,
  AgentMetricPoint,
  AgentMetricRangeRequest,
  AgentMetricsServer,
  AgentRuntimeConfig,
  AgentSessionsServer,
  AgentSkill,
  AgentSpec,
  AgentUIServer,
  ApprovalDecision,
  AuthenticateConnectorRequest,
  CatalogServer,
  CodeSnippet,
  CodeSnippetSampleCode,
  ConnectorAuth,
  ConnectorAuthApiKey,
  ConnectorAuthenticationResult,
  ConnectorAuthNone,
  ConnectorAuthOAuth,
  ConnectorAuthPublic,
  ConnectorAuthPublicApiKey,
  ConnectorAuthPublicNone,
  ConnectorAuthPublicOAuth,
  ConnectorAuthType,
  ConnectorBase,
  ConnectorCatalogEntry,
  ConnectorCatalogServer,
  ConnectorConfigBase,
  ConnectorState,
  CreateConnectorRequest,
  CreateModelProviderRequest,
  CreateSandboxProviderRequest,
  CreateScheduleRequest,
  CreateScheduleRunRequest,
  CreateSessionRequest,
  CreateSkillRequest,
  CreateSkillRequestBase,
  DefinedSkill,
  GithubSkill,
  ImportGithubSkillRequest,
  ListResult,
  ListSchedulesParams,
  ListSessionEventsParams,
  ListSessionsOrder,
  ListSessionsParams,
  McpServerMount,
  McpToolSelection,
  Model,
  ModelCatalogServer,
  ModelEntry,
  ModelParams,
  ModelProperties,
  ModelProviderBase,
  ModelProviderCatalogEntry,
  ModelProviderConfigBase,
  ModelSelection,
  ModelSelectorEntry,
  PageParams,
  PreviousTurnIdInput,
  ProviderEntry,
  ProviderType,
  RegistrySkill,
  SandboxCatalogServer,
  SandboxProviderBase,
  SandboxProviderCatalogEntry,
  SandboxProviderConfig,
  SandboxProviderListEntry,
  SandboxSnapshotSyncStatus,
  SaveAgentRequest,
  SaveAgentResult,
  Schedule,
  ScheduleRun,
  ScheduleRunStatus,
  ScheduleServer,
  ScheduleStatus,
  SearchAgentsParams,
  SelectRegistrySkillRequest,
  Session,
  SessionEventItem,
  SessionListEntry,
  SessionListMetrics,
  SkillBase,
  SkillCatalogEntry,
  SkillCatalogServer,
  SkillConfigBase,
  SkillMount,
  ToolBase,
  Turn,
  TurnDoneMetrics,
  TurnInputItem,
  TurnState,
  TurnStreamData,
  TurnStreamingEvent,
  UpdateConnectorRequest,
  UpdateModelProviderRequest,
  UpdateSandboxProviderRequest,
  UpdateScheduleRequest,
  UpdateSessionRequest,
  UserMessage,
  UserMessageContent,
  UserToolApprovalEvent,
  UserToolResponseEvent,
} from '@truefoundry/assistant-ui-runtime/server';

import type { ListResult as RuntimeListResult } from '@truefoundry/assistant-ui-runtime/server';

// ---------------------------------------------------------------------------
// Automations port (fork addition).
//
// These DTOs belong in `@truefoundry/assistant-ui-runtime/server` with the other
// server ports; they live here until that package ships them. Hosts still import
// from this module only.
// ---------------------------------------------------------------------------

export type AutomationMode = 'shadow' | 'armed';
export type AutomationStatus = 'active' | 'paused';
export type AutomationRunStatus = 'coalescing' | 'triggered' | 'waiting' | 'completed' | 'shadowed' | 'failed';
export type ConditionOperator = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'exists' | 'not_exists';
export type ConditionValue = string | number | boolean | Array<string | number>;

/** One typed trigger condition: a payload field, an operator, and a value. */
export type AutomationCondition = {
  field: string;
  op: ConditionOperator;
  value?: ConditionValue;
};

export type AutomationLanePart = { type: 'field'; path: string } | { type: 'literal'; value: string };

export type AutomationTrigger = {
  sourceId: string;
  /** Connector event kind, e.g. `issues.labeled`. */
  kind: string;
  /** Every condition must hold. */
  conditions: AutomationCondition[];
};

export type Automation = {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  trigger: AutomationTrigger;
  coalesceSeconds: number;
  lane: AutomationLanePart[];
  task: string;
  emit: string[];
  mode: AutomationMode;
  status: AutomationStatus;
  createdAt: string;
  updatedAt: string;
};

export type SaveAutomationRequest = {
  agentId: string;
  name: string;
  trigger: AutomationTrigger;
  coalesceSeconds: number;
  lane: AutomationLanePart[];
  task: string;
  emit: string[];
  mode: AutomationMode;
  status: AutomationStatus;
};

export type UpdateAutomationRequest = Omit<SaveAutomationRequest, 'agentId'> & { id: string };

export type AutomationRun = {
  id: string;
  automationId: string;
  subjectKey: string;
  laneKey: string | null;
  status: AutomationRunStatus;
  mode: AutomationMode;
  eventIds: string[];
  sessionId: string | null;
  scheduledFor: string;
  triggeredAt: string | null;
  finishedAt: string | null;
  outcome: Record<string, unknown> | null;
};

export type EventSourceKind = 'github' | 'trueforge';
export type EventSourceStatus = 'pending' | 'active' | 'error';

export type EventSource = {
  id: string;
  kind: EventSourceKind;
  name: string;
  status: EventSourceStatus;
  webhookUrl: string;
  app: { appId: number; appSlug: string; htmlUrl: string; owner: string | null } | null;
  lastDeliveryAt: string | null;
  createdAt: string;
};

export type GithubManifestStart = {
  sourceId: string;
  state: string;
  actionUrl: string;
  manifest: Record<string, unknown>;
};

export type LedgerEventSummary = {
  repository: string | null;
  number: number | null;
  title: string | null;
  actor: string | null;
  label: string | null;
};

export type LedgerEvent = {
  id: string;
  sourceId: string;
  sourceKind: EventSourceKind;
  kind: string;
  subjectKey: string;
  deliveryId: string;
  summary: LedgerEventSummary;
  receivedAt: string;
  routedAt: string | null;
};

export type LedgerEventDetail = LedgerEvent & { payload: Record<string, unknown> };

export type ListAutomationsParams = {
  agentId?: string;
  limit?: number;
  pageToken?: string;
};

export type ListLedgerEventsParams = {
  sourceId?: string;
  kind?: string;
  subjectKey?: string;
  since?: string;
  limit?: number;
  pageToken?: string;
};

/** Automations, the event ledger and event sources — one port, one page. */
export interface AutomationServer {
  listAutomations(req?: ListAutomationsParams): Promise<RuntimeListResult<Automation>>;
  getAutomation(req: { id: string }): Promise<Automation>;
  createAutomation(req: SaveAutomationRequest): Promise<Automation>;
  updateAutomation(req: UpdateAutomationRequest): Promise<Automation>;
  deleteAutomation(req: { id: string }): Promise<void>;
  listAutomationRuns(req: { automationId: string }): Promise<AutomationRun[]>;
  /** Runs one recorded event through the automation in shadow mode. */
  replayAutomation(req: { automationId: string; eventId: string }): Promise<AutomationRun>;
  listEvents(req?: ListLedgerEventsParams): Promise<RuntimeListResult<LedgerEvent>>;
  getEvent(req: { id: string }): Promise<LedgerEventDetail>;
  listEventSources(): Promise<EventSource[]>;
  startGithubManifest(req: { name: string; owner?: string }): Promise<GithubManifestStart>;
  deleteEventSource(req: { id: string }): Promise<void>;
}
