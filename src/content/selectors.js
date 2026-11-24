// Locator engine — describes a Target and ranks Locator candidates; resolves
// candidates back to elements during replay. Application-agnostic:
//   * test ids, stable ids, ARIA role + accessible name, label, placeholder,
//     name, aria-label, text, minimal CSS path, XPath
//   * Scope: a repeated element ("Add to cart" in every row) is made unique by
//     the row/card/list item that contains it, identified by that container's text
//   * open Shadow DOM is searched like Playwright does (web components, LWC…)
//   * the Frame the element lives in (iframes)
//
// Interface: QA.sel.describe(el), QA.sel.findByCandidate(candidate, root?),
//            QA.sel.actionableTarget(el), QA.sel.frameInfo(), helpers (isVisible, textOf, norm, getRole, getAccessibleName)
(() => {
  const QA = (globalThis.QA = globalThis.QA || {});
  if (QA.sel) return;

  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id', 'data-automation', 'data-e2e', 'data-pw'];
  const ROLE_CANDIDATES = new Set([
    'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'searchbox', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'slider', 'spinbutton', 'heading', 'treeitem', 'listbox', 'cell', 'gridcell', 'row',
  ]);
  const ACTIONABLE =
    'button, a[href], input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"], [role="combobox"], [contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
  // Containers that make repeated elements unique (most specific first).
  const SCOPES = [
    ['row', 'tr, [role="row"]'],
    ['listitem', 'li, [role="listitem"]'],
    ['card', 'article, [role="article"], [class*="card" i], [class*="tile" i], [class*="item" i], [class*="product" i], [class*="result" i]'],
    ['group', 'fieldset, [role="group"], section'],
    ['dialog', 'dialog, [role="dialog"], [role="alertdialog"]'],
    ['form', 'form'],
  ];

  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const cssEscape = (s) => (globalThis.CSS?.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'));
  const attrValue = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  function isStableToken(id) {
    if (!id || id.length > 48) return false;
    if (/^\d/.test(id) || /\d{4,}/.test(id) || /[:]/.test(id)) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return false;
    if (/^(ember|ext-|gen\d|ui-id|mui-|react-|radix-|headlessui-|__|rc_|el-id-|downshift-|aria-|mat-|cdk-|p-id|jss|input-\d|field-\d)/i.test(id)) return false;
    return true;
  }
  function isStableClass(c) {
    if (!c || c.length > 40) return false;
    if (/^(css|sc|jss|emotion|makeStyles|styled|svelte|chakra|tw)-/i.test(c)) return false;
    if (/[0-9a-f]{5,}/i.test(c) && /\d/.test(c)) return false;
    if (/^_/.test(c) || /__[a-z0-9]{5}$/i.test(c)) return false; // CSS modules
    if (/^(is-|has-)?(active|hover|focus|focused|selected|open|disabled|visible|hidden|ng-|v-|show|in|fade|collapsed|expanded|checked)$/i.test(c)) return false;
    return /^[a-zA-Z][\w-]*$/.test(c);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  }

  // ---------------------------------------------------------------- Shadow DOM aware traversal

  /** Every element under root (document, element or shadow root), entering open shadow roots. */
  function* allElements(root = document) {
    const stack = root.nodeType === 1 ? [root] : Array.from(root.children || []).reverse();
    while (stack.length) {
      const n = stack.pop();
      yield n;
      const kids = [...(n.shadowRoot ? n.shadowRoot.children : []), ...n.children];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (r) => {
      try {
        r.querySelectorAll(selector).forEach((e) => out.push(e));
      } catch {
        return;
      }
      r.querySelectorAll('*').forEach((e) => e.shadowRoot && visit(e.shadowRoot));
    };
    visit(root);
    return out;
  }

  // ---------------------------------------------------------------- ARIA

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a':
        return el.hasAttribute('href') ? 'link' : null;
      case 'button':
      case 'summary':
        return 'button';
      case 'select':
        return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'option':
        return 'option';
      case 'img':
        return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return 'heading';
      case 'dialog':
        return 'dialog';
      case 'nav':
        return 'navigation';
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'li':
        return 'listitem';
      case 'input': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        if (['text', 'email', 'tel', 'url', ''].includes(t)) return el.hasAttribute('list') ? 'combobox' : 'textbox';
        return null;
      }
      default:
        return null;
    }
  }

  // textContent (not innerText): matches Playwright/Cypress, unaffected by text-transform.
  function textOf(el) {
    if (!el.querySelector || !el.querySelector('script,style,noscript')) return norm(el.textContent ?? '');
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
    return norm(clone.textContent);
  }

  function labelText(el) {
    if (el.labels && el.labels.length) {
      return norm(Array.from(el.labels).map(labelTextOfLabel).join(' '));
    }
    return '';
  }
  function labelTextOfLabel(l) {
    const clone = l.cloneNode(true);
    clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
    return norm(clone.textContent);
  }

  function getAccessibleName(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode();
      const t = norm(labelledBy.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id))?.textContent || '').join(' '));
      if (t) return t;
    }
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.tagName.toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag)) {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && ['button', 'submit', 'reset'].includes(t)) return norm(el.value) || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '');
      if (tag === 'input' && t === 'image') return norm(el.getAttribute('alt'));
      return labelText(el) || norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder'));
    }
    if (tag === 'img') return norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));
    const txt = textOf(el);
    if (txt) return txt;
    const svgTitle = el.querySelector?.('svg title');
    if (svgTitle) return norm(svgTitle.textContent);
    const img = el.querySelector?.('img[alt]');
    if (img) return norm(img.getAttribute('alt'));
    return norm(el.getAttribute('title'));
  }

  // ---------------------------------------------------------------- queries (deep)

  function within(root) {
    return root && root !== document ? root : document;
  }

  function queryRole(role, name, root) {
    const out = [];
    for (const e of allElements(within(root))) {
      if (getRole(e) !== role) continue;
      if (name != null && getAccessibleName(e) !== name) continue;
      if (!isVisible(e)) continue;
      out.push(e);
    }
    return out;
  }

  function queryLabel(text, root) {
    const out = new Set();
    for (const l of deepQueryAll('label', within(root))) {
      if (norm(l.textContent) === text || labelTextOfLabel(l) === text) {
        const c = l.control;
        if (c && isVisible(c)) out.add(c);
      }
    }
    for (const e of deepQueryAll('[aria-label]', within(root))) {
      if (norm(e.getAttribute('aria-label')) === text && /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && isVisible(e)) out.add(e);
    }
    return Array.from(out);
  }

  function queryText(tag, text, root) {
    const out = [];
    for (const e of deepQueryAll(tag || '*', within(root))) {
      const raw = e.textContent || '';
      if (raw.length < text.length || (raw.length > text.length * 4 + 40 && norm(raw) !== text)) continue;
      if (textOf(e) === text && isVisible(e)) out.push(e);
    }
    return out.filter((e) => !out.some((o) => o !== e && e.contains(o)));
  }

  function queryCssAll(css, root) {
    return deepQueryAll(css, within(root));
  }

  function queryXPath(xpath) {
    try {
      const r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
      return out;
    } catch {
      return [];
    }
  }

  function queryShadowChain(c) {
    // c.shadow = [hostCss, innerHostCss, …]; c.css is relative to the last shadow root
    let roots = [document];
    for (const hostCss of c.shadow) {
      const next = [];
      for (const r of roots) r.querySelectorAll(hostCss).forEach((h) => h.shadowRoot && next.push(h.shadowRoot));
      roots = next;
    }
    return roots.flatMap((r) => Array.from(r.querySelectorAll(c.css)));
  }

  function findScopes(scope, root) {
    return queryCssAll(scope.css, root).filter((s) => isVisible(s) && norm(s.textContent).includes(scope.text));
  }

  function findByCandidate(c, root) {
    switch (c.type) {
      case 'role':
        return queryRole(c.role, c.name, root);
      case 'label':
        return queryLabel(c.value, root);
      case 'text':
        return queryText(c.tag, c.value, root);
      case 'xpath':
        return queryXPath(c.value);
      case 'scoped': {
        const hits = [];
        for (const s of findScopes(c.scope, root)) hits.push(...findByCandidate(c.inner, s));
        return Array.from(new Set(hits));
      }
      default:
        if (c.shadow?.length) return queryShadowChain(c);
        return c.css ? queryCssAll(c.css, root) : [];
    }
  }

  // ---------------------------------------------------------------- paths

  function cssPath(el) {
    const root = el.getRootNode();
    const q = (sel) => {
      try {
        return root.querySelectorAll(sel).length;
      } catch {
        return 0;
      }
    };
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'html') break;
      if (node.id && isStableToken(node.id) && q(`#${cssEscape(node.id)}`) === 1) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const tAttr = TEST_ID_ATTRS.find((a) => node.getAttribute(a));
      if (tAttr && node !== el) {
        const sel = `[${tAttr}="${attrValue(node.getAttribute(tAttr))}"]`;
        if (q(sel) === 1) {
          parts.unshift(sel);
          break;
        }
      }
      let part = tag;
      const classes = Array.from(node.classList).filter(isStableClass).slice(0, 2);
      if (classes.length) part += classes.map((c) => `.${cssEscape(c)}`).join('');
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (q(parts.join(' > ')) === 1) return parts.join(' > ');
      node = parent;
    }
    return parts.join(' > ');
  }

  /** Host chain for an element inside open shadow roots: ['my-app', 'x-card'] (outermost first). */
  function shadowHosts(el) {
    const hosts = [];
    let root = el.getRootNode();
    while (root && root.host) {
      hosts.unshift(cssPath(root.host));
      root = root.host.getRootNode();
    }
    return hosts;
  }

  function xPath(el) {
    if (el.getRootNode() !== document) return null; // XPath can't enter shadow roots
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.id && isStableToken(node.id)) {
        parts.unshift(`//*[@id="${node.id}"]`);
        return parts.join('/');
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        parts.unshift(same.length > 1 ? `${tag}[${same.indexOf(node) + 1}]` : tag);
      } else parts.unshift(tag);
      node = parent;
    }
    return `/${parts.join('/')}`;
  }

  // ---------------------------------------------------------------- scope (repeated elements)

  function scopeCss(container, kind) {
    const tag = container.tagName.toLowerCase();
    if (kind === 'row') return tag === 'tr' ? 'tr' : '[role="row"]';
    if (kind === 'listitem') return tag === 'li' ? 'li' : '[role="listitem"]';
    if (kind === 'dialog') return tag === 'dialog' ? 'dialog' : `[role="${container.getAttribute('role')}"]`;
    if (kind === 'form') return 'form';
    const cls = Array.from(container.classList).filter(isStableClass).find((c) => /card|tile|item|product|result/i.test(c)) || Array.from(container.classList).filter(isStableClass)[0];
    return cls ? `${tag}.${cssEscape(cls)}` : tag;
  }

  /**
   * Text inside the container (not the target's own) that identifies it among its peers.
   * Reading order wins (the first cell is usually the item's name); numbers and prices are
   * only a last resort because they change between runs.
   */
  function distinctiveText(container, el, css) {
    const own = textOf(el);
    const peers = queryCssAll(css).filter((p) => p !== container);
    const words = [];
    const numbers = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = norm(n.textContent);
      if (t.length < 2 || t.length > 60 || el.contains(n) || t === own) continue;
      (/^[\d\s$€£₹¥.,:%+\-/()]+$/.test(t) ? numbers : words).push(t);
    }
    const unique = (t) => !peers.some((p) => norm(p.textContent).includes(t));
    return words.find(unique) || numbers.find(unique) || null;
  }

  function scopedCandidate(el, inner) {
    for (const [kind, selector] of SCOPES) {
      const container = el.parentElement?.closest(selector);
      if (!container || container === document.body) continue;
      const css = scopeCss(container, kind);
      const text = distinctiveText(container, el, css);
      if (!text) continue;
      const scope = { kind, css, text, role: kind === 'row' || kind === 'listitem' || kind === 'dialog' ? (kind === 'dialog' ? 'dialog' : kind) : undefined };
      const cand = { type: 'scoped', scope, inner };
      const hits = findByCandidate(cand);
      if (hits.length === 1 && hits[0] === el) return { ...cand, unique: true };
    }
    return null;
  }

  // ---------------------------------------------------------------- candidates

  function buildCandidates(el) {
    const c = [];
    const tag = el.tagName.toLowerCase();
    const inShadow = el.getRootNode() !== document;
    const add = (cand, matches) => {
      cand.unique = matches.length === 1 && matches[0] === el;
      if (matches.includes(el) || cand.type === 'css') c.push(cand);
    };

    for (const a of TEST_ID_ATTRS) {
      const v = el.getAttribute(a);
      if (v) {
        add({ type: 'testid', attr: a, value: v, css: `[${a}="${attrValue(v)}"]` }, queryCssAll(`[${a}="${attrValue(v)}"]`));
        break;
      }
    }
    if (el.id && isStableToken(el.id)) add({ type: 'id', value: el.id, css: `#${cssEscape(el.id)}` }, queryCssAll(`#${cssEscape(el.id)}`));
    const role = getRole(el);
    const name = getAccessibleName(el);
    const roleCand = role && ROLE_CANDIDATES.has(role) && name && name.length <= 80 ? { type: 'role', role, name } : null;
    if (roleCand) add(roleCand, queryRole(role, name));
    if (/^(input|select|textarea)$/.test(tag)) {
      const lbl = labelText(el) || norm(el.getAttribute('aria-label'));
      if (lbl && lbl.length <= 80) add({ type: 'label', value: lbl }, queryLabel(lbl));
      const ph = el.getAttribute('placeholder');
      if (ph) add({ type: 'placeholder', value: ph, css: `${tag}[placeholder="${attrValue(ph)}"]` }, queryCssAll(`${tag}[placeholder="${attrValue(ph)}"]`));
      const nm = el.getAttribute('name');
      if (nm && isStableToken(nm.replace(/[[\].]/g, ''))) add({ type: 'name', value: nm, css: `${tag}[name="${attrValue(nm)}"]` }, queryCssAll(`${tag}[name="${attrValue(nm)}"]`));
    }
    const aria = el.getAttribute('aria-label');
    if (aria && !c.some((x) => x.type === 'label')) add({ type: 'aria', value: aria, css: `${tag}[aria-label="${attrValue(aria)}"]` }, queryCssAll(`${tag}[aria-label="${attrValue(aria)}"]`));
    for (const a of ['title', 'alt']) {
      const v = el.getAttribute(a);
      if (v && v.length <= 60 && !c.some((x) => x.unique)) add({ type: 'attr', value: v, css: `${tag}[${a}="${attrValue(v)}"]` }, queryCssAll(`${tag}[${a}="${attrValue(v)}"]`));
    }
    const txt = textOf(el);
    const textCand = txt && txt.length <= 60 && !/^(input|select|textarea)$/.test(tag) ? { type: 'text', tag, value: txt } : null;
    if (textCand) add(textCand, queryText(tag, txt));

    // Repeated element? Make it unique through its row/card/list item.
    if (!c.some((x) => x.unique)) {
      const inner = roleCand || textCand || (c.find((x) => x.css) ? { type: 'css', css: c.find((x) => x.css).css } : { type: 'css', css: tag });
      const scoped = scopedCandidate(el, inner);
      if (scoped) c.push(scoped);
    }

    const path = cssPath(el);
    const hosts = inShadow ? shadowHosts(el) : null;
    if (hosts) {
      const cand = { type: 'css', value: path, css: path, shadow: hosts };
      cand.unique = queryShadowChain(cand).length === 1;
      c.push(cand);
    } else add({ type: 'css', value: path, css: path }, queryCssAll(path));
    const xp = xPath(el);
    if (xp) c.push({ type: 'xpath', value: xp, unique: queryXPath(xp).length === 1 });

    return [...c.filter((x) => x.unique), ...c.filter((x) => !x.unique)];
  }

  function contextOf(el) {
    const ctx = {};
    const dialog = el.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    if (dialog) ctx.dialog = clip(getAccessibleName(dialog) || norm(dialog.querySelector('h1,h2,h3,h4,[class*="title"]')?.textContent) || 'dialog', 60);
    const form = el.closest('form');
    if (form) ctx.form = clip(norm(form.getAttribute('aria-label')) || norm(form.getAttribute('name')) || norm(form.id) || norm(form.querySelector('h1,h2,h3,legend')?.textContent), 60) || 'form';
    const fieldset = el.closest('fieldset');
    if (fieldset) ctx.fieldset = clip(norm(fieldset.querySelector('legend')?.textContent), 60);
    const row = el.closest('tr, [role="row"], li');
    if (row && row !== el) ctx.row = clip(textOf(row), 80);
    const region = el.closest('[role="region"][aria-label], section[aria-label], nav[aria-label], aside[aria-label], header, footer, nav, main');
    if (region) ctx.region = clip(norm(region.getAttribute('aria-label')) || region.tagName.toLowerCase(), 40);
    if (el.getRootNode() !== document) ctx.shadowHost = el.getRootNode().host.tagName.toLowerCase();
    return ctx;
  }

  /** Would a user expect clicking this to do something? (controls, ARIA widgets, click handlers, pointer cursor) */
  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.matches(ACTIONABLE)) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('ng-click') || el.hasAttribute('@click') || el.hasAttribute('v-on:click')) return true;
    try {
      return getComputedStyle(el).cursor === 'pointer';
    } catch {
      return false;
    }
  }

  function actionableTarget(el) {
    if (!el || el.nodeType !== 1) el = el?.parentElement;
    if (!el) return null;
    const hit = el.closest(ACTIONABLE);
    if (hit) {
      let depth = 0;
      for (let n = el; n && n !== hit; n = n.parentElement) depth++;
      if (depth <= 5) return hit;
    }
    return el;
  }

  /** Field facts the Test data module uses (kind recognition + constraints). */
  function fieldFacts(el) {
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return {};
    const f = {
      autocomplete: el.getAttribute('autocomplete') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      required: el.required || undefined,
      inputMode: el.getAttribute('inputmode') || undefined,
    };
    if (el.maxLength > 0) f.maxLength = el.maxLength;
    if (el.minLength > 0) f.minLength = el.minLength;
    for (const a of ['pattern', 'min', 'max', 'step']) if (el.getAttribute(a)) f[a] = el.getAttribute(a);
    if (el.tagName === 'SELECT') f.options = Array.from(el.options).slice(0, 60).map((o) => ({ value: o.value, label: norm(o.textContent), disabled: o.disabled || undefined }));
    return f;
  }

  function frameInfo() {
    if (window.top === window) return null;
    const info = { url: location.href, name: window.name || undefined };
    try {
      const fe = window.frameElement; // same-origin only
      if (fe) {
        if (fe.name) info.selector = `iframe[name="${attrValue(fe.name)}"]`;
        else if (fe.id && isStableToken(fe.id)) info.selector = `#${cssEscape(fe.id)}`;
        else if (fe.title) info.selector = `iframe[title="${attrValue(fe.title)}"]`;
      }
    } catch {}
    if (!info.selector) {
      if (info.name) info.selector = `iframe[name="${attrValue(info.name)}"]`;
      else {
        try {
          const u = new URL(location.href);
          info.selector = `iframe[src*="${attrValue(u.host + u.pathname)}"]`;
        } catch {}
      }
    }
    return info;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    const type = (el.getAttribute('type') || '').toLowerCase() || undefined;
    const testAttr = TEST_ID_ATTRS.find((a) => el.getAttribute(a));
    const name = getAccessibleName(el);
    return {
      tag,
      type,
      role: getRole(el) || undefined,
      name: clip(name, 100) || undefined,
      text: clip(textOf(el), 100) || undefined,
      label: clip(labelText(el), 100) || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      id: el.id || undefined,
      nameAttr: el.getAttribute('name') || undefined,
      testId: testAttr ? { attr: testAttr, value: el.getAttribute(testAttr) } : undefined,
      href: tag === 'a' ? el.getAttribute('href') : undefined,
      friendly: clip(name || labelText(el) || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || tag, 60),
      context: contextOf(el),
      candidates: buildCandidates(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      html: el.outerHTML.replace(/\svalue="[^"]*"/g, '').slice(0, 300),
      ...fieldFacts(el),
    };
  }

  QA.sel = {
    describe,
    actionableTarget,
    isInteractive,
    findByCandidate,
    frameInfo,
    deepQueryAll,
    getRole,
    getAccessibleName,
    isVisible,
    isStableToken,
    isStableClass,
    textOf,
    norm,
  };
})();
