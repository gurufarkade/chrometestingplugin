// Step builder — turns the stream of raw Interactions into Steps.
// DOM-free on purpose: the recorder's DOM adapter turns browser events into
// plain Interaction facts; this module decides which become Steps, merges
// typing, converts double-clicks, inserts hover steps for hover menus, pairs
// drag + drop, and filters keys. Tested in Node (tests/step-builder.test.mjs).
//
// Interface:
//   QA.createStepBuilder({ emit, page }) -> { handle(interaction) }
//     emit({ op: 'add'|'update', cid, step, screenshot, screenshotDelay })
//     page() -> { url, title, ts }
//
// Interaction = { type, ref, describe(), facts?, ...type-specific }
//   ref       opaque identity of the element (compared with ===)
//   describe  lazy Target description (expensive, only called when a Step is emitted)
//   facts     { textLike, textarea, toggle, checked, select, file, body, combobox, sensitive, hoverOwner }
//   type      click{button, detail, modifiers} | dblclick | input{value} | change{value, values, optionLabels, files}
//             | keydown{key, modifiers} | focus | hover | drag{source, target} | assert{assertion}
(() => {
  const QA = (globalThis.QA = globalThis.QA || {});
  if (QA.createStepBuilder) return;

  const EDITING_KEYS = /^[acvxzy]$/i;

  QA.createStepBuilder = function createStepBuilder({ emit, page }) {
    let seq = 0;
    let lastFill = null; // { ref, cid }
    let lastClick = null; // { ref, cid, ts }
    let lastHover = null; // { ref, describe, consumed }
    let suppressClickUntil = 0;

    const cid = () => `c${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

    function add(action, it, extra = {}, opts = {}) {
      const step = { action, ...page(), ...extra }; // url, title, ts, frame
      if (!step.frame) delete step.frame;
      if (it && it.describe && !it.facts?.body) step.target = it.describe();
      const id = opts.cid || cid();
      emit({ op: 'add', cid: id, step, screenshot: opts.screenshot !== false, screenshotDelay: opts.screenshotDelay });
      return id;
    }
    function update(id, patch, opts = {}) {
      emit({ op: 'update', cid: id, step: patch, screenshot: !!opts.screenshot, screenshotDelay: opts.screenshotDelay });
    }
    const mods = (m) => (m && Object.keys(m).some((k) => m[k]) ? m : undefined);

    const handlers = {
      click(it) {
        const f = it.facts || {};
        if (f.body || f.textLike || f.select || f.toggle) return;
        if (it.detail >= 2) return; // second click of a double-click
        if (page().ts < suppressClickUntil) return;
        if (f.hoverOwner && lastHover && lastHover.ref === f.hoverOwner && !lastHover.consumed) {
          add('hover', lastHover, {}, { screenshot: false });
          lastHover.consumed = true;
        }
        if (!f.hoverOwner && lastHover && lastHover.ref !== it.ref) lastHover = null;
        if (lastHover && lastHover.ref === it.ref) lastHover.consumed = true; // owner was clicked open, not hovered
        const id = add('click', it, { button: it.button === 'right' ? 'right' : 'left', modifiers: mods(it.modifiers) });
        lastClick = { ref: it.ref, cid: id, ts: page().ts };
      },
      dblclick(it) {
        if (lastClick && lastClick.ref === it.ref && page().ts - lastClick.ts < 800) update(lastClick.cid, { action: 'dblclick' }, { screenshot: true });
        else add('dblclick', it);
      },
      input(it) {
        if (!it.facts?.textLike) return;
        if (lastFill && lastFill.ref === it.ref) return update(lastFill.cid, { value: it.value });
        lastFill = { ref: it.ref, cid: add('fill', it, { value: it.value, sensitive: !!it.facts.sensitive || undefined }, { screenshot: false }) };
      },
      focus(it) {
        if (lastFill && lastFill.ref !== it.ref) lastFill = null;
      },
      change(it) {
        const f = it.facts || {};
        if (f.toggle) return void add(f.checked ? 'check' : 'uncheck', it);
        if (f.select) return void add('select', it, { value: it.value, values: it.values, optionLabels: it.optionLabels });
        if (f.file) return void add('upload', it, { files: it.files });
        if (lastFill && lastFill.ref === it.ref) update(lastFill.cid, { value: it.value }, { screenshot: true, screenshotDelay: 50 });
      },
      keydown(it) {
        const f = it.facts || {};
        if (f.select) return;
        const m = it.modifiers || {};
        const combo = m.ctrl || m.meta || m.alt;
        let keep = false;
        if (it.key === 'Enter') keep = !(f.textarea && !combo);
        else if (it.key === 'Escape') keep = true;
        else if (it.key === 'ArrowDown' || it.key === 'ArrowUp') keep = !!f.combobox;
        else if (combo && it.key.length === 1) keep = !(f.textLike && EDITING_KEYS.test(it.key));
        if (!keep) return;
        if (lastFill && lastFill.ref === it.ref) lastFill = { ...lastFill, closed: true };
        add('press', f.body ? null : it, { key: it.key, modifiers: mods(it.modifiers) }, { screenshotDelay: 500 });
      },
      hover(it) {
        lastHover = { ref: it.ref, describe: it.describe, consumed: false };
      },
      drag(it) {
        add('drag', it.source, { dropTarget: it.target.describe(), html5: it.html5 || undefined }, { screenshotDelay: 400 });
        suppressClickUntil = page().ts + 300;
        lastHover = null;
      },
      assert(it) {
        add('assert', it, { assert: it.assertion });
      },
    };

    return {
      handle(interaction) {
        const fn = handlers[interaction.type];
        if (fn) fn(interaction);
      },
    };
  };
})();
