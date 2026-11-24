// Turns a recorded session into: a normalised scenario model, an AI-ready
// context document, Playwright + Cypress specs, a Postman collection, a HAR
// file, a manual test case / bug report, and a full evidence pack (ZIP).
// Pure functions — no browser APIs — so they are unit-tested in Node.

import { apiSignature, isApiLike, maskHeaders, normalizeUrl, sameRoute } from './analysis.js';
import { createZip, dataUrlToBytes } from './zip.js';

export const SECRET_MODES = Object.freeze({ PLACEHOLDER: 'placeholder', INCLUDE: 'include', MASK: 'mask' });

const DEFAULT_SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization'];

// ------------------------------------------------------------------ small utils

export function q(s) {
  return `'${String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
}
const tq = (s) => `\`${String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``; // template literal (keeps ${…})
export function slugify(s) {
  return String(s || 'scenario').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scenario';
}
function camel(s) {
  const words = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return 'field';
  const out = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^\d/.test(out) ? `f${out}` : out;
}
function truncate(s, n) {
  if (s == null) return s;
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}… [truncated ${s.length - n} chars]` : s;
}
function safeUrl(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
/** /orders/123/items → /\/orders\/[^/]+\/items/ (as a JS regex literal) */
export function pathRegexLiteral(url) {
  const norm = safeUrl(normalizeUrl(url));
  const path = norm ? norm.pathname : String(url);
  const body = path
    .split('/')
    .map((seg) => (seg === ':id' ? '[^/]+' : escapeRegex(seg)))
    .join('\\/');
  return `/${body || '\\/'}(?:[?#]|$)/`;
}
function routePath(url) {
  const n = safeUrl(normalizeUrl(url));
  return n ? n.pathname : String(url);
}
function fmtDate(ts) {
  return ts ? new Date(ts).toISOString() : '';
}
function keyCombo(step) {
  const m = step.modifiers || {};
  return [m.ctrl && 'Control', m.alt && 'Alt', m.shift && 'Shift', m.meta && 'Meta', step.key].filter(Boolean).join('+');
}

// ------------------------------------------------------------------ scenario model

/**
 * @param {object} session  session record
 * @param {object[]} events all events of the session (any order)
 * @param {object} opts { secrets, sensitiveHeaders, maxBody, screenshots: [{id, stepEventId, reason}] }
 */
export function buildScenario(session, events, opts = {}) {
  const secrets = opts.secrets || SECRET_MODES.PLACEHOLDER;
  const sensitiveHeaders = opts.sensitiveHeaders || DEFAULT_SENSITIVE_HEADERS;
  const maxBody = opts.maxBody ?? 4000;
  const original = events.filter((e) => (e.runId ?? null) === null).sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  const rawSteps = original.filter((e) => e.kind === 'step' && !e.skip);
  const network = original.filter((e) => e.kind === 'network').sort((a, b) => (a.startTime || a.ts) - (b.startTime || b.ts));
  const navs = original.filter((e) => e.kind === 'navigation');
  const consoleEvents = original.filter((e) => e.kind === 'console');
  const shotsByStep = new Map();
  for (const s of opts.screenshots || []) if (s.stepEventId != null && !s.runId && !shotsByStep.has(s.stepEventId)) shotsByStep.set(s.stepEventId, s);

  const startUrl = session.startUrl || rawSteps.find((s) => s.url)?.url || '';
  const origin = safeUrl(startUrl)?.origin || '';

  // ---- credentials + test data
  const credentials = [];
  const testData = {};
  const valueRefs = new Map(); // step id -> { kind: 'credential'|'data', key }
  const usedKeys = new Set();
  const varCount = {};
  const nextVar = (base) => {
    varCount[base] = (varCount[base] || 0) + 1;
    return varCount[base] === 1 ? base : `${base}_${varCount[base]}`;
  };
  const fills = rawSteps.filter((s) => s.action === 'fill');
  fills.forEach((s, i) => {
    if (s.sensitive) {
      const hay = `${s.target?.nameAttr || ''} ${s.target?.id || ''} ${s.target?.label || ''} ${s.target?.type || ''}`;
      const base = /otp|one.?time|2fa|mfa|code/i.test(hay) ? 'TEST_OTP' : /pass|pwd/i.test(hay) || s.target?.type === 'password' ? 'TEST_PASSWORD' : 'TEST_SECRET';
      const variable = nextVar(base);
      credentials.push({ variable, key: camel(variable.replace(/^TEST_/, '')), field: s.target?.friendly || 'secret', url: s.url, value: s.value, masked: !!s.masked, role: base === 'TEST_PASSWORD' ? 'password' : 'secret' });
      valueRefs.set(s.id, { kind: 'credential', variable });
      // username = the nearest preceding non-sensitive fill on the same page
      if (base === 'TEST_PASSWORD') {
        const prev = fills.slice(0, i).reverse().find((p) => !p.sensitive && safeUrl(p.url)?.pathname === safeUrl(s.url)?.pathname && !valueRefs.has(p.id));
        if (prev) {
          const uvar = nextVar('TEST_USERNAME');
          credentials.push({ variable: uvar, key: camel(uvar.replace(/^TEST_/, '')), field: prev.target?.friendly || 'username', url: prev.url, value: prev.value, masked: false, role: 'username' });
          valueRefs.set(prev.id, { kind: 'credential', variable: uvar });
        }
      }
    }
  });
  for (const s of fills) {
    if (valueRefs.has(s.id)) continue;
    let key = camel(s.target?.label || s.target?.placeholder || s.target?.nameAttr || s.target?.name || s.target?.id || 'field');
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}${n}`)) n++;
      key = `${key}${n}`;
    }
    usedKeys.add(key);
    testData[key] = s.value ?? '';
    valueRefs.set(s.id, { kind: 'data', key });
  }
  credentials.sort((a, b) => (a.role === 'username' ? -1 : 0) - (b.role === 'username' ? -1 : 0));
  const credByVar = new Map(credentials.map((c) => [c.variable, c]));

  const secretDisplay = (variable) => {
    const c = credByVar.get(variable);
    if (secrets === SECRET_MODES.INCLUDE) return c?.value ?? '';
    if (secrets === SECRET_MODES.MASK) return '********';
    return `<${variable}>`;
  };

  // ---- api call shaping
  const shapeApi = (e) => ({
    id: e.id,
    api: e.api,
    method: (e.method || 'GET').toUpperCase(),
    url: e.url,
    route: routePath(e.url),
    signature: apiSignature(e),
    status: e.status,
    statusText: e.statusText,
    durationMs: e.duration,
    startTime: e.startTime || e.ts,
    mimeType: e.mimeType,
    error: e.error || undefined,
    requestHeaders: maskHeaders(e.requestHeaders, sensitiveHeaders, secrets !== SECRET_MODES.INCLUDE),
    requestBody: truncate(maskBodySecrets(e.requestBody, credentials, secrets), maxBody),
    responseHeaders: maskHeaders(e.responseHeaders, sensitiveHeaders, secrets !== SECRET_MODES.INCLUDE),
    responseBody: truncate(e.responseBody, maxBody),
    bodyTruncated: e.bodyTruncated || undefined,
  });

  // ---- steps
  const steps = rawSteps.map((s, i) => {
    const from = s.ts;
    const to = rawSteps[i + 1]?.ts ?? Infinity;
    const triggered = network.filter((n) => {
      const t = n.startTime || n.ts;
      return t >= from - 50 && t < to - 50 && isApiLike(n);
    });
    const navIn = navs.filter((n) => n.ts >= from && n.ts < to);
    const navigatedTo = navIn.length ? navIn[navIn.length - 1].url : null;
    const ref = valueRefs.get(s.id);
    let displayValue = s.value;
    if (ref?.kind === 'credential') displayValue = secretDisplay(ref.variable);
    const shot = shotsByStep.get(s.id);
    const step = {
      n: i + 1,
      id: s.id,
      action: s.action,
      url: s.url,
      pageTitle: s.title,
      value: displayValue,
      valueRef: ref,
      values: s.values,
      optionLabels: s.optionLabels,
      key: s.key,
      modifiers: s.modifiers,
      button: s.button,
      files: s.files,
      assert: s.assert,
      note: s.note,
      flag: s.flag,
      via: s.via,
      target: s.target ? summarizeTarget(s.target) : undefined,
      apiCalls: triggered.map(shapeApi),
      navigatedTo: navigatedTo && !sameRoute(navigatedTo, s.url || '') ? navigatedTo : null,
      screenshot: shot ? `screenshots/${screenshotName(i + 1, s.action, shot)}` : null,
      screenshotId: shot?.id || null,
    };
    step.description = describeStep(step);
    step.expected = expectedResult(step);
    return step;
  });

  const apis = network.filter(isApiLike).map(shapeApi);
  const endpoints = summarizeEndpoints(apis);
  const lastRun = (session.runs || []).filter((r) => r.status !== 'running').slice(-1)[0];

  return {
    format: 'qa-scenario-recorder/scenario',
    version: 1,
    name: session.name,
    sessionId: session.id,
    recordedAt: fmtDate(session.createdAt),
    durationMs: session.durationMs,
    startUrl,
    origin,
    environment: session.environment || {},
    secretsMode: secrets,
    credentials: credentials.map((c) => ({ ...c, value: secretDisplay(c.variable) })),
    testData,
    steps,
    apis,
    endpoints,
    documents: network.filter((n) => n.api === 'document').map((n) => ({ method: n.method, url: n.url, status: n.status, type: n.resourceType })),
    console: consoleEvents.map((c) => ({ level: c.level, message: truncate(c.message, 1000), url: c.url, ts: c.ts, stack: truncate(c.stack, 1500) })),
    notes: steps.filter((s) => s.action === 'note').map((s) => ({ step: s.n, flag: s.flag || 'info', text: s.value })),
    failedApis: apis.filter((a) => a.status >= 400 || a.status === 0),
    lastRun: lastRun ? summarizeRun(lastRun) : null,
  };
}

function maskBodySecrets(body, credentials, secrets) {
  if (!body || secrets === SECRET_MODES.INCLUDE) return body;
  let out = String(body);
  for (const c of credentials) {
    if (c.role === 'username' || !c.value || c.value.length < 3 || c.masked) continue;
    out = out.split(c.value).join(secrets === SECRET_MODES.MASK ? '********' : `<${c.variable}>`);
  }
  return out;
}

function screenshotName(n, action, shot) {
  return `step-${String(n).padStart(2, '0')}-${action}.jpg`;
}

function summarizeTarget(t) {
  return {
    friendly: t.friendly,
    tag: t.tag,
    type: t.type,
    role: t.role,
    name: t.name,
    text: t.text,
    label: t.label,
    placeholder: t.placeholder,
    testId: t.testId,
    context: t.context,
    candidates: t.candidates,
    rect: t.rect,
    viewport: t.viewport,
    html: t.html,
    locators: {
      playwright: playwrightLocator(t),
      cypress: cypressLocator(t),
      css: (t.candidates || []).find((c) => c.css && c.unique)?.css || (t.candidates || []).find((c) => c.css)?.css,
      xpath: (t.candidates || []).find((c) => c.type === 'xpath')?.value,
    },
  };
}

function summarizeRun(r) {
  const counts = { passed: 0, failed: 0, skipped: 0, 'not-run': 0 };
  for (const x of r.results || []) counts[x.status] = (counts[x.status] || 0) + 1;
  return {
    id: r.id,
    status: r.status,
    startedAt: fmtDate(r.startedAt),
    durationMs: r.endedAt ? r.endedAt - r.startedAt : undefined,
    counts,
    failures: (r.results || []).filter((x) => x.status === 'failed').map((x) => ({ index: x.index + 1, action: x.action, error: x.error })),
    apiDiff: r.apiDiff
      ? {
          missing: r.apiDiff.missing,
          unexpected: r.apiDiff.unexpected,
          statusChanged: r.apiDiff.statusChanged,
          slower: r.apiDiff.slower,
        }
      : null,
  };
}

function summarizeEndpoints(apis) {
  const map = new Map();
  for (const a of apis) {
    const k = a.signature;
    if (!map.has(k)) map.set(k, { signature: k, method: a.method, route: a.route, origin: safeUrl(a.url)?.origin, count: 0, statuses: new Set(), totalMs: 0, sampleRequest: a.requestBody, sampleResponse: a.responseBody, mimeType: a.mimeType });
    const m = map.get(k);
    m.count++;
    m.statuses.add(a.status);
    m.totalMs += a.durationMs || 0;
  }
  return Array.from(map.values()).map((m) => ({ ...m, statuses: Array.from(m.statuses), avgMs: Math.round(m.totalMs / m.count), totalMs: undefined }));
}

// ------------------------------------------------------------------ descriptions

function where(t) {
  const c = t?.context || {};
  if (c.dialog) return ` in the "${c.dialog}" dialog`;
  if (c.form && c.form !== 'form') return ` in the "${c.form}" form`;
  if (c.row) return ` in row "${truncate(c.row, 40)}"`;
  return '';
}
function noun(t) {
  if (!t) return 'element';
  if (t.role && !['textbox', 'searchbox'].includes(t.role)) return t.role === 'combobox' && t.tag === 'select' ? 'dropdown' : t.role;
  if (t.type === 'checkbox' || t.type === 'radio') return t.type;
  if (t.role === 'textbox' || t.role === 'searchbox' || ['input', 'textarea'].includes(t.tag)) return 'field';
  return t.role || t.tag || 'element';
}

export function describeStep(s) {
  const t = s.target;
  const name = t ? `"${t.friendly}"` : '';
  switch (s.action) {
    case 'goto':
      return s.via === 'history' ? `Navigate (back/forward) to ${s.url}` : `Navigate to ${s.url}`;
    case 'reload':
      return 'Reload the page';
    case 'click':
      return `${s.button === 'right' ? 'Right-click' : 'Click'} the ${name} ${noun(t)}${where(t)}`;
    case 'dblclick':
      return `Double-click the ${name} ${noun(t)}${where(t)}`;
    case 'fill':
      return `Enter ${s.valueRef?.kind === 'credential' ? s.value : `"${truncate(s.value, 60)}"`} into the ${name} field${where(t)}`;
    case 'select':
      return `Select "${(s.optionLabels || [s.value]).join(', ')}" in the ${name} dropdown${where(t)}`;
    case 'check':
      return `Check the ${name} ${noun(t)}${where(t)}`;
    case 'uncheck':
      return `Uncheck the ${name} ${noun(t)}${where(t)}`;
    case 'press':
      return `Press ${keyCombo(s)}${t ? ` in the ${name} ${noun(t)}` : ''}`;
    case 'upload':
      return `Upload ${(s.files || []).map((f) => f.name).join(', ') || 'a file'} via ${name}`;
    case 'hover':
      return `Hover over ${name}`;
    case 'assert': {
      const a = s.assert || {};
      if (a.type === 'url') return `Verify the page URL is ${a.expected}`;
      if (a.type === 'visible') return `Verify ${name} is visible`;
      if (a.type === 'hidden') return `Verify ${name} is not visible`;
      if (a.type === 'value') return `Verify ${name} has value "${truncate(a.expected, 60)}"`;
      if (a.type === 'checked') return `Verify ${name} is ${a.expected ? 'checked' : 'not checked'}`;
      return `Verify ${name} shows text "${truncate(a.expected, 80)}"`;
    }
    case 'note':
      return `${s.flag === 'bug' ? 'BUG' : 'Note'}: ${s.value}`;
    case 'screenshot':
      return 'Capture evidence screenshot';
    default:
      return s.action;
  }
}

function expectedResult(s) {
  const parts = [];
  if (s.action === 'assert') parts.push(describeStep(s).replace(/^Verify /, '') + ' ✔');
  if (s.navigatedTo) parts.push(`User lands on ${routePath(s.navigatedTo)}`);
  for (const a of s.apiCalls.slice(0, 4)) parts.push(`${a.method} ${a.route} → ${a.status || 'ERR'}`);
  if (s.action === 'goto' && !parts.length) parts.push('Page loads successfully');
  if (s.action === 'fill' && !parts.length) parts.push('Value is accepted by the field');
  if (!parts.length && s.action !== 'note') parts.push('Action completes without errors');
  return parts.join('; ');
}

// ------------------------------------------------------------------ locators

function bestCandidate(t, accept = () => true) {
  const c = (t?.candidates || []).filter(accept);
  return c.find((x) => x.unique) || c[0] || null;
}

export function playwrightLocator(t) {
  const c = bestCandidate(t, (x) => x.type !== 'xpath') || bestCandidate(t);
  if (!c) return 'page.locator(\'body\')';
  let loc;
  switch (c.type) {
    case 'testid':
      loc = c.attr === 'data-testid' ? `page.getByTestId(${q(c.value)})` : `page.locator(${q(c.css)})`;
      break;
    case 'role':
      loc = `page.getByRole(${q(c.role)}, { name: ${q(c.name)}, exact: true })`;
      break;
    case 'label':
      loc = `page.getByLabel(${q(c.value)}, { exact: true })`;
      break;
    case 'placeholder':
      loc = `page.getByPlaceholder(${q(c.value)}, { exact: true })`;
      break;
    case 'text':
      loc = `page.getByText(${q(c.value)}, { exact: true })`;
      break;
    case 'xpath':
      loc = `page.locator(${q(`xpath=${c.value}`)})`;
      break;
    default:
      loc = `page.locator(${q(c.css || c.value)})`;
  }
  return c.unique ? loc : `${loc}.first()`;
}

export function cypressLocator(t) {
  const cands = t?.candidates || [];
  const cssUnique = cands.find((x) => x.css && x.unique && ['testid', 'id', 'name', 'placeholder', 'aria'].includes(x.type));
  if (cssUnique) return `cy.get(${q(cssUnique.css)})`;
  const textual = cands.find((x) => x.unique && (x.type === 'text' || x.type === 'role'));
  if (textual && t.tag) return `cy.contains(${q(t.tag)}, ${q(textual.type === 'text' ? textual.value : textual.name)})`;
  const label = cands.find((x) => x.unique && x.type === 'label');
  if (label && t.id) return `cy.get(${q(`#${t.id}`)})`;
  const css = cands.find((x) => x.type === 'css');
  if (css) return `cy.get(${q(css.css)})${css.unique ? '' : '.first()'}`;
  const any = cands.find((x) => x.css);
  return any ? `cy.get(${q(any.css)}).first()` : "cy.get('body')";
}

// ------------------------------------------------------------------ value expressions

function valueExprPW(step) {
  const r = step.valueRef;
  if (r?.kind === 'credential') return `credentials.${camel(r.variable.replace(/^TEST_/, ''))}`;
  if (r?.kind === 'data') return `testData.${r.key}`;
  return q(step.value);
}
function urlExpr(url, origin, baseVar) {
  const u = safeUrl(url);
  if (u && origin && u.origin === origin) return tq(`\${${baseVar}}${u.pathname}${u.search}${u.hash}`);
  return q(url);
}
function keyApis(step) {
  // The calls worth synchronising on: mutations, or GETs returning data.
  return step.apiCalls.filter((a) => a.api !== 'document' && (a.method !== 'GET' || /json|graphql/i.test(a.mimeType || ''))).slice(0, 3);
}
function credentialsBlock(scn, lang) {
  if (!scn.credentials.length) return '';
  const lines = scn.credentials.map((c) => {
    const fallback = scn.secretsMode === SECRET_MODES.INCLUDE ? q(c.value) : "''";
    const env = lang === 'cy' ? `Cypress.env(${q(c.variable)})` : `process.env.${c.variable}`;
    return `  ${camel(c.variable.replace(/^TEST_/, ''))}: ${env} ?? ${fallback}, // ${c.field}`;
  });
  return `// Secrets come from env vars (see .env.example)\nconst credentials = {\n${lines.join('\n')}\n};\n`;
}
function testDataBlock(scn) {
  const entries = Object.entries(scn.testData);
  if (!entries.length) return '';
  return `const testData = {\n${entries.map(([k, v]) => `  ${k}: ${q(v)},`).join('\n')}\n};\n`;
}

