/**
 * GitHub tools an agent uses as the App behind a source: a small MCP server over the issue
 * endpoints the Factory needs. Every call carries an installation token, so nothing an agent
 * does is attributed to a human account.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { githubJson, type InstallationTokenMinter } from './appAuth';

/** One authenticated GitHub REST call for `repository`; the closure supplies the token. */
export type GithubRequest = (input: {
  repository: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}) => Promise<unknown>;

export function githubRequestWithMinter(input: {
  minter: InstallationTokenMinter;
  fetchImpl: typeof fetch;
  apiBaseUrl: string;
}): GithubRequest {
  return async ({ repository, method, path, body }) =>
    githubJson({
      fetchImpl: input.fetchImpl,
      apiBaseUrl: input.apiBaseUrl,
      method,
      path,
      token: await input.minter.tokenFor(repository),
      ...(body === undefined ? {} : { body }),
    });
}

/** Bearer token the built-in connector presents; derived so it never needs storing. */
export function sourceToolToken(input: { sourceId: string; webhookSecret: string }): string {
  return createHmac('sha256', input.webhookSecret).update(`source-tools:${input.sourceId}`).digest('base64url');
}

export function isSourceToolTokenValid(input: { presented: string; expected: string }): boolean {
  const presented = Buffer.from(input.presented);
  const expected = Buffer.from(input.expected);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function sourceToolsUrl(input: { publicBaseUrl: string; sourceId: string }): string {
  return `${input.publicBaseUrl.replace(/\/$/, '')}/api/v1/event-sources/${input.sourceId}/mcp`;
}

const RepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repo')
  .describe('Repository as owner/repo.');
const IssueNumberSchema = z.number().int().positive().describe('Issue number.');

const GithubIssueSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  html_url: z.string(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  user: z.object({ login: z.string() }).nullable().optional(),
  pull_request: z.unknown().optional(),
});
const GithubCommentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
  created_at: z.string(),
});

/** The fields an agent needs; the raw GitHub issue is ~100 keys of noise. */
function compactIssue(raw: unknown) {
  const issue = GithubIssueSchema.parse(raw);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    html_url: issue.html_url,
    labels: issue.labels.map(label => label.name),
    author: issue.user?.login ?? null,
    is_pull_request: issue.pull_request !== undefined,
  };
}

