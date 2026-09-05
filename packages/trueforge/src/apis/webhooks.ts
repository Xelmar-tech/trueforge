/**
 * Webhook ingress (mounted at /api/v1/webhooks, before auth). Verifies each delivery
 * with the source's connector and appends it to the event ledger.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';
import { WebhookRejectedError, type SourceConnector } from '../connectors/types';
import type { IEventSourceStore } from '../db/eventSourceStore';
import type { IEventStore } from '../db/eventStore';
import { receiveWebhookRoute } from '../routes/webhookRoutes';
import type { EventSourceKind } from '../schemas/eventSource';

export interface WebhooksRouterDeps<TTransaction> {
  eventSourceStore: IEventSourceStore<TTransaction>;
  eventStore: IEventStore<TTransaction>;
  connectors: Record<EventSourceKind, SourceConnector>;
  logger: Logger;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => Date;
}

export function createWebhooksRouter<TTransaction>(deps: WebhooksRouterDeps<TTransaction>) {
  const now = deps.now ?? (() => new Date());

  const receiveHandler: RouteHandler<typeof receiveWebhookRoute> = async c => {
    const { source_id: sourceId } = c.req.valid('param');
    const source = await deps.eventSourceStore.getSourceById(sourceId);
    if (source === undefined) {
      return c.json({ error: { message: `Event source not found: ${sourceId}` } }, 404);
    }
    const rawBody = await c.req.text();
    const secrets = await deps.eventSourceStore.getSecrets(source.id);
    const connector = deps.connectors[source.kind];

    let normalized;
    try {
      normalized = await connector.normalizeWebhook({ headers: c.req.raw.headers, rawBody, secrets });
    } catch (error) {
      if (error instanceof WebhookRejectedError) {
        deps.logger.warn('Webhook rejected', { source_id: source.id, status: error.status, reason: error.message });
        return c.json({ error: { message: error.message } }, error.status);
      }
      throw error;
    }

    const receivedAt = now();
    if (normalized === null) {
      await deps.eventSourceStore.markDelivery({ id: source.id, at: receivedAt, status: 'active' });
      return c.json({ event_id: null, created: false }, 202);
    }

    const { event, created } = await deps.eventStore.insertEvent({
      tenant_id: source.tenant_id,
      source_id: source.id,
      source_kind: source.kind,
      event: normalized,
      received_at: receivedAt,
    });
    await deps.eventSourceStore.markDelivery({ id: source.id, at: receivedAt, status: 'active' });
    deps.logger.info('Webhook recorded', {
      source_id: source.id,
      event_id: event.id,
      kind: event.kind,
      subject_key: event.subject_key,
      created,
    });
    return c.json({ event_id: event.id, created }, 202);
  };

  const router = new OpenAPIHono();
  router.openapi(receiveWebhookRoute, receiveHandler);
  return router;
}
