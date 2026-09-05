/**
 * Evaluates an automation's typed trigger conditions and lane parts against an event
 * payload. Pure functions: no I/O, no clock.
 */
import type { JsonObject } from '../connectors/types';
import type { Condition, LanePart, When } from '../schemas/automation';

/** Placeholder lane segment when a referenced field is absent, so the key stays stable. */
const MISSING_LANE_SEGMENT = '-';

/** Dotted-path lookup: `issue.labels.0.name`. Returns undefined for any missing hop. */
export function getPath(payload: JsonObject, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Scalar equality: numbers and strings compare by their string form (a payload `61`
 * equals a typed `"61"`); booleans only equal booleans.
 */
function scalarEquals(actual: unknown, expected: string | number | boolean): boolean {
  if (typeof expected === 'boolean' || typeof actual === 'boolean') {
    return actual === expected;
  }
  return isScalar(actual) && String(actual) === String(expected);
}

export function matchesCondition(condition: Condition, payload: JsonObject): boolean {
  const actual = getPath(payload, condition.field);
  const expected = condition.value;
  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'eq':
      return isScalar(expected) && scalarEquals(actual, expected);
    case 'neq':
      return isScalar(expected) && !scalarEquals(actual, expected);
    case 'in':
      return Array.isArray(expected) && expected.some(candidate => scalarEquals(actual, candidate));
    case 'not_in':
      return Array.isArray(expected) && !expected.some(candidate => scalarEquals(actual, candidate));
    case 'contains':
      if (Array.isArray(actual)) {
        return isScalar(expected) && actual.some(item => scalarEquals(item, expected));
      }
      return typeof actual === 'string' && isScalar(expected) && actual.includes(String(expected));
  }
}

/** Every condition must hold. An empty `all` matches. */
export function matchesWhen(when: When, payload: JsonObject): boolean {
  return when.all.every(condition => matchesCondition(condition, payload));
}

/**
 * Renders lane parts into one key, joined by `/`. Returns null when the automation
 * declares no lane, meaning runs may execute in parallel.
 */
export function renderLaneKey(parts: readonly LanePart[], payload: JsonObject): string | null {
  if (parts.length === 0) {
    return null;
  }
  return parts
    .map(part => {
      if (part.type === 'literal') {
        return part.value;
      }
      const value = getPath(payload, part.path);
      return isScalar(value) ? String(value) : MISSING_LANE_SEGMENT;
    })
    .join('/');
}
