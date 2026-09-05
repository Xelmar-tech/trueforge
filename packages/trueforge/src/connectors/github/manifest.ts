/**
 * GitHub App manifest flow: the browser POSTs a manifest to GitHub, GitHub creates the
 * App and redirects back with a one-time code, and we exchange that code for the App's
 * credentials. Nothing is copied by hand.
 * https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
import { z } from 'zod';
import type { GithubAppConfig, GithubSourceSecrets } from '../../schemas/eventSource';
import type { JsonObject } from '../types';

export const GITHUB_MANIFEST_CONVERSION_URL = 'https://api.github.com/app-manifests';

/** Repository permissions and webhook events every source App asks for. */
export const GITHUB_APP_PERMISSIONS = {
  issues: 'write',
  pull_requests: 'write',
  contents: 'write',
  checks: 'read',
  metadata: 'read',
} as const;

export const GITHUB_APP_EVENTS = [
  'issues',
  'issue_comment',
  'label',
  'pull_request',
  'pull_request_review',
  'check_suite',
  'push',
] as const;

export function githubWebhookUrl(input: { publicBaseUrl: string; sourceId: string }): string {
  return `${input.publicBaseUrl}/api/v1/webhooks/${encodeURIComponent(input.sourceId)}`;
}

export function githubManifestCallbackUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl}/api/v1/event-sources/github/callback`;
}

export function buildGithubAppManifest(input: {
  appName: string;
  publicBaseUrl: string;
  sourceId: string;
}): JsonObject {
  return {
    name: input.appName,
    url: input.publicBaseUrl,
    hook_attributes: {
      url: githubWebhookUrl(input),
      active: true,
    },
    redirect_url: githubManifestCallbackUrl(input.publicBaseUrl),
    public: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: [...GITHUB_APP_EVENTS],
  };
}

/** Where the browser POSTs the manifest form. `state` comes back on the callback. */
export function githubManifestActionUrl(input: { owner: string | undefined; state: string }): string {
  const base =
    input.owner === undefined
      ? 'https://github.com/settings/apps/new'
      : `https://github.com/organizations/${encodeURIComponent(input.owner)}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(input.state)}`;
}

const ConversionResponseSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().min(1),
  html_url: z.url(),
  owner: z
    .object({ login: z.string().min(1) })
    .nullable()
    .optional(),
});

/** The code was rejected by GitHub (expired, reused, or unknown). */
export class GithubManifestExchangeError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GithubManifestExchangeError';
    this.status = status;
  }
}

export interface GithubManifestConversion {
  app: GithubAppConfig;
  secrets: GithubSourceSecrets;
}

/** Exchanges the one-time manifest `code` for the App credentials. Codes expire after one hour. */
export async function exchangeGithubManifestCode(input: {
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<GithubManifestConversion> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${GITHUB_MANIFEST_CONVERSION_URL}/${encodeURIComponent(input.code)}/conversions`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new GithubManifestExchangeError(
      `GitHub rejected the manifest code (HTTP ${String(response.status)})`,
      response.status,
    );
  }
  const parsed = ConversionResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new GithubManifestExchangeError('GitHub manifest conversion response had an unexpected shape', 502, {
      cause: parsed.error,
    });
  }
  const body = parsed.data;
  return {
    app: {
      app_id: body.id,
      app_slug: body.slug,
      client_id: body.client_id,
      html_url: body.html_url,
      owner: body.owner?.login ?? null,
    },
    secrets: {
      private_key: body.pem,
      webhook_secret: body.webhook_secret,
      client_secret: body.client_secret,
    },
  };
}
