import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import {
  createGithubToolServer,
  isSourceToolTokenValid,
  sourceToolToken,
  sourceToolsUrl,
  type GithubRequest,
} from '../../../src/connectors/github/tools';

const ToolTextSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
});

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    number: 61,
    title: 'Mission',
    body: 'Do the thing',
    state: 'open',
    html_url: 'https://github.com/o/r/issues/61',
    labels: [{ name: 'mission' }],
    user: { login: 'aaron' },
    ...overrides,
  };
}

async function connect(github: GithubRequest) {
  const server = createGithubToolServer(github);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const parsed = ToolTextSchema.parse(await client.callTool({ name, arguments: args }));
  if (parsed.isError === true) {
    return { error: parsed.content[0]?.text };
  }
  return JSON.parse(parsed.content[0]?.text ?? 'null');
}

describe('github source tools', () => {
  test('exposes the issue tool set', async () => {
    const client = await connect(async () => null);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'add_labels',
      'create_comment',
      'create_issue',
      'get_issue',
      'list_comments',
      'list_issues',
      'list_sub_issues',
      'update_issue',
    ]);
  });

  test('create_issue with a parent creates the issue then attaches it as a sub-issue', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const client = await connect(async ({ method, path, body }) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return path.endsWith('/sub_issues') ? issue({ number: 61 }) : issue({ id: 9002, number: 62, title: 'Draft' });
    });

    const result = await callText(client, 'create_issue', {
      repository: 'o/r',
      title: 'Draft',
      body: 'AC',
      labels: ['draft'],
      parent_number: 61,
    });
    expect(result).toEqual({
      id: 9002,
      number: 62,
      title: 'Draft',
      body: 'Do the thing',
      state: 'open',
      html_url: 'https://github.com/o/r/issues/61',
      labels: ['mission'],
      author: 'aaron',
      is_pull_request: false,
      parent_number: 61,
    });
    expect(calls).toEqual([
      { method: 'POST', path: '/repos/o/r/issues', body: { title: 'Draft', body: 'AC', labels: ['draft'] } },
      { method: 'POST', path: '/repos/o/r/issues/61/sub_issues', body: { sub_issue_id: 9002 } },
    ]);
  });

  test('list_issues passes filters and drops pull requests', async () => {
    let seenPath = '';
    const client = await connect(async ({ path }) => {
      seenPath = path;
      return [issue({ number: 1 }), issue({ number: 2, pull_request: { url: 'x' } })];
    });
    const result = await callText(client, 'list_issues', { repository: 'o/r', state: 'all', labels: ['a', 'b'] });
    expect(seenPath).toBe('/repos/o/r/issues?state=all&per_page=50&labels=a%2Cb');
    expect(
      z
        .array(z.object({ number: z.number() }))
        .parse(result)
        .map(row => row.number),
    ).toEqual([1]);
  });

  test('GitHub failures come back as tool errors, not transport errors', async () => {
    const client = await connect(async () => {
      throw new Error('GitHub GET /repos/o/r/issues/5 failed with 404: Not Found');
    });
    expect(await callText(client, 'get_issue', { repository: 'o/r', number: 5 })).toEqual({
      error: 'GitHub GET /repos/o/r/issues/5 failed with 404: Not Found',
    });
  });

  test('rejects a malformed repository before calling GitHub', async () => {
    const github = jest.fn<Promise<unknown>, Parameters<GithubRequest>>(async () => null);
    const client = await connect(github);
    const result = ToolTextSchema.parse(
      await client.callTool({ name: 'get_issue', arguments: { repository: 'not-a-repo', number: 1 } }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('owner/repo');
    expect(github).not.toHaveBeenCalled();
  });
});

describe('source tool token', () => {
  test('is deterministic per source and secret, and compared in constant time', () => {
    const token = sourceToolToken({ sourceId: 'src-1', webhookSecret: 'shh' });
    expect(token).toBe(sourceToolToken({ sourceId: 'src-1', webhookSecret: 'shh' }));
    expect(token).not.toBe(sourceToolToken({ sourceId: 'src-2', webhookSecret: 'shh' }));
    expect(isSourceToolTokenValid({ presented: token, expected: token })).toBe(true);
    expect(isSourceToolTokenValid({ presented: `${token}x`, expected: token })).toBe(false);
    expect(isSourceToolTokenValid({ presented: '', expected: token })).toBe(false);
  });

  test('builds the endpoint url under the public base', () => {
    expect(sourceToolsUrl({ publicBaseUrl: 'https://forge.example/', sourceId: 'src-1' })).toBe(
      'https://forge.example/api/v1/event-sources/src-1/mcp',
    );
  });
});
