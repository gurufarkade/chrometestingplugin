import * as db from '../shared/db.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../shared/settings.js';
import { buildScenario, parseBackup } from '../shared/exporters.js';
import { exportSession, download, FORMATS } from '../shared/export-service.js';

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder — all captured data goes through textContent, never innerHTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let sessions = [];
let current = null; // { session, events, screenshots, scenario, rawById, shotByStep }
let activeTab = 'steps';
let exportFormat = 'ai';
let lastExport = null;
let selectedNetId = null;
const revealed = new Set();

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString() : '');
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const pathOf = (u) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};
function pretty(body) {
  if (body == null || body === '') return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return String(body);
  }
}
async function copy(text, label = 'Copied') {
  await navigator.clipboard.writeText(text);
  toast(label);
}
function toast(text) {
  const t = h('div', { class: 'card', style: { position: 'fixed', bottom: '16px', right: '16px', zIndex: 20 }, text });
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

// ------------------------------------------------------------------ sessions list

async function loadSessions() {
  sessions = await db.listSessions();
  renderList();
  const est = await navigator.storage?.estimate?.();
  if (est) $('storageInfo').textContent = `${fmtBytes(est.usage)} used`;
}

function renderList() {
  const term = $('search').value.toLowerCase();
  const ul = $('sessionList');
  ul.replaceChildren();
  for (const s of sessions) {
    if (term && !`${s.name} ${s.startUrl}`.toLowerCase().includes(term)) continue;
    const last = (s.runs || []).slice(-1)[0];
    ul.append(
      h(
        'li',
        { class: current?.session.id === s.id ? 'active' : '', onclick: () => (location.hash = s.id) },
        h('span', { class: 's-name', title: s.name, text: s.name }),
        h(
          'span',
          { class: 's-meta' },
          h('span', { text: fmtDate(s.createdAt) }),
          s.summary ? h('span', { text: `${s.summary.steps} steps · ${s.summary.network} API` }) : null,
          h('span', { class: `chip ${s.status}`, text: s.status }),
          last ? h('span', { class: `chip ${last.status}`, text: `replay ${last.status}` }) : null,
        ),
      ),
    );
  }
  if (!ul.children.length) ul.append(h('li', { class: 'muted', text: sessions.length ? 'No match' : 'No scenarios recorded yet' }));
}

// ------------------------------------------------------------------ session view

async function openSession(id) {
  const session = await db.getSession(id);
  if (!session) {
    location.hash = '';
    return;
  }
  const [events, screenshots] = await Promise.all([db.getEvents(id), db.getScreenshots(id)]);
  const rawById = new Map(events.map((e) => [e.id, e]));
  const shotByStep = new Map();
  for (const s of screenshots) if (!s.runId && s.stepEventId != null && !shotByStep.has(s.stepEventId)) shotByStep.set(s.stepEventId, s);
  // Build with skipped steps included so they stay visible (flagged) in the UI.
  const scenario = buildScenario(session, events.map((e) => (e.skip ? { ...e, skip: false } : e)), {
    secrets: 'placeholder', // descriptions show <TEST_PASSWORD>; raw values sit behind "reveal"
    screenshots: screenshots.map(({ id: sid, stepEventId, reason, runId }) => ({ id: sid, stepEventId, reason, runId })),
  });
  current = { session, events, screenshots, scenario, rawById, shotByStep };
  $('empty').classList.add('hidden');
  $('settingsView').classList.add('hidden');
  $('sessionView').classList.remove('hidden');
  renderHeader();
  renderTab();
  renderList();
}

function renderHeader() {
  const { session, scenario, events, screenshots } = current;
  $('sessionTitle').value = session.name;
  $('sessionStatus').textContent = session.status;
  $('sessionStatus').className = `chip ${session.status}`;
  const env = session.environment || {};
  $('sessionMeta').replaceChildren(
    h('span', {}, 'Start: ', h('a', { href: session.startUrl, target: '_blank', rel: 'noopener', text: session.startUrl })),
    h('span', { text: `Recorded ${fmtDate(session.createdAt)}` }),
    session.durationMs ? h('span', { text: `Duration ${fmtMs(session.durationMs)}` }) : null,
    env.viewport ? h('span', { text: `Viewport ${env.viewport.width}×${env.viewport.height}` }) : null,
    env.timezone ? h('span', { text: `${env.language} · ${env.timezone}` }) : null,
  );
  $('cSteps').textContent = scenario.steps.length;
  $('cNet').textContent = events.filter((e) => e.kind === 'network' && !e.runId).length;
  const errs = scenario.console.filter((c) => c.level === 'error').length;
  $('cCon').textContent = errs ? `${errs} err` : scenario.console.length;
  $('cShots').textContent = screenshots.length;
  $('cRuns').textContent = (session.runs || []).length;
}

function renderTab() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${activeTab}`));
  ({ steps: renderSteps, network: renderNetwork, console: renderConsole, gallery: renderGallery, runs: renderRuns, export: renderExport })[activeTab]();
}

// ------------------------------------------------------------------ steps

function renderSteps() {
  const panel = $('tab-steps');
  panel.replaceChildren();
  const { scenario, rawById, shotByStep } = current;
  if (!scenario.steps.length) panel.append(h('p', { class: 'muted', text: 'No steps captured.' }));
  for (const s of scenario.steps) {
    const raw = rawById.get(s.id) || {};
    const shot = shotByStep.get(s.id);
    const sub = h('div', { class: 'sub' });
    if (s.url && s.action !== 'goto') sub.append(h('span', { text: `on ${pathOf(s.url)}${s.pageTitle ? ` — ${s.pageTitle}` : ''}` }));
    if (s.target) {
      sub.append(h('span', {}, 'Locator ', h('code', { text: s.target.locators.playwright })));
      const ctx = Object.entries(s.target.context || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
      if (ctx) sub.append(h('span', { text: `Context — ${ctx}` }));
    }
    if (s.action === 'fill') {
      const secret = raw.sensitive;
      const show = !secret || revealed.has(s.id);
      sub.append(
        h(
          'span',
          {},
          'Value ',
          h('code', { text: show ? raw.value ?? '' : '••••••••' }),
          secret ? h('button', { class: 'small', onclick: () => (revealed.has(s.id) ? revealed.delete(s.id) : revealed.add(s.id), renderSteps()), text: show ? 'hide' : 'reveal' }) : null,
          s.valueRef ? h('span', { text: `  → ${s.valueRef.kind === 'credential' ? s.valueRef.variable : `testData.${s.valueRef.key}`}` }) : null,
        ),
      );
    }
    if (raw.note) sub.append(h('span', { text: `📝 ${raw.note}` }));
    if (s.apiCalls.length) {
      sub.append(
        h(
          'div',
          { class: 'apis' },
          s.apiCalls.map((a) =>
            h('button', {
              class: `api-chip${a.status >= 400 || a.status === 0 ? ' bad' : ''}`,
              title: a.url,
              text: `${a.method} ${a.route} · ${a.status || 'ERR'}`,
              onclick: () => {
                selectedNetId = a.id;
                activeTab = 'network';
                renderTab();
              },
            }),
          ),
        ),
      );
    }
    if (s.navigatedTo) sub.append(h('span', { text: `→ navigated to ${pathOf(s.navigatedTo)}` }));

    const actions = h('div', { class: 'step-actions' });
    const editable = ['fill', 'select', 'assert', 'note', 'goto'].includes(s.action);
    if (editable) actions.append(h('button', { onclick: (e) => editStep(e.target.closest('.step'), raw), text: 'Edit' }));
    if (s.action === 'assert') actions.append(assertTypeSelect(raw));
    actions.append(
      h('button', { onclick: () => noteStep(raw), text: raw.note ? 'Edit note' : 'Add note' }),
      h('button', { onclick: () => patchEvent(raw.id, { skip: !raw.skip }), text: raw.skip ? 'Include in replay' : 'Skip in replay' }),
      h('button', { class: 'danger', onclick: () => deleteStep(raw), text: 'Delete' }),
    );

    const thumb = shot
      ? h('img', { class: 'thumb', src: shot.dataUrl, alt: `Screenshot after step ${s.n}`, onclick: () => lightbox(shot, `Step ${s.n} — ${s.description}`, raw.target) })
      : h('div', { class: 'thumb none', text: 'no screenshot' });

    panel.append(
      h(
        'article',
        { class: `step${raw.skip ? ' skipped' : ''}${raw.flag === 'bug' ? ' bug' : ''}` },
        h('div', { class: 'num', text: s.n }),
        h('div', {}, h('div', { class: 'desc' }, h('span', { class: `badge ${s.action}`, text: s.action }), s.description), sub, actions),
        thumb,
      ),
    );
  }
}

function assertTypeSelect(raw) {
  const sel = h(
    'select',
    { style: { width: 'auto', fontSize: '11px', padding: '2px 4px' }, onchange: (e) => patchEvent(raw.id, { assert: { ...raw.assert, type: e.target.value } }) },
    ['text', 'contains', 'visible', 'hidden', 'value', 'checked', 'url'].map((t) => h('option', { value: t, selected: raw.assert?.type === t, text: t })),
  );
  return sel;
}

function editStep(card, raw) {
  if (card.querySelector('.edit-row')) return;
  const field = raw.action === 'assert' ? 'expected' : raw.action === 'goto' ? 'url' : 'value';
  const currentVal = raw.action === 'assert' ? raw.assert?.expected : raw[field];
  const input = h('input', { type: 'text', value: currentVal ?? '' });
  const row = h(
    'div',
    { class: 'edit-row' },
    input,
    h('button', {
      class: 'primary small',
      text: 'Save',
      onclick: () => {
        const v = input.value;
        if (raw.action === 'assert') patchEvent(raw.id, { assert: { ...raw.assert, expected: v } });
        else if (raw.action === 'select') patchEvent(raw.id, { value: v, values: [v], optionLabels: [] });
        else patchEvent(raw.id, { [field]: v, masked: false });
      },
    }),
    h('button', { class: 'small', text: 'Cancel', onclick: () => row.remove() }),
  );
  card.querySelector('.step-actions').after(row);
  input.focus();
}

async function noteStep(raw) {
  const text = prompt('Note for this step (shown in exports and test cases):', raw.note || '');
  if (text === null) return;
  await patchEvent(raw.id, { note: text.trim() || undefined });
}

async function patchEvent(id, patch) {
  const ev = await db.getEvent(id);
  if (!ev) return;
  Object.assign(ev, patch);
  await db.putEvent(ev);
  await openSession(current.session.id);
}

async function deleteStep(raw) {
  if (!confirm('Delete this step? It will be removed from replays and exports.')) return;
  await db.deleteEvent(raw.id);
  await openSession(current.session.id);
}

// ------------------------------------------------------------------ network

function stepForApi() {
  const map = new Map();
  for (const s of current.scenario.steps) for (const a of s.apiCalls) map.set(a.id, s.n);
  return map;
}

function renderNetwork() {
  const { events, session } = current;
  const term = $('netSearch').value.toLowerCase();
  const method = $('netMethod').value;
  const status = $('netStatus').value;
  const apiOnly = $('netApiOnly').checked;
  const stepOf = stepForApi();
  const rows = events
    .filter((e) => e.kind === 'network' && !e.runId)
    .sort((a, b) => (a.startTime || a.ts) - (b.startTime || b.ts))
    .filter((e) => {
      if (apiOnly && e.api === 'document' && e.method === 'GET') return false;
      if (method && e.method !== method) return false;
      if (status === 'err' && !(e.status >= 400 || e.status === 0)) return false;
      if (status && status !== 'err' && String(e.status)[0] !== status) return false;
      if (term && !`${e.url} ${e.requestBody || ''} ${e.responseBody || ''}`.toLowerCase().includes(term)) return false;
      return true;
    });
  const table = $('netTable');
  table.replaceChildren(
    h('thead', {}, h('tr', {}, ['#', '+time', 'Method', 'Status', 'URL', 'Type', 'Duration', 'Size', 'Step'].map((c) => h('th', { text: c })))),
  );
  const tbody = h('tbody');
  rows.forEach((e, i) =>
    tbody.append(
      h(
        'tr',
        { class: `row${selectedNetId === e.id ? ' sel' : ''}`, onclick: () => ((selectedNetId = e.id), renderNetwork()) },
        h('td', { text: i + 1 }),
        h('td', { text: fmtMs(Math.max(0, (e.startTime || e.ts) - session.createdAt)) }),
        h('td', { text: e.method }),
        h('td', { class: `st-${String(e.status || 0)[0]}`, text: e.status || (e.error ? 'ERR' : '…') }),
        h('td', { class: 'url', title: e.url, text: pathOf(e.url) }),
        h('td', { text: e.api }),
        h('td', { text: fmtMs(e.duration) }),
        h('td', { text: fmtBytes(e.responseBody?.length) }),
        h('td', { text: stepOf.get(e.id) ?? '' }),
      ),
    ),
  );
  table.append(tbody);
  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: 9, class: 'muted', text: 'No requests match.' })));
  const sel = events.find((e) => e.id === selectedNetId);
  renderNetDetail(sel);
}

function kv(obj) {
  const entries = Object.entries(obj || {}).filter(([, v]) => v !== '' && v != null);
  if (!entries.length) return h('span', { class: 'muted', text: '—' });
  return h('div', { class: 'kv' }, entries.flatMap(([k, v]) => [h('span', { text: k }), h('span', { text: String(v) })]));
}

function curlFor(e) {
  const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const parts = [`curl -X ${e.method} ${sq(e.url)}`];
  for (const [k, v] of Object.entries(e.requestHeaders || {})) parts.push(`-H ${sq(`${k}: ${v}`)}`);
  if (e.requestBody && !/^\[/.test(e.requestBody)) parts.push(`--data-raw ${sq(e.requestBody)}`);
  return parts.join(' \\\n  ');
}

function renderNetDetail(e) {
  const d = $('netDetail');
  const split = d.parentElement;
  if (!e) {
    d.classList.add('hidden');
    split.classList.remove('open');
    return;
  }
  d.classList.remove('hidden');
  split.classList.add('open');
  d.replaceChildren(
    h(
      'div',
      { class: 'd-head' },
      h('div', {}, h('strong', { text: `${e.method} ${e.status || 'ERR'} ${e.statusText || ''}` }), h('div', { class: 'd-url', text: e.url })),
      h('button', { class: 'small', text: '✕', onclick: () => ((selectedNetId = null), renderNetwork()) }),
    ),
    h(
      'div',
      { class: 'step-actions' },
      h('button', { text: 'Copy as cURL', onclick: () => copy(curlFor(e), 'cURL copied') }),
      h('button', { text: 'Copy URL', onclick: () => copy(e.url) }),
      e.responseBody ? h('button', { text: 'Copy response', onclick: () => copy(e.responseBody) }) : null,
    ),
    h('h4', { text: 'General' }),
    kv({ Type: e.api, Duration: fmtMs(e.duration), Started: fmtDate(e.startTime || e.ts), Page: e.pageUrl || '', Error: e.error || '', Truncated: e.bodyTruncated ? 'response body truncated' : '' }),
    h('h4', { text: 'Request headers' }),
    kv(e.requestHeaders),
    e.requestBody ? h('h4', { text: 'Request body' }) : null,
    e.requestBody ? h('pre', { class: 'code', text: pretty(e.requestBody) }) : null,
    h('h4', { text: 'Response headers' }),
    kv(e.responseHeaders),
    h('h4', { text: 'Response body' }),
    e.responseBody ? h('pre', { class: 'code', text: pretty(e.responseBody) }) : h('span', { class: 'muted', text: e.api === 'document' ? 'Document bodies are not captured' : '—' }),
  );
}

// ------------------------------------------------------------------ console / gallery

function renderConsole() {
  const panel = $('tab-console');
  const logs = current.events.filter((e) => e.kind === 'console' && !e.runId);
  panel.replaceChildren(
    logs.length
      ? h('div', { class: 'card', style: { padding: 0, overflow: 'hidden' } }, logs.map((l) => h('div', { class: `log ${l.level}` }, `[${l.level}] ${l.message}`, h('span', { class: 'src', text: `${fmtDate(l.ts)} · ${l.source || l.url || ''}` }), l.stack ? h('span', { class: 'src', text: l.stack }) : null)))
      : h('p', { class: 'muted', text: 'No console errors or warnings were captured. 🎉' }),
  );
}

function renderGallery() {
  const panel = $('tab-gallery');
  const runIdx = new Map((current.session.runs || []).map((r, i) => [r.id, i + 1]));
  const stepN = new Map(current.scenario.steps.map((s) => [s.id, s.n]));
  panel.replaceChildren(
    current.screenshots.length
      ? h(
          'div',
          { class: 'gallery' },
          current.screenshots.map((s) => {
            const caption = `${s.runId ? `Replay #${runIdx.get(s.runId) || '?'} · ` : ''}${stepN.has(s.stepEventId) ? `step ${stepN.get(s.stepEventId)} · ` : ''}${s.reason} · ${new Date(s.ts).toLocaleTimeString()}`;
            return h('figure', {}, h('img', { src: s.dataUrl, alt: caption, loading: 'lazy', onclick: () => lightbox(s, `${caption} — ${s.url}`, current.rawById.get(s.stepEventId)?.target) }), h('figcaption', { text: caption }));
          }),
        )
      : h('p', { class: 'muted', text: 'No screenshots (enable them in Settings).' }),
  );
}

function lightbox(shot, caption, target) {
  $('lbCaption').textContent = caption;
  const img = $('lbImg');
  const box = $('lbBox');
  box.classList.add('hidden');
  img.onload = () => {
    const r = target?.rect;
    const vw = target?.viewport?.w || shot.width;
    if (!r || !vw || shot.runId) return;
    const scale = img.clientWidth / vw;
    Object.assign(box.style, { left: `${r.x * scale}px`, top: `${r.y * scale}px`, width: `${Math.max(6, r.w * scale)}px`, height: `${Math.max(6, r.h * scale)}px` });
    box.classList.remove('hidden');
  };
  img.src = shot.dataUrl;
  $('lightbox').classList.remove('hidden');
}
$('lbClose').addEventListener('click', () => $('lightbox').classList.add('hidden'));
$('lightbox').addEventListener('click', (e) => e.target.id === 'lightbox' && $('lightbox').classList.add('hidden'));
document.addEventListener('keydown', (e) => e.key === 'Escape' && $('lightbox').classList.add('hidden'));

// ------------------------------------------------------------------ runs

async function renderRuns() {
  const panel = $('tab-runs');
  const runs = [...(current.session.runs || [])].reverse();
  panel.replaceChildren();
  if (!runs.length) {
    panel.append(h('p', { class: 'muted', text: 'No replays yet. Use “Replay in new tab” to re-execute this scenario and compare UI + API behaviour against the recording.' }));
    return;
  }
  const stepById = new Map(current.scenario.steps.map((s) => [s.id, s]));
  const shotById = new Map(current.screenshots.map((s) => [s.id, s]));
  runs.forEach((run, i) => {
    const counts = { passed: 0, failed: 0, skipped: 0, 'not-run': 0 };
    (run.results || []).forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));
    const table = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['#', 'Result', 'Step', 'Time', 'Details', 'Screen'].map((c) => h('th', { text: c })))));
    const tbody = h('tbody');
    for (const r of run.results || []) {
      const st = stepById.get(r.stepId);
      const shot = r.screenshotId && shotById.get(r.screenshotId);
      const details = [r.error, r.warning, r.urlCheck && !r.urlCheck.match ? `URL: expected ${pathOf(r.urlCheck.expected)}, got ${pathOf(r.urlCheck.actual)}` : null, r.usedSelector ? `via ${r.usedSelector.type}` : null].filter(Boolean).join(' · ');
      tbody.append(
        h(
          'tr',
          {},
          h('td', { text: st?.n ?? r.index + 1 }),
          h('td', { class: `res-${r.status}`, text: r.status }),
          h('td', { text: st?.description || r.action }),
          h('td', { text: fmtMs(r.durationMs) }),
          h('td', { text: details }),
          h('td', {}, shot ? h('img', { class: 'mini-thumb', src: shot.dataUrl, alt: 'replay screenshot', onclick: () => lightbox(shot, `Replay step ${st?.n} — ${r.status}`) }) : ''),
        ),
      );
    }
    table.append(tbody);
    const d = run.apiDiff;
    const diffCard = (title, items, fmt) => h('div', { class: 'card' }, h('h4', { text: `${title} (${items?.length || 0})` }), items?.length ? h('ul', {}, items.slice(0, 30).map((x) => h('li', { text: fmt(x) }))) : h('span', { class: 'muted', text: 'none' }));
    panel.append(
      h(
        'details',
        { class: 'run', open: i === 0 },
        h(
          'summary',
          {},
          h('span', { class: `chip ${run.status}`, text: run.status }),
          h('strong', { text: `Replay #${runs.length - i}` }),
          h('span', { class: 'muted', text: `${fmtDate(run.startedAt)}${run.endedAt ? ` · ${fmtMs(run.endedAt - run.startedAt)}` : ''}` }),
          h('span', { class: 'muted', text: `${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} skipped · ${counts['not-run']} not run${run.consoleErrors ? ` · ${run.consoleErrors} console errors` : ''}` }),
        ),
        h(
          'div',
          { class: 'run-body' },
          h('div', { class: 'table-wrap' }, table),
          d
            ? h(
                'div',
                { class: 'diff' },
                diffCard('API status changed', d.statusChanged, (x) => `${x.signature}: ${x.recordedStatus} → ${x.replayStatus}`),
                diffCard('Recorded API not called', d.missing, (x) => x.signature),
                diffCard('New API calls', d.unexpected, (x) => `${x.signature} (${x.replayStatus})`),
                diffCard('Slower than recording (>2×)', d.slower, (x) => `${x.signature}: ${x.recordedMs} → ${x.replayMs} ms`),
              )
            : null,
        ),
      ),
    );
  });
}

