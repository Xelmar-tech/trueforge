/**
 * Built-in MCP endpoint per GitHub source (mounted at /api/v1/event-sources, path
 * `/:source_id/mcp`). The core's MCP client calls it with the bearer token the manifest callback
 * registered on the matching connector row; tools act with the App's installation token.
 *
 * Stateless: every POST gets a fresh server + transport, so there is no session to leak.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { Logger } from 'winston';
import {
  createInstallationTokenMinter,
  GITHUB_API_BASE_URL,
  type InstallationTokenMinter,
} from '../connectors/github/appAuth';
import {
  createGithubToolServer,
  githubRequestWithMinter,
  isSourceToolTokenValid,
  sourceToolToken,
} from '../connectors/github/tools';
import type { IEventSourceStore } from '../db/eventSourceStore';

export interface SourceToolsRouterDeps<TTransaction> {
  eventSourceStore: IEventSourceStore<TTransaction>;
  logger: Logger;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to api.github.com. */
  githubApiBaseUrl?: string;
}

function bearerToken(header: string | undefined): string {
  return header === undefined ? '' : header.replace(/^Bearer\s+/i, '');
}

export function createSourceToolsRouter<TTransaction>(deps: SourceToolsRouterDeps<TTransaction>) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBaseUrl = deps.githubApiBaseUrl ?? GITHUB_API_BASE_URL;
  // Installation tokens are cached inside each minter; one minter per source keeps them across requests.
  const minters = new Map<string, InstallationTokenMinter>();

  const router = new Hono();

  router.post('/:source_id/mcp', async c => {
    const sourceId = c.req.param('source_id');
    const source = await deps.eventSourceStore.getSourceById(sourceId);
    if (source?.manifest.kind !== 'github' || source.manifest.app === null) {
      return c.json({ error: { message: `Event source not found: ${sourceId}` } }, 404);
    }
    const secrets = await deps.eventSourceStore.getSecrets(sourceId);
    if (secrets === null) {
      return c.json({ error: { message: `Event source has no credentials: ${sourceId}` } }, 404);
    }
    const expected = sourceToolToken({ sourceId, webhookSecret: secrets.github.webhook_secret });
    if (!isSourceToolTokenValid({ presented: bearerToken(c.req.header('authorization')), expected })) {
      deps.logger.warn('Source tools call rejected: bad bearer token', { source_id: sourceId });
      return c.json({ error: { message: 'Unauthorized' } }, 401);
    }

    let minter = minters.get(sourceId);
    if (minter === undefined) {
      minter = createInstallationTokenMinter({
        credentials: { app_id: source.manifest.app.app_id, private_key: secrets.github.private_key },
        fetchImpl,
        apiBaseUrl,
      });
      minters.set(sourceId, minter);
    }

    const server = createGithubToolServer(githubRequestWithMinter({ minter, fetchImpl, apiBaseUrl }));
    // No `sessionIdGenerator` = stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  // Stateless mode has no stream to resume and no session to end.
  router.on(['GET', 'DELETE'], '/:source_id/mcp', c => c.json({ error: { message: 'Method not allowed' } }, 405));

  return router;
}
