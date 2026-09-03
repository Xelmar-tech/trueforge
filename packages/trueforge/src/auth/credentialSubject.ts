import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { createdBySubjectFromRequestContext, type RequestContext, type UserCredential } from './identity';

export type CredentialSubject =
  | UserCredential
  | {
      tenant_id: string;
      created_by_subject: CreatedBySubject;
    };

export function credentialSubjectFor(context: RequestContext): CredentialSubject {
  return (
    context.user_credential ?? {
      tenant_id: context.tenant_id,
      created_by_subject: createdBySubjectFromRequestContext(context),
    }
  );
}

export function isUserCredential(subject: CredentialSubject): subject is UserCredential {
  return 'authorization' in subject;
}
