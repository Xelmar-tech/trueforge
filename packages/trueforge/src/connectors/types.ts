/**
 * A source connector turns one provider's webhook deliveries into events the
 * automations engine can route. One connector per {@link EventSourceKind}.
 */
import type { EventSummary } from '../schemas/event';
import type { EventSourceKind, EventSourceSecrets } from '../schemas/eventSource';

export type JsonObject = Record<string, unknown>;

export interface NormalizedEvent {
  /** Connector event kind, e.g. `issues.labeled`. */
  kind: string;
  /** Stable key of the subject, e.g. `owner/repo#61`; drives coalescing and lanes. */
  subject_key: string;
  /** Provider delivery id; unique per source so a redelivery is idempotent. */
  delivery_id: string;
  summary: EventSummary;
  payload: JsonObject;
}

/** The delivery failed verification or was malformed. `status` is what the webhook route returns. */
export class WebhookRejectedError extends Error {
  readonly status: 400 | 401;

  constructor(message: string, status: 400 | 401, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebhookRejectedError';
    this.status = status;
  }
}

export interface SourceConnector {
  readonly kind: EventSourceKind;
  /**
   * Verify a raw delivery against the source secrets and normalize it. Resolves
   * `null` for deliveries that are valid but carry no event (e.g. GitHub `ping`).
   * Throws {@link WebhookRejectedError} for a bad signature or malformed body.
   */
  normalizeWebhook(input: {
    headers: Headers;
    rawBody: string;
    secrets: EventSourceSecrets;
  }): Promise<NormalizedEvent | null>;
}
