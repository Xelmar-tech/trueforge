import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import type { Logger } from 'winston';
import { z } from 'zod';

import { isUserCredential, type CredentialSubject } from '../auth/credentialSubject';
import type { AgentAction } from '../auth/externalAuthorizer';
import { rawTokenFromCredential } from '../auth/token';
import { createInternalTlsDispatcher, normalizeInternalTlsUrl, type InternalTlsOptions } from './internalTls';

const INTEGRATIONS_PATH = 'v1/provider-integrations';
const INSTALLATIONS_PATH = 'v1/llm-gateway/installations';
const MCP_SERVERS_PATH = 'v1/mcp';
const SESSION_PATH = 'v1/session';
const AUTHORIZATION_PERMISSIONS_PATH = 'v1/authorize/permissions';
const VEND_TOKEN_PATH = 'v1/x/vend-token';
const INTEGRATIONS_PAGE_SIZE = 1000;
const MCP_SERVERS_PAGE_SIZE = 100;

const SessionIdentityPrincipalSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  display_name: z.string().min(1).nullable().optional(),
});

const GetSessionResponseSchema = z.object({
  user: z.object({
    tenantName: z.string().min(1),
    roles: z.array(z.string()),
  }),
  identity: z.object({
    subject: SessionIdentityPrincipalSchema,
    actor: SessionIdentityPrincipalSchema.nullable(),
  }),
});

const AgentPermissionsResponseSchema = z.record(z.string(), z.array(z.string()));
const AgentIdentityTokenResponseSchema = z.object({ token: z.string().min(1) });

export type GetSessionResponse = z.infer<typeof GetSessionResponseSchema>;

const ListResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({
    data: z.array(z.unknown()).catch([]),
    pagination: z.object({ total: z.number().optional() }).optional(),
  }),
]);

type ListResponse = z.infer<typeof ListResponseSchema>;

const ServiceFoundryErrorSchema = z.object({
  message: z.union([z.string(), z.array(z.string())]).optional(),
});

async function readServiceFoundryErrorMessage(
  response: Awaited<ReturnType<typeof undiciFetch>>,
): Promise<string | undefined> {
  const body = await response.json().catch(() => undefined);
  const parsed = ServiceFoundryErrorSchema.safeParse(body);
  const message = parsed.success ? parsed.data.message : undefined;
  return Array.isArray(message) ? message.join(', ') : message;
}

function listPage(response: ListResponse): unknown[] {
  return Array.isArray(response) ? response : response.data;
}

function listPaginationTotal(response: ListResponse): number | undefined {
  return Array.isArray(response) ? undefined : response.pagination?.total;
}

export class TrueFoundryServiceFoundryServerClient {
  readonly #baseUrl: string;
  readonly #logger: Logger | undefined;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #apiKey: string | undefined;

