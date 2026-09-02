/**
 * Same-origin relative path only.
 * - starts with `/`
 * - not `//…` (open redirect)
 * - not `/api` or `/api/…`
 */
import configuration from '../config';

const SAFE_RETURN_TO = /^\/(?!\/|api(?:\/|$)).*/;

function isSafeReturnTo(value: string): boolean {
  return SAFE_RETURN_TO.test(value);
}

/** Same-origin path, or `ROOT_PATH` / `/` when missing or unsafe. */
export function safeReturnTo(value: string | undefined): string {
  if (value && isSafeReturnTo(value)) {
    return value;
  }
  return configuration.ROOT_PATH || '/';
}
