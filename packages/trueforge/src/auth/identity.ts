import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import { z } from 'zod';

export const SubjectTypeSchema = z.enum(['user', 'virtualaccount']);
export type SubjectType = z.infer<typeof SubjectTypeSchema>;

export interface RequestSubject {
  id: string;
  type: SubjectType;
  display_name: string;
}

export interface UserCredential {
  authorization: string;
}

export interface RequestContext {
  tenant_id: string;
  subject: RequestSubject;
  is_admin: boolean;
  user_credential: UserCredential | null;
}

export const STANDALONE_REQUEST_CONTEXT: RequestContext = {
  tenant_id: 'default',
  subject: {
    id: 'trueforge-default',
    type: 'user',
    display_name: 'Admin',
  },
  is_admin: true,
  user_credential: null,
};

export type ResolveRequestContext = (c: Context) => RequestContext;

export function resolveRequestContext(c: Context): RequestContext {
  const requestContext = c.get('request_context');
  if (requestContext === undefined) {
    throw new Error('RequestContext missing; auth middleware did not run');
  }
  return requestContext;
}

/** Persistable creator snapshot derived from the authenticated request. */
export function createdBySubjectFromRequestContext(ctx: RequestContext): CreatedBySubject {
  return {
    subject_id: ctx.subject.id,
    subject_type: ctx.subject.type,
    subject_display_name: ctx.subject.display_name,
  };
}

export function requestSubjectFromCreatedBy(subject: CreatedBySubject): RequestSubject {
  if (subject.subject_type !== 'user' && subject.subject_type !== 'virtualaccount') {
    throw new Error(`Unsupported created-by subject type: ${subject.subject_type}`);
  }
  return {
    id: subject.subject_id,
    type: subject.subject_type,
    display_name: subject.subject_display_name,
  };
}