function compactComment(raw: unknown) {
  const comment = GithubCommentSchema.parse(raw);
  return {
    id: comment.id,
    body: comment.body ?? '',
    author: comment.user?.login ?? null,
    created_at: comment.created_at,
  };
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

/** Wraps a tool body so GitHub failures come back as tool errors the model can read. */
function guarded<Input>(run: (input: Input) => Promise<unknown>) {
  return async (input: Input) => {
    try {
      return textResult(await run(input));
    } catch (error) {
      return errorResult(error);
    }
  };
}

const LabelsSchema = z.array(z.string().min(1)).describe('Label names.');

export function createGithubToolServer(github: GithubRequest): McpServer {
  const server = new McpServer({ name: 'github-source-tools', version: '1.0.0' });

  server.registerTool(
    'get_issue',
    {
      description: 'Read one issue: title, body, state, labels.',
      inputSchema: { repository: RepositorySchema, number: IssueNumberSchema },
    },
    guarded(async ({ repository, number }) =>
      compactIssue(await github({ repository, method: 'GET', path: `/repos/${repository}/issues/${String(number)}` })),
    ),
  );

  server.registerTool(
    'list_issues',
    {
      description: 'List issues (pull requests excluded), newest first, up to 50.',
      inputSchema: {
        repository: RepositorySchema,
        state: z.enum(['open', 'closed', 'all']).default('open'),
        labels: LabelsSchema.optional().describe('Only issues carrying every one of these labels.'),
      },
    },
    guarded(async ({ repository, state, labels }) => {
      const query = new URLSearchParams({ state, per_page: '50' });
      if (labels !== undefined && labels.length > 0) {
        query.set('labels', labels.join(','));
      }
      const rows = z
        .array(z.unknown())
        .parse(await github({ repository, method: 'GET', path: `/repos/${repository}/issues?${query.toString()}` }));
      return rows.map(compactIssue).filter(issue => !issue.is_pull_request);
    }),
  );

  server.registerTool(
    'create_issue',
    {
      description: 'Create an issue. With parent_number, it is also attached as a sub-issue of that parent.',
      inputSchema: {
        repository: RepositorySchema,
        title: z.string().min(1),
        body: z.string().optional(),
        labels: LabelsSchema.optional(),
        parent_number: IssueNumberSchema.optional().describe('Parent issue to attach the new issue under.'),
      },
    },
    guarded(async ({ repository, title, body, labels, parent_number }) => {
      const created = compactIssue(
        await github({
          repository,
          method: 'POST',
          path: `/repos/${repository}/issues`,
          body: { title, ...(body === undefined ? {} : { body }), ...(labels === undefined ? {} : { labels }) },
        }),
      );
      if (parent_number !== undefined) {
        await github({
          repository,
          method: 'POST',
          path: `/repos/${repository}/issues/${String(parent_number)}/sub_issues`,
          body: { sub_issue_id: created.id },
        });
      }
      return { ...created, parent_number: parent_number ?? null };
    }),
  );

  server.registerTool(
    'update_issue',
    {
      description: 'Change title, body, state or labels of an issue. Labels given here replace the current set.',
      inputSchema: {
        repository: RepositorySchema,
        number: IssueNumberSchema,
        title: z.string().min(1).optional(),
        body: z.string().optional(),
        state: z.enum(['open', 'closed']).optional(),
        labels: LabelsSchema.optional(),
      },
    },
    guarded(async ({ repository, number, ...patch }) =>
      compactIssue(
        await github({
          repository,
          method: 'PATCH',
          path: `/repos/${repository}/issues/${String(number)}`,
          body: patch,
        }),
      ),
    ),
  );

  server.registerTool(
    'add_labels',
    {
      description: 'Add labels to an issue, keeping the ones it has.',
      inputSchema: { repository: RepositorySchema, number: IssueNumberSchema, labels: LabelsSchema.min(1) },
    },
    guarded(async ({ repository, number, labels }) => {
      const rows = z.array(z.object({ name: z.string() })).parse(
        await github({
          repository,
          method: 'POST',
          path: `/repos/${repository}/issues/${String(number)}/labels`,
          body: { labels },
        }),
      );
      return { number, labels: rows.map(row => row.name) };
    }),
  );

  server.registerTool(
    'create_comment',
    {
      description: 'Comment on an issue.',
      inputSchema: { repository: RepositorySchema, number: IssueNumberSchema, body: z.string().min(1) },
    },
    guarded(async ({ repository, number, body }) =>
      compactComment(
        await github({
          repository,
          method: 'POST',
          path: `/repos/${repository}/issues/${String(number)}/comments`,
          body: { body },
        }),
      ),
    ),
  );

  server.registerTool(
    'list_comments',
    {
      description: 'Comments on an issue, oldest first, up to 50.',
      inputSchema: { repository: RepositorySchema, number: IssueNumberSchema },
    },
    guarded(async ({ repository, number }) =>
      z
        .array(z.unknown())
        .parse(
          await github({
            repository,
            method: 'GET',
            path: `/repos/${repository}/issues/${String(number)}/comments?per_page=50`,
          }),
        )
        .map(compactComment),
    ),
  );

  server.registerTool(
    'list_sub_issues',
    {
      description: 'Sub-issues attached to an issue.',
      inputSchema: { repository: RepositorySchema, number: IssueNumberSchema },
    },
    guarded(async ({ repository, number }) =>
      z
        .array(z.unknown())
        .parse(
          await github({
            repository,
            method: 'GET',
            path: `/repos/${repository}/issues/${String(number)}/sub_issues?per_page=50`,
          }),
        )
        .map(compactIssue),
    ),
  );

  return server;
}