// ------------------------------------------------------------------ Playwright

export function toPlaywright(scn) {
  const L = [];
  L.push("import { test, expect } from '@playwright/test';");
  L.push('');
  L.push('/**');
  L.push(` * Scenario: ${scn.name}`);
  L.push(` * Recorded: ${scn.recordedAt} with QA Scenario Recorder`);
  L.push(` * Start URL: ${scn.startUrl}`);
  L.push(' * Locators were ranked at record time (test-id > role/label > css). Review any marked .first().');
  L.push(' */');
  L.push('');
  L.push(`const BASE_URL = process.env.BASE_URL ?? ${q(scn.origin)};`);
  const cb = credentialsBlock(scn, 'pw');
  if (cb) L.push(cb);
  const tb = testDataBlock(scn);
  if (tb) L.push(tb);
  const vp = scn.environment?.viewport;
  if (vp?.width) L.push(`test.use({ viewport: { width: ${vp.width}, height: ${vp.height} } });\n`);
  L.push(`test.describe(${q(scn.name)}, () => {`);
  L.push(`  test(${q(scn.name)}, async ({ page }) => {`);

  for (const s of scn.steps) {
    const body = [];
    const loc = s.target?.locators.playwright;
    const apis = s.action === 'note' ? [] : keyApis(s);
    apis.forEach((a, i) => {
      const v = `resp${s.n}${apis.length > 1 ? `_${i + 1}` : ''}`;
      body.push(`const ${v} = page.waitForResponse((r) => ${pathRegexLiteral(a.url)}.test(new URL(r.url()).pathname + new URL(r.url()).search) && r.request().method() === ${q(a.method)});`);
    });
    switch (s.action) {
      case 'goto':
        body.push(`await page.goto(${urlExpr(s.url, scn.origin, 'BASE_URL')});`);
        break;
      case 'reload':
        body.push('await page.reload();');
        break;
      case 'click': {
        const opts = [];
        if (s.button === 'right') opts.push("button: 'right'");
        const m = s.modifiers || {};
        const mods = [m.ctrl && "'Control'", m.alt && "'Alt'", m.shift && "'Shift'", m.meta && "'Meta'"].filter(Boolean);
        if (mods.length) opts.push(`modifiers: [${mods.join(', ')}]`);
        body.push(`await ${loc}.click(${opts.length ? `{ ${opts.join(', ')} }` : ''});`);
        break;
      }
      case 'dblclick':
        body.push(`await ${loc}.dblclick();`);
        break;
      case 'hover':
        body.push(`await ${loc}.hover();`);
        break;
      case 'fill':
        body.push(`await ${loc}.fill(${valueExprPW(s)});`);
        break;
      case 'select':
        body.push(`await ${loc}.selectOption(${s.values && s.values.length > 1 ? `[${s.values.map(q).join(', ')}]` : q(s.value)});`);
        break;
      case 'check':
        body.push(`await ${loc}.check();`);
        break;
      case 'uncheck':
        body.push(`await ${loc}.uncheck();`);
        break;
      case 'press':
        body.push(loc ? `await ${loc}.press(${q(keyCombo(s))});` : `await page.keyboard.press(${q(keyCombo(s))});`);
        break;
      case 'upload':
        body.push(`// TODO: point to a fixture file`);
        body.push(`await ${loc}.setInputFiles(${q(`fixtures/${s.files?.[0]?.name || 'file.txt'}`)});`);
        break;
      case 'assert':
        body.push(playwrightAssertion(s, loc));
        break;
      case 'screenshot':
        body.push(`await test.info().attach(${q(`step-${s.n}`)}, { body: await page.screenshot(), contentType: 'image/png' });`);
        break;
      case 'note':
        body.push(`// ${s.flag === 'bug' ? 'BUG' : 'NOTE'} (tester): ${String(s.value).replace(/\n/g, ' ')}`);
        break;
      default:
        body.push(`// Unsupported action: ${s.action}`);
    }
    apis.forEach((a, i) => {
      const v = `resp${s.n}${apis.length > 1 ? `_${i + 1}` : ''}`;
      if (a.status && a.status !== 304) body.push(`expect((await ${v}).status()).toBe(${a.status});`);
      else body.push(`await ${v};`);
    });
    if (s.navigatedTo) body.push(`await expect(page).toHaveURL(${pathRegexLiteral(s.navigatedTo)});`);

    if (s.action === 'note') {
      L.push(`    ${body.join('\n    ')}`);
      continue;
    }
    L.push(`    await test.step(${q(`${s.n}. ${s.description}`)}, async () => {`);
    for (const b of body) L.push(`      ${b}`);
    L.push('    });');
  }
  L.push('  });');
  L.push('});');
  L.push('');
  return L.join('\n');
}

