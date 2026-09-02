import {
  type AgentRecord,
  type CreateAgentInput,
  type DeleteAgentInput,
  type GetAgentInput,
  type IAgentStore,
  type UpdateAgentInput,
} from '../db/agentStore';
import { toPutRemoteAgentPayload } from './toPutRemoteAgentPayload';
import { TrueFoundryServiceFoundryServerClient } from './TrueFoundryServiceFoundryServerClient';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Wraps DB agent persistence and keeps ServiceFoundry in sync. Remote work always runs
 * before the local write so a ServiceFoundry/network failure leaves the DB unchanged.
 * The remote agent id is stored on the row as `external_id`.
 *
 * Create — put remote agent, then insert locally with that id; if the insert fails, delete
 * the remote agent; if that cleanup also fails, throw AggregateError (both failures).
 *
 * Update (manifest) — put remote with the new manifest, then patch the local row (and
 * external_id if it changed); if the local write fails, put remote again with the previous
 * manifest; if that restore also fails, throw AggregateError. Non-manifest patches skip SF.
 *
 * Delete — delete remote first (404 counts as already gone), then delete the local row; if
 * remote delete fails, the local row stays.
 *
 *   create:  putRemote → createDB(external_id) | on DB fail → deleteRemote | both fail → AggregateError
 *   update:  putRemote(new) → updateDB | on DB fail → putRemote(old) | both fail → AggregateError
 *   delete:  deleteRemote(404 ok) → deleteDB
 */
export class TrueFoundryAgentStore<TTransaction = never> implements IAgentStore<TTransaction> {
  readonly #inner: IAgentStore<TTransaction>;
  readonly #client: TrueFoundryServiceFoundryServerClient;
  readonly #accessToken: string;

  constructor(input: {
    inner: IAgentStore<TTransaction>;
    client: TrueFoundryServiceFoundryServerClient;
    accessToken: string;
  }) {
    this.#inner = input.inner;
    this.#client = input.client;
    this.#accessToken = input.accessToken;
  }

  listAgents(tenantId: string, transaction?: TTransaction): Promise<AgentRecord[]> {
    return this.#inner.listAgents(tenantId, transaction);
  }

  getAgent(input: GetAgentInput, transaction?: TTransaction): Promise<AgentRecord | undefined> {
    return this.#inner.getAgent(input, transaction);
  }

  async createAgent(input: CreateAgentInput, transaction?: TTransaction): Promise<AgentRecord> {
    const { remoteAgentId } = await this.#client.putRemoteAgent({
      accessToken: this.#accessToken,
      ...toPutRemoteAgentPayload({ name: input.name, manifest: input.manifest }),
    });
    try {
      return await this.#inner.createAgent(
        {
          tenant_id: input.tenant_id,
          name: input.name,
          manifest: input.manifest,
          external_id: remoteAgentId,
        },
        transaction,
      );
    } catch (error) {
      try {
        await this.#client.deleteRemoteAgent({ accessToken: this.#accessToken, remoteAgentId });
      } catch (cleanupError) {
        throw new AggregateError(
          [asError(error), asError(cleanupError)],
          'createAgent failed and ServiceFoundry cleanup also failed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  async updateAgent(input: UpdateAgentInput, transaction?: TTransaction): Promise<AgentRecord | undefined> {
    if (input.manifest === undefined) {
      return this.#inner.updateAgent(input, transaction);
    }

    const previous = await this.#inner.getAgent({ tenant_id: input.tenant_id, id: input.id }, transaction);
    if (previous === undefined) {
      return undefined;
    }

    const { remoteAgentId } = await this.#client.putRemoteAgent({
      accessToken: this.#accessToken,
      ...toPutRemoteAgentPayload({ name: previous.name, manifest: input.manifest }),
    });

    try {
      return await this.#inner.updateAgent(
        {
          tenant_id: input.tenant_id,
          id: input.id,
          manifest: input.manifest,
          ...(remoteAgentId === previous.external_id ? {} : { external_id: remoteAgentId }),
        },
        transaction,
      );
    } catch (error) {
      try {
        await this.#client.putRemoteAgent({
          accessToken: this.#accessToken,
          ...toPutRemoteAgentPayload({ name: previous.name, manifest: previous.manifest }),
        });
      } catch (restoreError) {
        throw new AggregateError(
          [asError(error), asError(restoreError)],
          'updateAgent failed and ServiceFoundry restore also failed',
          { cause: restoreError },
        );
      }
      throw error;
    }
  }

  async deleteAgent(input: DeleteAgentInput, transaction?: TTransaction): Promise<void> {
    const previous = await this.#inner.getAgent({ tenant_id: input.tenant_id, id: input.id }, transaction);
    if (previous?.external_id) {
      await this.#client.deleteRemoteAgent({
        accessToken: this.#accessToken,
        remoteAgentId: previous.external_id,
      });
    }
    await this.#inner.deleteAgent(input, transaction);
  }
}
