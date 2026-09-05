'use client';

import type { AutomationRun } from '../../server/types.js';
import { AutomationRunChip } from './AutomationRunChip.js';
import { lastStartedRuns } from './automationRuns.js';

export function AutomationLastRunsCell({ runs }: { runs: readonly AutomationRun[] }) {
  const history = lastStartedRuns(runs);
  const collecting = runs.filter(run => run.status === 'coalescing').length;
  if (history.length === 0 && collecting === 0) {
    return <span className="text-text-secondary text-sm">—</span>;
  }
  return (
    <div className="flex items-center gap-1">
      {history.map(run => (
        <AutomationRunChip key={run.id} run={run} />
      ))}
      {collecting > 0 ? (
        <span className="text-text-secondary ml-1 text-xs">
          {String(collecting)} window{collecting === 1 ? '' : 's'} open
        </span>
      ) : null}
    </div>
  );
}
