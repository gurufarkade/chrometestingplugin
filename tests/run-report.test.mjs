// Seam under test: the Run report (src/shared/run-report.js)
//   buildRunReport({ results, recordedNetwork, replayNetwork, replayConsole, cancelled }) -> report
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunReport } from '../src/shared/run-report.js';

const net = (method, url, status, duration = 100) => ({ api: 'fetch', method, url, status, duration });

test('all steps passed and APIs match -> passed', () => {
  const r = buildRunReport({
    results: [{ status: 'passed' }, { status: 'passed' }, { status: 'skipped' }],
    recordedNetwork: [net('POST', 'https://a.test/api/orders', 201)],
    replayNetwork: [net('POST', 'https://a.test/api/orders', 201)],
    replayConsole: [],
  });
  assert.equal(r.status, 'passed');
  assert.deepEqual(r.counts, { passed: 2, failed: 0, skipped: 1, 'not-run': 0, warnings: 0 });
  assert.equal(r.headline, 'All 2 steps passed');
});

test('a failed step fails the run and names the first failure', () => {
  const r = buildRunReport({
    results: [{ status: 'passed' }, { status: 'failed', index: 1, action: 'click', error: 'Element "Save" not found' }, { status: 'not-run' }],
    recordedNetwork: [],
    replayNetwork: [],
    replayConsole: [],
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.headline, 'Step 2 failed: Element "Save" not found');
});

test('steps pass but the backend changed -> passed with warnings, issues listed', () => {
  const r = buildRunReport({
    results: [{ status: 'passed', warning: 'Outcome "Saved" did not appear' }],
    recordedNetwork: [net('POST', 'https://a.test/api/login', 200), net('GET', 'https://a.test/api/cart', 200)],
    replayNetwork: [net('POST', 'https://a.test/api/login', 500)],
    replayConsole: [{ level: 'error', message: 'boom' }, { level: 'warn', message: 'meh' }],
  });
  assert.equal(r.status, 'warning');
  assert.equal(r.counts.warnings, 1);
  assert.equal(r.consoleErrors, 1);
  assert.deepEqual(r.issues, [
    'POST https://a.test/api/login: 200 → 500',
    'Not called: GET https://a.test/api/cart',
    '1 console error',
    '1 step warning',
  ]);
});

test('cancelled run', () => {
  const r = buildRunReport({ results: [{ status: 'passed' }, { status: 'not-run' }], recordedNetwork: [], replayNetwork: [], replayConsole: [], cancelled: true });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.headline, 'Cancelled after 1 of 2 steps');
});
