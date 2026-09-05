/**
 * Event sources API (mounted at /api/v1/event-sources) and the public GitHub manifest
 * callback (mounted at /api/v1/event-sources/github).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'winston';
import { createdBySubjectFromRequestContext, type ResolveRequestContext } from '../auth/identity';
import {
  buildGithubAppManifest,
  exchangeGithubManifestCode,
  githubManifestActionUrl,
  GithubManifestExchangeError,
  githubWebhookUrl,
} from '../connectors/github/manifest';
import { EventSourceNameConflictError, type EventSourceRecord, type IEventSourceStore } from '../db/eventSourceStore';
import type { WithTransaction } from '../db/transaction';
import {
  createGithubManifestRoute,
  deleteEventSourceRoute,
  getEventSourceRoute,
  githubManifestCallbackRoute,
  listEventSourcesRoute,
} from '../routes/eventSourceRoutes';
import type { EventSource } from '../schemas/eventSource';

/** A manifest flow left unfinished this long is dead: GitHub codes expire after one hour. */
const MANIFEST_STATE_TTL_MS = 60 * 60 * 1000;

/** Where the callback sends the browser. Settings opens the Event sources tab and reads the flags. */
export const MANIFEST_CALLBACK_LANDING_PATH = '/settings';

export interface EventSourcesRouterDeps<TTransaction> {
  eventSourceStore: IEventSourceStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  /** Public origin GitHub can reach; throws when the server has none configured. */
  getPublicBaseUrl: () => string;
}

export interface GithubManifestCallbackRouterDeps<TTransaction> {
  eventSourceStore: IEventSourceStore<TTransaction>;
  logger: Logger;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function toWireEventSource(record: EventSourceRecord, publicBaseUrl: string | null): EventSource {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    status: record.status,
    manifest: record.manifest,
    webhook_url: publicBaseUrl === null ? '' : githubWebhookUrl({ publicBaseUrl, sourceId: record.id }),
    last_delivery_at: record.last_delivery_at,
    created_by_subject: record.created_by_subject,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function safePublicBaseUrl(getPublicBaseUrl: () => string): string | null {
  try {
    return getPublicBaseUrl();
  } catch {
    return null;
  }
}

export function createEventSourcesRouter<TTransaction>(deps: EventSourcesRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listEventSourcesRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const publicBaseUrl = safePublicBaseUrl(deps.getPublicBaseUrl);
    const sources = await deps.eventSourceStore.listSources({ tenant_id: requestContext.tenant_id });
    return c.json({ data: sources.map(source => toWireEventSource(source, publicBaseUrl)) }, 200);
  };

  const getHandler: RouteHandler<typeof getEventSourceRoute> = async c => {
    const { source_id: sourceId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const source = await deps.eventSourceStore.getSource({ tenant_id: requestContext.tenant_id, id: sourceId });
    if (source === undefined) {
      return c.json({ error: { message: `Event source not found: ${sourceId}` } }, 404);
    }
    return c.json({ data: toWireEventSource(source, safePublicBaseUrl(deps.getPublicBaseUrl)) }, 200);
  };

  const deleteHandler: RouteHandler<typeof deleteEventSourceRoute> = async c => {
    const { source_id: sourceId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    await deps.eventSourceStore.deleteSource({ tenant_id: requestContext.tenant_id, id: sourceId });
    return c.json({}, 200);
  };

  const createGithubManifestHandler: RouteHandler<typeof createGithubManifestRoute> = async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    let publicBaseUrl: string;
    try {
      publicBaseUrl = deps.getPublicBaseUrl();
    } catch (error) {
      return c.json(
        {
          error: {
            message: `Set PUBLIC_BASE_URL to an address GitHub can reach before connecting a source: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
        400,
      );
    }
    const state = randomBytes(24).toString('base64url');
    let source: EventSourceRecord;
    try {
      source = await deps.withTransaction(txn =>
        deps.eventSourceStore.createPendingGithubSource(
          {
            tenant_id: requestContext.tenant_id,
            name: body.name,
            manifest_state: state,
            created_by_subject: createdBySubjectFromRequestContext(requestContext),
          },
          txn,
        ),
      );
    } catch (error) {
      if (error instanceof EventSourceNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
    return c.json(
      {
        data: {
          source_id: source.id,
          state,
          action_url: githubManifestActionUrl({ owner: body.owner, state }),
          manifest: buildGithubAppManifest({ appName: body.name, publicBaseUrl, sourceId: source.id }),
        },
      },
      201,
    );
  };

  const router = new OpenAPIHono();
  router.openapi(listEventSourcesRoute, listHandler);
  router.openapi(createGithubManifestRoute, createGithubManifestHandler);
  router.openapi(getEventSourceRoute, getHandler);
  router.openapi(deleteEventSourceRoute, deleteHandler);
  return router;
}

function landingPath(input: { isSuccess: boolean; sourceId?: string; reason?: string }): string {
  const params = new URLSearchParams({ section: 'sources', isSuccess: String(input.isSuccess) });
  if (input.sourceId !== undefined) {
    params.set('source', input.sourceId);
  }
  if (input.reason !== undefined) {
    params.set('reason', input.reason);
  }
  return `${MANIFEST_CALLBACK_LANDING_PATH}?${params.toString()}`;
}

/** Public: GitHub redirects the browser here after creating the App. */
export function createGithubManifestCallbackRouter<TTransaction>(deps: GithubManifestCallbackRouterDeps<TTransaction>) {
  const callbackHandler: RouteHandler<typeof githubManifestCallbackRoute> = async c => {
    const { code, state } = c.req.valid('query');
    const source = await deps.eventSourceStore.getSourceByManifestState(state);
    if (source === undefined) {
      return c.json({ error: { message: 'Unknown or already used manifest state' } }, 400);
    }
    if (Date.now() - Date.parse(source.created_at) > MANIFEST_STATE_TTL_MS) {
      return c.redirect(landingPath({ isSuccess: false, sourceId: source.id, reason: 'expired' }), 302);
    }
    try {
      const conversion = await exchangeGithubManifestCode({
        code,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      await deps.eventSourceStore.activateGithubSource({
        tenant_id: source.tenant_id,
        id: source.id,
        app: conversion.app,
        secrets: conversion.secrets,
      });
      deps.logger.info('GitHub event source activated', { source_id: source.id, app_slug: conversion.app.app_slug });
      return c.redirect(landingPath({ isSuccess: true, sourceId: source.id }), 302);
    } catch (error) {
      if (error instanceof GithubManifestExchangeError) {
        deps.logger.warn('GitHub manifest exchange failed', { source_id: source.id, status: error.status });
        return c.redirect(landingPath({ isSuccess: false, sourceId: source.id, reason: error.message }), 302);
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(githubManifestCallbackRoute, callbackHandler);
  return router;
}
