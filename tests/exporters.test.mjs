import { test } from 'node:test';
import assert from 'node:assert/strict';
import { session, events, screenshots } from './fixtures.mjs';
import {
  buildScenario,
  toPlaywright,
  toCypress,
  toPostman,
  toHar,
  toAiContext,
  toTestCaseMarkdown,
  buildEvidencePack,
  playwrightLocator,
  cypressLocator,
  pathRegexLiteral,
  parseBackup,
  toBackup,
  envExample,
} from '../src/shared/exporters.js';

const scn = (secrets = 'placeholder') => buildScenario(session, events, { secrets, screenshots });

test('scenario: steps, API attribution and navigation', () => {
  const s = scn();
  assert.equal(s.steps.length, 13);
  assert.equal(s.origin, 'http://localhost:4321');
  const signIn = s.steps.find((x) => x.target?.friendly === 'Sign in');
  assert.deepEqual(signIn.apiCalls.map((a) => `${a.method} ${a.route} ${a.status}`), ['POST /api/login 200', 'GET /api/products 200']);
  assert.equal(signIn.navigatedTo, 'http://localhost:4321/app/products');
  const view = s.steps.find((x) => x.target?.friendly === 'View order');
  assert.equal(view.apiCalls[0].route, '/api/orders/:id');
  assert.match(view.description, /in the "Order confirmed" dialog/);
  assert.equal(s.failedApis.length, 1);
  assert.equal(s.failedApis[0].status, 500);
  assert.deepEqual(s.notes, [{ step: 9, flag: 'bug', text: 'Coupon returns 500' }]);
  assert.equal(s.steps[0].screenshot, 'screenshots/step-01-goto.jpg');
});

test('credentials: detected, username paired, placeholders by default', () => {
  const s = scn();
  assert.deepEqual(s.credentials.map((c) => [c.variable, c.role, c.value]), [
    ['TEST_USERNAME', 'username', '<TEST_USERNAME>'],
    ['TEST_PASSWORD', 'password', '<TEST_PASSWORD>'],
  ]);
  // password must not leak via the captured request body either
  const login = s.apis.find((a) => a.route === '/api/login');
  assert.ok(!login.requestBody.includes('Passw0rd!'));
  assert.ok(login.requestBody.includes('<TEST_PASSWORD>'));
  // Authorization header masked
  assert.equal(s.apis.find((a) => a.route === '/api/products').requestHeaders.Authorization, '***MASKED***');
  assert.equal(Object.keys(s.testData).length, 0);
});

test('credentials: include mode exposes real values', () => {
  const s = scn('include');
  assert.equal(s.credentials.find((c) => c.role === 'password').value, 'Passw0rd!');
  assert.match(envExample(s), /TEST_PASSWORD=Passw0rd!/);
  assert.match(toPlaywright(s), /process\.env\.TEST_PASSWORD \?\? 'Passw0rd!'/);
});

test('no secret leaks anywhere in placeholder exports', () => {
  const s = scn();
  const outputs = [toPlaywright(s), toCypress(s), toAiContext(s), toTestCaseMarkdown(s), JSON.stringify(toPostman(s)), JSON.stringify(toHar(s)), envExample(s)];
  for (const out of outputs) {
    assert.ok(!out.includes('Passw0rd!'), 'password leaked');
    assert.ok(!out.includes('Bearer tok_abc'), 'auth header leaked');
  }
});

test('locators: priority and uniqueness handling', () => {
  const s = scn();
  const byName = (n) => s.steps.find((x) => x.target?.friendly === n).target;
  assert.equal(byName('Sign in').locators.playwright, "page.getByRole('button', { name: 'Sign in', exact: true })");
  assert.equal(byName('Add to cart').locators.playwright, "page.getByTestId('add-101')");
  assert.equal(byName('Add to cart').locators.cypress, `cy.get('[data-testid="add-101"]')`);
  assert.equal(byName('Sign in').locators.cypress, "cy.contains('button', 'Sign in')");
  // non-unique-only candidate falls back to .first()
  assert.equal(playwrightLocator({ candidates: [{ type: 'role', role: 'button', name: 'Save', unique: false }] }), "page.getByRole('button', { name: 'Save', exact: true }).first()");
  assert.equal(cypressLocator({ tag: 'div', candidates: [{ type: 'css', css: 'div > span', unique: false }] }), "cy.get('div > span').first()");
  // quotes are escaped
  assert.equal(playwrightLocator({ candidates: [{ type: 'text', value: "Don't", unique: true }] }), "page.getByText('Don\\'t', { exact: true })");
});

