import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { createdBySubjectFromRequestContext, type RequestContext } from './identity';

export type CredentialSubject =
  | string
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

export function isUserCredential(subject: CredentialSubject): subject is string {
  return typeof subject === 'string';
}
