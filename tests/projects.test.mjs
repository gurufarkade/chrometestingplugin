// Seam under test: the Projects module (src/shared/projects.js) — pure suite
// operations and the project export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { session, events } from './fixtures.mjs';
import { createProject, addSuite, addToSuite, removeFromSuite, moveInSuite, deleteSuite, suitesOf, buildProjectFiles, toProjectBackup, parseProjectBackup } from '../src/shared/projects.js';

test('create a project with suites and file scenarios into them', () => {
  let p = createProject({ name: 'Demo Shop', baseUrl: 'http://localhost:4321' });
  assert.equal(p.suites.length, 0);
  let smoke;
  ({ project: p, suite: smoke } = addSuite(p, 'Smoke'));
  let reg;
  ({ project: p, suite: reg } = addSuite(p, 'Regression'));
  p = addToSuite(p, smoke.id, 'sess_a');
  p = addToSuite(p, smoke.id, 'sess_b');
  p = addToSuite(p, smoke.id, 'sess_a'); // no duplicates
  p = addToSuite(p, reg.id, 'sess_a'); // a scenario can be in several suites
  assert.deepEqual(p.suites.map((s) => [s.name, s.scenarioIds]), [['Smoke', ['sess_a', 'sess_b']], ['Regression', ['sess_a']]]);
  assert.deepEqual(suitesOf([p], 'sess_a').map((x) => `${x.project.name} › ${x.suite.name}`), ['Demo Shop › Smoke', 'Demo Shop › Regression']);
});

test('reorder, remove and delete suites without mutating the input', () => {
  let p = createProject({ name: 'X' });
  let s;
  ({ project: p, suite: s } = addSuite(p, 'S'));
  for (const id of ['a', 'b', 'c']) p = addToSuite(p, s.id, id);
  const before = structuredClone(p);
  const moved = moveInSuite(p, s.id, 'c', -2);
  assert.deepEqual(moved.suites[0].scenarioIds, ['c', 'a', 'b']);
  assert.deepEqual(moveInSuite(moved, s.id, 'c', -1).suites[0].scenarioIds, ['c', 'a', 'b'], 'clamped at the top');
  assert.deepEqual(removeFromSuite(moved, s.id, 'a').suites[0].scenarioIds, ['c', 'b']);
  assert.equal(deleteSuite(moved, s.id).suites.length, 0);
  assert.deepEqual(p, before, 'input untouched');
});

test('suite names must be unique within a project', () => {
  let p = createProject({ name: 'X' });
  ({ project: p } = addSuite(p, 'Smoke'));
  assert.throws(() => addSuite(p, ' smoke '), /already exists/);
});

test('project export: runnable Playwright project + Cypress specs per suite', () => {
  let p = createProject({ name: 'Demo Shop', baseUrl: 'http://localhost:4321' });
  let smoke;
  ({ project: p, suite: smoke } = addSuite(p, 'Smoke'));
  p = addToSuite(p, smoke.id, session.id);
  const files = buildProjectFiles(p, [{ session, events, screenshots: [] }]);
  const names = files.map((f) => f.name);
  for (const n of ['README.md', 'package.json', 'playwright.config.ts', 'cypress.config.js', '.env.example', 'project.qa.json', 'tests/smoke/01-login-and-place-an-order.spec.ts', 'cypress/e2e/smoke/01-login-and-place-an-order.cy.js', 'ai-context/smoke/01-login-and-place-an-order.md']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const config = files.find((f) => f.name === 'playwright.config.ts').data;
  assert.match(config, /baseURL: process\.env\.BASE_URL \?\? 'http:\/\/localhost:4321'/);
  assert.match(config, /name: 'smoke'/);
  const env = files.find((f) => f.name === '.env.example').data;
  assert.match(env, /TEST_PASSWORD=/);
  assert.equal((env.match(/TEST_PASSWORD=/g) || []).length, 1, 'env vars merged across scenarios');
  const spec = files.find((f) => f.name.endsWith('.spec.ts')).data;
  assert.match(spec, /test\.describe\('Login and place an order'/);
  assert.ok(!files.some((f) => typeof f.data === 'string' && f.data.includes('Passw0rd!')), 'no secrets leak');
});

test('project backup round-trip', () => {
  let p = createProject({ name: 'Demo' });
  let s;
  ({ project: p, suite: s } = addSuite(p, 'Smoke'));
  p = addToSuite(p, s.id, session.id);
  const backup = toProjectBackup(p, [{ session, events, screenshots: [] }]);
  const parsed = parseProjectBackup(JSON.stringify(backup));
  assert.equal(parsed.project.name, 'Demo');
  assert.equal(parsed.scenarios[0].session.id, session.id);
  assert.equal(parsed.scenarios[0].events.length, events.length);
  assert.throws(() => parseProjectBackup('{}'), /Not a QA Scenario Recorder project/);
});
