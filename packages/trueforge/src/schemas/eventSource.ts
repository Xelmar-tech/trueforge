import { z } from '@hono/zod-openapi';
import { CreatedBySubjectSchema } from '@truefoundry/trueforge-core/agent-session';
import { NameSchema } from './common';

/** `trueforge` is the per-tenant internal source that automations emit into; it accepts no webhooks. */
export const EventSourceKindSchema = z.enum(['github', 'trueforge']).openapi('EventSourceKind');

export const INTERNAL_SOURCE_NAME = 'trueforge';

/**
 * - `pending`  created, waiting for the GitHub App manifest callback
 * - `active`   credentials stored; webhooks are accepted
 * - `error`    the last delivery or credential refresh failed
 */
export const EventSourceStatusSchema = z.enum(['pending', 'active', 'error']).openapi('EventSourceStatus');

/** Public identity of the GitHub App behind a source. Secrets never travel on the wire. */
export const GithubAppConfigSchema = z
  .object({
    app_id: z.number().int().positive().describe('GitHub App id.'),
    app_slug: z.string().min(1).describe('GitHub App URL slug.'),
    client_id: z.string().min(1).describe('GitHub App OAuth client id.'),
    html_url: z.url().describe('Settings page of the App on GitHub.'),
    owner: z.string().min(1).nullable().describe('Login of the org or user that owns the App.'),
  })
  .strict()
  .openapi('GithubAppConfig');

/**
 * Source document persisted as `event_source.manifest`. `app` is null until the
 * manifest callback stores the created App.
 */
export const EventSourceManifestSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('github'),
        app: GithubAppConfigSchema.nullable(),
      })
      .strict(),
    z.object({ kind: z.literal('trueforge') }).strict(),
  ])
  .openapi('EventSourceManifest');

/** Persisted as `event_source.secrets`; read only by the server. */
export const GithubSourceSecretsSchema = z
  .object({
    private_key: z.string().min(1),
    webhook_secret: z.string().min(1),
    client_secret: z.string().min(1),
  })
  .strict();

export const EventSourceSecretsSchema = z
  .discriminatedUnion('kind', [z.object({ kind: z.literal('github'), github: GithubSourceSecretsSchema }).strict()])
  .nullable();

/** Wire ISO-8601 instant. */
const IsoTimestamp = z.iso.datetime().openapi({ type: 'string', format: 'date-time' });
const NullableIsoTimestamp = z.iso
  .datetime()
  .nullable()
  .openapi({ type: ['string', 'null'], format: 'date-time' });

export const EventSourceSchema = z
  .object({
    id: z.string(),
    kind: EventSourceKindSchema,
    name: NameSchema,
    status: EventSourceStatusSchema,
    manifest: EventSourceManifestSchema,
    webhook_url: z.string().describe('URL GitHub delivers webhooks to for this source.'),
    last_delivery_at: NullableIsoTimestamp,
    created_by_subject: CreatedBySubjectSchema,
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .strict()
  .openapi('EventSource');

export const GetEventSourceResponseSchema = z.object({ data: EventSourceSchema }).openapi('GetEventSourceResponse');
export const ListEventSourcesResponseSchema = z
  .object({ data: z.array(EventSourceSchema) })
  .openapi('ListEventSourcesResponse');
export const DeleteEventSourceResponseSchema = z.object({}).openapi('DeleteEventSourceResponse');

/** The connector row through which agents act as the App behind a source. */
export const RegisterSourceConnectorResponseSchema = z
  .object({
    data: z
      .object({
        mcp_server_name: z.string().min(1).describe('Name of the MCP connector to give an agent.'),
        url: z.url().describe('Built-in MCP endpoint of this source.'),
      })
      .strict(),
  })
  .strict()
  .openapi('RegisterSourceConnectorResponse');

/** Starts the GitHub App manifest flow for a new source. */
export const CreateGithubManifestRequestSchema = z
  .object({
    name: NameSchema.describe('Source name, unique per tenant. Also used as the App name suffix.'),
    owner: z
      .string()
      .min(1)
      .optional()
      .describe('Organization login to create the App under. Omit to create it under the calling user.'),
  })
  .strict()
  .openapi('CreateGithubManifestRequest');

/**
 * What the browser needs to hand GitHub: an HTML form POST of `manifest` (JSON) to
 * `action_url`. GitHub redirects to our callback with a one-time code.
 */
export const GithubManifestStartSchema = z
  .object({
    source_id: z.string(),
    state: z.string(),
    action_url: z.url(),
    manifest: z.record(z.string(), z.unknown()).describe('GitHub App manifest, POSTed as the `manifest` form field.'),
  })
  .strict()
  .openapi('GithubManifestStart');

export const CreateGithubManifestResponseSchema = z
  .object({ data: GithubManifestStartSchema })
  .openapi('CreateGithubManifestResponse');

export type EventSourceKind = z.infer<typeof EventSourceKindSchema>;
export type EventSourceStatus = z.infer<typeof EventSourceStatusSchema>;
export type GithubAppConfig = z.infer<typeof GithubAppConfigSchema>;
export type EventSourceManifest = z.infer<typeof EventSourceManifestSchema>;
export type GithubSourceSecrets = z.infer<typeof GithubSourceSecretsSchema>;
export type EventSourceSecrets = z.infer<typeof EventSourceSecretsSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type CreateGithubManifestRequest = z.infer<typeof CreateGithubManifestRequestSchema>;
export type GithubManifestStart = z.infer<typeof GithubManifestStartSchema>;