function playwrightAssertion(s, loc) {
  const a = s.assert || {};
  switch (a.type) {
    case 'url':
      return `await expect(page).toHaveURL(${pathRegexLiteral(a.expected)});`;
    case 'visible':
      return `await expect(${loc}).toBeVisible();`;
    case 'hidden':
      return `await expect(${loc}).toBeHidden();`;
    case 'value':
      return `await expect(${loc}).toHaveValue(${q(a.expected)});`;
    case 'checked':
      return a.expected ? `await expect(${loc}).toBeChecked();` : `await expect(${loc}).not.toBeChecked();`;
    default:
      return `await expect(${loc}).toContainText(${q(a.expected)});`;
  }
}

// ------------------------------------------------------------------ Cypress

const CY_KEYS = { Enter: '{enter}', Escape: '{esc}', Tab: '{tab}', ArrowDown: '{downArrow}', ArrowUp: '{upArrow}', Backspace: '{backspace}' };
function cyKey(s) {
  const m = s.modifiers || {};
  const prefix = [m.ctrl && '{ctrl}', m.alt && '{alt}', m.shift && '{shift}', m.meta && '{meta}'].filter(Boolean).join('');
  return prefix + (CY_KEYS[s.key] || (s.key.length === 1 ? s.key.toLowerCase() : `{${s.key.toLowerCase()}}`));
}
function cyValueExpr(step) {
  const r = step.valueRef;
  if (r?.kind === 'credential') return `credentials.${camel(r.variable.replace(/^TEST_/, ''))}`;
  if (r?.kind === 'data') return `testData.${r.key}`;
  return q(step.value);
}
function cyRouteMatcher(a, origin) {
  const u = safeUrl(a.url);
  const path = routePath(a.url).replace(/:id/g, '*');
  const parts = [`method: ${q(a.method)}`, `pathname: ${q(path)}`];
  if (u && origin && u.origin !== origin) parts.push(`hostname: ${q(u.hostname)}`);
  return `{ ${parts.join(', ')} }`;
}

