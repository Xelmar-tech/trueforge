import { CreatedBySubjectSchema } from '@truefoundry/trueforge-core/agent-session';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { timingSafeEqual } from 'node:crypto';

import { requestSubjectFromCreatedBy, type RequestContext } from './identity';
import { readBearerToken } from './token';

// tells TypeScript that c.set('request_context', …) / c.get('request_context') are valid and return RequestContextt
declare module 'hono' {
  interface ContextVariableMap {
    request_context?: RequestContext;
  }
}

export interface Authenticator {
  authenticate(c: Context): Promise<RequestContext>;
}

export function createAuthMiddleware(authenticator: Authenticator): MiddlewareHandler {
  return async (c, next) => {
    c.set('request_context', await authenticator.authenticate(c));
    return next();
  };
}

export function createAdminAuthMiddleware(authenticator: Authenticator): MiddlewareHandler {
  return async (c, next) => {
    const requestContext = await authenticator.authenticate(c);
    if (!requestContext.is_admin) {
      throw new HTTPException(403, { message: 'Admin access required' });
    }
    c.set('request_context', requestContext);
    return next();
  };
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function trustedControllerContext(c: Context, apiKey: string): RequestContext | undefined {
  const token = readBearerToken(c);
  if (token === undefined || !secretsEqual(token, apiKey)) {
    return undefined;
  }
  const tenantId = c.req.header('x-tf-tenant-id');
  const subjectHeader = c.req.header('x-tf-subject');
  if (!tenantId || !subjectHeader) {
    throw new HTTPException(400, { message: 'Missing trusted controller identity headers' });
  }
  let subjectPayload: unknown;
  try {
    subjectPayload = JSON.parse(subjectHeader);
  } catch (error) {
    throw new HTTPException(400, { message: 'Invalid x-tf-subject header', cause: error });
  }
  const parsed = CreatedBySubjectSchema.safeParse(subjectPayload);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid x-tf-subject header', cause: parsed.error });
  }
  return {
    tenant_id: tenantId,
    subject: requestSubjectFromCreatedBy(parsed.data),
    is_admin: false,
    user_credential: null,
  };
}

export function createTrustedControllerAuthMiddleware(apiKey: string): MiddlewareHandler {
  return async (c, next) => {
    const context = trustedControllerContext(c, apiKey);
    if (context === undefined) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }
    c.set('request_context', context);
    return next();
  };
}

export function createControllerAwareAuthMiddleware(
  authenticator: Authenticator,
  apiKey: string | undefined,
): MiddlewareHandler {
  if (apiKey === undefined) {
    return createAuthMiddleware(authenticator);
  }
  return async (c, next) => {
    c.set('request_context', trustedControllerContext(c, apiKey) ?? (await authenticator.authenticate(c)));
    return next();
  };
}
