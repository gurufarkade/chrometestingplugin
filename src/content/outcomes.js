// Outcome observer — after a Step, watches the page for what the application
// showed in response (toast, alert, validation message, opened dialog, title
// change) and reports it as Outcomes. During replay, verifies Outcomes appear.
//
// Interface:
//   QA.outcomes.watch(onOutcomes, { ms }) -> stop()   // onOutcomes([{ kind, text, role?, testId? }]) once, at the end
//   QA.outcomes.verify(outcomes, timeoutMs) -> Promise<{ seen: [], missing: [] }>
(() => {
  const QA = (globalThis.QA = globalThis.QA || {});
  if (QA.outcomes) return;

  const MESSAGE_SELECTOR = [
    '[role="alert"]', '[role="status"]', '[aria-live="assertive"]', '[aria-live="polite"]',
    '[class*="toast" i]', '[class*="snackbar" i]', '[class*="notification" i]', '[class*="alert" i]',
    '[class*="error-message" i]', '[class*="invalid-feedback" i]', '[class*="field-error" i]', '[class*="form-error" i]',
    '[class*="help-block" i]', '[class*="validation" i]', '[data-testid*="toast" i]', '[data-testid*="error" i]', '[data-testid*="alert" i]',
  ].join(',');
  const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const MAX_TEXT = 200;
  const MAX_OUTCOMES = 5;

  const norm = (s) => QA.sel.norm(s);

  function kindOf(el) {
    const role = el.getAttribute('role');
    const cls = `${el.className || ''} ${el.getAttribute('data-testid') || ''}`.toLowerCase();
    if (/error|invalid|validation|field-error|help-block/.test(cls)) return 'validation';
    if (role === 'alert' || /alert/.test(cls)) return 'alert';
    if (/toast|snackbar|notification/.test(cls)) return 'toast';
    return 'status';
  }

  function messages() {
    const out = new Map();
    for (const el of QA.sel.deepQueryAll(MESSAGE_SELECTOR)) {
      if (!QA.sel.isVisible(el)) continue;
      const text = norm(el.textContent);
      if (!text || text.length > MAX_TEXT) continue;
      // keep the innermost message container
      if (Array.from(out.keys()).some((o) => el.contains(o))) continue;
      for (const o of Array.from(out.keys())) if (o.contains(el)) out.delete(o);
      out.set(el, { kind: kindOf(el), text, role: el.getAttribute('role') || undefined, testId: el.getAttribute('data-testid') || undefined });
    }
    // aria-invalid fields with their error text
    for (const f of QA.sel.deepQueryAll('[aria-invalid="true"]')) {
      if (!QA.sel.isVisible(f)) continue;
      const ids = `${f.getAttribute('aria-errormessage') || ''} ${f.getAttribute('aria-describedby') || ''}`.trim().split(/\s+/).filter(Boolean);
      const text = norm(ids.map((id) => f.getRootNode().getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || '').join(' '));
      if (text && text.length <= MAX_TEXT) out.set(f, { kind: 'validation', text, field: QA.sel.getAccessibleName(f) || undefined });
    }
    return Array.from(out.values());
  }

  function dialogs() {
    return QA.sel
      .deepQueryAll(DIALOG_SELECTOR)
      .filter((d) => QA.sel.isVisible(d))
      .map((d) => ({ kind: 'dialog', text: norm(QA.sel.getAccessibleName(d) || d.querySelector('h1,h2,h3,[class*="title" i]')?.textContent || '').slice(0, 100) }))
      .filter((d) => d.text);
  }

  const keyOf = (o) => `${o.kind}|${o.text}`;

  function watch(onOutcomes, { ms = 2000 } = {}) {
    const before = new Set([...messages(), ...dialogs()].map(keyOf));
    const titleBefore = document.title;
    const found = new Map();
    let done = false;

    const scan = () => {
      for (const o of [...messages(), ...dialogs()]) {
        const k = keyOf(o);
        if (!before.has(k) && !found.has(k) && found.size < MAX_OUTCOMES) found.set(k, o);
      }
    };
    const onInvalid = (e) => {
      const el = e.target;
      if (el && el.validationMessage && found.size < MAX_OUTCOMES) {
        const o = { kind: 'validation', text: el.validationMessage, field: QA.sel.getAccessibleName(el) || undefined, native: true };
        found.set(keyOf(o), o);
      }
    };
    let pending = null;
    const mo = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        scan();
      }, 120);
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-invalid', 'aria-hidden'] });
    document.addEventListener('invalid', onInvalid, true);

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(pending);
      mo.disconnect();
      document.removeEventListener('invalid', onInvalid, true);
      scan();
      if (document.title !== titleBefore && document.title) found.set(`title|${document.title}`, { kind: 'title', text: document.title });
      if (found.size) onOutcomes(Array.from(found.values()));
    };
    const timer = setTimeout(finish, ms);
    return finish;
  }

  async function verify(outcomes, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    // Native browser validation bubbles are not in the DOM, so they can't be verified here.
    const pending = new Set(outcomes.filter((o) => !o.ignored && !o.native));
    const seen = [];
    while (pending.size && Date.now() < end) {
      const bodyText = norm(document.body?.textContent || '');
      for (const o of Array.from(pending)) {
        const ok = o.kind === 'title' ? document.title === o.text : bodyText.includes(o.text);
        if (ok) {
          seen.push(o);
          pending.delete(o);
        }
      }
      if (pending.size) await new Promise((r) => setTimeout(r, 150));
    }
    return { seen, missing: Array.from(pending) };
  }

  QA.outcomes = { watch, verify };
})();
