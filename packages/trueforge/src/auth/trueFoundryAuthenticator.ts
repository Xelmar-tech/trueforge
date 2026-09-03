import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { GetSessionResponse } from '../truefoundry/TrueFoundryServiceFoundryServerClient';
import type { Authenticator } from './authenticator';
import { SubjectTypeSchema, type RequestContext, type SubjectType } from './identity';
import { extractRequestToken } from './token';

const TENANT_ADMIN_ROLE = 'tenant-admin';

/** Narrow port used by the authenticator (avoids depending on the full SFY client). */
export interface TrueFoundrySessionClient {
  getSession(accessToken: string): Promise<GetSessionResponse>;
}

function mapSubjectType(raw: string): SubjectType | undefined {
  if (raw === 'user' || raw === 'virtualaccount') {
    return SubjectTypeSchema.parse(raw);
  }
  // sfy server uses 'serviceaccount' for virtual accounts
  if (raw === 'serviceaccount') {
    return 'virtualaccount';
  }
  return undefined;
}

export class TrueFoundryAuthenticator implements Authenticator {
  readonly #client: TrueFoundrySessionClient;

  constructor(client: TrueFoundrySessionClient) {
    this.#client = client;
  }

  async authenticate(c: Context): Promise<RequestContext> {
    const token = extractRequestToken(c);
    if (!token) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    const session = await this.#client.getSession(token);
    const subjectType = mapSubjectType(session.identity.subject.type);
    if (subjectType === undefined) {
      throw new HTTPException(502, {
        message: 'TrueFoundry session returned an unsupported subject type',
      });
    }

    const { subject } = session.identity;
    return {
      tenant_id: session.user.tenantName,
      subject: {
        id: subject.id,
        type: subjectType,
        display_name: subject.display_name ?? subject.id,
      },
      is_admin: session.user.roles.includes(TENANT_ADMIN_ROLE),
      user_credential: token,
    };
  }
}
