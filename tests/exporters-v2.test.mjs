// Seam under test: the exporters' public functions, for the v1.1 capabilities:
// scoped / shadow / iframe locators, hover + drag, Outcomes as assertions, and
// Test data generated inside the exported specs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, toPlaywright, toCypress, toAiContext, toTestCaseMarkdown, playwrightLocator, cypressLocator } from '../src/shared/exporters.js';

const T0 = Date.UTC(2026, 10, 24);
let n = 0;
const step = (ts, data) => ({ id: ++n, seq: n, ts: T0 + ts, kind: 'step', sessionId: 's', runId: null, url: 'https://shop.test/products', ...data });
const session = { id: 's', name: 'Kanban and checkout', createdAt: T0, startUrl: 'https://shop.test/products', environment: {} };

const scoped = {
  tag: 'button', role: 'button', name: 'Add to cart', friendly: 'Add to cart', context: { row: 'Mechanical keyboard — $89.00' },
  candidates: [
    { type: 'scoped', scope: { kind: 'row', role: 'row', css: 'tr', text: 'Mechanical keyboard' }, inner: { type: 'role', role: 'button', name: 'Add to cart' }, unique: true },
    { type: 'role', role: 'button', name: 'Add to cart', unique: false },
    { type: 'css', css: 'tr:nth-of-type(1) > td > button', value: 'tr:nth-of-type(1) > td > button', unique: true },
  ],
};
const shadow = { tag: 'button', friendly: 'Save', candidates: [{ type: 'css', css: 'button.save', value: 'button.save', shadow: ['my-app', 'x-editor'], unique: true }] };
const inFrame = { tag: 'input', label: 'Card number', friendly: 'Card number', candidates: [{ type: 'label', value: 'Card number', unique: true }, { type: 'css', css: '#cc', value: '#cc', unique: true }] };
const frame = { url: 'https://pay.test/widget', name: 'payment', selector: 'iframe[name="payment"]' };
const card = { tag: 'div', friendly: 'Card A', candidates: [{ type: 'testid', attr: 'data-testid', value: 'card-a', css: '[data-testid="card-a"]', unique: true }] };
const lane = { tag: 'div', friendly: 'Done', candidates: [{ type: 'testid', attr: 'data-testid', value: 'lane-done', css: '[data-testid="lane-done"]', unique: true }] };
const menu = { tag: 'li', friendly: 'Account', candidates: [{ type: 'id', value: 'account', css: '#account', unique: true }] };

const events = [
  step(0, { action: 'goto', url: 'https://shop.test/products' }),
  step(1000, { action: 'click', target: scoped, outcomes: [{ kind: 'toast', text: 'Added to cart' }, { kind: 'title', text: 'Cart (1) – Shop' }] }),
  step(2000, { action: 'hover', target: menu }),
  step(3000, { action: 'click', target: shadow, outcomes: [{ kind: 'dialog', text: 'Confirm save' }, { kind: 'validation', text: 'Please fill out this field.', native: true, field: 'Name' }] }),
  step(4000, { action: 'drag', target: card, dropTarget: lane, html5: true }),
  step(5000, { action: 'fill', value: '4111111111111111', target: inFrame, frame }),
  step(6000, { action: 'fill', value: 'ada@acme.io', target: { tag: 'input', type: 'email', label: 'Email', friendly: 'Email', context: { form: 'Create account' }, candidates: [{ type: 'label', value: 'Email', unique: true }] } }),
  step(7000, { action: 'click', target: { tag: 'button', role: 'button', name: 'Create account', friendly: 'Create account', candidates: [{ type: 'role', role: 'button', name: 'Create account', unique: true }] } }),
];
const scn = (opts = {}) => buildScenario(session, events, opts);

test('scoped locators chain container + text + inner locator', () => {
  assert.equal(playwrightLocator(scoped), "page.getByRole('row').filter({ hasText: 'Mechanical keyboard' }).getByRole('button', { name: 'Add to cart', exact: true })");
  assert.equal(cypressLocator(scoped), "cy.contains('tr', 'Mechanical keyboard').contains('button', 'Add to cart')");
});