// ------------------------------------------------------------------ export

function secretsMode() {
  return document.querySelector('input[name="secrets"]:checked').value;
}

function renderExport() {
  const list = $('formatList');
  list.replaceChildren(
    ...Object.entries(FORMATS).map(([k, f]) => h('button', { class: k === exportFormat ? 'active' : '', text: f.label, onclick: () => ((exportFormat = k), renderExport()) })),
  );
  $('secretWarn').classList.toggle('hidden', secretsMode() !== 'include');
  refreshPreview();
}

async function refreshPreview() {
  const pre = $('preview');
  $('previewTitle').textContent = FORMATS[exportFormat].label;
  pre.textContent = 'Generating…';
  try {
    lastExport = await exportSession(current.session.id, exportFormat, { secrets: secretsMode() });
    if (lastExport.content instanceof Uint8Array) {
      const s = lastExport.scenario;
      pre.textContent = [
        `${lastExport.filename} — ${fmtBytes(lastExport.content.length)}`,
        '',
        'Contains:',
        '  README.md, ai-context.md, test-case.md, scenario.json, .env.example',
        '  tests/playwright/*.spec.ts, tests/cypress/*.cy.js',
        '  api/postman_collection.json, api/traffic.har',
        `  screenshots/ (${s.steps.filter((x) => x.screenshot).length} step screenshots + page-load captures)`,
        '  session-backup.json (re-importable)',
      ].join('\n');
    } else {
      const text = lastExport.content;
      pre.textContent = text.length > 300_000 ? `${text.slice(0, 300_000)}\n\n… preview truncated — download for the full file` : text;
    }
  } catch (e) {
    pre.textContent = `Export failed: ${e.message}`;
  }
}