export function toCypress(scn) {
  const L = [];
  const intercepts = [];
  const aliasFor = new Map();
  for (const s of scn.steps) {
    keyApis(s).forEach((a, i) => {
      const alias = `step${s.n}${camel(`${a.method} ${a.route.split('/').filter((x) => x && x !== ':id').slice(-2).join(' ')}`).replace(/^./, (c) => c.toUpperCase())}${i ? i + 1 : ''}`;
      aliasFor.set(`${s.n}:${i}`, alias);
      intercepts.push(`    cy.intercept(${cyRouteMatcher(a, scn.origin)}).as(${q(alias)});`);
    });
  }
  L.push('/// <reference types="cypress" />');
  L.push('/**');
  L.push(` * Scenario: ${scn.name}`);
  L.push(` * Recorded: ${scn.recordedAt} with QA Scenario Recorder`);
  L.push(` * Start URL: ${scn.startUrl}`);
  L.push(' */');
  L.push('');
  L.push(`const BASE_URL = Cypress.env('BASE_URL') || ${q(scn.origin)};`);
  const cb = credentialsBlock(scn, 'cy');
  if (cb) L.push(cb);
  const tb = testDataBlock(scn);
  if (tb) L.push(tb);
  L.push(`describe(${q(scn.name)}, () => {`);
  const vp = scn.environment?.viewport;
  if (intercepts.length || vp?.width) {
    L.push('  beforeEach(() => {');
    if (vp?.width) L.push(`    cy.viewport(${vp.width}, ${vp.height});`);
    L.push(...intercepts);
    L.push('  });');
    L.push('');
  }
  L.push(`  it(${q(scn.name)}, () => {`);
  for (const s of scn.steps) {
    const loc = s.target?.locators.cypress;
    L.push(`    // ${s.n}. ${s.description.replace(/\n/g, ' ')}`);
    switch (s.action) {
      case 'goto':
        L.push(`    cy.visit(${urlExpr(s.url, scn.origin, 'BASE_URL')});`);
        break;
      case 'reload':
        L.push('    cy.reload();');
        break;
      case 'click':
        L.push(`    ${loc}.${s.button === 'right' ? 'rightclick' : 'click'}();`);
        break;
      case 'dblclick':
        L.push(`    ${loc}.dblclick();`);
        break;
      case 'hover':
        L.push(`    ${loc}.trigger('mouseover');`);
        break;
      case 'fill': {
        const sensitive = s.valueRef?.kind === 'credential';
        const opts = `{ delay: 0, parseSpecialCharSequences: false${sensitive ? ', log: false' : ''} }`;
        const v = cyValueExpr(s);
        L.push(s.value === '' ? `    ${loc}.clear();` : `    ${loc}.clear().type(${v}, ${opts});`);
        break;
      }
      case 'select':
        L.push(`    ${loc}.select(${s.values && s.values.length > 1 ? `[${s.values.map(q).join(', ')}]` : q(s.value)});`);
        break;
      case 'check':
        L.push(`    ${loc}.check();`);
        break;
      case 'uncheck':
        L.push(`    ${loc}.uncheck();`);
        break;
      case 'press':
        L.push(loc ? `    ${loc}.type(${q(cyKey(s))});` : `    cy.focused().type(${q(cyKey(s))});`);
        break;
      case 'upload':
        L.push(`    ${loc}.selectFile(${q(`cypress/fixtures/${s.files?.[0]?.name || 'file.txt'}`)}); // TODO: add fixture`);
        break;
      case 'assert':
        L.push(`    ${cypressAssertion(s, loc)}`);
        break;
      case 'screenshot':
        L.push(`    cy.screenshot(${q(`step-${s.n}`)});`);
        break;
      case 'note':
        L.push(`    // ${s.flag === 'bug' ? 'BUG' : 'NOTE'} (tester): ${String(s.value).replace(/\n/g, ' ')}`);
        break;
      default:
        L.push(`    // Unsupported action: ${s.action}`);
    }
    keyApis(s).forEach((a, i) => {
      const alias = aliasFor.get(`${s.n}:${i}`);
      if (a.status && a.status !== 304) L.push(`    cy.wait('@${alias}').its('response.statusCode').should('eq', ${a.status});`);
      else L.push(`    cy.wait('@${alias}');`);
    });
    if (s.navigatedTo) L.push(`    cy.location('pathname').should('match', ${pathRegexLiteral(s.navigatedTo).replace('(?:[?#]|$)', '$')});`);
  }
  L.push('  });');
  L.push('});');
  L.push('');
  return L.join('\n');
}

