import type { SessionRecord } from '@truefoundry/trueforge-core/agent-session';
import type { ExternalAuthorizer } from '../auth/externalAuthorizer';
import type { RequestContext } from '../auth/identity';
import type { IAgentStore } from '../db/agentStore';
import { resolveManagedAgentIds } from './agentAccess';

/** Session mutations remain owner-only. */
export function isSessionOwner(input: {
  session: Pick<SessionRecord, 'created_by_subject'>;
  context: RequestContext;
}): boolean {
  return input.session.created_by_subject.subject_id === input.context.subject.id;
}

/** Reads include owner sessions and reference sessions covered by an external manager grant. */
export async function canReadSession<TTransaction>(input: {
  session: Pick<SessionRecord, 'agent' | 'created_by_subject'>;
  context: RequestContext;
  agentStore: IAgentStore<TTransaction>;
  authorizer: ExternalAuthorizer;
}): Promise<boolean> {
  if (isSessionOwner(input)) {
    return true;
  }
  if (input.session.agent.type === 'inline') {
    return false;
  }
  const managedAgentIds = await resolveManagedAgentIds({
    store: input.agentStore,
    context: input.context,
    authorizer: input.authorizer,
  });
  return managedAgentIds.includes(input.session.agent.id);
}