document.querySelectorAll('input[name="secrets"]').forEach((r) => r.addEventListener('change', renderExport));
$('btnCopy').addEventListener('click', async () => {
  if (!lastExport) return;
  if (lastExport.content instanceof Uint8Array) return toast('Binary file — use Download');
  copy(lastExport.content, 'Copied to clipboard');
});
$('btnDownload').addEventListener('click', () => lastExport && download(lastExport));

// ------------------------------------------------------------------ settings

const SETTING_META = {
  captureScreenshots: ['Capture screenshots after each step', 'bool'],
  screenshotQuality: ['Screenshot JPEG quality (10–100)', 'number'],
  captureResponseBodies: ['Capture API request/response bodies', 'bool'],
  maxBodyBytes: ['Max body size kept per request (chars)', 'number'],
  captureConsole: ['Capture console errors/warnings', 'bool'],
  showOverlay: ['Show the in-page recording toolbar', 'bool'],
  maskPasswordsAtCapture: ['Mask password fields at capture time (replay of login then needs manual entry)', 'bool'],
  ignoreUrlPatterns: ['Ignore requests whose URL contains (one per line)', 'text'],
  replayStepDelayMs: ['Delay between replayed steps (ms)', 'number'],
  replayTimeoutMs: ['Element wait timeout during replay (ms)', 'number'],
  replayWaitForNetworkIdle: ['Wait for network idle after each replayed step', 'bool'],
  replayHighlight: ['Highlight elements during replay', 'bool'],
  replayContinueOnFailure: ['Continue replay after a failed step', 'bool'],
  sensitiveHeaders: ['Headers masked in exports (one per line)', 'text'],
};

