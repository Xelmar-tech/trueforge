import type { AgentRecord, IAgentStore } from '../db/agentStore';
import { credentialSubjectFor, type CredentialSubject } from './credentialSubject';
import type { RequestContext } from './identity';

export type AgentAction = 'read' | 'manage';

export type ExternalAgentListAccess = { kind: 'all' } | { kind: 'agent_external_ids'; agent_external_ids: string[] };

export type AgentAuthorizationContext = Pick<RequestContext, 'tenant_id' | 'subject' | 'is_admin' | 'user_credential'>;

export interface ExternalAuthorizer {
  listAgentAccess(input: { context: AgentAuthorizationContext; action: AgentAction }): Promise<ExternalAgentListAccess>;

  canAccessAgent(input: {
    context: AgentAuthorizationContext;
    action: AgentAction;
    agent: AgentRecord;
  }): Promise<boolean>;
}

export class AllowAllExternalAuthorizer implements ExternalAuthorizer {
  listAgentAccess(): Promise<ExternalAgentListAccess> {
    return Promise.resolve({ kind: 'all' });
  }

  canAccessAgent(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export interface TrueFoundryAgentAuthorizationClient {
  listAuthorizedAgentIds(input: { subject: CredentialSubject; action: AgentAction }): Promise<string[]>;

  canAccessAgent(input: {
    subject: CredentialSubject;
    action: AgentAction;
    agent_external_id: string;
  }): Promise<boolean>;
}

function requireExternalId(agent: AgentRecord): string {
  if (agent.external_id === null) {
    throw new Error(`Agent ${agent.id} has no TrueFoundry external_id`);
  }
  return agent.external_id;
}

export class TrueFoundryExternalAuthorizer implements ExternalAuthorizer {
  readonly #client: TrueFoundryAgentAuthorizationClient;

  constructor(input: { client: TrueFoundryAgentAuthorizationClient }) {
    this.#client = input.client;
  }

  async listAgentAccess(input: {
    context: AgentAuthorizationContext;
    action: AgentAction;
  }): Promise<ExternalAgentListAccess> {
    if (input.context.is_admin) {
      return { kind: 'all' };
    }
    return {
      kind: 'agent_external_ids',
      agent_external_ids: await this.#client.listAuthorizedAgentIds({
        subject: credentialSubjectFor(input.context),
        action: input.action,
      }),
    };
  }

  async canAccessAgent(input: {
    context: AgentAuthorizationContext;
    action: AgentAction;
    agent: AgentRecord;
  }): Promise<boolean> {
    if (input.context.is_admin) {
      return true;
    }
    return this.#client.canAccessAgent({
      subject: credentialSubjectFor(input.context),
      action: input.action,
      agent_external_id: requireExternalId(input.agent),
    });
  }
}

export function listAccessibleAgents(input: {
  tenant_id: string;
  access: ExternalAgentListAccess;
  agent_store: IAgentStore;
}): Promise<AgentRecord[]> {
  return input.agent_store.listAgents({
    tenant_id: input.tenant_id,
    external_ids: input.access.kind === 'all' ? undefined : input.access.agent_external_ids,
  });
}

export async function resolveInternalAgentIds(input: {
  tenant_id: string;
  access: ExternalAgentListAccess;
  agent_store: IAgentStore;
}): Promise<string[] | undefined> {
  if (input.access.kind === 'all') {
    return undefined;
  }
  const agents = await listAccessibleAgents(input);
  return agents.map(agent => agent.id);
}
