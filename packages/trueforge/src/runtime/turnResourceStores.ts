import type { CredentialProvider } from '../auth/credentialProvider';
import { credentialSubjectFor } from '../auth/credentialSubject';
import type { RequestContext } from '../auth/identity';
import { rawTokenFromCredential } from '../auth/token';
import type { AgentRecord } from '../db/agentStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import { TrueFoundryMcpServerStore } from '../truefoundry/TrueFoundryMcpServerStore';
import { TrueFoundryModelProviderStore } from '../truefoundry/TrueFoundryModelProviderStore';
import type { TrueFoundryServiceFoundryServerClient } from '../truefoundry/TrueFoundryServiceFoundryServerClient';

export interface TurnResourceStores {
  modelProviderStore: IModelProviderStore;
  mcpServerStore: IMcpServerStore;
}

export type ResolveTurnResourceStores = (input: {
  context: RequestContext;
  agent: AgentRecord | undefined;
}) => Promise<TurnResourceStores>;

export function createTrueFoundryTurnResourceStoresResolver(input: {
  client: TrueFoundryServiceFoundryServerClient;
  credentialProvider: CredentialProvider;
}): ResolveTurnResourceStores {
  return async ({ context, agent }) => {
    const credential = await input.credentialProvider.getToken({
      user: credentialSubjectFor(context),
      agent,
    });
    if (credential === null) {
      throw new Error('TrueFoundry execution credential was not resolved');
    }
    const accessToken = rawTokenFromCredential(credential.authorization);
    return {
      modelProviderStore: new TrueFoundryModelProviderStore({ client: input.client, accessToken }),
      mcpServerStore: new TrueFoundryMcpServerStore({ client: input.client, accessToken }),
    };
  };
}

export function createPersistenceTurnResourceStoresResolver(input: {
  modelProviderStore: IModelProviderStore;
  mcpServerStore: IMcpServerStore;
}): ResolveTurnResourceStores {
  return () => Promise.resolve(input);
}