function cypressAssertion(s, loc) {
  const a = s.assert || {};
  switch (a.type) {
    case 'url':
      return `cy.location('pathname').should('eq', ${q(safeUrl(a.expected)?.pathname || a.expected)});`;
    case 'visible':
      return `${loc}.should('be.visible');`;
    case 'hidden':
      return `${loc}.should('not.be.visible');`;
    case 'value':
      return `${loc}.should('have.value', ${q(a.expected)});`;
    case 'checked':
      return `${loc}.should('${a.expected ? 'be.checked' : 'not.be.checked'}');`;
    default:
      return `${loc}.should('contain.text', ${q(a.expected)});`;
  }
}

// ------------------------------------------------------------------ Postman / HAR

export function toPostman(scn) {
  const variables = [{ key: 'baseUrl', value: scn.origin }];
  const tokenVars = new Set();
  const toItem = (a, idx) => {
    const u = safeUrl(a.url);
    const sameOrigin = u && u.origin === scn.origin;
    const raw = sameOrigin ? `{{baseUrl}}${u.pathname}${u.search}` : a.url;
    const header = Object.entries(a.requestHeaders || {}).map(([key, value]) => {
      if (value === '***MASKED***') {
        const v = camel(key);
        tokenVars.add(v);
        return { key, value: `{{${v}}}` };
      }
      return { key, value: String(value) };
    });
    const item = {
      name: `${idx}. ${a.method} ${a.route}`,
      request: {
        method: a.method,
        header,
        url: {
          raw,
          ...(sameOrigin ? { host: ['{{baseUrl}}'] } : u ? { protocol: u.protocol.replace(':', ''), host: u.hostname.split('.') , port: u.port || undefined } : {}),
          path: u ? u.pathname.split('/').filter(Boolean) : [],
          query: u ? Array.from(u.searchParams.entries()).map(([key, value]) => ({ key, value })) : [],
        },
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: a.status
              ? [`pm.test('Status is ${a.status}', () => pm.response.to.have.status(${a.status}));`, `pm.test('Responds within ${Math.max(1000, (a.durationMs || 0) * 3)}ms', () => pm.expect(pm.response.responseTime).to.be.below(${Math.max(1000, (a.durationMs || 0) * 3)}));`]
              : [],
          },
        },
      ],
    };
    if (a.requestBody && a.method !== 'GET') {
      const isJson = /^\s*[[{]/.test(a.requestBody);
      item.request.body = { mode: 'raw', raw: a.requestBody, options: { raw: { language: isJson ? 'json' : 'text' } } };
    }
    return item;
  };
  let idx = 0;
  const folders = scn.steps
    .filter((s) => s.apiCalls.some((a) => a.api !== 'document' || a.method !== 'GET'))
    .map((s) => ({
      name: `Step ${s.n} — ${s.description.slice(0, 80)}`,
      item: s.apiCalls.filter((a) => a.api !== 'document' || a.method !== 'GET').map((a) => toItem(a, ++idx)),
    }));
  for (const v of tokenVars) variables.push({ key: v, value: '' });
  return {
    info: {
      name: `${scn.name} — API calls`,
      description: `Captured by QA Scenario Recorder on ${scn.recordedAt} from ${scn.startUrl}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: folders,
    variable: variables,
  };
}

export function toHar(scn, version = '1.0.0') {
  const h = (obj) => Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
  return {
    log: {
      version: '1.2',
      creator: { name: 'QA Scenario Recorder', version },
      pages: [{ startedDateTime: scn.recordedAt || new Date(0).toISOString(), id: 'page_1', title: scn.name, pageTimings: {} }],
      entries: scn.apis.map((a) => {
        const u = safeUrl(a.url);
        const entry = {
          pageref: 'page_1',
          startedDateTime: new Date(a.startTime || 0).toISOString(),
          time: a.durationMs || 0,
          request: {
            method: a.method,
            url: a.url,
            httpVersion: 'HTTP/1.1',
            headers: h(a.requestHeaders),
            queryString: u ? Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value })) : [],
            cookies: [],
            headersSize: -1,
            bodySize: a.requestBody ? a.requestBody.length : 0,
          },
          response: {
            status: a.status || 0,
            statusText: a.statusText || '',
            httpVersion: 'HTTP/1.1',
            headers: h(a.responseHeaders),
            cookies: [],
            content: { size: a.responseBody ? a.responseBody.length : 0, mimeType: a.mimeType || '', text: a.responseBody || '' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: a.durationMs || 0, receive: 0 },
        };
        if (a.requestBody) entry.request.postData = { mimeType: a.requestHeaders?.['content-type'] || a.requestHeaders?.['Content-Type'] || 'application/json', text: a.requestBody };
        return entry;
      }),
    },
  };
}

// ------------------------------------------------------------------ Markdown documents

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function envTable(scn) {
  const e = scn.environment || {};
  const rows = [
    ['Start URL', scn.startUrl],
    ['Browser', e.userAgent],
    ['Viewport', e.viewport ? `${e.viewport.width}×${e.viewport.height} @${e.devicePixelRatio || 1}x` : ''],
    ['Locale / Timezone', [e.language, e.timezone].filter(Boolean).join(' / ')],
    ['Color scheme', e.colorScheme],
    ['Recorded', scn.recordedAt],
    ['Duration', scn.durationMs ? `${Math.round(scn.durationMs / 1000)}s` : ''],
  ].filter(([, v]) => v);
  return ['| Field | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${mdEscape(v)} |`)].join('\n');
}

