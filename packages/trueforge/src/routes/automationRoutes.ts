/**
 * Automation route definitions (mounted at /api/v1/automations).
 * Handlers are registered in apis/automations.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateAutomationRequestSchema,
  DeleteAutomationResponseSchema,
  GetAutomationResponseSchema,
  ListAutomationRunsResponseSchema,
  ListAutomationsResponseSchema,
  ReplayAutomationRequestSchema,
  ReplayAutomationResponseSchema,
  UpdateAutomationRequestSchema,
} from '../schemas/automation';
import { NameSchema, PAGE_LIMIT, parseCommaSeparatedQuery } from '../schemas/common';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { TOKEN_PAGINATION } from './fernExtensions';
import { OpenApiTag } from './openapiTags';

export const AutomationIdParamsSchema = z.object({
  automation_id: z.string().min(1).max(64).describe('Immutable automation identifier.'),
});

export const ListAutomationsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGE_LIMIT)
      .optional()
      .default(PAGE_LIMIT)
      .describe(`Page size. Defaults to ${String(PAGE_LIMIT)}`),
    page_token: z.string().optional().describe('Opaque token from a previous response `next_page_token`.'),
    agent_names: z
      .string()
      .optional()
      .openapi({
        type: 'string',
        description: 'Filter by one or more agent names (comma-separated). When set, at least one name is required.',
      })
      .transform(value => parseCommaSeparatedQuery(value))
      .pipe(z.array(NameSchema).min(1).optional()),
  })
  .openapi('ListAutomationsQuery');

const NOT_FOUND = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'Not found.',
};
const FORBIDDEN = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'The caller is not the automation creator.',
};

export const listAutomationsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.AUTOMATIONS],
  summary: 'List automations',
  description: 'List automations for the tenant, newest first. Optionally filter by `agent_names`.',
  'x-fern-sdk-group-name': ['automations'],
  'x-fern-sdk-method-name': 'list',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { query: ListAutomationsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListAutomationsResponseSchema } },
      description: 'Paginated matching automations.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters or page token.',
    },
  },
});

export const createAutomationRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.AUTOMATIONS],
  summary: 'Create an automation',
  description:
    'Bind an agent to an event trigger. The automation starts in the mode its manifest declares (shadow by default).',
  'x-fern-sdk-group-name': ['automations'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: { content: { 'application/json': { schema: CreateAutomationRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetAutomationResponseSchema } },
      description: 'Created.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid manifest, or the trigger names an unknown event source.',
    },
    404: { ...NOT_FOUND, description: 'The agent does not exist or is not accessible.' },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'An automation with this name already exists.',
    },
  },
});

export const getAutomationRoute = createRoute({
  method: 'get',
  path: '/{automation_id}',
  tags: [OpenApiTag.AUTOMATIONS],
  summary: 'Get an automation',
  description: 'Fetch one automation by id.',
  'x-fern-sdk-group-name': ['automations'],
  'x-fern-sdk-method-name': 'get',
  request: { params: AutomationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetAutomationResponseSchema } },
      description: 'The automation.',
    },
    403: FORBIDDEN,
    404: NOT_FOUND,
  },
});

export const putAutomationRoute = createRoute({
  method: 'put',
  path: '/{automation_id}',
  tags: [OpenApiTag.AUTOMATIONS],
  summary: 'Replace an automation',
  description: 'Replace the name and manifest. Open coalesce windows keep their original settings.',
  'x-fern-sdk-group-name': ['automations'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: AutomationIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateAutomationRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetAutomationResponseSchema } },
      description: 'Updated.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid manifest, or the trigger names an unknown event source.',
    },
    403: FORBIDDEN,
    404: NOT_FOUND,
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'An automation with this name already exists.',
    },
  },
});

export const deleteAutomationRoute = createRoute({
  method: 'delete',
  path: '/{automation_id}',
  tags: [OpenApiTag.AUTOMATIONS],
  summary: 'Delete an automation',
  description: 'Delete an automation and its run history. Sessions already started keep running.',
  'x-fern-sdk-group-name': ['automations'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: AutomationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteAutomationResponseSchema } },
      description: 'Deleted, or already absent.',
    },
    403: FORBIDDEN,
  },
});

export const listAutomationRunsRoute = createRoute({
  method: 'get',
  path: '/{automation_id}/runs',
  tags: [OpenApiTag.AUTOMATIONS],
  summary: 'List runs of an automation',
  description: 'Runs of one automation, newest first: open coalesce windows and finished runs alike.',
  'x-fern-sdk-group-name': ['automations'],
  'x-fern-sdk-method-name': 'list_runs',
  request: { params: AutomationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListAutomationRunsResponseSchema } },
      description: 'Runs of the automation.',
    },
    403: FORBIDDEN,
    404: NOT_FOUND,
  },
});

export const replayAutomationRoute = createRoute({
  method: 'post',
  path: '/{automation_id}/replay',
  tags: [OpenApiTag.AUTOMATIONS],
  summary: 'Replay a recorded event',
  description:
    'Run the automation against one recorded event in shadow mode: the agent pauses before its first gated tool call and nothing is written. Returns the run, which the dispatch loop picks up immediately.',
  'x-fern-sdk-group-name': ['automations'],
  'x-fern-sdk-method-name': 'replay',
  request: {
    params: AutomationIdParamsSchema,
    body: { content: { 'application/json': { schema: ReplayAutomationRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: ReplayAutomationResponseSchema } },
      description: 'Replay run created.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The event belongs to another source or kind than the trigger.',
    },
    403: FORBIDDEN,
    404: { ...NOT_FOUND, description: 'Automation or event not found.' },
  },
});
