// Run report — the single place that decides what a Run means: its status,
// counts, headline, API diff against the recording and the issue list.
// Used by the service worker (to store), popup, dashboard and exporters (to show).
//
// Interface:
//   buildRunReport({ results, recordedNetwork, replayNetwork, replayConsole, cancelled }) ->
//     { status: 'passed'|'warning'|'failed'|'cancelled', counts, headline, issues[], apiDiff, consoleErrors }
import { diffApiCalls } from './analysis.js';

export function buildRunReport({ results = [], recordedNetwork = [], replayNetwork = [], replayConsole = [], cancelled = false }) {
  const counts = { passed: 0, failed: 0, skipped: 0, 'not-run': 0, warnings: 0 };
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.warning) counts.warnings++;
  }
  const apiDiff = diffApiCalls(recordedNetwork, replayNetwork);
  const consoleErrors = replayConsole.filter((c) => c.level === 'error').length;

  const issues = [
    ...apiDiff.statusChanged.map((x) => `${x.signature}: ${x.recordedStatus} → ${x.replayStatus}`),
    ...apiDiff.missing.map((x) => `Not called: ${x.signature}`),
    ...apiDiff.unexpected.map((x) => `New call: ${x.signature} (${x.replayStatus})`),
    ...apiDiff.slower.map((x) => `Slower: ${x.signature} ${x.recordedMs} → ${x.replayMs} ms`),
  ];
  if (consoleErrors) issues.push(`${consoleErrors} console error${consoleErrors > 1 ? 's' : ''}`);
  if (counts.warnings) issues.push(`${counts.warnings} step warning${counts.warnings > 1 ? 's' : ''}`);

  const executed = counts.passed + counts.failed + counts.skipped;
  const firstFailure = results.find((r) => r.status === 'failed');
  let status;
  let headline;
  if (cancelled) {
    status = 'cancelled';
    headline = `Cancelled after ${executed} of ${results.length} steps`;
  } else if (firstFailure) {
    status = 'failed';
    headline = `Step ${(firstFailure.index ?? results.indexOf(firstFailure)) + 1} failed: ${firstFailure.error}`;
  } else if (issues.length) {
    status = 'warning';
    headline = `All ${counts.passed} steps passed — ${issues.length} issue${issues.length > 1 ? 's' : ''} to review`;
  } else {
    status = 'passed';
    headline = `All ${counts.passed} steps passed`;
  }
  return { status, counts, headline, issues, apiDiff, consoleErrors };
}
