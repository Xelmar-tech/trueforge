/**
 * Automations API (mounted at /api/v1/automations).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { InvalidPageTokenError } from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import type { Authorizer } from '../auth/authorizer';
import {
  createdBySubjectFromRequestContext,
  hasAdminRole,
  type RequestContext,
  type ResolveRequestContext,
} from '../auth/identity';
import type { IAgentStore } from '../db/agentStore';
import {
  AutomationNameConflictError,
  type AutomationRecord,
  type AutomationRunRecord,
  type IAutomationStore,
} from '../db/automationStore';
import type { IEventSourceStore } from '../db/eventSourceStore';
import type { IEventStore } from '../db/eventStore';
import type { WithTransaction } from '../db/transaction';
import {
  createAutomationRoute,
  deleteAutomationRoute,
  getAutomationRoute,
  listAutomationRunsRoute,
  listAutomationsRoute,
  putAutomationRoute,
  replayAutomationRoute,
} from '../routes/automationRoutes';
import { renderLaneKey } from '../runtime/conditions';
import type { Automation, AutomationManifest, AutomationRun } from '../schemas/automation';
import { agentIfAccessible } from './agentAccess';

export interface AutomationsRouterDeps<TTransaction> {
  automationStore: IAutomationStore<TTransaction>;
  eventStore: IEventStore<TTransaction>;
  eventSourceStore: IEventSourceStore<TTransaction>;
  resolveAgentStore: (c: Context) => IAgentStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  authorizer: Authorizer;
}

export function toWireAutomation(record: AutomationRecord): Automation {
  return {
    id: record.id,
    agent_name: record.agent_name,
    name: record.name,
    manifest: record.manifest,
    created_by_subject: record.created_by_subject,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export function toWireAutomationRun(record: AutomationRunRecord): AutomationRun {
  return {
    id: record.id,
    automation_id: record.automation_id,
    subject_key: record.subject_key,
    lane_key: record.lane_key,
    status: record.status,
    mode: record.mode,
    event_ids: record.event_ids,
    session_id: record.session_id,
    scheduled_for: record.scheduled_for,
    triggered_at: record.triggered_at,
    finished_at: record.finished_at,
    outcome: record.outcome,
    created_by_subject: record.created_by_subject,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

const FORBIDDEN_AUTOMATION_ACCESS = 'Only the automation creator can access this automation';

/** An automation is visible to its creator, and to any admin. */
function canAccessAutomation(
  requestContext: Pick<RequestContext, 'roles' | 'subject'>,
  created_by_subject_id: string,
): boolean {
  return hasAdminRole(requestContext) || requestContext.subject.id === created_by_subject_id;
}

/** The replay subject is unique per event so it never collides with a live coalesce window. */
export function replaySubjectKey(event: { subject_key: string; id: string }): string {
  return `${event.subject_key}~replay:${event.id}`;
}

