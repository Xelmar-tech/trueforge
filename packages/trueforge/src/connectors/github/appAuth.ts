/**
 * GitHub App authentication: a short-lived RS256 JWT for the App itself, exchanged for a
 * per-installation access token. `node:crypto` only — the octokit packages are ESM-only and
 * the whole flow is two requests.
 */
import { createSign } from 'node:crypto';
import { z } from 'zod';

export const GITHUB_API_BASE_URL = 'https://api.github.com';

export interface GithubAppCredentials {
  app_id: number;
  /** PEM private key as returned by the manifest conversion. */
  private_key: string;
}

export class GithubApiError extends Error {
  readonly status: number;
  constructor(input: { method: string; path: string; status: number; body: string }) {
    super(`GitHub ${input.method} ${input.path} failed with ${String(input.status)}: ${input.body.slice(0, 300)}`);
    this.name = 'GithubApiError';
    this.status = input.status;
  }
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** App JWT valid for nine minutes, back-dated a minute for clock skew (GitHub's documented recipe). */
export function githubAppJwt(credentials: GithubAppCredentials, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: String(credentials.app_id) }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(credentials.private_key, 'base64url');
  return `${header}.${payload}.${signature}`;
}

const InstallationSchema = z.object({ id: z.number().int() });
const AccessTokenSchema = z.object({ token: z.string().min(1), expires_at: z.string().min(1) });

export const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
} as const;

export async function githubJson(input: {
  fetchImpl: typeof fetch;
  apiBaseUrl: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  token: string;
  body?: unknown;
}): Promise<unknown> {
  const response = await input.fetchImpl(`${input.apiBaseUrl}${input.path}`, {
    method: input.method,
    headers: {
      ...GITHUB_HEADERS,
      authorization: `Bearer ${input.token}`,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new GithubApiError({ method: input.method, path: input.path, status: response.status, body: text });
  }
  return text.length === 0 ? null : JSON.parse(text);
}

/** Refresh an installation token this long before GitHub expires it (they last one hour). */
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface InstallationTokenMinter {
  /** Installation token for `owner/repo`; cached per repository until close to expiry. */
  tokenFor(repository: string): Promise<string>;
}

export function createInstallationTokenMinter(input: {
  credentials: GithubAppCredentials;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => number;
}): InstallationTokenMinter {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiBaseUrl = input.apiBaseUrl ?? GITHUB_API_BASE_URL;
  const now = input.now ?? Date.now;
  const cache = new Map<string, { token: string; expires_at_ms: number }>();

  return {
    async tokenFor(repository) {
      const cached = cache.get(repository);
      if (cached !== undefined && cached.expires_at_ms - now() > TOKEN_REFRESH_MARGIN_MS) {
        return cached.token;
      }
      const jwt = githubAppJwt(input.credentials, Math.floor(now() / 1000));
      const installation = InstallationSchema.parse(
        await githubJson({
          fetchImpl,
          apiBaseUrl,
          method: 'GET',
          path: `/repos/${repository}/installation`,
          token: jwt,
        }),
      );
      const minted = AccessTokenSchema.parse(
        await githubJson({
          fetchImpl,
          apiBaseUrl,
          method: 'POST',
          path: `/app/installations/${String(installation.id)}/access_tokens`,
          token: jwt,
        }),
      );
      cache.set(repository, { token: minted.token, expires_at_ms: Date.parse(minted.expires_at) });
      return minted.token;
    },
  };
}