  constructor(input: { serviceFoundryServerUrl: string; logger?: Logger; tls?: InternalTlsOptions; apiKey?: string }) {
    const tls = input.tls ?? { enabled: false, dir: '' };
    this.#baseUrl = normalizeInternalTlsUrl({ url: input.serviceFoundryServerUrl, enabled: tls.enabled }).replace(
      /\/+$/,
      '',
    );
    this.#dispatcher = createInternalTlsDispatcher(tls);
    this.#logger = input.logger;
    this.#apiKey = input.apiKey;
  }

  async listProviderIntegrations(accessToken: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let offset = 0;
    for (;;) {
      const payload = await this.#getJson(
        this.#url(INTEGRATIONS_PATH, {
          type: 'model',
          offset: String(offset),
          limit: String(INTEGRATIONS_PAGE_SIZE),
        }),
        accessToken,
      );
      const response = this.#parseListResponse(payload);
      const page = listPage(response);
      const total = listPaginationTotal(response);
      items.push(...page);
      if (total === undefined || items.length >= total || page.length === 0) {
        break;
      }
      offset = items.length;
    }
    return items;
  }

  listGatewayInstallations(accessToken: string): Promise<unknown> {
    return this.#getJson(this.#url(INSTALLATIONS_PATH), accessToken);
  }

  /**
   * Paginated `GET v1/mcp`. Returns raw SFY rows; callers parse with {@link mapSfyMcpServers}.
   * Offset advances by raw page length (same as {@link listProviderIntegrations}).
   */
  async listMcpServers(accessToken: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let offset = 0;
    for (;;) {
      const payload = await this.#getJson(
        this.#url(MCP_SERVERS_PATH, {
          offset: String(offset),
          limit: String(MCP_SERVERS_PAGE_SIZE),
        }),
        accessToken,
      );
      const response = this.#parseListResponse(payload);
      const page = listPage(response);
      const total = listPaginationTotal(response);
      items.push(...page);
      if (total === undefined || items.length >= total || page.length === 0) {
        break;
      }
      offset = items.length;
    }
    return items;
  }

  /**
   * Resolve one MCP server by name via list filter `name EQUAL`.
   * Returns the first raw row, or `undefined` when the tenant has no match.
   * Callers parse with {@link parseSfyMcpServerSummary}.
   */
  async getMcpServerByName(input: { accessToken: string; name: string }): Promise<unknown> {
    const filter = JSON.stringify({
      op: 'and',
      values: [{ field: 'name', op: 'EQUAL', value: input.name }],
    });
    const payload = await this.#getJson(
      this.#url(MCP_SERVERS_PATH, { filter, limit: '1', offset: '0' }),
      input.accessToken,
    );
    const rows = listPage(this.#parseListResponse(payload));
    if (rows.length > 1) {
      this.#logger?.warn('TrueFoundry ServiceFoundry MCP name filter returned multiple rows', {
        name: input.name,
        count: rows.length,
      });
    }
    return rows[0];
  }

  /**
   * `GET v1/session` for RequestContext mapping.
   * Transport / auth failures follow {@link #getJson}; schema mismatch → 502 with `{ cause }`.
   */
  async getSession(accessToken: string): Promise<GetSessionResponse> {
    const payload = await this.#getJson(this.#url(SESSION_PATH), accessToken);
    const parsed = GetSessionResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new HTTPException(502, {
        message: 'TrueFoundry ServiceFoundry session response was malformed',
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async listAuthorizedAgentIds(input: { subject: CredentialSubject; action: AgentAction }): Promise<string[]> {
    if (!isUserCredential(input.subject)) {
      throw new Error('Listing authorized agents requires a live user credential');
    }
    const payload = await this.#getJson(
      this.#url(AUTHORIZATION_PERMISSIONS_PATH, {
        resourceType: 'agent',
        v2: 'true',
      }),
      rawTokenFromCredential(input.subject.authorization),
    );
    const permissions = this.#parseAgentPermissions(payload);
    const requiredPermission = this.#permissionFor(input.action);
    return Object.entries(permissions)
      .filter(([, granted]) => granted.includes(requiredPermission))
      .map(([agentId]) => agentId);
  }

  async canAccessAgent(input: {
    subject: CredentialSubject;
    action: AgentAction;
    agent_external_id: string;
  }): Promise<boolean> {
    if (!isUserCredential(input.subject)) {
      if (input.action === 'manage') {
        return false;
      }
      try {
        await this.#vendAgentToken({
          tenant_name: input.subject.tenant_id,
          subject_id: input.subject.created_by_subject.subject_id,
          subject_type: input.subject.created_by_subject.subject_type,
          agent_external_id: input.agent_external_id,
        });
        return true;
      } catch (error) {
        if (error instanceof HTTPException && (error.status === 401 || error.status === 403 || error.status === 404)) {
          return false;
        }
        throw error;
      }
    }
    try {
      const payload = await this.#getJson(
        this.#url(AUTHORIZATION_PERMISSIONS_PATH, {
          resourceType: 'agent',
          v2: 'true',
          resourceIds: JSON.stringify([input.agent_external_id]),
        }),
        rawTokenFromCredential(input.subject.authorization),
      );
      const permissions = this.#parseAgentPermissions(payload);
      return (permissions[input.agent_external_id] ?? []).includes(this.#permissionFor(input.action));
    } catch (error) {
      if (error instanceof HTTPException && (error.status === 403 || error.status === 404)) {
        return false;
      }
      throw error;
    }
  }

  async getAgentIdentityToken(input: { subject: CredentialSubject; agent_external_id: string }): Promise<string> {
    if (isUserCredential(input.subject)) {
      const session = await this.getSession(rawTokenFromCredential(input.subject.authorization));
      return this.#vendAgentToken({
        tenant_name: session.user.tenantName,
        subject_id: session.identity.subject.id,
        subject_type: session.identity.subject.type,
        agent_external_id: input.agent_external_id,
      });
    }
    return this.#vendAgentToken({
      tenant_name: input.subject.tenant_id,
      subject_id: input.subject.created_by_subject.subject_id,
      subject_type: input.subject.created_by_subject.subject_type,
      agent_external_id: input.agent_external_id,
    });
  }

  #permissionFor(action: AgentAction): string {
    return action === 'read' ? 'READ_AGENT' : 'MANAGE_AGENT';
  }

  #parseAgentPermissions(payload: unknown): Record<string, string[]> {
    const parsed = AgentPermissionsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new HTTPException(502, {
        message: 'TrueFoundry agent authorization response was malformed',
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async #vendAgentToken(input: {
    tenant_name: string;
    subject_id: string;
    subject_type: string;
    agent_external_id: string;
  }): Promise<string> {
    if (this.#apiKey === undefined) {
      throw new Error('TRUEFOUNDRY_API_KEY is required for agent token exchange');
    }
    const payload = await this.#postJson(this.#url(VEND_TOKEN_PATH), this.#apiKey, {
      identity: {
        subject: {
          id: input.subject_id,
          type: input.subject_type,
        },
        actor: {
          id: input.agent_external_id,
          type: 'agent',
        },
        tenantName: input.tenant_name,
      },
    });
    const parsed = AgentIdentityTokenResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new HTTPException(502, {
        message: 'TrueFoundry agent token response was malformed',
        cause: parsed.error,
      });
    }
    return parsed.data.token;
  }

  #parseListResponse(payload: unknown): ListResponse {
    const parsed = ListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      this.#logger?.error('TrueFoundry ServiceFoundry server returned an unexpected list response', {
        ...extractErrorLogFields(parsed.error),
      });
      throw new HTTPException(502, {
        message: 'TrueFoundry ServiceFoundry server returned an unexpected list response',
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  #url(path: string, search?: Record<string, string>): URL {
    const url = new URL(`${this.#baseUrl}/${path}`);
    if (search) {
      for (const [key, value] of Object.entries(search)) {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  #getJson(url: URL, accessToken: string): Promise<unknown> {
    return this.#requestJson({ url, accessToken, method: 'GET', body: undefined });
  }

  #postJson(url: URL, accessToken: string, body: unknown): Promise<unknown> {
    return this.#requestJson({ url, accessToken, method: 'POST', body });
  }

  async #requestJson(input: {
    url: URL;
    accessToken: string;
    method: 'GET' | 'POST';
    body: unknown;
  }): Promise<unknown> {
    const startedAt = Date.now();
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(input.url, {
        method: input.method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.accessToken}`,
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
    } catch (error) {
      this.#logger?.warn('TrueFoundry ServiceFoundry server request failed', {
        url: input.url.href,
        durationMs: Date.now() - startedAt,
        ...extractErrorLogFields(error),
      });
      throw new HTTPException(502, {
        message: 'TrueFoundry ServiceFoundry server request failed',
        cause: error,
      });
    }
    this.#logger?.info('TrueFoundry ServiceFoundry server request completed', {
      url: input.url.href,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    if (response.status === 401 || response.status === 403) {
      throw new HTTPException(response.status, {
        message: 'TrueFoundry ServiceFoundry server rejected the request',
      });
    }
    if (!response.ok) {
      const detail = await readServiceFoundryErrorMessage(response);
      throw new HTTPException(502, {
        message: `TrueFoundry ServiceFoundry server request failed: ${detail ?? `HTTP ${String(response.status)}`}`,
      });
    }
    return response.json();
  }
}
