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
import { sourceToolsUrl, sourceToolToken } from '../connectors/github/tools';
import { EventSourceNameConflictError, type EventSourceRecord, type IEventSourceStore } from '../db/eventSourceStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { WithTransaction } from '../db/transaction';
import {
  createGithubManifestRoute,
  deleteEventSourceRoute,
  getEventSourceRoute,
  githubManifestCallbackRoute,
  listEventSourcesRoute,
  registerSourceConnectorRoute,
} from '../routes/eventSourceRoutes';
import type { EventSource, GithubSourceSecrets } from '../schemas/eventSource';

/** A manifest flow left unfinished this long is dead: GitHub codes expire after one hour. */
const MANIFEST_STATE_TTL_MS = 60 * 60 * 1000;

/** Where the callback sends the browser. Settings opens the Event sources tab and reads the flags. */
export const MANIFEST_CALLBACK_LANDING_PATH = '/settings';

export interface EventSourcesRouterDeps<TTransaction> {
  eventSourceStore: IEventSourceStore<TTransaction>;
  mcpServerStore: Pick<IMcpServerStore<TTransaction>, 'upsertServer'>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  /** Public origin GitHub can reach; throws when the server has none configured. */
  getPublicBaseUrl: () => string;
}

export interface GithubManifestCallbackRouterDeps<TTransaction> {
  eventSourceStore: IEventSourceStore<TTransaction>;
  mcpServerStore: Pick<IMcpServerStore<TTransaction>, 'upsertServer'>;
  logger: Logger;
  /** Public origin agents' MCP client calls back into; throws when the server has none configured. */
  getPublicBaseUrl: () => string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Registers (or refreshes) the MCP connector through which agents act as the App behind a
 * GitHub source. The row is named after the source; its bearer token is derived from the
 * webhook secret, so nothing new is stored and rotation is a re-registration.
 */
export async function registerSourceConnector<TTransaction>(input: {
  source: EventSourceRecord;
  secrets: GithubSourceSecrets;
  publicBaseUrl: string;
  mcpServerStore: Pick<IMcpServerStore<TTransaction>, 'upsertServer'>;
}): Promise<{ mcp_server_name: string; url: string }> {
  const url = sourceToolsUrl({ publicBaseUrl: input.publicBaseUrl, sourceId: input.source.id });
  const app = input.source.manifest.kind === 'github' ? input.source.manifest.app : null;
  await input.mcpServerStore.upsertServer({
    tenant_id: input.source.tenant_id,
    name: input.source.name,
    manifest: {
      type: 'remote',
      name: input.source.name,
      url,
      description: `GitHub issues and comments, acting as the ${app?.app_slug ?? input.source.name} App.`,
      auth: {
        type: 'header',
        headers: {
          Authorization: `Bearer ${sourceToolToken({ sourceId: input.source.id, webhookSecret: input.secrets.webhook_secret })}`,
        },
      },
    },
  });
  return { mcp_server_name: input.source.name, url };
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
    // The tenant's internal source always exists, so downstream automations can be built
    // before the first run emits into it.
    await deps.eventSourceStore.ensureInternalSource({ tenant_id: requestContext.tenant_id });
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

  const registerConnectorHandler: RouteHandler<typeof registerSourceConnectorRoute> = async c => {
    const { source_id: sourceId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const source = await deps.eventSourceStore.getSource({ tenant_id: requestContext.tenant_id, id: sourceId });
    if (source === undefined || source.status === 'pending' || source.manifest.kind !== 'github') {
      return c.json({ error: { message: `Active GitHub event source not found: ${sourceId}` } }, 404);
    }
    const publicBaseUrl = safePublicBaseUrl(deps.getPublicBaseUrl);
    if (publicBaseUrl === null) {
      return c.json({ error: { message: 'Set PUBLIC_BASE_URL before registering the tools connector' } }, 400);
    }
    const secrets = await deps.eventSourceStore.getSecrets(source.id);
    if (secrets === null) {
      return c.json({ error: { message: `Active GitHub event source not found: ${sourceId}` } }, 404);
    }
    const data = await registerSourceConnector({
      source,
      secrets: secrets.github,
      publicBaseUrl,
      mcpServerStore: deps.mcpServerStore,
    });
    return c.json({ data }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listEventSourcesRoute, listHandler);
  router.openapi(createGithubManifestRoute, createGithubManifestHandler);
  router.openapi(getEventSourceRoute, getHandler);
  router.openapi(deleteEventSourceRoute, deleteHandler);
  router.openapi(registerSourceConnectorRoute, registerConnectorHandler);
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
      const activated = await deps.eventSourceStore.activateGithubSource({
        tenant_id: source.tenant_id,
        id: source.id,
        app: conversion.app,
        secrets: conversion.secrets,
      });
      deps.logger.info('GitHub event source activated', { source_id: source.id, app_slug: conversion.app.app_slug });
      if (activated !== undefined) {
        await registerSourceConnector({
          source: activated,
          secrets: conversion.secrets,
          publicBaseUrl: deps.getPublicBaseUrl(),
          mcpServerStore: deps.mcpServerStore,
        });
      }
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
