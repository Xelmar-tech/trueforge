import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventSummary } from '../../schemas/event';
import { WebhookRejectedError, type JsonObject, type NormalizedEvent, type SourceConnector } from '../types';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const EVENT_HEADER = 'x-github-event';
const DELIVERY_HEADER = 'x-github-delivery';

/** `sha256=<hex>` over the raw body, as GitHub computes it. */
export function signGithubBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifyGithubSignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = Buffer.from(signGithubBody(secret, rawBody));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(object: JsonObject | undefined, key: string): string | null {
  const value = object?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(object: JsonObject | undefined, key: string): number | null {
  const value = object?.[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function objectField(object: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = object?.[key];
  return isObject(value) ? value : undefined;
}

/**
 * The subject an event is about, as one stable string. Issues and pull requests
 * share the repository number space on GitHub, so `owner/repo#N` names both.
 */
export function githubSubjectKey(event: string, payload: JsonObject): string {
  const repository = stringField(objectField(payload, 'repository'), 'full_name');
  const issue = objectField(payload, 'issue');
  const pullRequest = objectField(payload, 'pull_request');
  const number = numberField(issue, 'number') ?? numberField(pullRequest, 'number');
  if (repository !== null && number !== null) {
    return `${repository}#${String(number)}`;
  }
  if (repository !== null && event === 'check_suite') {
    const headSha = stringField(objectField(payload, 'check_suite'), 'head_sha');
    if (headSha !== null) {
      return `${repository}@${headSha}`;
    }
  }
  if (repository !== null && event === 'push') {
    const ref = stringField(payload, 'ref');
    if (ref !== null) {
      return `${repository}:${ref}`;
    }
  }
  if (repository !== null) {
    return repository;
  }
  const installation = objectField(payload, 'installation');
  const installationId = numberField(installation, 'id');
  if (installationId !== null) {
    return `installation:${String(installationId)}`;
  }
  return event;
}

export function githubSummary(payload: JsonObject): EventSummary {
  const issue = objectField(payload, 'issue');
  const pullRequest = objectField(payload, 'pull_request');
  const headCommit = objectField(payload, 'head_commit');
  return {
    repository: stringField(objectField(payload, 'repository'), 'full_name'),
    number: numberField(issue, 'number') ?? numberField(pullRequest, 'number'),
    title: stringField(issue, 'title') ?? stringField(pullRequest, 'title') ?? stringField(headCommit, 'message'),
    actor: stringField(objectField(payload, 'sender'), 'login'),
    label: stringField(objectField(payload, 'label'), 'name'),
  };
}

/** `issues.labeled` when the payload carries an action, otherwise the bare event name. */
export function githubEventKind(event: string, payload: JsonObject): string {
  const action = stringField(payload, 'action');
  return action === null ? event : `${event}.${action}`;
}

type NormalizeInput = Parameters<SourceConnector['normalizeWebhook']>[0];

/** Synchronous body of {@link githubConnector.normalizeWebhook}; throws {@link WebhookRejectedError}. */
export function normalizeGithubWebhook({ headers, rawBody, secrets }: NormalizeInput): NormalizedEvent | null {
  if (secrets?.kind !== 'github') {
    throw new WebhookRejectedError('Source has no GitHub credentials yet', 401);
  }
  const signature = headers.get(SIGNATURE_HEADER);
  if (signature === null) {
    throw new WebhookRejectedError(`Missing ${SIGNATURE_HEADER} header`, 401);
  }
  if (!verifyGithubSignature(secrets.github.webhook_secret, rawBody, signature)) {
    throw new WebhookRejectedError('Webhook signature did not verify', 401);
  }

  const event = headers.get(EVENT_HEADER);
  const deliveryId = headers.get(DELIVERY_HEADER);
  if (event === null || deliveryId === null) {
    throw new WebhookRejectedError(`Missing ${EVENT_HEADER} or ${DELIVERY_HEADER} header`, 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    throw new WebhookRejectedError('Webhook body is not JSON', 400, { cause: error });
  }
  if (!isObject(parsed)) {
    throw new WebhookRejectedError('Webhook body is not a JSON object', 400);
  }

  // GitHub sends `ping` once when the webhook is created; it verifies the secret and nothing else.
  if (event === 'ping') {
    return null;
  }

  return {
    kind: githubEventKind(event, parsed),
    subject_key: githubSubjectKey(event, parsed),
    delivery_id: deliveryId,
    summary: githubSummary(parsed),
    payload: parsed,
  };
}

export const githubConnector: SourceConnector = {
  kind: 'github',
  normalizeWebhook: input => Promise.resolve().then(() => normalizeGithubWebhook(input)),
};
