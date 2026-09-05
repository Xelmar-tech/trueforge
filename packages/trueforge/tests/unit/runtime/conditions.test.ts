import { getPath, matchesCondition, matchesWhen, renderLaneKey } from '../../../src/runtime/conditions';
import { WhenSchema } from '../../../src/schemas/automation';

const payload = {
  action: 'labeled',
  label: { name: 'ready-for-planning' },
  issue: { number: 61, title: 'Mission', labels: [{ name: 'ready-for-planning' }, { name: 'mission' }], draft: false },
  repository: { full_name: 'xelmar-tech/dogfood' },
};

describe('conditions', () => {
  test('getPath walks objects and arrays', () => {
    expect(getPath(payload, 'label.name')).toBe('ready-for-planning');
    expect(getPath(payload, 'issue.labels.1.name')).toBe('mission');
    expect(getPath(payload, 'issue.labels.9.name')).toBeUndefined();
    expect(getPath(payload, 'nope.deeper')).toBeUndefined();
    expect(getPath(payload, 'issue.number.x')).toBeUndefined();
  });

  test('operators', () => {
    expect(matchesCondition({ field: 'label.name', op: 'eq', value: 'ready-for-planning' }, payload)).toBe(true);
    expect(matchesCondition({ field: 'issue.number', op: 'eq', value: '61' }, payload)).toBe(true);
    expect(matchesCondition({ field: 'issue.draft', op: 'eq', value: false }, payload)).toBe(true);
    expect(matchesCondition({ field: 'issue.draft', op: 'eq', value: 'false' }, payload)).toBe(false);
    expect(matchesCondition({ field: 'label.name', op: 'neq', value: 'x' }, payload)).toBe(true);
    expect(matchesCondition({ field: 'label.name', op: 'in', value: ['a', 'ready-for-planning'] }, payload)).toBe(true);
    expect(matchesCondition({ field: 'label.name', op: 'not_in', value: ['a'] }, payload)).toBe(true);
    expect(matchesCondition({ field: 'issue.title', op: 'contains', value: 'iss' }, payload)).toBe(true);
    expect(matchesCondition({ field: 'issue.labels', op: 'contains', value: 'mission' }, payload)).toBe(false);
    expect(matchesCondition({ field: 'issue.number', op: 'exists' }, payload)).toBe(true);
    expect(matchesCondition({ field: 'issue.assignee', op: 'not_exists' }, payload)).toBe(true);
    expect(matchesCondition({ field: 'label.name', op: 'eq' }, payload)).toBe(false);
  });

  test('matchesWhen is AND over all, and empty matches', () => {
    expect(matchesWhen(WhenSchema.parse({}), payload)).toBe(true);
    expect(
      matchesWhen(
        {
          all: [
            { field: 'label.name', op: 'eq', value: 'ready-for-planning' },
            { field: 'action', op: 'eq', value: 'labeled' },
          ],
        },
        payload,
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        {
          all: [
            { field: 'label.name', op: 'eq', value: 'ready-for-planning' },
            { field: 'action', op: 'eq', value: 'opened' },
          ],
        },
        payload,
      ),
    ).toBe(false);
  });

  test('renderLaneKey joins fields and literals; missing fields become a placeholder', () => {
    expect(renderLaneKey([], payload)).toBeNull();
    expect(
      renderLaneKey(
        [
          { type: 'field', path: 'repository.full_name' },
          { type: 'literal', value: 'planning' },
        ],
        payload,
      ),
    ).toBe('xelmar-tech/dogfood/planning');
    expect(
      renderLaneKey(
        [
          { type: 'field', path: 'nope' },
          { type: 'field', path: 'issue.number' },
        ],
        payload,
      ),
    ).toBe('-/61');
  });
});
