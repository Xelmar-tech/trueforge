import {
  githubConnector,
  githubEventKind,
  githubSubjectKey,
  githubSummary,
  signGithubBody,
  verifyGithubSignature,
} from '../../../src/connectors/github/webhook';
import { WebhookRejectedError } from '../../../src/connectors/types';
import type { EventSourceSecrets } from '../../../src/schemas/eventSource';

const SECRET = 'test-webhook-secret';
const secrets: EventSourceSecrets = {
  kind: 'github',
  github: { private_key: 'pem', webhook_secret: SECRET, client_secret: 'cs' },
};

const labeledPayload = {
  action: 'labeled',
  issue: { number: 61, title: 'Mission: automations', labels: [{ name: 'ready-for-planning' }] },
  label: { name: 'ready-for-planning' },
  repository: { full_name: 'xelmar-tech/dogfood' },
  sender: { login: 'aaron' },
};

async function headersFor(event: string, body: string, delivery = 'd-1'): Promise<Headers> {
  return new Headers({
    'x-github-event': event,
    'x-github-delivery': delivery,
    'x-hub-signature-256': signGithubBody(SECRET, body),
    'content-type': 'application/json',
  });
}

describe('github webhook connector', () => {
  test('normalizes issues.labeled with subject, summary and delivery id', async () => {
    const rawBody = JSON.stringify(labeledPayload);
    const event = await githubConnector.normalizeWebhook({
      headers: await headersFor('issues', rawBody),
      rawBody,
      secrets,
    });
    expect(event).toEqual({
      kind: 'issues.labeled',
      subject_key: 'xelmar-tech/dogfood#61',
      delivery_id: 'd-1',
      summary: {
        repository: 'xelmar-tech/dogfood',
        number: 61,
        title: 'Mission: automations',
        actor: 'aaron',
        label: 'ready-for-planning',
      },
      payload: labeledPayload,
    });
  });

  test('rejects a wrong signature with 401', async () => {
    const rawBody = JSON.stringify(labeledPayload);
    const headers = await headersFor('issues', rawBody);
    headers.set('x-hub-signature-256', signGithubBody('other-secret', rawBody));
    await expect(githubConnector.normalizeWebhook({ headers, rawBody, secrets })).rejects.toMatchObject({
      name: 'WebhookRejectedError',
      status: 401,
    });
  });

  test('rejects a missing signature with 401 and a pending source with 401', async () => {
    const rawBody = JSON.stringify(labeledPayload);
    const headers = await headersFor('issues', rawBody);
    headers.delete('x-hub-signature-256');
    await expect(githubConnector.normalizeWebhook({ headers, rawBody, secrets })).rejects.toBeInstanceOf(
      WebhookRejectedError,
    );
    await expect(
      githubConnector.normalizeWebhook({ headers: await headersFor('issues', rawBody), rawBody, secrets: null }),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('rejects a non-object body with 400', async () => {
    const rawBody = '[1,2]';
    await expect(
      githubConnector.normalizeWebhook({ headers: await headersFor('issues', rawBody), rawBody, secrets }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('treats ping as a valid delivery with no event', async () => {
    const rawBody = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 });
    await expect(
      githubConnector.normalizeWebhook({ headers: await headersFor('ping', rawBody), rawBody, secrets }),
    ).resolves.toBeNull();
  });

  test('subject keys for pull requests, check suites, pushes and installations', () => {
    const repo = { full_name: 'o/r' };
    expect(githubSubjectKey('pull_request', { repository: repo, pull_request: { number: 7 } })).toBe('o/r#7');
    expect(githubSubjectKey('check_suite', { repository: repo, check_suite: { head_sha: 'abc' } })).toBe('o/r@abc');
    expect(githubSubjectKey('push', { repository: repo, ref: 'refs/heads/main' })).toBe('o/r:refs/heads/main');
    expect(githubSubjectKey('installation', { installation: { id: 42 } })).toBe('installation:42');
    expect(githubSubjectKey('meta', {})).toBe('meta');
  });

  test('signature verification is exact and constant-length safe', () => {
    const body = '{"a":1}';
    const signature = signGithubBody('s', body);
    expect(signature.startsWith('sha256=')).toBe(true);
    expect(verifyGithubSignature('s', body, signature)).toBe(true);
    expect(verifyGithubSignature('s', body, 'sha256=00')).toBe(false);
    expect(verifyGithubSignature('other', body, signature)).toBe(false);
  });

  test('event kind carries the action when present', () => {
    expect(githubEventKind('issues', { action: 'opened' })).toBe('issues.opened');
    expect(githubEventKind('push', {})).toBe('push');
  });

  test('summary tolerates missing fields', () => {
    expect(githubSummary({})).toEqual({ repository: null, number: null, title: null, actor: null, label: null });
  });
});
