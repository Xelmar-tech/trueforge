import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Logger } from 'winston';
import { automationDispatchLoop } from './controller/automationDispatch';
import { Controller } from './controller/Controller';
import { eventCoalesceLoop } from './controller/eventCoalesce';
import { runFinalizeLoop } from './controller/runFinalize';
import { scheduleDispatchLoop } from './controller/scheduleDispatch';
import type { IAutomationStore } from './db/automationStore';
import type { IEventSourceStore } from './db/eventSourceStore';
import type { IEventStore } from './db/eventStore';
import type { IScheduleStore } from './db/scheduleStore';
import type { WithTransaction } from './db/transaction';
import { createTlsFetch, normalizeTlsUrl, type TlsOptions } from './http/tls';

function createScheduleApiClient(params: { baseUrl: string; tls: TlsOptions }): TrueForge {
  const baseUrl = normalizeTlsUrl({ url: params.baseUrl, enabled: params.tls.enabled });
  const fetchImpl = createTlsFetch(params.tls);
  return new TrueForge({
    baseUrl,
    auth: false,
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });
}

/**
 * The loops the controller runs.
 */
export interface ControllerStores<TTransaction> {
  scheduleStore: IScheduleStore<TTransaction>;
  eventStore: IEventStore<TTransaction>;
  eventSourceStore: IEventSourceStore<TTransaction>;
  automationStore: IAutomationStore<TTransaction>;
}

export function createController<TTransaction>(
  params: ControllerStores<TTransaction> & {
    withTransaction: WithTransaction<TTransaction>;
    logger: Logger;
    baseUrl: string;
    tls?: TlsOptions;
  },
): Controller {
  const { scheduleStore, eventStore, eventSourceStore, automationStore, withTransaction, logger, baseUrl } = params;
  const tls = params.tls ?? { enabled: false, dir: '' };
  const client = createScheduleApiClient({ baseUrl, tls });
  return new Controller({
    loops: [
      scheduleDispatchLoop({
        scheduleStore,
        client,
        withTransaction,
        logger,
      }),
      eventCoalesceLoop({ eventStore, automationStore, logger }),
      automationDispatchLoop({ automationStore, eventStore, client, logger }),
      runFinalizeLoop({ automationStore, eventStore, eventSourceStore, client, logger }),
    ],
    logger,
  });
}

/**
 * Runs the controller: starts the loops and drains them on SIGTERM/SIGINT.
 */
export function runController<TTransaction>(
  params: ControllerStores<TTransaction> & {
    withTransaction: WithTransaction<TTransaction>;
    logger: Logger;
    baseUrl: string;
    tls?: TlsOptions;
    gracefulTimeoutSeconds: number;
    /** Releases what the caller opened for the loops, e.g. its database pool. */
    onStopped?: () => Promise<void>;
  },
): Controller {
  const { logger, gracefulTimeoutSeconds, onStopped } = params;
  const controller = createController(params);
  controller.start();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, stopping control loops`);

    // Passes only hold short transactions, so the deadline should never elapse.
    setTimeout(() => {
      logger.warn(`Controller drain timed out after ${String(gracefulTimeoutSeconds)}s, exiting`);
      process.exit(1);
    }, gracefulTimeoutSeconds * 1000).unref();

    await controller.stop();
    await onStopped?.();
    process.exit(0);
  };
  process.on('SIGTERM', signal => {
    void shutdown(signal);
  });
  process.on('SIGINT', signal => {
    void shutdown(signal);
  });

  return controller;
}
