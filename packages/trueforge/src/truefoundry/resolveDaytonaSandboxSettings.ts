/**
 * Fetch Daytona snapshot name + lifecycle settings from the deployment settings server
 * (TrueFoundry mode). Mirrors tfy-llm-gateway sandboxComposition.resolveDaytonaSettings —
 * no SANDBOX_SETTINGS JSON override.
 */
import { z } from 'zod';
import configuration from '../config';

const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;

const SANDBOX_DEFAULT_SETTINGS = {
  timeoutMs: 60_000,
  autoStopIntervalInMinutes: 5,
  autoArchiveIntervalInMinutes: 60,
  autoDeleteIntervalInMinutes: 43_200,
} as const;

const DaytonaSandboxSettingsSchema = z.object({
  snapshotName: z.string().min(1, 'snapshotName is required'),
  autoStopIntervalInMinutes: z.number().default(SANDBOX_DEFAULT_SETTINGS.autoStopIntervalInMinutes),
  autoArchiveIntervalInMinutes: z.number().default(SANDBOX_DEFAULT_SETTINGS.autoArchiveIntervalInMinutes),
  autoDeleteIntervalInMinutes: z.number().default(SANDBOX_DEFAULT_SETTINGS.autoDeleteIntervalInMinutes),
  timeoutMs: z.number().default(SANDBOX_DEFAULT_SETTINGS.timeoutMs),
});

export type DaytonaSandboxSettings = z.infer<typeof DaytonaSandboxSettingsSchema>;

let cachedRemoteDaytonaSettings:
  | {
      value: DaytonaSandboxSettings;
      expiresAt: number;
    }
  | undefined;

export async function resolveDaytonaSandboxSettings({
  accessToken,
}: {
  accessToken: string;
}): Promise<DaytonaSandboxSettings> {
  const settingsServerUrl = configuration.SANDBOX_SETTINGS_SERVER_URL;
  if (settingsServerUrl === undefined) {
    throw new Error('SANDBOX_SETTINGS_SERVER_URL is required when resolving Daytona sandbox settings');
  }
  if (cachedRemoteDaytonaSettings !== undefined && Date.now() < cachedRemoteDaytonaSettings.expiresAt) {
    return cachedRemoteDaytonaSettings.value;
  }
  // Deployment settings server (config), not tenant-configurable — trusted like CONTROL_PLANE_URL.
  const response = await fetch(settingsServerUrl, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sandbox settings endpoint returned ${String(response.status)}: ${body}`);
  }
  const settings = DaytonaSandboxSettingsSchema.parse(await response.json());
  cachedRemoteDaytonaSettings = { value: settings, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
  return settings;
}

/** @internal Exported for tests. */
export function __resetDaytonaSettingsCacheForTests(): void {
  cachedRemoteDaytonaSettings = undefined;
}
