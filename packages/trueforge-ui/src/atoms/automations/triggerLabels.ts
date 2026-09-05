import type {
  AutomationCondition,
  AutomationLanePart,
  AutomationTrigger,
  ConditionOperator,
} from '../../server/types.js';

export const CONDITION_OPERATOR_OPTIONS: Array<{ value: ConditionOperator; label: string; needsValue: boolean }> = [
  { value: 'eq', label: 'is', needsValue: true },
  { value: 'neq', label: 'is not', needsValue: true },
  { value: 'in', label: 'is one of', needsValue: true },
  { value: 'not_in', label: 'is none of', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'exists', label: 'exists', needsValue: false },
  { value: 'not_exists', label: 'does not exist', needsValue: false },
];

export function operatorLabel(op: ConditionOperator): string {
  return CONDITION_OPERATOR_OPTIONS.find(option => option.value === op)?.label ?? op;
}

export function operatorNeedsValue(op: ConditionOperator): boolean {
  return CONDITION_OPERATOR_OPTIONS.find(option => option.value === op)?.needsValue ?? true;
}

/** GitHub event kinds worth offering before the ledger has seen any. */
export const GITHUB_EVENT_KINDS: readonly string[] = [
  'issues.opened',
  'issues.labeled',
  'issues.unlabeled',
  'issues.edited',
  'issues.closed',
  'issues.reopened',
  'issue_comment.created',
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.labeled',
  'pull_request.ready_for_review',
  'pull_request.closed',
  'pull_request_review.submitted',
  'check_suite.completed',
  'push',
];

/** Payload fields a GitHub condition usually keys on. Free text is always allowed. */
export const GITHUB_CONDITION_FIELDS: readonly string[] = [
  'action',
  'label.name',
  'issue.number',
  'issue.title',
  'issue.state',
  'issue.author_association',
  'issue.user.login',
  'pull_request.number',
  'pull_request.draft',
  'pull_request.base.ref',
  'pull_request.user.login',
  'repository.full_name',
  'repository.default_branch',
  'sender.login',
  'check_suite.conclusion',
  'ref',
];

export const GITHUB_LANE_FIELDS: readonly string[] = [
  'repository.full_name',
  'issue.number',
  'pull_request.number',
  'sender.login',
];

export function formatConditionValue(value: AutomationCondition['value']): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

/** `label.name is ready-for-planning` */
export function formatCondition(condition: AutomationCondition): string {
  const value = operatorNeedsValue(condition.op) ? ` ${formatConditionValue(condition.value)}` : '';
  return `${condition.field} ${operatorLabel(condition.op)}${value}`;
}

/** One line for a table cell: kind plus the number of conditions. */
export function formatTriggerSummary(trigger: AutomationTrigger): string {
  if (trigger.conditions.length === 0) return trigger.kind;
  const first = trigger.conditions[0];
  const rest = trigger.conditions.length - 1;
  const suffix = rest > 0 ? ` +${String(rest)}` : '';
  return first === undefined ? trigger.kind : `${trigger.kind} · ${formatCondition(first)}${suffix}`;
}

export function formatLane(lane: readonly AutomationLanePart[]): string {
  if (lane.length === 0) return 'none';
  return lane.map(part => (part.type === 'field' ? `{${part.path}}` : part.value)).join('/');
}

/** Parses a typed value: comma lists for `in`/`not_in`, numbers and booleans when unambiguous. */
export function parseConditionValue(op: ConditionOperator, raw: string): AutomationCondition['value'] {
  const trimmed = raw.trim();
  if (!operatorNeedsValue(op)) return undefined;
  if (op === 'in' || op === 'not_in') {
    return trimmed
      .split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0)
      .map(item => (/^-?\d+(\.\d+)?$/.test(item) ? Number(item) : item));
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
