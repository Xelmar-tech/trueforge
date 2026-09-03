import type { AgentRecord } from '../db/agentStore';
import type { CredentialSubject } from './credentialSubject';

export interface ExecutionCredential {
  authorization: string;
}

export interface CredentialProvider {
  getToken(input: {
    user: CredentialSubject | null;
    agent: AgentRecord | undefined;
  }): Promise<ExecutionCredential | null>;
}

export interface TrueFoundryAgentTokenClient {
  getAgentIdentityToken(input: { subject: CredentialSubject; agent_external_id: string }): Promise<string>;
}

function requireExternalId(agent: AgentRecord): string {
  if (agent.external_id === null) {
    throw new Error(`Agent ${agent.id} has no TrueFoundry external_id`);
  }
  return agent.external_id;
}

export class NullCredentialProvider implements CredentialProvider {
  getToken(): Promise<null> {
    return Promise.resolve(null);
  }
}

export class TrueFoundryCredentialProvider implements CredentialProvider {
  readonly #client: TrueFoundryAgentTokenClient;

  constructor(input: { client: TrueFoundryAgentTokenClient }) {
    this.#client = input.client;
  }

  async getToken(input: {
    user: CredentialSubject | null;
    agent: AgentRecord | undefined;
  }): Promise<ExecutionCredential | null> {
    if (input.user === null) {
      throw new Error('TrueFoundry execution requires a user identity');
    }
    if (input.agent === undefined) {
      if (!('authorization' in input.user)) {
        throw new Error('Offline execution requires a saved agent');
      }
      return { authorization: input.user.authorization };
    }
    const token = await this.#client.getAgentIdentityToken({
      subject: input.user,
      agent_external_id: requireExternalId(input.agent),
    });
    return { authorization: `Bearer ${token}` };
  }
}