async function openSettings() {
  current = null;
  renderList();
  $('empty').classList.add('hidden');
  $('sessionView').classList.add('hidden');
  $('settingsView').classList.remove('hidden');
  const s = await getSettings();
  const form = $('settingsForm');
  const groups = { Capture: [], Replay: [], Export: [] };
  for (const [key, [label, type]] of Object.entries(SETTING_META)) {
    const group = key.startsWith('replay') ? 'Replay' : key === 'sensitiveHeaders' ? 'Export' : 'Capture';
    let input;
    if (type === 'bool') input = h('input', { type: 'checkbox', name: key, checked: !!s[key] });
    else if (type === 'number') input = h('input', { type: 'number', name: key, value: s[key] });
    else input = h('textarea', { name: key, text: s[key] });
    groups[group].push(type === 'bool' ? h('label', { class: 'field inline' }, input, label) : h('label', { class: 'field' }, h('span', { text: label }), input));
  }
  form.replaceChildren(
    ...Object.entries(groups).map(([g, fields]) => h('div', { class: 'card' }, h('h3', { text: g }), fields)),
    h(
      'div',
      { class: 'save' },
      h('button', { class: 'primary', type: 'submit', text: 'Save settings' }),
      h('button', {
        type: 'button',
        text: 'Restore defaults',
        onclick: async () => {
          await saveSettings({ ...DEFAULT_SETTINGS });
          openSettings();
          toast('Defaults restored');
        },
      }),
    ),
  );
}
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  for (const [key, [, type]] of Object.entries(SETTING_META)) {
    const el = e.target.elements[key];
    patch[key] = type === 'bool' ? el.checked : type === 'number' ? Number(el.value) : el.value;
  }
  patch.screenshotQuality = Math.min(100, Math.max(10, patch.screenshotQuality || 60));
  await saveSettings(patch);
  toast('Settings saved');
});

