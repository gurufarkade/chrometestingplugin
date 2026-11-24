// Seam under test: the Test data module (src/shared/test-data.js)
//   buildDataPlan(steps, opts) -> Data plan  (what each field is + recommended strategy + why)
//   resolveData(plan, choices, opts) -> { values: {stepId: value}, fields }   (values for one Run)
//   applyData(steps, resolved) -> steps with values substituted (incl. dependent assertions)
//   generatorSource(field) -> JS expression used by exported specs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataPlan, resolveData, applyData, generatorSource, dataHelpersSource, createRng } from '../src/shared/test-data.js';

const NOW = Date.UTC(2026, 10, 24);
let id = 0;
const fill = (value, target, extra = {}) => ({ id: ++id, kind: 'step', action: 'fill', value, url: 'https://app.test/register', target: { tag: 'input', ...target }, ...extra });
const select = (value, label, options) => ({ id: ++id, kind: 'step', action: 'select', value, values: [value], optionLabels: [label], target: { tag: 'select', label: 'Country', options } });
const click = (name) => ({ id: ++id, kind: 'step', action: 'click', target: { tag: 'button', role: 'button', name, friendly: name } });

function signupSteps() {
  return [
    fill('Ada', { label: 'First name', nameAttr: 'firstName', autocomplete: 'given-name', context: { form: 'Create account' } }),
    fill('Lovelace', { label: 'Last name', nameAttr: 'lastName', context: { form: 'Create account' } }),
    fill('ada@acme.io', { type: 'email', label: 'Email', context: { form: 'Create account' } }),
    fill('+971 50 123 4567', { type: 'tel', label: 'Mobile number', context: { form: 'Create account' } }),
    fill('S3cret!pass', { type: 'password', label: 'Password', context: { form: 'Create account' } }, { sensitive: true }),
    select('ae', 'United Arab Emirates', [{ value: '', label: 'Choose…' }, { value: 'ae', label: 'United Arab Emirates' }, { value: 'in', label: 'India' }]),
    click('Create account'),
    { id: ++id, kind: 'step', action: 'assert', assert: { type: 'text', expected: 'Welcome, Ada!' }, target: { tag: 'h1' } },
  ];
}

test('recognises field kinds from labels, types, autocomplete and values', () => {
  const plan = buildDataPlan(signupSteps(), { now: NOW });
  const kinds = Object.fromEntries(plan.fields.map((f) => [f.label, f.kind]));
  assert.deepEqual(kinds, {
    'First name': 'firstName',
    'Last name': 'lastName',
    Email: 'email',
    'Mobile number': 'phone',
    Password: 'password',
    Country: 'option',
  });
  assert.equal(plan.fields.find((f) => f.kind === 'password').secret, true);
});

test('sign-up scenario: unique fields must be fresh, and says why', () => {
  const plan = buildDataPlan(signupSteps(), { now: NOW });
  assert.equal(plan.intent, 'signup');
  const email = plan.fields.find((f) => f.kind === 'email');
  assert.equal(email.strategy, 'fresh');
  assert.match(email.reason, /unique/i);
  assert.equal(plan.fields.find((f) => f.kind === 'option').strategy, 'recorded');
  assert.equal(plan.needsDecision, true);
});

test('login scenario: credentials are reused, nothing to decide', () => {
  const steps = [
    fill('qa@example.com', { type: 'email', label: 'Email', context: { form: 'Sign in' } }),
    fill('Passw0rd!', { type: 'password', label: 'Password', context: { form: 'Sign in' } }, { sensitive: true }),
    click('Sign in'),
  ];
  const plan = buildDataPlan(steps, { now: NOW });
  assert.equal(plan.intent, 'login');
  assert.ok(plan.fields.every((f) => f.strategy === 'recorded'));
  assert.equal(plan.needsDecision, false);
});

test('shopping actions ("Add to cart") are not a create flow; typed fields decide the scenario type', () => {
  const steps = [
    fill('qa@example.com', { type: 'email', label: 'Email', context: { form: 'Sign in' } }),
    fill('Passw0rd!', { type: 'password', label: 'Password', context: { form: 'Sign in' } }, { sensitive: true }),
    click('Sign in'),
    select('peripherals', 'Peripherals', [{ value: 'peripherals', label: 'Peripherals' }]),
    click('Add to cart'),
  ];
  const plan = buildDataPlan(steps, { now: NOW });
  assert.equal(plan.intent, 'login');
  assert.equal(plan.needsDecision, false);
  const createUser = buildDataPlan([fill('Grace', { label: 'Name', context: { form: 'Add user' } }), click('Save')], { now: NOW });
  assert.equal(createUser.intent, 'create');
});

