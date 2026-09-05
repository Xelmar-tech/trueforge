/**
 * Event ledger route definitions (mounted at /api/v1/events).
 * Handlers are registered in apis/events.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { PAGE_LIMIT } from '../schemas/common';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetEventResponseSchema, ListEventsResponseSchema } from '../schemas/event';
import { TOKEN_PAGINATION } from './fernExtensions';
import { OpenApiTag } from './openapiTags';

export const EventIdParamsSchema = z.object({
  event_id: z.string().min(1).max(64).describe('Immutable event identifier.'),
});

export const ListEventsQuerySchema = z
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
    source_id: z.string().min(1).optional().describe('Only events from this source.'),
    kind: z.string().min(1).optional().describe('Only events of this connector kind, e.g. `issues.labeled`.'),
    subject_key: z.string().min(1).optional().describe('Only events about this subject, e.g. `owner/repo#61`.'),
    since: z.iso.datetime().optional().describe('Only events received at or after this instant.'),
  })
  .openapi('ListEventsQuery');

export const listEventsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.EVENTS],
  summary: 'List events',
  description: 'List received events, newest first, without payloads. Filter by source, kind, subject, or time.',
  'x-fern-sdk-group-name': ['events'],
  'x-fern-sdk-method-name': 'list',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { query: ListEventsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListEventsResponseSchema } },
      description: 'Paginated matching events.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters or page token.',
    },
  },
});

export const getEventRoute = createRoute({
  method: 'get',
  path: '/{event_id}',
  tags: [OpenApiTag.EVENTS],
  summary: 'Get an event',
  description: 'Fetch one event with its full provider payload.',
  'x-fern-sdk-group-name': ['events'],
  'x-fern-sdk-method-name': 'get',
  request: { params: EventIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetEventResponseSchema } },
      description: 'The event with payload.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Not found.',
    },
  },
});
