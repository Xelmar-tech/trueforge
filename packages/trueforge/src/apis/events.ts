/**
 * Event ledger API (mounted at /api/v1/events).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { InvalidPageTokenError } from '@truefoundry/trueforge-core/agent-session';
import type { ResolveRequestContext } from '../auth/identity';
import type { EventRecord, EventWithPayloadRecord, IEventStore } from '../db/eventStore';
import { getEventRoute, listEventsRoute } from '../routes/eventRoutes';
import type { Event, EventDetail } from '../schemas/event';

export interface EventsRouterDeps<TTransaction> {
  eventStore: IEventStore<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
}

export function toWireEvent(record: EventRecord): Event {
  return {
    id: record.id,
    source_id: record.source_id,
    source_kind: record.source_kind,
    kind: record.kind,
    subject_key: record.subject_key,
    delivery_id: record.delivery_id,
    summary: record.summary,
    received_at: record.received_at,
    routed_at: record.routed_at,
  };
}

export function toWireEventDetail(record: EventWithPayloadRecord): EventDetail {
  return { ...toWireEvent(record), payload: record.payload };
}

export function createEventsRouter<TTransaction>(deps: EventsRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listEventsRoute> = async c => {
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    try {
      const { data, pagination } = await deps.eventStore.listEvents({
        tenant_id: requestContext.tenant_id,
        limit: query.limit,
        page_token: query.page_token,
        source_id: query.source_id,
        kind: query.kind,
        subject_key: query.subject_key,
        since: query.since === undefined ? undefined : new Date(query.since),
      });
      return c.json({ data: data.map(toWireEvent), pagination }, 200);
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const getHandler: RouteHandler<typeof getEventRoute> = async c => {
    const { event_id: eventId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const event = await deps.eventStore.getEvent({ tenant_id: requestContext.tenant_id, id: eventId });
    if (event === undefined) {
      return c.json({ error: { message: `Event not found: ${eventId}` } }, 404);
    }
    return c.json({ data: toWireEventDetail(event) }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listEventsRoute, listHandler);
  router.openapi(getEventRoute, getHandler);
  return router;
}