test('pathRegexLiteral normalises ids', () => {
  assert.equal(pathRegexLiteral('http://x.test/api/orders/5001'), '/\\/api\\/orders\\/[^/]+(?:[?#]|$)/');
  // eslint-disable-next-line no-eval
  const re = eval(pathRegexLiteral('http://x.test/api/orders/5001'));
  assert.ok(re.test('/api/orders/77'));
  assert.ok(re.test('/api/orders/77?x=1'));
  assert.ok(!re.test('/api/orders/77/items'));
});

test('playwright spec structure', () => {
  const code = toPlaywright(scn());
  assert.match(code, /import \{ test, expect \} from '@playwright\/test';/);
  assert.match(code, /await page\.goto\(`\$\{BASE_URL\}\/app\/login`\);/);
  assert.match(code, /\.fill\(credentials\.username\);/);
  assert.match(code, /\.fill\(credentials\.password\);/);
  assert.match(code, /page\.waitForResponse\(\(r\) => \/\\\/api\\\/login/);
  assert.match(code, /expect\(\(await resp4_1\)\.status\(\)\)\.toBe\(200\);/);
  assert.match(code, /await expect\(page\)\.toHaveURL\(\/\\\/app\\\/products/);
  assert.match(code, /selectOption\('peripherals'\)/);
  assert.match(code, /page\.locator\('#express'\)\.check\(\)/);
  assert.match(code, /toContainText\('CONFIRMED'\)/);
  assert.match(code, /page\.keyboard\.press\('Control\+k'\)/);
  assert.match(code, /\/\/ BUG \(tester\): Coupon returns 500/);
  assert.match(code, /test\.use\(\{ viewport: \{ width: 1280, height: 720 \} \}\);/);
  // balanced braces as a cheap syntax sanity check
  assert.equal((code.match(/\{/g) || []).length, (code.match(/\}/g) || []).length);
});

test('playwright spec is valid JavaScript once TS types are absent', async () => {
  // The generated spec has no TS-only syntax, so it must parse as an ES module.
  const code = toPlaywright(scn()).replace("import { test, expect } from '@playwright/test';", 'const test = () => {}; test.describe = () => {}; test.use = () => {}; test.step = () => {}; const expect = () => {};');
  await import(`data:text/javascript,${encodeURIComponent(code)}`);
});

test('cypress spec structure and validity', async () => {
  const code = toCypress(scn());
  assert.match(code, /cy\.intercept\(\{ method: 'POST', pathname: '\/api\/login' \}\)\.as\('step4PostApiLogin'\);/);
  assert.match(code, /cy\.intercept\(\{ method: 'GET', pathname: '\/api\/orders\/\*' \}\)/);
  assert.match(code, /cy\.wait\('@step4PostApiLogin'\)\.its\('response\.statusCode'\)\.should\('eq', 200\);/);
  assert.match(code, /\.type\(credentials\.password, \{ delay: 0, parseSpecialCharSequences: false, log: false \}\)/);
  assert.match(code, /cy\.get\('#category'\)\.select\('peripherals'\);/);
  assert.match(code, /should\('contain\.text', 'CONFIRMED'\)/);
  assert.match(code, /cy\.focused\(\)\.type\('\{ctrl\}k'\);/);
  const shim = "const Cypress = { env: () => undefined }; const describe = () => {}; const it = () => {}; const beforeEach = () => {};";
  await import(`data:text/javascript,${encodeURIComponent(shim + code)}`);
});

test('postman collection groups calls by step with status tests', () => {
  const col = toPostman(scn());
  assert.equal(col.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  const all = col.item.flatMap((f) => f.item);
  assert.equal(all.length, 5);
  const login = all.find((i) => i.request.url.raw === '{{baseUrl}}/api/login');
  assert.equal(login.request.method, 'POST');
  assert.equal(login.request.body.options.raw.language, 'json');
  assert.match(login.event[0].script.exec[0], /status\(200\)/);
  const products = all.find((i) => i.request.url.raw.startsWith('{{baseUrl}}/api/products'));
  assert.equal(products.request.header.find((h) => h.key === 'Authorization').value, '{{authorization}}');
  assert.ok(col.variable.some((v) => v.key === 'authorization'));
});

test('HAR is well-formed', () => {
  const har = toHar(scn());
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 5);
  const e = har.log.entries[0];
  assert.ok(e.startedDateTime.endsWith('Z'));
  assert.equal(e.request.method, 'POST');
  assert.equal(e.response.status, 200);
  assert.ok(e.request.postData.text.includes('<TEST_PASSWORD>'));
});

test('AI context contains everything an assistant needs', () => {
  const md = toAiContext(scn());
  for (const needle of ['## Instructions for the AI assistant', '## Credentials & secrets', 'TEST_PASSWORD', '## Steps', '### Step 4', 'POST http://localhost:4321/api/login', '## API inventory', '## Console errors observed', '## Tester notes', '```json', 'getByRole']) {
    assert.ok(md.includes(needle), `missing: ${needle}`);
  }
  const json = md.slice(md.lastIndexOf('```json') + 7, md.lastIndexOf('```'));
  const parsed = JSON.parse(json);
  assert.equal(parsed.steps.length, 13);
});

test('manual test case lists steps, expectations and issues', () => {
  const md = toTestCaseMarkdown(scn());
  assert.match(md, /\| 4 \| Click the "Sign in" button in the "Sign in" form \| User lands on \/app\/products; POST \/api\/login → 200/);
  assert.match(md, /🐞 \*\*Step 9\*\* — Coupon returns 500/);
  assert.match(md, /Check the "Express delivery" checkbox/);
  assert.match(md, /`POST \/api\/coupon` returned \*\*500\*\*/);
});

test('evidence pack zip contains all artefacts', () => {
  const s = scn();
  const zip = buildEvidencePack(s, screenshots, { session, events });
  const text = Buffer.from(zip).toString('latin1');
  for (const name of ['README.md', 'ai-context.md', 'test-case.md', 'scenario.json', 'tests/playwright/login-and-place-an-order.spec.ts', 'tests/cypress/login-and-place-an-order.cy.js', 'api/postman_collection.json', 'api/traffic.har', '.env.example', 'screenshots/step-01-goto.jpg', 'screenshots/step-04-click.jpg', 'screenshots/other/01-page-load.jpg', 'session-backup.json']) {
    assert.ok(text.includes(name), `zip missing ${name}`);
  }
});

test('backup round-trip', () => {
  const b = toBackup(session, events);
  const parsed = parseBackup(JSON.stringify(b));
  assert.equal(parsed.events.length, events.length);
  assert.throws(() => parseBackup('{"foo":1}'), /Not a QA Scenario Recorder/);
});

test('skipped steps are excluded', () => {
  const evs = events.map((e) => (e.action === 'check' ? { ...e, skip: true } : e));
  const s = buildScenario(session, evs, {});
  assert.equal(s.steps.length, 12);
  assert.ok(!s.steps.some((x) => x.action === 'check'));
});

test('test data keys are derived from field labels', () => {
  const evs = [
    { id: 1, seq: 1, ts: 1, kind: 'step', action: 'goto', url: 'https://app.test/form' },
    { id: 2, seq: 2, ts: 2, kind: 'step', action: 'fill', value: 'Ada', url: 'https://app.test/form', target: { tag: 'input', label: 'First name', friendly: 'First name', candidates: [] } },
    { id: 3, seq: 3, ts: 3, kind: 'step', action: 'fill', value: 'Lovelace', url: 'https://app.test/form', target: { tag: 'input', label: 'First name', friendly: 'First name', candidates: [] } },
  ];
  const s = buildScenario({ id: 'x', name: 'Form', startUrl: 'https://app.test/form', createdAt: 0 }, evs, {});
  assert.deepEqual(s.testData, { firstName: 'Ada', firstName2: 'Lovelace' });
  assert.match(toPlaywright(s), /fill\(testData\.firstName2\)/);
});
