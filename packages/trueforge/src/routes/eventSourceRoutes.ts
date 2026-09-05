/**
 * Event source route definitions (mounted at /api/v1/event-sources, admin only) plus the
 * public GitHub manifest callback (mounted at /api/v1/event-sources/github, before auth).
 * Handlers are registered in apis/eventSources.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CreateGithubManifestRequestSchema,
  CreateGithubManifestResponseSchema,
  DeleteEventSourceResponseSchema,
  GetEventSourceResponseSchema,
  ListEventSourcesResponseSchema,
} from '../schemas/eventSource';
import { OpenApiTag } from './openapiTags';

export const EventSourceIdParamsSchema = z.object({
  source_id: z.string().min(1).max(64).describe('Immutable event source identifier.'),
});

export const listEventSourcesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.EVENT_SOURCES],
  summary: 'List event sources',
  description: 'List the connected event sources for the tenant, newest first. Credentials are never returned.',
  'x-fern-sdk-group-name': ['event_sources'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListEventSourcesResponseSchema } },
      description: 'Connected event sources.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unauthenticated.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin role required.',
    },
  },
});

export const getEventSourceRoute = createRoute({
  method: 'get',
  path: '/{source_id}',
  tags: [OpenApiTag.EVENT_SOURCES],
  summary: 'Get an event source',
  description: 'Fetch one event source by id. Credentials are never returned.',
  'x-fern-sdk-group-name': ['event_sources'],
  'x-fern-sdk-method-name': 'get',
  request: { params: EventSourceIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetEventSourceResponseSchema } },
      description: 'The event source.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Not found.',
    },
  },
});

export const deleteEventSourceRoute = createRoute({
  method: 'delete',
  path: '/{source_id}',
  tags: [OpenApiTag.EVENT_SOURCES],
  summary: 'Delete an event source',
  description: 'Delete an event source and every event it received. The GitHub App itself is not deleted.',
  'x-fern-sdk-group-name': ['event_sources'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: EventSourceIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteEventSourceResponseSchema } },
      description: 'Deleted, or already absent.',
    },
  },
});

export const createGithubManifestRoute = createRoute({
  method: 'post',
  path: '/github/manifest',
  tags: [OpenApiTag.EVENT_SOURCES],
  summary: 'Start the GitHub App manifest flow',
  description:
    'Create a pending GitHub event source and return the App manifest the browser must POST to GitHub. GitHub redirects back to the callback, which stores the created App.',
  'x-fern-sdk-group-name': ['event_sources'],
  'x-fern-sdk-method-name': 'create_github_manifest',
  request: {
    body: {
      content: { 'application/json': { schema: CreateGithubManifestRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: CreateGithubManifestResponseSchema } },
      description: 'Pending source created; POST `manifest` to `action_url`.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request, or the server has no public base URL to receive webhooks on.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'An event source with this name already exists.',
    },
  },
});

export const GithubManifestCallbackQuerySchema = z.object({
  code: z.string().min(1).describe('One-time code issued by GitHub after the App was created.'),
  state: z.string().min(1).describe('The `state` returned by the manifest start call.'),
});

export const githubManifestCallbackRoute = createRoute({
  method: 'get',
  path: '/callback',
  tags: [OpenApiTag.EVENT_SOURCES],
  summary: 'GitHub App manifest callback',
  description:
    'Browser redirect target after GitHub creates the App. Exchanges `code` for the App credentials and redirects to Settings. Not called by the SDK — browsers hit this URL directly.',
  'x-fern-ignore': true,
  'x-excluded': true,
  request: { query: GithubManifestCallbackQuerySchema },
  responses: {
    302: {
      description: 'Redirect to Settings with `isSuccess` (and `reason` when it failed) appended.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unknown or expired `state`, or GitHub rejected the code.',
    },
  },
});