export function envExample(scn) {
  const lines = ['# Environment for the generated tests', `BASE_URL=${scn.origin}`];
  for (const c of scn.credentials) lines.push(`${c.variable}=${scn.secretsMode === SECRET_MODES.INCLUDE ? c.value : ''}   # ${c.field}`);
  return `${lines.join('\n')}\n`;
}

export function toTestCaseMarkdown(scn) {
  const L = [];
  L.push(`# Test Case: ${scn.name}`);
  L.push('');
  L.push(envTable(scn));
  L.push('');
  L.push('## Preconditions');
  L.push(`- Application reachable at ${scn.origin}`);
  if (scn.credentials.length) L.push(`- Test account available (${scn.credentials.map((c) => c.variable).join(', ')})`);
  L.push('');
  if (Object.keys(scn.testData).length) {
    L.push('## Test data');
    L.push('| Key | Value |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(scn.testData)) L.push(`| ${k} | ${mdEscape(v)} |`);
    L.push('');
  }
  L.push('## Steps');
  L.push('| # | Step | Expected result | Evidence |');
  L.push('|---|---|---|---|');
  for (const s of scn.steps) L.push(`| ${s.n} | ${mdEscape(s.description)} | ${mdEscape(s.expected)} | ${s.screenshot ? `[screenshot](${s.screenshot})` : ''} |`);
  L.push('');
  const bugs = scn.notes.filter((n) => n.flag === 'bug');
  if (bugs.length || scn.failedApis.length || scn.console.some((c) => c.level === 'error')) {
    L.push('## Observed issues');
    for (const b of bugs) L.push(`- 🐞 **Step ${b.step}** — ${b.text}`);
    for (const a of scn.failedApis) L.push(`- ⚠️ \`${a.method} ${a.route}\` returned **${a.status || 'network error'}** ${a.error ? `(${a.error})` : ''}`);
    for (const c of scn.console.filter((x) => x.level === 'error').slice(0, 20)) L.push(`- 🧯 Console error: \`${mdEscape(truncate(c.message, 200))}\``);
    L.push('');
  }
  if (scn.lastRun) {
    L.push('## Last replay');
    L.push(`Status: **${scn.lastRun.status}** — ${JSON.stringify(scn.lastRun.counts)}`);
    for (const f of scn.lastRun.failures) L.push(`- Step ${f.index} (${f.action}): ${f.error}`);
    L.push('');
  }
  return L.join('\n');
}

export function toAiContext(scn) {
  const L = [];
  L.push(`# Test automation context — ${scn.name}`);
  L.push('');
  L.push(`> Captured with QA Scenario Recorder on ${scn.recordedAt}. This document is self-contained: it describes a manual test scenario performed by a QA engineer, including every UI interaction, the element locators observed in the live DOM, the backend API traffic each step triggered, and the resulting navigation. Use it as the source of truth for writing automated tests.`);
  L.push('');
  L.push('## Instructions for the AI assistant');
  L.push('');
  L.push('You are a senior SDET. Using the recorded scenario below:');
  L.push('');
  L.push('1. Generate a **Playwright Test (TypeScript)** spec using the Page Object Model (one page class per distinct page/route below). Wrap each step in `test.step()` named after the step description.');
  L.push('2. If asked for **Cypress** instead, generate an equivalent spec with `cy.intercept()` aliases for the listed API calls and custom commands for login.');
  L.push('3. Locators: use the ranked candidates provided per step. Prefer, in order: `getByTestId` → `getByRole` with name → `getByLabel` / `getByPlaceholder` → stable CSS. Never use the XPath unless nothing else is unique. Candidates marked `unique: false` need scoping (e.g. within the dialog/form/row given in `context`).');
  L.push('4. Synchronisation: never use fixed sleeps. Wait on the API responses listed under each step (`waitForResponse` / `cy.wait(@alias)`) and on URL changes (`toHaveURL`).');
  L.push('5. Assertions: assert every explicit verification step, every navigation, and the HTTP status of each key API call. Add response-body assertions for important fields visible in the sample responses.');
  L.push('6. Data: read credentials from the environment variables listed (never hard-code secrets). Move the test data into a fixture/object so the test can be data-driven.');
  L.push('7. Also generate API-level tests for the endpoints in the API inventory (status, schema of the sample response, negative cases such as missing auth or invalid payloads).');
  L.push('8. Call out anything ambiguous (e.g. tester notes flagged as bugs, failing APIs, console errors) as TODO comments rather than guessing.');
  L.push('');
  L.push('## Application under test');
  L.push('');
  L.push(envTable(scn));
  L.push('');
  L.push('## Credentials & secrets');
  L.push('');
  if (scn.credentials.length) {
    L.push('| Env variable | Field | Used on | Value |');
    L.push('|---|---|---|---|');
    for (const c of scn.credentials) L.push(`| \`${c.variable}\` | ${mdEscape(c.field)} | ${mdEscape(routePath(c.url))} | ${mdEscape(c.value)} |`);
    L.push('');
    L.push('```dotenv');
    L.push(envExample(scn).trim());
    L.push('```');
  } else L.push('_No credential fields were detected in this scenario._');
  L.push('');
  if (Object.keys(scn.testData).length) {
    L.push('## Test data (non-secret values typed by the tester)');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(scn.testData, null, 2));
    L.push('```');
    L.push('');
  }
  L.push('## Steps');
  L.push('');
  for (const s of scn.steps) {
    L.push(`### Step ${s.n} — ${s.description}`);
    L.push('');
    L.push(`- **Action:** \`${s.action}\`${s.value !== undefined && s.action !== 'note' ? ` · **Value:** \`${mdEscape(truncate(s.value, 200))}\`${s.valueRef ? ` (→ ${s.valueRef.kind === 'credential' ? `env \`${s.valueRef.variable}\`` : `testData.${s.valueRef.key}`})` : ''}` : ''}${s.key ? ` · **Key:** \`${keyCombo(s)}\`` : ''}`);
    L.push(`- **Page:** ${s.pageTitle ? `"${mdEscape(s.pageTitle)}" ` : ''}${s.url || ''}`);
    if (s.target) {
      const t = s.target;
      L.push(`- **Element:** \`<${t.tag}${t.type ? ` type="${t.type}"` : ''}>\` ${t.role ? `role=\`${t.role}\`` : ''} name="${mdEscape(t.name || t.friendly)}"${Object.keys(t.context || {}).length ? ` · context: ${mdEscape(JSON.stringify(t.context))}` : ''}`);
      L.push(`- **Suggested locators:** Playwright \`${t.locators.playwright}\` · Cypress \`${t.locators.cypress}\``);
      L.push(`- **All candidates (ranked):** ${(t.candidates || []).map((c) => `\`${c.type}${c.role ? `:${c.role}` : ''}=${mdEscape(c.name || c.value || c.css)}\`${c.unique ? '' : ' (not unique)'}`).join(', ')}`);
      if (t.html) L.push(`- **HTML:** \`${mdEscape(truncate(t.html, 240))}\``);
    }
    if (s.assert) L.push(`- **Verification:** ${s.assert.type}${s.assert.expected !== undefined ? ` = \`${mdEscape(truncate(String(s.assert.expected), 200))}\`` : ''}`);
    if (s.apiCalls.length) {
      L.push('- **API calls triggered:**');
      for (const a of s.apiCalls.slice(0, 10)) {
        L.push(`  - \`${a.method} ${a.url}\` → **${a.status || 'ERR'}** in ${a.durationMs ?? '?'} ms${a.error ? ` (error: ${a.error})` : ''}`);
        if (a.requestBody) L.push(`    - request: \`${mdEscape(truncate(a.requestBody, 600))}\``);
        if (a.responseBody) L.push(`    - response: \`${mdEscape(truncate(a.responseBody, 800))}\``);
      }
      if (s.apiCalls.length > 10) L.push(`  - …and ${s.apiCalls.length - 10} more`);
    }
    if (s.navigatedTo) L.push(`- **Result:** navigated to ${s.navigatedTo}`);
    L.push(`- **Expected:** ${s.expected}`);
    if (s.screenshot) L.push(`- **Screenshot:** \`${s.screenshot}\``);
    L.push('');
  }
  if (scn.endpoints.length) {
    L.push('## API inventory');
    L.push('');
    L.push('| Method | Route | Origin | Calls | Statuses | Avg ms |');
    L.push('|---|---|---|---|---|---|');
    for (const e of scn.endpoints) L.push(`| ${e.method} | \`${mdEscape(e.route)}\` | ${e.origin || ''} | ${e.count} | ${e.statuses.join(', ')} | ${e.avgMs} |`);
    L.push('');
  }
  const errors = scn.console.filter((c) => c.level === 'error');
  if (errors.length) {
    L.push('## Console errors observed');
    L.push('');
    for (const c of errors.slice(0, 30)) L.push(`- \`${mdEscape(truncate(c.message, 300))}\` on ${c.url}`);
    L.push('');
  }
  if (scn.notes.length) {
    L.push('## Tester notes');
    L.push('');
    for (const n of scn.notes) L.push(`- ${n.flag === 'bug' ? '🐞 **BUG**' : '📝'} (after step ${n.step - 1}): ${n.text}`);
    L.push('');
  }
  if (scn.lastRun) {
    L.push('## Last replay result');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(scn.lastRun, null, 2));
    L.push('```');
    L.push('');
  }
  L.push('## Machine-readable scenario');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(compactScenario(scn), null, 2));
  L.push('```');
  L.push('');
  return L.join('\n');
}