// ------------------------------------------------------------------ import / actions

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = parseBackup(await file.text());
    const session = { ...data.session };
    if (await db.getSession(session.id)) session.id = `${session.id}_imp${Date.now().toString(36)}`;
    session.name = `${session.name} (imported)`;
    session.runs = [];
    await db.putSession(session);
    const idMap = new Map();
    for (const ev of data.events.sort((a, b) => a.seq - b.seq)) {
      const { id: oldId, ...rest } = ev;
      const newId = await db.addEvent({ ...rest, sessionId: session.id, runId: null });
      idMap.set(oldId, newId);
    }
    for (const s of data.screenshots || []) {
      if (s.runId) continue;
      await db.putScreenshot({ ...s, id: `${s.id}_${session.id}`, sessionId: session.id, stepEventId: idMap.get(s.stepEventId) ?? null });
    }
    await loadSessions();
    location.hash = session.id;
    toast('Scenario imported');
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

$('search').addEventListener('input', renderList);
$('btnSettings').addEventListener('click', () => (location.hash = 'settings'));
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    renderTab();
  }),
);
['netSearch', 'netMethod', 'netStatus', 'netApiOnly'].forEach((id) => $(id).addEventListener('input', renderNetwork));
$('sessionTitle').addEventListener('change', async (e) => {
  const s = await db.getSession(current.session.id);
  s.name = e.target.value.trim() || s.name;
  await db.putSession(s);
  current.session = s;
  await loadSessions();
});
$('btnRefresh').addEventListener('click', () => openSession(current.session.id));
$('btnDelete').addEventListener('click', async () => {
  if (!confirm(`Delete "${current.session.name}" with all its steps, API calls and screenshots? This cannot be undone.`)) return;
  await db.deleteSession(current.session.id);
  current = null;
  location.hash = '';
  await loadSessions();
});
$('btnReplay').addEventListener('click', async () => {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  const res = await chrome.runtime.sendMessage({ type: 'replay', sessionId: current.session.id, tabId: tab.id });
  if (res?.error) {
    alert(res.error);
    chrome.tabs.remove(tab.id);
  }
});

// live refresh while recording / replaying
let refreshTimer = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (!current) return;
  const id = current.session.id;
  const relevant =
    (msg.type === 'state' && (msg.state.sessionId === id || msg.state.replay?.sessionId === id)) ||
    ((msg.type === 'replay:progress' || msg.type === 'replay:done') && msg.sessionId === id);
  if (!relevant) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (activeTab !== 'export') openSession(id);
  }, msg.type === 'replay:done' ? 200 : 1500);
});

async function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id === 'settings') return openSettings();
  if (id) return openSession(id);
  current = null;
  $('sessionView').classList.add('hidden');
  $('settingsView').classList.add('hidden');
  $('empty').classList.remove('hidden');
  renderList();
}
window.addEventListener('hashchange', route);

await loadSessions();
await route();
