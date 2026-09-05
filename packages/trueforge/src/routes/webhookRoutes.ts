/**
 * Webhook ingress (mounted at /api/v1/webhooks, before auth). Handlers are registered in
 * apis/webhooks.ts. Providers call this; the SDK never does.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

export const WebhookSourceParamsSchema = z.object({
  source_id: z.string().min(1).max(64).describe('Event source the provider was configured with.'),
});

export const WebhookAcceptedSchema = z
  .object({
    event_id: z.string().nullable().describe('Ledger id of the event; null when the delivery carried no event.'),
    created: z.boolean().describe('False when this delivery id had already been recorded.'),
  })
  .strict()
  .openapi('WebhookAccepted');

export const receiveWebhookRoute = createRoute({
  method: 'post',
  path: '/{source_id}',
  tags: [OpenApiTag.EVENTS],
  summary: 'Receive a provider webhook',
  description:
    'Verifies the delivery signature against the source secret and records the event. Providers call this URL; it is not part of the SDK.',
  'x-fern-ignore': true,
  'x-excluded': true,
  request: { params: WebhookSourceParamsSchema },
  responses: {
    202: {
      content: { 'application/json': { schema: WebhookAcceptedSchema } },
      description: 'Delivery verified and recorded (or already recorded).',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Malformed delivery.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Signature missing or invalid.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unknown source.',
    },
  },
});