/** Scenario JSON without bulky duplicates (rects, html, full headers). */
export function compactScenario(scn) {
  return {
    ...scn,
    apis: undefined,
    steps: scn.steps.map((s) => ({
      ...s,
      screenshotId: undefined,
      target: s.target ? { ...s.target, rect: undefined, viewport: undefined, html: undefined } : undefined,
      apiCalls: s.apiCalls.map((a) => ({ method: a.method, url: a.url, status: a.status, durationMs: a.durationMs, requestBody: truncate(a.requestBody, 1500), responseBody: truncate(a.responseBody, 1500) })),
    })),
  };
}

// ------------------------------------------------------------------ evidence pack

/**
 * @param {object} scn scenario from buildScenario
 * @param {object[]} screenshots [{id, dataUrl}] (original recording)
 * @param {object} raw { session, events } for the backup JSON
 */
export function buildEvidencePack(scn, screenshots, raw) {
  const slug = slugify(scn.name);
  const shotById = new Map(screenshots.map((s) => [s.id, s]));
  const files = [
    { name: 'README.md', data: packReadme(scn, slug) },
    { name: 'ai-context.md', data: toAiContext(scn) },
    { name: 'test-case.md', data: toTestCaseMarkdown(scn) },
    { name: 'scenario.json', data: JSON.stringify(compactScenario(scn), null, 2) },
    { name: `tests/playwright/${slug}.spec.ts`, data: toPlaywright(scn) },
    { name: `tests/cypress/${slug}.cy.js`, data: toCypress(scn) },
    { name: 'api/postman_collection.json', data: JSON.stringify(toPostman(scn), null, 2) },
    { name: 'api/traffic.har', data: JSON.stringify(toHar(scn), null, 2) },
    { name: '.env.example', data: envExample(scn) },
  ];
  for (const s of scn.steps) {
    const shot = s.screenshotId && shotById.get(s.screenshotId);
    if (shot?.dataUrl) files.push({ name: s.screenshot, data: dataUrlToBytes(shot.dataUrl) });
  }
  const extra = screenshots.filter((s) => !scn.steps.some((st) => st.screenshotId === s.id) && !s.runId);
  extra.forEach((s, i) => files.push({ name: `screenshots/other/${String(i + 1).padStart(2, '0')}-${s.reason || 'page'}.jpg`, data: dataUrlToBytes(s.dataUrl) }));
  if (raw) files.push({ name: 'session-backup.json', data: JSON.stringify(toBackup(raw.session, raw.events), null, 2) });
  return createZip(files);
}

