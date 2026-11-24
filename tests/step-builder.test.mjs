// Seam under test: the Step builder (src/content/step-builder.js), loaded the
// way Chrome loads it — a classic script attaching to globalThis.QA.
//   QA.createStepBuilder({ emit, page }) -> { handle(interaction) }
// Interactions are DOM-free facts produced by the recorder's DOM adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/content/step-builder.js', import.meta.url), 'utf8');

function setup() {
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  const ops = [];
  let now = 1000;
  const b = ctx.QA.createStepBuilder({ emit: (op) => ops.push(op), page: () => ({ url: 'https://app.test/x', title: 'X', ts: now }) });
  const el = (name, facts = {}) => ({ ref: { name }, describe: () => ({ friendly: name }), facts });
  const tick = (ms) => (now += ms);
  // Steps as the background would store them: apply add/update ops in order.
  const steps = () => {
    const out = [];
    for (const o of ops) {
      if (o.op === 'add') out.push({ ...o.step, cid: o.cid });
      else Object.assign(out.find((s) => s.cid === o.cid), o.step);
    }
    return out;
  };
  return { b, ops, el, tick, steps };
}

test('typing merges into one fill; committing the value takes a screenshot', () => {
  const { b, el, ops, steps } = setup();
  const email = el('Email', { textLike: true });
  for (const v of ['q', 'qa', 'qa@x.io']) b.handle({ type: 'input', ...email, value: v });
  b.handle({ type: 'change', ...email, value: 'qa@x.io' });
  assert.deepEqual(steps().map((s) => [s.action, s.value]), [['fill', 'qa@x.io']]);
  assert.equal(ops.filter((o) => o.screenshot).length, 1);
});

test('focusing another field ends merging', () => {
  const { b, el, steps } = setup();
  const a = el('A', { textLike: true });
  const c = el('B', { textLike: true });
  b.handle({ type: 'input', ...a, value: '1' });
  b.handle({ type: 'focus', ...c });
  b.handle({ type: 'input', ...c, value: '2' });
  b.handle({ type: 'focus', ...a });
  b.handle({ type: 'input', ...a, value: '13' });
  assert.deepEqual(steps().map((s) => s.value), ['1', '2', '13']);
});

test('clicks that only focus a field, toggles and native selects are recorded via change', () => {
  const { b, el, steps } = setup();
  b.handle({ type: 'click', ...el('Email', { textLike: true }), button: 'left', detail: 1 });
  const box = el('Express', { toggle: true });
  b.handle({ type: 'click', ...box, button: 'left', detail: 1 });
  b.handle({ type: 'change', ...box, facts: { toggle: true, checked: true } });
  b.handle({ type: 'click', ...el('Country', { select: true }), button: 'left', detail: 1 });
  b.handle({ type: 'change', ...el('Country'), facts: { select: true }, value: 'ae', values: ['ae'], optionLabels: ['UAE'] });
  assert.deepEqual(steps().map((s) => s.action), ['check', 'select']);
});

test('a double-click becomes one dblclick step', () => {
  const { b, el, steps, tick } = setup();
  const row = el('Row');
  b.handle({ type: 'click', ...row, button: 'left', detail: 1 });
  tick(100);
  b.handle({ type: 'click', ...row, button: 'left', detail: 2 });
  b.handle({ type: 'dblclick', ...row });
  assert.deepEqual(steps().map((s) => s.action), ['dblclick']);
});

test('keyboard: Enter/Escape/shortcuts kept, typing and dropdown keys ignored', () => {
  const { b, el, steps } = setup();
  const field = el('Search', { textLike: true });
  b.handle({ type: 'keydown', ...field, key: 'a' });
  b.handle({ type: 'keydown', ...field, key: 'c', modifiers: { ctrl: true } });
  b.handle({ type: 'keydown', ...field, key: 'Enter' });
  b.handle({ type: 'keydown', ...el('Country', { select: true }), key: 'Enter' });
  b.handle({ type: 'keydown', ...el('Notes', { textLike: true, textarea: true }), key: 'Enter' });
  b.handle({ type: 'keydown', ...el('Body', { body: true }), key: 'k', modifiers: { ctrl: true } });
  b.handle({ type: 'keydown', ...el('Dialog'), key: 'Escape' });
  assert.deepEqual(steps().map((s) => `${s.action}:${s.key}`), ['press:Enter', 'press:k', 'press:Escape']);
  assert.equal(steps()[1].target, undefined, 'page-level shortcut has no target');
});

test('clicking inside a hover-revealed menu inserts one hover step per real hover', () => {
  const { b, el, steps } = setup();
  const account = el('Account');
  b.handle({ type: 'hover', ...account });
  b.handle({ type: 'click', ...el('Theme', { hoverOwner: account.ref }), button: 'left', detail: 1 });
  b.handle({ type: 'click', ...el('Dark', { hoverOwner: account.ref }), button: 'left', detail: 1 }); // menu still open
  b.handle({ type: 'hover', ...account }); // menu closed, tester hovers again
  b.handle({ type: 'click', ...el('Profile', { hoverOwner: account.ref }), button: 'left', detail: 1 });
  b.handle({ type: 'click', ...el('Save'), button: 'left', detail: 1 });
  assert.deepEqual(steps().map((s) => `${s.action}:${s.target?.friendly}`), [
    'hover:Account', 'click:Theme', 'click:Dark', 'hover:Account', 'click:Profile', 'click:Save',
  ]);
});

test('no hover step when the owner was clicked open (click menus)', () => {
  const { b, el, steps } = setup();
  const menu = el('Menu');
  b.handle({ type: 'hover', ...menu });
  b.handle({ type: 'click', ...menu, button: 'left', detail: 1 });
  b.handle({ type: 'click', ...el('Logout', { hoverOwner: menu.ref }), button: 'left', detail: 1 });
  assert.deepEqual(steps().map((s) => s.action), ['click', 'click']);
});

test('drag and drop becomes one drag step and swallows the trailing click', () => {
  const { b, el, steps } = setup();
  const card = el('Card A');
  const lane = el('Done lane');
  b.handle({ type: 'drag', source: card, target: lane });
  b.handle({ type: 'click', ...lane, button: 'left', detail: 1 });
  const s = steps();
  assert.equal(s.length, 1);
  assert.equal(s[0].action, 'drag');
  assert.equal(s[0].target.friendly, 'Card A');
  assert.equal(s[0].dropTarget.friendly, 'Done lane');
});

test('assertions are recorded with page info', () => {
  const { b, el, steps } = setup();
  b.handle({ type: 'assert', ...el('Status'), assertion: { type: 'text', expected: 'CONFIRMED' } });
  const [s] = steps();
  assert.equal(s.action, 'assert');
  assert.deepEqual(s.assert, { type: 'text', expected: 'CONFIRMED' });
  assert.equal(s.url, 'https://app.test/x');
});