test('search terms are kept; one-time codes must be supplied by the tester', () => {
  const steps = [
    fill('keyboard', { type: 'search', role: 'searchbox', label: 'Search products', placeholder: 'Search products' }),
    fill('482913', { label: 'Verification code', autocomplete: 'one-time-code', maxLength: 6 }, { sensitive: true }),
  ];
  const plan = buildDataPlan(steps, { now: NOW });
  const [search, otp] = plan.fields;
  assert.equal(search.kind, 'search');
  assert.equal(search.strategy, 'recorded');
  assert.equal(otp.kind, 'otp');
  assert.equal(otp.strategy, 'custom');
  assert.match(otp.reason, /changes every time/i);
});

test('a booking date recorded in the past is refreshed to a future date', () => {
  const steps = [fill('2026-01-10', { type: 'date', label: 'Check-in date', context: { form: 'Book a room' } })];
  const plan = buildDataPlan(steps, { now: NOW });
  const f = plan.fields[0];
  assert.equal(f.kind, 'date');
  assert.equal(f.strategy, 'fresh');
  assert.match(f.reason, /past/i);
  const { values } = resolveData(plan, { mode: 'recommended' }, { rng: createRng(1), now: NOW });
  assert.ok(new Date(values[f.stepId]) > new Date(NOW), 'generated date must be in the future');
});

test('fresh values are realistic, respect constraints and keep the recorded shape', () => {
  const steps = signupSteps();
  steps.push(fill('ACME-1234', { label: 'Promo code', maxLength: 9, pattern: '[A-Z]{4}-[0-9]{4}' }));
  steps.push(fill('42', { type: 'number', label: 'Age', min: '18', max: '65' }));
  const plan = buildDataPlan(steps, { now: NOW });
  const { values } = resolveData(plan, { mode: 'fresh' }, { rng: createRng(7), now: NOW });
  const v = (label) => values[plan.fields.find((f) => f.label === label).stepId];

  assert.match(v('Email'), /^ada\+[a-z0-9]{6}@acme\.io$/, 'plus-addressing keeps mail in the tester inbox');
  assert.notEqual(v('First name'), 'Ada');
  assert.match(v('First name'), /^[A-Z][a-z]+$/);
  assert.match(v('Mobile number'), /^\+971 50 \d{3} \d{4}$/, 'phone keeps country code and format');
  assert.match(v('Password'), /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/);
  assert.ok(['ae', 'in'].includes(v('Country')));
  assert.match(v('Promo code'), /^[A-Z]{4}-[0-9]{4}$/);
  assert.ok(v('Promo code').length <= 9);
  const age = Number(v('Age'));
  assert.ok(age >= 18 && age <= 65);
});

test('same seed gives the same data; different seeds differ', () => {
  const plan = buildDataPlan(signupSteps(), { now: NOW });
  const a = resolveData(plan, { mode: 'fresh' }, { rng: createRng(3), now: NOW }).values;
  const b = resolveData(plan, { mode: 'fresh' }, { rng: createRng(3), now: NOW }).values;
  const c = resolveData(plan, { mode: 'fresh' }, { rng: createRng(4), now: NOW }).values;
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('modes: recorded keeps everything, custom values win, per-field strategy overrides', () => {
  const plan = buildDataPlan(signupSteps(), { now: NOW });
  const email = plan.fields.find((f) => f.kind === 'email');
  const first = plan.fields.find((f) => f.kind === 'firstName');
  const rec = resolveData(plan, { mode: 'recorded' }, { rng: createRng(1), now: NOW }).values;
  assert.equal(rec[email.stepId], 'ada@acme.io');
  const mixed = resolveData(plan, { mode: 'recorded', strategies: { [first.key]: 'fresh' }, custom: { [email.key]: 'me@x.io' } }, { rng: createRng(1), now: NOW }).values;
  assert.equal(mixed[email.stepId], 'me@x.io');
  assert.notEqual(mixed[first.stepId], 'Ada');
});

test('applyData substitutes values and keeps dependent assertions consistent', () => {
  const steps = signupSteps();
  const plan = buildDataPlan(steps, { now: NOW });
  const first = plan.fields.find((f) => f.kind === 'firstName');
  const resolved = resolveData(plan, { mode: 'recorded', custom: { [first.key]: 'Grace' } }, { rng: createRng(1), now: NOW });
  const out = applyData(steps, resolved);
  assert.equal(out.find((s) => s.id === first.stepId).value, 'Grace');
  assert.equal(out.find((s) => s.action === 'assert').assert.expected, 'Welcome, Grace!');
  assert.equal(steps.find((s) => s.id === first.stepId).value, 'Ada', 'input steps are not mutated');
});

test('generatorSource produces runnable expressions for exported specs', () => {
  const plan = buildDataPlan(signupSteps(), { now: NOW });
  const helpers = dataHelpersSource();
  for (const f of plan.fields.filter((x) => !x.secret)) {
    const expr = generatorSource(f);
    // eslint-disable-next-line no-new-func
    const value = new Function(`${helpers}\nreturn (${expr});`)();
    assert.equal(typeof value, 'string', `${f.kind} -> ${expr}`);
    assert.ok(value.length > 0, `${f.kind} produced an empty value`);
    if (f.kind === 'email') assert.match(value, /@acme\.io$/);
  }
});
