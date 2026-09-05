import { z } from '@hono/zod-openapi';
import { TokenPaginationSchema } from '@truefoundry/trueforge-core/agent-session';
import { EventSourceKindSchema } from './eventSource';

/**
 * The few fields a person needs to recognize an event in a list. Computed by the
 * connector at ingest so listings never load the payload.
 */
export const EventSummarySchema = z
  .object({
    repository: z.string().nullable().describe('`owner/repo` when the event belongs to a repository.'),
    number: z.number().int().nullable().describe('Issue or pull request number when applicable.'),
    title: z.string().nullable().describe('Issue, pull request, or commit title when applicable.'),
    actor: z.string().nullable().describe('Login of the user or App that caused the event.'),
    label: z.string().nullable().describe('Label name for label events.'),
  })
  .strict()
  .openapi('EventSummary');

/** Wire ISO-8601 instant. */
const IsoTimestamp = z.iso.datetime().openapi({ type: 'string', format: 'date-time' });
const NullableIsoTimestamp = z.iso
  .datetime()
  .nullable()
  .openapi({ type: ['string', 'null'], format: 'date-time' });

export const EventSchema = z
  .object({
    id: z.string(),
    source_id: z.string(),
    source_kind: EventSourceKindSchema,
    kind: z.string().describe('Connector event kind, e.g. `issues.labeled`.'),
    subject_key: z.string().describe('Stable key of the thing the event is about, e.g. `owner/repo#61`.'),
    delivery_id: z.string().describe('Provider delivery id; unique per source.'),
    summary: EventSummarySchema,
    received_at: IsoTimestamp,
    routed_at: NullableIsoTimestamp.describe('When the coalesce loop matched this event against automations.'),
  })
  .strict()
  .openapi('Event');

/** One event with its full provider payload. */
export const EventDetailSchema = EventSchema.extend({
  payload: z.record(z.string(), z.unknown()).describe('Raw provider payload as delivered.'),
})
  .strict()
  .openapi('EventDetail');

export const ListEventsResponseSchema = z
  .object({
    data: z.array(EventSchema),
    pagination: TokenPaginationSchema,
  })
  .openapi('ListEventsResponse');

export const GetEventResponseSchema = z.object({ data: EventDetailSchema }).openapi('GetEventResponse');

export type EventSummary = z.infer<typeof EventSummarySchema>;
export type Event = z.infer<typeof EventSchema>;
export type EventDetail = z.infer<typeof EventDetailSchema>;