test('shadow DOM locators', () => {
  assert.equal(playwrightLocator(shadow), "page.locator('my-app').locator('x-editor').locator('button.save')");
  assert.equal(cypressLocator(shadow), "cy.get('my-app').shadow().find('x-editor').shadow().find('button.save')");
});

test('iframe locators', () => {
  assert.equal(playwrightLocator(inFrame, frame), "page.frameLocator('iframe[name=\"payment\"]').getByLabel('Card number', { exact: true })");
  assert.equal(cypressLocator(inFrame, frame), "qaIframe('iframe[name=\"payment\"]').find('#cc')");
});

test('Playwright: hover, drag, outcomes as assertions, frame steps', () => {
  const code = toPlaywright(scn());
  assert.match(code, /await page\.locator\('#account'\)\.hover\(\);/);
  assert.match(code, /await page\.getByTestId\('card-a'\)\.dragTo\(page\.getByTestId\('lane-done'\)\);/);
  assert.match(code, /await expect\(page\.getByText\('Added to cart'\)\)\.toBeVisible\(\);/);
  assert.match(code, /await expect\(page\)\.toHaveTitle\('Cart \(1\) – Shop'\);/);
  assert.match(code, /await expect\(page\.getByRole\('dialog', \{ name: 'Confirm save' \}\)\)\.toBeVisible\(\);/);
  assert.match(code, /\/\/ Browser validation on "Name": Please fill out this field\./);
  assert.match(code, /page\.frameLocator\('iframe\[name="payment"\]'\)\.getByLabel\('Card number', \{ exact: true \}\)\.fill\(testData\.cardNumber\)/);
});

test('Cypress: hover, drag, outcomes, iframe helper', async () => {
  const code = toCypress(scn());
  assert.match(code, /cy\.get\('#account'\)\.trigger\('mouseover'\);/);
  assert.match(code, /const dataTransfer = new DataTransfer\(\);/);
  assert.match(code, /cy\.get\('\[data-testid="card-a"\]'\)\.trigger\('dragstart', \{ dataTransfer \}\);/);
  assert.match(code, /cy\.get\('\[data-testid="lane-done"\]'\)\.trigger\('dragover', \{ dataTransfer \}\)\.trigger\('drop', \{ dataTransfer \}\);/);
  assert.match(code, /cy\.contains\('Added to cart'\)\.should\('be\.visible'\);/);
  assert.match(code, /cy\.title\(\)\.should\('eq', 'Cart \(1\) – Shop'\);/);
  assert.match(code, /const qaIframe = \(sel\) =>/);
  const shim = 'const Cypress = { env: () => undefined }; const describe = () => {}; const it = () => {}; const beforeEach = () => {};';
  await import(`data:text/javascript,${encodeURIComponent(shim + code)}`);
});

test('fresh test data is generated inside the specs when the plan asks for it', async () => {
  const s = scn({ data: 'recommended' });
  const email = s.dataPlan.find((f) => f.kind === 'email');
  assert.equal(email.strategy, 'fresh');
  const pw = toPlaywright(s);
  assert.match(pw, /const qaData = \{/);
  assert.match(pw, /email: `ada\+\$\{qaData\.uid\(6\)\}@acme\.io`,/);
  assert.match(pw, /cardNumber: '4111111111111111',/);
  const recorded = toPlaywright(scn({ data: 'recorded' }));
  assert.doesNotMatch(recorded, /qaData/);
  assert.match(recorded, /email: 'ada@acme\.io',/);
  // still valid JS
  const code = pw.replace("import { test, expect } from '@playwright/test';", 'const test = () => {}; test.describe = () => {}; test.use = () => {}; test.step = () => {}; const expect = () => {};');
  await import(`data:text/javascript,${encodeURIComponent(code)}`);
});

test('AI context and test case include data plan, outcomes and frames', () => {
  const s = scn({ data: 'recommended' });
  const md = toAiContext(s);
  assert.match(md, /## Test data plan/);
  assert.match(md, /\| `email` \| Email \| email \| fresh \| Must be unique/);
  assert.match(md, /\*\*Expected results seen:\*\* toast "Added to cart"/);
  assert.match(md, /\*\*Frame:\*\* iframe\[name="payment"\]/);
  const tc = toTestCaseMarkdown(s);
  assert.match(tc, /Shows "Added to cart"/);
});