export function createAutomationsRouter<TTransaction>(deps: AutomationsRouterDeps<TTransaction>) {
  /** The trigger must name a source in the caller's tenant. */
  async function triggerSourceError(tenantId: string, manifest: AutomationManifest): Promise<string | undefined> {
    const source = await deps.eventSourceStore.getSource({ tenant_id: tenantId, id: manifest.trigger.source_id });
    return source === undefined ? `Event source not found: ${manifest.trigger.source_id}` : undefined;
  }

  const listHandler: RouteHandler<typeof listAutomationsRoute> = async c => {
    const { agent_names: agentNames, limit, page_token: pageToken } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    try {
      const { data, pagination } = await deps.automationStore.listAutomations({
        tenant_id: requestContext.tenant_id,
        limit,
        page_token: pageToken,
        agent_names: agentNames,
        created_by_subject_id: hasAdminRole(requestContext) ? undefined : requestContext.subject.id,
      });
      return c.json({ data: data.map(toWireAutomation), pagination }, 200);
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const createHandler: RouteHandler<typeof createAutomationRoute> = async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);

    const agent = await agentIfAccessible({
      authorizer: deps.authorizer,
      context: requestContext,
      action: 'read',
      agent: await deps.resolveAgentStore(c).getAgent({ tenant_id: requestContext.tenant_id, name: body.agent_name }),
    });
    if (agent === undefined) {
      return c.json({ error: { message: `Agent not found: ${body.agent_name}` } }, 404);
    }
    const sourceError = await triggerSourceError(requestContext.tenant_id, body.manifest);
    if (sourceError !== undefined) {
      return c.json({ error: { message: sourceError } }, 400);
    }

    try {
      const record = await deps.withTransaction(txn =>
        deps.automationStore.createAutomation(
          {
            tenant_id: requestContext.tenant_id,
            agent_id: agent.id,
            agent_name: agent.name,
            name: body.name,
            manifest: body.manifest,
            created_by_subject: createdBySubjectFromRequestContext(requestContext),
          },
          txn,
        ),
      );
      return c.json({ data: toWireAutomation(record) }, 201);
    } catch (error) {
      if (error instanceof AutomationNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const getHandler: RouteHandler<typeof getAutomationRoute> = async c => {
    const { automation_id: automationId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.automationStore.getAutomation({ tenant_id: requestContext.tenant_id, id: automationId });
    if (record === undefined) {
      return c.json({ error: { message: `Automation not found: ${automationId}` } }, 404);
    }
    if (!canAccessAutomation(requestContext, record.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_AUTOMATION_ACCESS } }, 403);
    }
    return c.json({ data: toWireAutomation(record) }, 200);
  };

  const putHandler: RouteHandler<typeof putAutomationRoute> = async c => {
    const { automation_id: automationId } = c.req.valid('param');
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const existing = await deps.automationStore.getAutomation({
      tenant_id: requestContext.tenant_id,
      id: automationId,
    });
    if (existing === undefined) {
      return c.json({ error: { message: `Automation not found: ${automationId}` } }, 404);
    }
    if (!canAccessAutomation(requestContext, existing.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_AUTOMATION_ACCESS } }, 403);
    }
    const sourceError = await triggerSourceError(requestContext.tenant_id, body.manifest);
    if (sourceError !== undefined) {
      return c.json({ error: { message: sourceError } }, 400);
    }
    try {
      const updated = await deps.withTransaction(txn =>
        deps.automationStore.updateAutomation(
          { tenant_id: requestContext.tenant_id, id: automationId, name: body.name, manifest: body.manifest },
          txn,
        ),
      );
      if (updated === undefined) {
        return c.json({ error: { message: `Automation not found: ${automationId}` } }, 404);
      }
      return c.json({ data: toWireAutomation(updated) }, 200);
    } catch (error) {
      if (error instanceof AutomationNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteAutomationRoute> = async c => {
    const { automation_id: automationId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const existing = await deps.automationStore.getAutomation({
      tenant_id: requestContext.tenant_id,
      id: automationId,
    });
    if (existing !== undefined && !canAccessAutomation(requestContext, existing.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_AUTOMATION_ACCESS } }, 403);
    }
    await deps.automationStore.deleteAutomation({ tenant_id: requestContext.tenant_id, id: automationId });
    return c.json({}, 200);
  };

  const listRunsHandler: RouteHandler<typeof listAutomationRunsRoute> = async c => {
    const { automation_id: automationId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.automationStore.getAutomation({ tenant_id: requestContext.tenant_id, id: automationId });
    if (record === undefined) {
      return c.json({ error: { message: `Automation not found: ${automationId}` } }, 404);
    }
    if (!canAccessAutomation(requestContext, record.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_AUTOMATION_ACCESS } }, 403);
    }
    const runs = await deps.automationStore.listRuns({
      tenant_id: requestContext.tenant_id,
      automation_id: automationId,
    });
    return c.json({ data: runs.map(toWireAutomationRun) }, 200);
  };

  const replayHandler: RouteHandler<typeof replayAutomationRoute> = async c => {
    const { automation_id: automationId } = c.req.valid('param');
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.automationStore.getAutomation({ tenant_id: requestContext.tenant_id, id: automationId });
    if (record === undefined) {
      return c.json({ error: { message: `Automation not found: ${automationId}` } }, 404);
    }
    if (!canAccessAutomation(requestContext, record.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_AUTOMATION_ACCESS } }, 403);
    }
    const event = await deps.eventStore.getEvent({ tenant_id: requestContext.tenant_id, id: body.event_id });
    if (event === undefined) {
      return c.json({ error: { message: `Event not found: ${body.event_id}` } }, 404);
    }
    const { trigger } = record.manifest;
    if (event.source_id !== trigger.source_id || event.kind !== trigger.kind) {
      return c.json(
        {
          error: {
            message: `Event ${event.id} is ${event.kind} from another source; the trigger wants ${trigger.kind}`,
          },
        },
        400,
      );
    }
    const run = await deps.withTransaction(txn =>
      deps.automationStore.createImmediateRun(
        {
          tenant_id: requestContext.tenant_id,
          automation_id: record.id,
          subject_key: replaySubjectKey(event),
          lane_key: renderLaneKey(record.manifest.lane, event.payload),
          mode: 'shadow',
          event_ids: [event.id],
          created_by_subject: createdBySubjectFromRequestContext(requestContext),
          now: new Date(),
        },
        txn,
      ),
    );
    return c.json({ data: toWireAutomationRun(run) }, 201);
  };

  const router = new OpenAPIHono();
  router.openapi(listAutomationsRoute, listHandler);
  router.openapi(createAutomationRoute, createHandler);
  router.openapi(getAutomationRoute, getHandler);
  router.openapi(putAutomationRoute, putHandler);
  router.openapi(deleteAutomationRoute, deleteHandler);
  router.openapi(listAutomationRunsRoute, listRunsHandler);
  router.openapi(replayAutomationRoute, replayHandler);
  return router;
}
