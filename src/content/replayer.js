// Replays a single recorded step inside the page: resolves the element via the
// ranked locator candidates (auto-waiting for it to be visible + enabled),
// then performs the action with framework-friendly events (React/Vue/Angular).
(() => {
  const QA = (globalThis.QA = globalThis.QA || {});
  if (QA.replay) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isEnabled(el) {
    return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }

  /** Try candidates in rank order; prefer a single visible match. */
  function tryResolve(target) {
    const cands = target?.candidates || [];
    let fallback = null;
    for (const c of cands) {
      const all = QA.sel.findByCandidate(c);
      const vis = all.filter((e) => QA.sel.isVisible(e));
      const els = vis.length ? vis : all;
      if (els.length === 1) return { el: els[0], used: c };
      if (els.length > 1 && !fallback) {
        // Several matches: pick the one closest to where it was recorded.
        const rect = target.rect;
        let best = els[0];
        if (rect) {
          let bestD = Infinity;
          for (const e of els) {
            const r = e.getBoundingClientRect();
            const d = Math.hypot(r.x - rect.x, r.y - rect.y);
            if (d < bestD) (bestD = d), (best = e);
          }
        }
        fallback = { el: best, used: { ...c, ambiguous: els.length } };
      }
    }
    return fallback;
  }

  async function resolve(target, timeoutMs, { needEnabled = true, needVisible = true } = {}) {
    const end = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < end) {
      last = tryResolve(target);
      if (last && (!needVisible || QA.sel.isVisible(last.el)) && (!needEnabled || isEnabled(last.el))) return last;
      await sleep(150);
    }
    if (last) return last; // present but hidden/disabled: let the action try anyway
    const tried = (target?.candidates || []).map((c) => `${c.type}=${c.value || c.name || c.css}`).slice(0, 4).join(', ');
    throw new Error(`Element "${target?.friendly || target?.tag}" not found after ${timeoutMs}ms (tried ${tried})`);
  }

  function mouse(el, type, extra = {}) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ...extra };
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { pointerId: 1, isPrimary: true, ...opts }));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function keyEvent(el, type, key, mods = {}) {
    const codeMap = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', Backspace: 'Backspace', ' ': 'Space' };
    const keyCode = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Backspace: 8, ' ': 32 }[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const ev = new KeyboardEvent(type, {
      key,
      code: codeMap[key] || (key.length === 1 ? `Key${key.toUpperCase()}` : key),
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: !!mods.ctrl,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
      metaKey: !!mods.meta,
    });
    return el.dispatchEvent(ev);
  }

  function click(el, { button = 'left', count = 1 } = {}) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const b = button === 'right' ? 2 : 0;
    mouse(el, 'pointerover');
    mouse(el, 'mouseover');
    mouse(el, 'pointerdown', { button: b, buttons: 1 });
    mouse(el, 'mousedown', { button: b, buttons: 1 });
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    mouse(el, 'pointerup', { button: b });
    mouse(el, 'mouseup', { button: b });
    if (button === 'right') {
      mouse(el, 'contextmenu', { button: 2 });
      return;
    }
    el.click(); // triggers default actions (links, submit buttons, labels)
    if (count === 2) {
      el.click();
      mouse(el, 'dblclick', { detail: 2 });
    }
  }

  function fill(el, value) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return;
    }
    if (typeof el.select === 'function' && !/^(date|time|datetime-local|month|week|color|range)$/.test(el.type)) {
      try {
        el.select();
      } catch {}
    }
    setNativeValue(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectOption(el, step) {
    if (!(el instanceof HTMLSelectElement)) throw new Error('Target is not a <select>');
    const wanted = step.values || [step.value];
    let matched = 0;
    for (const opt of el.options) {
      const hit = wanted.includes(opt.value) || (step.optionLabels || []).includes(QA.sel.norm(opt.textContent));
      if (el.multiple) opt.selected = hit;
      else if (hit && !matched) {
        setNativeValue(el, opt.value);
      }
      if (hit) matched++;
    }
    if (!matched) throw new Error(`Option ${JSON.stringify(wanted)} not found in select`);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function press(el, step) {
    const target = el || document.activeElement || document.body;
    const mods = step.modifiers || {};
    const notCancelled = keyEvent(target, 'keydown', step.key, mods);
    if (step.key.length === 1 || step.key === 'Enter') keyEvent(target, 'keypress', step.key, mods);
    keyEvent(target, 'keyup', step.key, mods);
    // Synthetic Enter never triggers implicit form submission — emulate it.
    if (notCancelled && step.key === 'Enter' && target instanceof HTMLInputElement && target.form) {
      const form = target.form;
      const submitter = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (form.requestSubmit) form.requestSubmit(submitter && !submitter.disabled ? submitter : undefined);
      else form.submit();
    }
  }

  function checkAssertion(el, a) {
    const norm = QA.sel.norm;
    switch (a.type) {
      case 'url':
        return { pass: location.href === a.expected || location.href.split('?')[0] === a.expected.split('?')[0], actual: location.href };
      case 'visible':
        return { pass: !!el && QA.sel.isVisible(el), actual: el ? 'visible' : 'missing' };
      case 'hidden':
        return { pass: !el || !QA.sel.isVisible(el), actual: el && QA.sel.isVisible(el) ? 'visible' : 'hidden' };
      case 'value':
        return { pass: el?.value === a.expected, actual: el?.value };
      case 'checked':
        return { pass: !!el?.checked === !!a.expected, actual: !!el?.checked };
      case 'contains': {
        const t = norm(el?.textContent);
        return { pass: t.includes(norm(a.expected)), actual: t.slice(0, 200) };
      }
      case 'text':
      default: {
        const t = norm(el?.textContent);
        return { pass: t === norm(a.expected) || t.includes(norm(a.expected)), actual: t.slice(0, 200) };
      }
    }
  }

  async function exec(step, { timeoutMs = 10000, highlight = true } = {}) {
    const a = step.action;
    const needsElement = !['press', 'note', 'screenshot'].includes(a) || step.target;
    if (a === 'assert' && step.assert?.type === 'url') {
      const end = Date.now() + timeoutMs;
      let r;
      do {
        r = checkAssertion(null, step.assert);
        if (r.pass) break;
        await sleep(200);
      } while (Date.now() < end);
      return r.pass ? { ok: true, actual: r.actual } : { ok: false, error: `URL assertion failed: expected ${step.assert.expected}, got ${r.actual}`, actual: r.actual };
    }

    let el = null;
    let used = null;
    if (needsElement && step.target) {
      const hiddenAssert = a === 'assert' && step.assert?.type === 'hidden';
      try {
        // Styled checkboxes/selects often hide the native input, so don't require visibility for them.
        const needVisible = !['check', 'uncheck', 'select'].includes(a);
        ({ el, used } = await resolve(step.target, hiddenAssert ? 1500 : timeoutMs, { needEnabled: a !== 'assert', needVisible }));
      } catch (e) {
        if (hiddenAssert) return { ok: true, actual: 'hidden' };
        throw e;
      }
      if (highlight && el) {
        QA.overlay.highlight(el, { kind: 'replay', label: `${a} · ${step.target.friendly || ''}` });
        await sleep(250);
      }
    }

    switch (a) {
      case 'click':
        click(el, { button: step.button, count: 1 });
        break;
      case 'dblclick':
        click(el, { count: 2 });
        break;
      case 'fill':
        if (step.masked) throw new Error('Value was masked at capture time — cannot replay this field');
        fill(el, step.value ?? '');
        break;
      case 'select':
        selectOption(el, step);
        break;
      case 'check':
      case 'uncheck': {
        const want = a === 'check';
        if (!!el.checked !== want) click(el);
        if (el.type === 'checkbox' && !!el.checked !== want) throw new Error(`Checkbox did not become ${a}ed`);
        break;
      }
      case 'press':
        press(el, step);
        break;
      case 'hover':
        mouse(el, 'pointerover');
        mouse(el, 'mouseover');
        mouse(el, 'mouseenter', { bubbles: false });
        break;
      case 'assert': {
        let r = checkAssertion(el, step.assert || {});
        const end = Date.now() + Math.min(timeoutMs, 5000);
        while (!r.pass && Date.now() < end) {
          await sleep(200);
          const again = tryResolve(step.target);
          r = checkAssertion(again?.el || el, step.assert || {});
        }
        if (highlight && el) QA.overlay.highlight(el, { kind: r.pass ? 'replay' : 'fail', label: r.pass ? '✓ assertion passed' : '✗ assertion failed' });
        if (!r.pass) return { ok: false, error: `Assertion (${step.assert?.type}) failed: expected "${step.assert?.expected}", got "${r.actual}"`, actual: r.actual, usedSelector: used };
        return { ok: true, actual: r.actual, usedSelector: used };
      }
      default:
        break;
    }
    setTimeout(() => QA.overlay.clearHighlight(), 600);
    const warning = used?.ambiguous ? `Locator ${used.type} matched ${used.ambiguous} elements; picked the nearest` : undefined;
    return { ok: true, usedSelector: used ? { type: used.type, value: used.value || used.name || used.css } : null, warning };
  }

  QA.replay = { exec, resolve, tryResolve };
})();
