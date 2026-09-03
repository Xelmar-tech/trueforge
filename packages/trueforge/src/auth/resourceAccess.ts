import type { CreatedBySubject, SessionRecord } from '@truefoundry/trueforge-core/agent-session';
import type { IAgentStore } from '../db/agentStore';
import type { ExternalAuthorizer } from './externalAuthorizer';
import type { RequestContext } from './identity';

export function isOwner(
  context: Pick<RequestContext, 'tenant_id' | 'subject'>,
  record: { tenant_id: string; created_by_subject: CreatedBySubject },
): boolean {
  return context.tenant_id === record.tenant_id && context.subject.id === record.created_by_subject.subject_id;
}

export async function canReadSession(input: {
  context: RequestContext;
  record: SessionRecord;
  agent_store: IAgentStore;
  external_authorizer: ExternalAuthorizer;
}): Promise<boolean> {
  if (isOwner(input.context, input.record)) {
    return true;
  }
  if (input.record.agent.type !== 'reference') {
    return false;
  }
  const agent = await input.agent_store.getAgent({
    tenant_id: input.context.tenant_id,
    id: input.record.agent.id,
  });
  return (
    agent !== undefined &&
    input.external_authorizer.canAccessAgent({
      context: input.context,
      action: 'manage',
      agent,
    })
  );
}
