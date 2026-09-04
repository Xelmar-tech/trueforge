import { HTTPException } from 'hono/http-exception';
import { resolveTrueFoundrySandboxProviderConfig } from '../config';
import type {
  ISandboxProviderStore,
  SandboxProviderRecord,
  UpdateSandboxStatusInput,
  UpsertSandboxProviderInput,
} from '../db/sandboxProviderStore';
import { resolveDaytonaSandboxSettings } from './resolveDaytonaSandboxSettings';
import { TRUEFOUNDRY_MANAGED_MESSAGE, TRUEFOUNDRY_MANAGED_STATUS } from './trueFoundryManaged';

function managed(): never {
  throw new HTTPException(TRUEFOUNDRY_MANAGED_STATUS, { message: TRUEFOUNDRY_MANAGED_MESSAGE });
}

/**
 * Shared Daytona sandbox for TrueFoundry mode: settings from env + settings-server,
 * not the tenant DB. Writes are managed (424).
 */
export class TrueFoundrySandboxProviderStore<TTransaction = never> implements ISandboxProviderStore<TTransaction> {
  readonly #accessToken: string;

  constructor(input: { accessToken: string }) {
    this.#accessToken = input.accessToken;
  }

  async getSandboxProvider(tenantId: string, transaction?: TTransaction): Promise<SandboxProviderRecord | undefined> {
    void transaction;
    const providerConfig = resolveTrueFoundrySandboxProviderConfig();
    if (!providerConfig) {
      return undefined;
    }
    const settings = await resolveDaytonaSandboxSettings({ accessToken: this.#accessToken });
    const now = new Date().toISOString();
    return {
      tenant_id: tenantId,
      manifest: {
        type: 'daytona',
        auth: { api_key: providerConfig.apiKey },
        exec_timeout_ms: settings.timeoutMs,
        auto_stop_interval_in_minutes: settings.autoStopIntervalInMinutes,
        auto_archive_interval_in_minutes: settings.autoArchiveIntervalInMinutes,
        auto_delete_interval_in_minutes: settings.autoDeleteIntervalInMinutes,
      },
      status: 'ready',
      status_reason: null,
      // Snapshot name only — no image_uri; TFY mode never registers a snapshot.
      build_metadata: { build_ref: settings.snapshotName },
      created_at: now,
      // Fresh on every get so checkSnapshotStatus short-circuits without Daytona.
      updated_at: now,
    };
  }

  getSandboxProviderForUpdate(tenantId: string, transaction: TTransaction): Promise<SandboxProviderRecord | undefined> {
    void tenantId;
    void transaction;
    return managed();
  }

  upsertSandboxProvider(input: UpsertSandboxProviderInput, transaction?: TTransaction): Promise<SandboxProviderRecord> {
    void input;
    void transaction;
    return managed();
  }

  updateSandboxStatus(
    input: UpdateSandboxStatusInput,
    transaction?: TTransaction,
  ): Promise<SandboxProviderRecord | undefined> {
    void input;
    void transaction;
    return managed();
  }
}