function packReadme(scn, slug) {
  return [
    `# Evidence pack — ${scn.name}`,
    '',
    `Recorded ${scn.recordedAt} on ${scn.startUrl} · ${scn.steps.length} steps · ${scn.apis.length} API calls · ${scn.steps.filter((s) => s.screenshot).length} screenshots`,
    '',
    '| File | What it is |',
    '|---|---|',
    '| `ai-context.md` | Paste into an AI assistant to generate Playwright/Cypress/API tests |',
    '| `test-case.md` | Manual test case with expected results and observed issues |',
    `| \`tests/playwright/${slug}.spec.ts\` | Ready-to-run Playwright spec (\`npx playwright test\`) |`,
    `| \`tests/cypress/${slug}.cy.js\` | Ready-to-run Cypress spec |`,
    '| `api/postman_collection.json` | Captured API calls as a Postman collection (with status tests) |',
    '| `api/traffic.har` | Full HTTP archive — open in Chrome DevTools or any HAR viewer |',
    '| `scenario.json` | Machine-readable scenario |',
    '| `screenshots/` | Screenshot after each step |',
    '| `.env.example` | Variables the tests expect |',
    '| `session-backup.json` | Re-import into QA Scenario Recorder |',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ backup / import

export function toBackup(session, events, screenshots) {
  return {
    format: 'qa-scenario-recorder/session',
    version: 1,
    exportedAt: new Date().toISOString(),
    session,
    events: events.filter((e) => (e.runId ?? null) === null),
    screenshots: screenshots || undefined,
  };
}

export function parseBackup(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (data?.format !== 'qa-scenario-recorder/session' || !data.session || !Array.isArray(data.events)) {
    throw new Error('Not a QA Scenario Recorder session backup');
  }
  return data;
}
