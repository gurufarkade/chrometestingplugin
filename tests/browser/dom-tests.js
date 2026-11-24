// Browser feedback loop for the DOM-bound modules (Locator engine, Outcome
// observer, Replayer). Open tests/browser/harness.html over HTTP, then run
//   await import('/tests/browser/dom-tests.js').then((m) => m.run())
// Results: returned and stored on window.__domResults.
const FILES = ['selectors', 'overlay', 'outcomes', 'step-builder', 'replayer', 'recorder'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stubChrome(win) {
  win.__msgs = [];
  win.chrome = win.chrome || {};
  win.chrome.runtime = {
    sendMessage: async (m) => {
      win.__msgs.push(JSON.parse(JSON.stringify(m)));
      return m.type === 'content:ready' ? { mode: 'off', settings: { showOverlay: false } } : { ok: true };
    },
    onMessage: { addListener: (fn) => (win.__listeners = [...(win.__listeners || []), fn]) },
  };
}

async function loadInto(win) {
  if (win.QA?.recorderLoaded) return;
  stubChrome(win);
  for (const f of FILES) {
    await new Promise((res, rej) => {
      const s = win.document.createElement('script');
      s.src = `/src/content/${f}.js?${Date.now()}`;
      s.onload = res;
      s.onerror = rej;
      win.document.head.appendChild(s);
    });
  }
}

export async function run() {
  const results = [];
  const t = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS ${name}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${e.message}`);
    }
  };
  const eq = (a, b, msg = '') => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  };
  const ok = (v, msg) => {
    if (!v) throw new Error(msg);
  };

  const frameWin = document.getElementById('pay').contentWindow;
  if (frameWin.document.readyState !== 'complete') await new Promise((r) => document.getElementById('pay').addEventListener('load', r, { once: true }));
  await loadInto(window);
  await loadInto(frameWin);
  const { QA } = window;

  await t('scoped locator makes a repeated button unique by its row', () => {
    const btn = document.querySelectorAll('.add')[1];
    const d = QA.sel.describe(btn);
    const first = d.candidates[0];
    eq(first.type, 'scoped');
    eq(first.scope.css, 'tr');
    eq(first.scope.text, '4K monitor');
    eq(first.unique, true);
    eq(QA.sel.findByCandidate(first)[0] === btn, true, 'resolves back');
    const role = d.candidates.find((c) => c.type === 'role');
    eq(role.unique, false, 'plain role is ambiguous');
  });

  await t('shadow DOM: role query pierces, css candidate carries host chain', () => {
    const save = document.getElementById('editor').shadowRoot.querySelector('.save');
    const d = QA.sel.describe(save);
    eq(d.candidates[0].type, 'role');
    eq(d.candidates[0].unique, true);
    const css = d.candidates.find((c) => c.type === 'css');
    eq(css.shadow, ['#editor']);
    eq(QA.sel.findByCandidate(css)[0] === save, true, 'css+shadow resolves');
    eq(d.context.shadowHost, 'x-editor');
  });

  await t('field facts feed the Test data module', () => {
    const d = QA.sel.describe(document.getElementById('email'));
    eq(d.autocomplete, 'email');
    eq(d.maxLength, 40);
    eq(d.type, 'email');
    eq(d.context.form, 'Create account');
  });

  await t('iframe identity', () => {
    eq(QA.sel.frameInfo(), null, 'top has no frame');
    const fi = frameWin.QA.sel.frameInfo();
    eq(fi.selector, 'iframe[name="payment"]');
    ok(fi.url.endsWith('/tests/browser/frame.html'), 'frame url');
  });

  await t('outcome: toast after a click', async () => {
    const got = await new Promise((resolve) => {
      QA.outcomes.watch(resolve, { ms: 1200 });
      document.getElementById('saveBtn').click();
    });
    eq(got.map((o) => [o.kind, o.text]), [['toast', 'Settings saved']]);
  });

  await t('outcome: dialog opens', async () => {
    const got = await new Promise((resolve) => {
      QA.outcomes.watch(resolve, { ms: 600 });
      document.getElementById('delBtn').click();
    });
    eq(got.map((o) => [o.kind, o.text]), [['dialog', 'Confirm delete']]);
    document.getElementById('dlg').close();
  });

  await t('outcome: validation message + page title change', async () => {
    const form = document.getElementById('signup');
    document.getElementById('email').value = 'nope';
    const bad = await new Promise((resolve) => {
      QA.outcomes.watch(resolve, { ms: 500 });
      form.requestSubmit();
    });
    eq(bad.map((o) => [o.kind, o.text]), [['validation', 'Enter a valid email']]);
    document.getElementById('email').value = 'qa@x.io';
    const good = await new Promise((resolve) => {
      QA.outcomes.watch(resolve, { ms: 500 });
      form.requestSubmit();
    });
    eq(good.map((o) => [o.kind, o.text]), [['title', 'Welcome – Fixture']]);
  });

  await t('replay: scoped click hits the right row', async () => {
    const target = QA.sel.describe(document.querySelectorAll('.add')[2]);
    const r = await QA.replay.exec({ action: 'click', target }, { timeoutMs: 2000, highlight: false });
    eq(r.ok, true);
    eq(r.usedSelector.type, 'scoped');
    ok(document.getElementById('cart').textContent.endsWith('USB-C hub'), document.getElementById('cart').textContent);
  });

  await t('replay: fill + click inside shadow DOM', async () => {
    const root = document.getElementById('editor').shadowRoot;
    await QA.replay.exec({ action: 'fill', value: 'Hello', target: QA.sel.describe(root.querySelector('.title')) }, { timeoutMs: 2000, highlight: false });
    await QA.replay.exec({ action: 'click', target: QA.sel.describe(root.querySelector('.save')) }, { timeoutMs: 2000, highlight: false });
    eq(document.getElementById('saved').textContent, 'saved:Hello');
  });

  await t('replay: HTML5 drag and drop', async () => {
    const step = { action: 'drag', html5: true, target: QA.sel.describe(document.getElementById('cardA')), dropTarget: QA.sel.describe(document.getElementById('done')) };
    const r = await QA.replay.exec(step, { timeoutMs: 2000, highlight: false });
    eq(r.ok, true);
    eq(document.getElementById('cardA').parentElement.id, 'done');
  });

  await t('replay: mouse-driven drag (sortable)', async () => {
    const step = { action: 'drag', target: QA.sel.describe(document.getElementById('s1')), dropTarget: QA.sel.describe(document.getElementById('s3')) };
    await QA.replay.exec(step, { timeoutMs: 2000, highlight: false });
    eq([...document.querySelectorAll('#sortable li')].map((li) => li.textContent), ['Two', 'Three', 'One']);
  });

  await t('replay: JS hover menu then click item', async () => {
    const menu = document.getElementById('jsMenu');
    // Hover the trigger button; the menu listens for mouseenter on its container.
    await QA.replay.exec({ action: 'hover', target: QA.sel.describe(menu.querySelector('button')) }, { timeoutMs: 2000, highlight: false });
    ok(menu.classList.contains('open'), 'menu opened via ancestor mouseenter');
    const item = QA.sel.describe(document.getElementById('laptops'));
    await QA.replay.exec({ action: 'click', target: item }, { timeoutMs: 2000, highlight: false, afterHover: true });
    eq(document.getElementById('menuResult').textContent, 'laptops');
  });

  await t('replay: CSS-only hover menu item is still clickable after hover', async () => {
    document.getElementById('menuResult').textContent = '';
    const target = { ...QA.sel.describe(document.getElementById('profileLink')) }; // described while hidden
    const t0 = Date.now();
    await QA.replay.exec({ action: 'hover', target: QA.sel.describe(document.getElementById('cssMenu')) }, { timeoutMs: 2000, highlight: false });
    await QA.replay.exec({ action: 'click', target }, { timeoutMs: 8000, highlight: false, afterHover: true });
    eq(document.getElementById('menuResult').textContent, 'profile');
    ok(Date.now() - t0 < 4000, `took ${Date.now() - t0}ms`);
  });

  await t('replay inside the iframe', async () => {
    const F = frameWin.QA;
    await F.replay.exec({ action: 'fill', value: '4111111111111111', target: F.sel.describe(frameWin.document.getElementById('cc')) }, { timeoutMs: 2000, highlight: false });
    await F.replay.exec({ action: 'click', target: F.sel.describe(frameWin.document.getElementById('pay')) }, { timeoutMs: 2000, highlight: false });
    eq(frameWin.document.getElementById('paid').textContent, 'paid:4111111111111111');
  });

  await t('outcome verification during replay', async () => {
    document.getElementById('saveBtn').click();
    const r = await QA.outcomes.verify([{ kind: 'status', text: 'Settings saved' }, { kind: 'toast', text: 'Never shown' }], 1500);
    eq(r.seen.map((o) => o.text), ['Settings saved']);
    eq(r.missing.map((o) => o.text), ['Never shown']);
  });

  window.__domResults = results;
  return results;
}
