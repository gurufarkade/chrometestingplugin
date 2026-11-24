// Workbench — review, edit, replay and export Scenarios.
import * as db from '../shared/db.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../shared/settings.js';
import { buildScenario, parseBackup, candidateLabel } from '../shared/exporters.js';
import { buildDataPlan, resolveData, createRng } from '../shared/test-data.js';
import { buildRunReport } from '../shared/run-report.js';
import { exportSession, download, FORMATS } from '../shared/export-service.js';

const $ = (id) => document.getElementById(id);

/** DOM builder — captured data only ever goes through textContent. */
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
const svg = (d, fill = false) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.innerHTML = `<path d="${d}"${fill ? ' fill="currentColor" stroke="none"' : ''}/>`;
  return s;
};
const ICON = {
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  play: 'M4.5 2.8v10.4L13 8z',
  dice: 'M3 3h10v10H3zM6 6h.01M10 10h.01M10 6h.01M6 10h.01',
};

let sessions = [];
let cur = null;
let view = 'steps';
let selStep = null;
let stageMode = 'rec';
let exportFormat = 'ai';
let exportSecrets = 'placeholder';
let exportData = 'recommended';
let netSel = null;
let lastExport = null;
const netFilter = { q: '', method: '', status: '', apiOnly: true };

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString() : '');
const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const pathOf = (u) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u || '';
  }
};
const pretty = (b) => {
  if (b == null || b === '') return '';
  try {
    return JSON.stringify(JSON.parse(b), null, 2);
  } catch {
    return String(b);
  }
};
function toast(text) {
  const t = h('div', { class: 'toast', text });
  $('toasts').append(t);
  setTimeout(() => t.remove(), 2400);
}
async function copy(text, label = 'Copied') {
  await navigator.clipboard.writeText(text);
  toast(label);
}
const copyBtn = (text, title = 'Copy') => h('button', { class: 'btn ghost icon sm', title, 'aria-label': title, onclick: (e) => (e.stopPropagation(), copy(text)) }, svg(ICON.copy));

// ================================================================== scenarios rail

async function loadSessions() {
  sessions = await db.listSessions();
  renderRail();
  const est = await navigator.storage?.estimate?.();
  if (est) $('storageInfo').textContent = `${fmtBytes(est.usage)} stored`;
}

function renderRail() {
  const term = $('search').value.toLowerCase();
  const ul = $('sessionList');
  ul.replaceChildren();
  for (const s of sessions) {
    if (term && !`${s.name} ${s.startUrl}`.toLowerCase().includes(term)) continue;
    const last = (s.runs || []).filter((r) => r.status !== 'running').slice(-1)[0];
    ul.append(
      h(
        'li',
        { class: cur?.session.id === s.id ? 'active' : '', role: 'option', tabindex: 0, onclick: () => (location.hash = s.id), onkeydown: (e) => e.key === 'Enter' && (location.hash = s.id) },
        h('span', { class: 's-name', title: s.name, text: s.name }),
        h(
          'span',
          { class: 's-meta' },
          h('span', { text: new Date(s.createdAt).toLocaleDateString() }),
          s.summary ? h('span', { class: 'mono', text: `${s.summary.steps} st · ${s.summary.network} api` }) : null,
          s.status === 'recording' ? h('span', { class: 'chip recording', text: 'rec' }) : null,
          last ? h('span', { class: `chip ${last.status}`, text: last.status }) : null,
        ),
      ),
    );
  }
  if (!ul.children.length) ul.append(h('li', { class: 'dim', text: sessions.length ? 'No match' : 'Nothing recorded yet' }));
}

// ================================================================== session

async function openSession(id, { keepSelection = false } = {}) {
  const session = await db.getSession(id);
  if (!session) {
    location.hash = '';
    return;
  }
  const [events, screenshots] = await Promise.all([db.getEvents(id), db.getScreenshots(id)]);
  const rawById = new Map(events.map((e) => [e.id, e]));
  const shotByStep = new Map();
  for (const s of screenshots) if (!s.runId && s.stepEventId != null && !shotByStep.has(s.stepEventId)) shotByStep.set(s.stepEventId, s);
  const runs = (session.runs || []).filter((r) => r.status !== 'running');
  const lastRun = runs[runs.length - 1] || null;
  const runShot = new Map(screenshots.filter((s) => s.runId === lastRun?.id).map((s) => [s.stepEventId, s]));
  const scenario = buildScenario(session, events.map((e) => (e.skip ? { ...e, skip: false } : e)), {
    secrets: 'placeholder',
    screenshots: screenshots.map(({ id: sid, stepEventId, reason, runId }) => ({ id: sid, stepEventId, reason, runId })),
  });
  const rawSteps = events.filter((e) => e.kind === 'step' && !e.runId).sort((a, b) => a.seq - b.seq);
  const plan = buildDataPlan(rawSteps.filter((s) => !s.skip));
  cur = { session, events, screenshots, scenario, rawById, shotByStep, runShot, runs, lastRun, plan };
  if (!keepSelection || !scenario.steps.some((s) => s.id === selStep)) selStep = scenario.steps.find((s) => s.action !== 'goto')?.id ?? scenario.steps[0]?.id ?? null;
  $('empty').classList.add('hidden');
  $('settingsView').classList.add('hidden');
  $('sessionView').classList.remove('hidden');
  renderHead();
  renderView();
  renderRail();
}

function renderHead() {
  const { session, scenario, events, lastRun } = cur;
  $('sessionTitle').value = session.name;
  const env = session.environment || {};
  $('sessionMeta').replaceChildren(
    ...[
      h('span', { class: `chip ${session.status}`, text: session.status }),
      h('a', { href: session.startUrl, target: '_blank', rel: 'noopener', text: session.startUrl }),
      h('span', { text: fmtDate(session.createdAt) }),
      env.viewport ? h('span', { class: 'mono', text: `${env.viewport.width}×${env.viewport.height}` }) : null,
      env.timezone ? h('span', { text: `${env.language} · ${env.timezone}` }) : null,
    ].filter(Boolean), // replaceChildren() would print null as text
  );

  const net = events.filter((e) => e.kind === 'network' && !e.runId);
  const failedApis = scenario.failedApis.length;
  const outcomes = scenario.steps.reduce((n, s) => n + (s.outcomes?.length || 0), 0);
  const risky = scenario.steps.filter((s) => s.target && !s.target.candidates?.some((c) => c.unique)).length;
  const errors = scenario.console.filter((c) => c.level === 'error').length;
  const report = lastRun ? lastRun.report || buildRunReport({ results: lastRun.results || [] }) : null;
  const readout = (k, v, cls = '', sub = null) => h('div', { class: `readout ${cls}` }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, String(v), sub ? h('small', { text: sub }) : null));
  $('readouts').replaceChildren(
    readout('Steps', scenario.steps.length),
    readout('API calls', net.length, failedApis ? 'bad' : '', failedApis ? `${failedApis} failed` : null),
    readout('Expected results', outcomes, outcomes ? 'good' : ''),
    readout('Locator risk', risky, risky ? 'warn' : 'good', risky ? 'steps' : null),
    readout('Console errors', errors, errors ? 'bad' : 'good'),
    readout('Duration', fmtMs(session.durationMs)),
    h('div', { class: `readout run ${report ? { passed: 'good', failed: 'bad', warning: 'warn' }[report.status] || '' : ''}` }, h('span', { class: 'k', text: 'Last run' }), h('span', { class: 'v', title: report?.headline || '', text: report ? report.headline : 'Not replayed yet' })),
  );
  document.querySelectorAll('.views button').forEach((b) => {
    const counts = { network: net.length, runs: cur.runs.length, console: scenario.console.length, evidence: cur.screenshots.length, data: cur.plan.fields.length };
    const c = counts[b.dataset.view];
    b.querySelector('.count')?.remove();
    if (c !== undefined) b.append(h('span', { class: 'count', text: c }));
  });
}

function renderView() {
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const host = $('view');
  host.replaceChildren();
  ({ steps: viewSteps, network: viewNetwork, data: viewData, runs: viewRuns, console: viewConsole, evidence: viewEvidence, export: viewExport })[view](host);
}

// ================================================================== steps workbench

function stepRunStatuses(stepId) {
  return cur.runs.slice(-5).map((r) => {
    const res = (r.results || []).find((x) => x.stepId === stepId);
    if (!res) return 'not-run';
    return res.status === 'passed' && res.warning ? 'warning' : res.status;
  });
}

function viewSteps(host) {
  const tape = h('ol');
  for (const s of cur.scenario.steps) {
    const raw = cur.rawById.get(s.id) || {};
    const risky = s.target && !s.target.candidates?.some((c) => c.unique);
    tape.append(
      h(
        'li',
        { class: `tstep${s.id === selStep ? ' sel' : ''}${raw.skip ? ' skipped' : ''}`, tabindex: 0, 'data-id': s.id, onclick: () => selectStep(s.id) },
        h('span', { class: `node a-${s.action}${raw.flag === 'bug' ? ' bug' : ''}`, text: s.n }),
        h(
          'div',
          { class: 'tbody' },
          h('div', { class: 'tdesc', text: s.description }),
          h(
            'div',
            { class: 'tsub' },
            h('span', { class: 'tag', text: s.action }),
            s.apiCalls.length ? h('span', { class: `tag api${s.apiCalls.some((a) => a.status >= 400 || a.status === 0) ? ' bad' : ''}`, text: `${s.apiCalls.length} api` }) : null,
            s.outcomes?.length ? h('span', { class: 'tag out', text: `${s.outcomes.length} result${s.outcomes.length > 1 ? 's' : ''}` }) : null,
            s.frame ? h('span', { class: 'tag frame', text: 'iframe' }) : null,
            risky ? h('span', { class: 'tag risk', text: 'locator risk' }) : null,
            raw.skip ? h('span', { class: 'tag', text: 'skipped' }) : null,
          ),
        ),
        h('div', { class: 'pips', title: 'Last runs (oldest → newest)' }, stepRunStatuses(s.id).map((st) => h('span', { class: `pip ${st}`, title: st }))),
      ),
    );
  }
  const insp = h('div', { class: 'inspector' });
  host.append(h('div', { class: 'bench' }, h('div', { class: 'tape', 'aria-label': 'Steps' }, tape), insp));
  renderInspector(insp);
}

function selectStep(id) {
  selStep = id;
  stageMode = 'rec';
  document.querySelectorAll('.tstep').forEach((el) => el.classList.toggle('sel', Number(el.dataset.id) === id));
  const insp = document.querySelector('.inspector');
  if (insp) renderInspector(insp);
  document.querySelector('.tstep.sel')?.scrollIntoView({ block: 'nearest' });
}

function renderInspector(host) {
  host.replaceChildren();
  const s = cur.scenario.steps.find((x) => x.id === selStep);
  if (!s) return host.append(h('div', { class: 'panel panel-body dim', text: 'No steps captured.' }));
  const raw = cur.rawById.get(s.id) || {};
  const runRes = cur.lastRun?.results?.find((r) => r.stepId === s.id);

  host.append(
    h(
      'div',
      { class: 'insp-head' },
      h('span', { class: `node a-${s.action}${raw.flag === 'bug' ? ' bug' : ''}`, text: s.n }),
      h(
        'div',
        { class: 'insp-title' },
        h('h2', { text: s.description }),
        h(
          'div',
          { class: 'meta' },
          s.url ? h('span', { class: 'mono', text: pathOf(s.url) }) : null,
          s.pageTitle ? h('span', { text: s.pageTitle }) : null,
          runRes ? h('span', { class: `chip ${runRes.status === 'passed' && runRes.warning ? 'warning' : runRes.status}`, text: `last run: ${runRes.status}${runRes.warning ? ' (warning)' : ''}` }) : null,
        ),
      ),
    ),
  );

  // ---- stage
  const recShot = cur.shotByStep.get(s.id);
  const runShot = cur.runShot.get(s.id);
  const shot = stageMode === 'run' && runShot ? runShot : recShot;
  const stage = h('div', { class: 'stage' });
  if (shot) {
    const img = h('img', { src: shot.dataUrl, alt: `Screenshot after step ${s.n}`, onclick: () => lightbox(shot, `Step ${s.n} — ${s.description}`, stageMode === 'rec' ? raw.target : null) });
    stage.append(img);
    if (stageMode === 'rec' && raw.target?.rect) img.addEventListener('load', () => placeTarget(stage, img, raw.target, s.target?.friendly), { once: true });
  } else stage.append(h('div', { class: 'noshot', text: 'No screenshot for this step' }));
  if (recShot && runShot) {
    stage.append(
      h(
        'div',
        { class: 'stage-bar' },
        h('button', { class: stageMode === 'rec' ? 'on' : '', text: 'Recording', onclick: () => ((stageMode = 'rec'), renderInspector(host)) }),
        h('button', { class: stageMode === 'run' ? 'on' : '', text: 'Last replay', onclick: () => ((stageMode = 'run'), renderInspector(host)) }),
      ),
    );
  }
  host.append(stage);

  const grid = h('div', { class: 'insp-grid' });
  if (s.target) grid.append(locatorPanel(s));
  grid.append(outcomePanel(s, raw));
  if (s.apiCalls.length) grid.append(apiPanel(s));
  grid.append(detailPanel(s, raw, runRes));
  host.append(grid);
}

function placeTarget(stage, img, target, label) {
  const vw = target.viewport?.w;
  if (!vw) return;
  const k = img.clientWidth / vw;
  const r = target.rect;
  const box = h('div', { class: 'target-box', style: { left: `${r.x * k}px`, top: `${r.y * k}px`, width: `${Math.max(8, r.w * k)}px`, height: `${Math.max(8, r.h * k)}px` } });
  const tag = h('div', { class: 'target-label', text: label || target.friendly || target.tag, style: { left: `${r.x * k}px`, top: `${Math.max(18, r.y * k)}px` } });
  stage.append(box, tag);
}

function panel(title, body, { wide = false, extra = null } = {}) {
  return h('section', { class: `panel${wide ? ' wide' : ''}` }, h('header', { class: 'panel-head' }, h('h3', { text: title }), h('span', { class: 'grow' }), extra), h('div', { class: 'panel-body' }, body));
}

function locatorPanel(s) {
  const t = s.target;
  const rows = (t.candidates || []).map((c, i) =>
    h(
      'tr',
      {},
      h('td', { class: 'rank', text: i + 1 }),
      h('td', {}, h('span', { class: 'kind', text: c.type }), h('code', { text: candidateLabel(c) })),
      h('td', {}, h('span', { class: `uniq${c.unique ? '' : ' no'}`, text: c.unique ? 'unique' : 'ambiguous' })),
    ),
  );
  const body = h(
    'div',
    {},
    h(
      'dl',
      { class: 'kv' },
      h('dt', { text: 'Playwright' }),
      h('dd', {}, h('code', { class: 'mono', text: t.locators.playwright }), ' ', copyBtn(t.locators.playwright, 'Copy Playwright locator')),
      h('dt', { text: 'Cypress' }),
      h('dd', {}, h('code', { class: 'mono', text: t.locators.cypress }), ' ', copyBtn(t.locators.cypress, 'Copy Cypress locator')),
    ),
    h('table', { class: 'loc-table', style: { marginTop: '10px' } }, h('tbody', {}, rows)),
  );
  return panel('Locators', body, { wide: true, extra: h('span', { class: 'dim mono', text: `${t.tag}${t.role ? ` · ${t.role}` : ''}` }) });
}

function outcomePanel(s, raw) {
  const outs = raw.outcomes || [];
  if (!outs.length) return panel('Expected results', h('div', { class: 'dim', text: s.action === 'goto' ? 'Page load.' : 'Nothing extra appeared after this step (no toast, alert, validation or dialog).' }));
  const list = outs.map((o, i) =>
    h(
      'div',
      { class: `outcome${o.ignored ? ' ignored' : ''}` },
      h('span', { class: `chip plain ${o.required ? 'passed' : ''}`, text: o.kind }),
      h('span', { class: 'txt', text: o.text }),
      h('button', { class: 'btn sm', title: 'A Run fails if this does not appear', onclick: () => patchOutcome(raw, i, { required: !o.required, ignored: false }), text: o.required ? '✓ Required' : 'Require' }),
      h('button', { class: 'btn ghost sm', onclick: () => patchOutcome(raw, i, { ignored: !o.ignored, required: false }), text: o.ignored ? 'Restore' : 'Ignore' }),
    ),
  );
  return panel('Expected results', h('div', {}, list), { extra: h('span', { class: 'dim', text: 'auto-captured' }) });
}

function apiPanel(s) {
  return panel(
    'API calls triggered',
    h(
      'div',
      {},
      s.apiCalls.map((a) =>
        h(
          'div',
          { class: 'api-row', title: a.url, onclick: () => ((netSel = a.id), (view = 'network'), renderView()) },
          h('span', { class: 'm', text: a.method }),
          h('span', { class: `s${String(a.status || 0)[0]}`, text: a.status || 'ERR' }),
          h('span', { class: 'ell', text: a.route }),
          h('span', { class: 'dim', text: fmtMs(a.durationMs) }),
        ),
      ),
    ),
  );
}

function detailPanel(s, raw, runRes) {
  const field = cur.plan.fields.find((f) => f.stepId === s.id);
  const dl = h('dl', { class: 'kv' });
  const row = (k, v) => v != null && v !== '' && dl.append(h('dt', { text: k }), h('dd', {}, v));
  if (raw.value !== undefined && raw.action !== 'note') row('Value', h('code', { class: 'mono', text: raw.sensitive ? '•••••••• (secret)' : String(raw.value) }));
  if (field) row('Test data', h('span', {}, `${field.kind} · `, h('span', { class: `chip ${field.strategy}`, text: field.strategy }), ' ', h('span', { class: 'dim', text: field.reason })));
  if (s.assert) row('Check', `${s.assert.type}${s.assert.expected !== undefined ? ` = "${s.assert.expected}"` : ''}`);
  if (s.dropTarget) row('Drop on', `"${s.dropTarget.friendly}"${s.html5 ? ' (HTML5)' : ''}`);
  if (s.frame) row('Frame', h('code', { class: 'mono', text: s.frame.selector || s.frame.url }));
  const ctx = Object.entries(s.target?.context || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
  if (ctx) row('Context', ctx);
  if (raw.note) row('Note', raw.note);
  if (runRes) row('Last run', [runRes.error, runRes.warning, runRes.usedSelector ? `found via ${runRes.usedSelector.type}` : null].filter(Boolean).join(' · ') || `${runRes.status} in ${fmtMs(runRes.durationMs)}`);
  if (!dl.children.length) row('Action', s.action);

  const actions = h('div', { class: 'actions-row', style: { marginTop: '12px' } });
  const editable = { fill: 'value', select: 'value', goto: 'url', assert: 'expected', note: 'value' }[s.action];
  if (editable) actions.append(h('button', { class: 'btn sm', text: 'Edit', onclick: (e) => editField(e.currentTarget.closest('.panel-body'), raw, editable) }));
  if (s.action === 'assert') {
    actions.append(
      h(
        'select',
        { 'aria-label': 'Assertion type', onchange: (e) => patchEvent(raw.id, { assert: { ...raw.assert, type: e.target.value } }) },
        ['text', 'contains', 'visible', 'hidden', 'value', 'checked', 'url'].map((t) => h('option', { value: t, selected: raw.assert?.type === t, text: t })),
      ),
    );
  }
  actions.append(
    h('button', { class: 'btn sm', text: raw.note ? 'Edit note' : 'Add note', onclick: () => noteStep(raw) }),
    h('button', { class: 'btn sm', text: raw.skip ? 'Include in replay' : 'Skip in replay', onclick: () => patchEvent(raw.id, { skip: !raw.skip }) }),
    h('button', { class: 'btn ghost sm danger', text: 'Delete step', onclick: () => deleteStep(raw) }),
  );
  return panel('Details', h('div', {}, dl, actions), { wide: !s.apiCalls.length });
}

function editField(container, raw, field) {
  if (container.querySelector('.edit-row')) return;
  const val = field === 'expected' ? raw.assert?.expected : raw[field];
  const input = h('input', { type: 'text', value: val ?? '' });
  const row = h(
    'div',
    { class: 'edit-row' },
    input,
    h('button', {
      class: 'btn primary sm',
      text: 'Save',
      onclick: () => {
        const v = input.value;
        if (field === 'expected') patchEvent(raw.id, { assert: { ...raw.assert, expected: v } });
        else if (raw.action === 'select') patchEvent(raw.id, { value: v, values: [v], optionLabels: [] });
        else patchEvent(raw.id, { [field]: v, masked: false });
      },
    }),
    h('button', { class: 'btn ghost sm', text: 'Cancel', onclick: () => row.remove() }),
  );
  container.append(row);
  input.focus();
}

async function noteStep(raw) {
  const text = prompt('Note for this step (shown in test cases and exports):', raw.note || '');
  if (text !== null) await patchEvent(raw.id, { note: text.trim() || undefined });
}
async function patchOutcome(raw, i, patch) {
  const outcomes = (raw.outcomes || []).map((o, j) => (j === i ? { ...o, ...patch } : o));
  await patchEvent(raw.id, { outcomes });
}
async function patchEvent(id, patch) {
  const ev = await db.getEvent(id);
  if (!ev) return;
  Object.assign(ev, patch);
  await db.putEvent(ev);
  await openSession(cur.session.id, { keepSelection: true });
}
async function deleteStep(raw) {
  if (!confirm('Delete this step? It is removed from replays and exports.')) return;
  await db.deleteEvent(raw.id);
  await openSession(cur.session.id, { keepSelection: false });
}

document.addEventListener('keydown', (e) => {
  if (view !== 'steps' || !cur || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'j' && e.key !== 'k') return;
  const ids = cur.scenario.steps.map((s) => s.id);
  const i = ids.indexOf(selStep);
  const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1)))];
  if (next !== selStep) {
    e.preventDefault();
    selectStep(next);
  }
});

// ================================================================== network waterfall

function viewNetwork(host) {
  const stepOf = new Map();
  for (const s of cur.scenario.steps) for (const a of s.apiCalls) stepOf.set(a.id, s.n);
  const all = cur.events.filter((e) => e.kind === 'network' && !e.runId).sort((a, b) => (a.startTime || a.ts) - (b.startTime || b.ts));
  const rows = all.filter((e) => {
    if (netFilter.apiOnly && e.api === 'document' && e.method === 'GET') return false;
    if (netFilter.method && e.method !== netFilter.method) return false;
    if (netFilter.status === 'err' && !(e.status >= 400 || e.status === 0)) return false;
    if (netFilter.status && netFilter.status !== 'err' && String(e.status)[0] !== netFilter.status) return false;
    if (netFilter.q && !`${e.url} ${e.requestBody || ''} ${e.responseBody || ''}`.toLowerCase().includes(netFilter.q)) return false;
    return true;
  });
  const t0 = cur.session.createdAt;
  const tEnd = Math.max(t0 + 1000, ...all.map((e) => (e.startTime || e.ts) + (e.duration || 0)));
  const span = tEnd - t0;
  const pct = (t) => `${(((t - t0) / span) * 100).toFixed(2)}%`;

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('input', { type: 'search', placeholder: 'Filter URL or body…', value: netFilter.q, oninput: (e) => ((netFilter.q = e.target.value.toLowerCase()), renderView()) }),
    h('select', { onchange: (e) => ((netFilter.method = e.target.value), renderView()) }, ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => h('option', { value: m, selected: netFilter.method === m, text: m || 'All methods' }))),
    h('select', { onchange: (e) => ((netFilter.status = e.target.value), renderView()) }, [['', 'All statuses'], ['2', '2xx'], ['3', '3xx'], ['4', '4xx'], ['5', '5xx'], ['err', 'Failures']].map(([v, l]) => h('option', { value: v, selected: netFilter.status === v, text: l }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: netFilter.apiOnly, onchange: (e) => ((netFilter.apiOnly = e.target.checked), renderView()) }), 'API only'),
    h('span', { class: 'dim mono', text: `${rows.length} / ${all.length}` }),
  );
  const marks = cur.scenario.steps.map((s) => h('span', { class: 'step-mark', style: { left: pct(cur.rawById.get(s.id)?.ts || t0) } }));
  const wf = h(
    'div',
    { class: 'panel wf' },
    h('div', { class: 'wf-row headrow' }, h('span', { text: 'Step' }), h('span', { text: 'Method' }), h('span', { text: 'Status' }), h('span', { text: 'Route' }), h('span', { text: 'Timeline' }), h('span', { text: 'Time' })),
    rows.map((e) =>
      h(
        'div',
        { class: `wf-row${netSel === e.id ? ' sel' : ''}`, onclick: () => ((netSel = netSel === e.id ? null : e.id), renderView()) },
        h('span', { class: 'dim', text: stepOf.get(e.id) ?? '' }),
        h('span', { class: 'm', text: e.method }),
        h('span', { class: `s${String(e.status || 0)[0]}`, text: e.status || (e.error ? 'ERR' : '…') }),
        h('span', { class: 'ell', title: e.url, text: pathOf(e.url) }),
        h('span', { class: 'bar-track' }, ...marks.map((m) => m.cloneNode()), h('span', { class: `bar${e.status >= 400 || e.status === 0 ? ' bad' : ''}`, style: { left: pct(e.startTime || e.ts), width: `${Math.max(0.4, ((e.duration || 0) / span) * 100)}%` } })),
        h('span', { class: 'dim', text: fmtMs(e.duration) }),
      ),
    ),
    rows.length ? null : h('div', { class: 'panel-body dim', text: 'No requests match.' }),
  );
  const sel = all.find((e) => e.id === netSel);
  host.append(toolbar, h('div', { class: `net${sel ? ' open' : ''}` }, wf, sel ? netDetail(sel) : null));
}

function curlFor(e) {
  const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const parts = [`curl -X ${e.method} ${sq(e.url)}`];
  for (const [k, v] of Object.entries(e.requestHeaders || {})) parts.push(`-H ${sq(`${k}: ${v}`)}`);
  if (e.requestBody && !/^\[/.test(e.requestBody)) parts.push(`--data-raw ${sq(e.requestBody)}`);
  return parts.join(' \\\n  ');
}
function kvList(obj) {
  const entries = Object.entries(obj || {}).filter(([, v]) => v !== '' && v != null);
  if (!entries.length) return h('div', { class: 'dim', text: '—' });
  return h('dl', { class: 'kv mono' }, entries.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]));
}
function netDetail(e) {
  return h(
    'section',
    { class: 'panel detail' },
    h('header', { class: 'panel-head' }, h('h3', { text: `${e.method} · ${e.status || 'ERR'} ${e.statusText || ''}` }), h('span', { class: 'grow' }), h('button', { class: 'btn ghost icon sm', 'aria-label': 'Close', onclick: () => ((netSel = null), renderView()) }, svg('M4 4l8 8M12 4l-8 8'))),
    h(
      'div',
      { class: 'panel-body' },
      h('div', { class: 'url', text: e.url }),
      h('div', { class: 'actions-row', style: { marginTop: '10px' } }, h('button', { class: 'btn sm', text: 'Copy as cURL', onclick: () => copy(curlFor(e), 'cURL copied') }), e.responseBody ? h('button', { class: 'btn sm', text: 'Copy response', onclick: () => copy(e.responseBody) }) : null),
      h('h4', { text: 'General' }),
      kvList({ Type: e.api, Duration: fmtMs(e.duration), Started: fmtDate(e.startTime || e.ts), Frame: e.frameUrl, Error: e.error, Truncated: e.bodyTruncated ? 'response truncated' : '' }),
      h('h4', { text: 'Request headers' }),
      kvList(e.requestHeaders),
      e.requestBody ? h('h4', { text: 'Request body' }) : null,
      e.requestBody ? h('pre', { text: pretty(e.requestBody) }) : null,
      h('h4', { text: 'Response headers' }),
      kvList(e.responseHeaders),
      h('h4', { text: 'Response body' }),
      e.responseBody ? h('pre', { text: pretty(e.responseBody) }) : h('div', { class: 'dim', text: e.api === 'document' ? 'Document bodies are not captured' : '—' }),
    ),
  );
}

// ================================================================== test data

function savedChoice() {
  return { strategies: {}, custom: {}, seed: Date.now() % 100000, ...(cur.session.dataChoice || {}) };
}

/** Editable data-plan table. `choice` is mutated; onChange re-renders. */
function dataTable(choice, onChange) {
  const resolved = resolveData(cur.plan, { mode: 'recommended', strategies: choice.strategies, custom: choice.custom }, { rng: createRng(choice.seed) });
  const tbody = h('tbody');
  for (const f of resolved.fields) {
    const planned = cur.plan.fields.find((x) => x.key === f.key);
    const set = (strategy) => {
      if (strategy === planned.strategy) delete choice.strategies[f.key];
      else choice.strategies[f.key] = strategy;
      if (strategy !== 'custom') delete choice.custom[f.key];
      onChange();
    };
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': `Strategy for ${f.label}` }, ['recorded', 'fresh', 'custom'].map((st) => h('button', { type: 'button', class: f.strategy === st ? 'on' : '', text: st, onclick: () => set(st) })));
    let valueCell;
    if (f.strategy === 'custom') {
      valueCell = h('input', {
        type: f.secret ? 'password' : 'text',
        placeholder: f.kind === 'otp' ? 'Enter the code when you run' : 'Value for this run',
        value: choice.custom[f.key] || '',
        oninput: (e) => {
          choice.custom[f.key] = e.target.value;
          updateRunGate();
        },
      });
    } else valueCell = h('span', { class: 'preview', text: f.secret ? (f.strategy === 'fresh' ? `${f.value.slice(0, 2)}•••••• (generated)` : '•••••••• (recorded)') : String(f.value) });
    tbody.append(
      h(
        'tr',
        {},
        h('td', {}, h('strong', { text: f.label }), h('div', { class: 'why', text: `${f.kind}${f.secret ? ' · secret' : ''}${f.constraints?.maxLength ? ` · max ${f.constraints.maxLength}` : ''}` })),
        h('td', {}, h('span', { class: 'preview dim', text: f.secret ? '••••••••' : String(f.recorded) })),
        h('td', {}, seg, h('div', { class: 'why', text: planned.strategy === f.strategy ? `Recommended: ${planned.reason}` : `You changed this (recommended: ${planned.strategy})` })),
        h('td', {}, valueCell),
      ),
    );
  }
  return h('table', { class: 'dtable' }, h('thead', {}, h('tr', {}, ['Field', 'Recorded', 'Strategy', 'Value for next run'].map((t) => h('th', { text: t })))), tbody);
}

function intentBanner() {
  const p = cur.plan;
  const fresh = p.fields.filter((f) => f.strategy === 'fresh').length;
  const custom = p.fields.filter((f) => f.strategy === 'custom').length;
  const label = { signup: 'Sign-up flow', create: 'Create/record flow', login: 'Login flow', checkout: 'Checkout flow', booking: 'Booking flow', search: 'Search flow', form: 'Form flow' }[p.intent];
  const msg = !p.fields.length
    ? 'This scenario has no typed or chosen data.'
    : p.needsDecision
      ? `${fresh ? `${fresh} field${fresh > 1 ? 's' : ''} should get fresh data` : ''}${fresh && custom ? ' and ' : ''}${custom ? `${custom} need${custom > 1 ? '' : 's'} your input` : ''} before replaying.`
      : 'Reusing the recorded data is safe for this scenario.';
  return h('div', { class: 'data-intro' }, h('span', { class: 'chip fresh plain', text: label }), h('div', {}, h('div', { class: 'big', text: msg }), h('div', { class: 'dim', text: 'Recognised from field labels, types, autocomplete hints, the form and its submit button.' })));
}

function viewData(host) {
  const choice = savedChoice();
  const again = () => {
    host.replaceChildren();
    drawDataView(host, choice, again);
  };
  drawDataView(host, choice, again);
}
function drawDataView(host, choice, again) {
  if (!cur.plan.fields.length) return void host.append(intentBanner());
  host.append(
    intentBanner(),
    h(
      'div',
      { class: 'presets' },
      h('button', { class: 'btn sm', text: 'Use recommendations', onclick: () => ((choice.strategies = {}), (choice.custom = {}), again()) }),
      h('button', { class: 'btn sm', text: 'All recorded', onclick: () => ((choice.strategies = Object.fromEntries(cur.plan.fields.filter((f) => f.strategy !== 'custom').map((f) => [f.key, 'recorded']))), again()) }),
      h('button', { class: 'btn sm', text: 'All fresh', onclick: () => ((choice.strategies = Object.fromEntries(cur.plan.fields.filter((f) => !f.secret || f.strategy === 'fresh').map((f) => [f.key, 'fresh']))), again()) }),
      h('button', { class: 'btn sm', onclick: () => ((choice.seed = Math.floor(Math.random() * 1e6)), again()) }, svg(ICON.dice), 'New values'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', text: 'Save as default', onclick: () => saveChoice(choice) }),
      h('button', { class: 'btn primary sm', onclick: () => openReplayDialog(choice) }, svg(ICON.play, true), 'Replay with this data'),
    ),
    h('div', { class: 'panel' }, dataTable(choice, again)),
  );
}

async function saveChoice(choice) {
  const s = await db.getSession(cur.session.id);
  s.dataChoice = { strategies: choice.strategies, seed: choice.seed }; // custom values (e.g. OTP) are never stored
  await db.putSession(s);
  cur.session = s;
  toast('Saved as the default data for replays');
}

// ================================================================== replay dialog

let dialogChoice = null;
function updateRunGate() {
  if (!dialogChoice) return;
  const r = resolveData(cur.plan, { mode: 'recommended', ...dialogChoice }, { rng: createRng(dialogChoice.seed) });
  const missing = r.fields.filter((f) => f.missing);
  $('btnRunWithData').disabled = missing.length > 0;
  $('dataDialogHint').textContent = missing.length ? `Enter a value for: ${missing.map((f) => f.label).join(', ')}` : `Seed ${dialogChoice.seed} · values are kept in the Run report`;
}
function openReplayDialog(choice = savedChoice()) {
  dialogChoice = { strategies: { ...choice.strategies }, custom: { ...choice.custom }, seed: choice.seed };
  const content = $('dataDialogContent');
  const draw = () => {
    content.replaceChildren(
      intentBanner(),
      cur.plan.fields.length
        ? h(
            'div',
            {},
            h(
              'div',
              { class: 'presets' },
              h('button', { type: 'button', class: 'btn sm', text: 'Recommended', onclick: () => ((dialogChoice.strategies = {}), draw()) }),
              h('button', { type: 'button', class: 'btn sm', text: 'Same data as recorded', onclick: () => ((dialogChoice.strategies = Object.fromEntries(cur.plan.fields.filter((f) => f.strategy !== 'custom').map((f) => [f.key, 'recorded']))), draw()) }),
              h('button', { type: 'button', class: 'btn sm', text: 'New data for everything', onclick: () => ((dialogChoice.strategies = Object.fromEntries(cur.plan.fields.filter((f) => !f.secret || f.strategy === 'fresh').map((f) => [f.key, 'fresh']))), draw()) }),
              h('button', { type: 'button', class: 'btn sm', onclick: () => ((dialogChoice.seed = Math.floor(Math.random() * 1e6)), draw()) }, svg(ICON.dice), 'New values'),
            ),
            h('div', { class: 'panel' }, dataTable(dialogChoice, draw)),
          )
        : '',
    );
    updateRunGate();
  };
  draw();
  $('dataDialog').showModal();
}
$('dataDialog').addEventListener('close', async () => {
  if ($('dataDialog').returnValue !== 'run' || !dialogChoice) return;
  const data = { mode: 'recommended', ...dialogChoice };
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  const res = await chrome.runtime.sendMessage({ type: 'replay', sessionId: cur.session.id, tabId: tab.id, data });
  if (res?.error) {
    alert(res.error);
    chrome.tabs.remove(tab.id);
  }
});

// ================================================================== runs, console, evidence

function viewRuns(host) {
  const runs = [...cur.runs].reverse();
  if (!runs.length) return host.append(h('div', { class: 'panel panel-body dim', text: 'No replays yet. Press “Replay…” to re-execute this scenario and compare UI, expected results and APIs against the recording.' }));
  const stepById = new Map(cur.scenario.steps.map((s) => [s.id, s]));
  const shotById = new Map(cur.screenshots.map((s) => [s.id, s]));
  runs.forEach((run, i) => {
    const report = run.report || buildRunReport({ results: run.results || [] });
    const table = h('table', { class: 'rtable' }, h('thead', {}, h('tr', {}, ['#', 'Result', 'Step', 'Time', 'Details', ''].map((t) => h('th', { text: t })))));
    const tb = h('tbody');
    for (const r of run.results || []) {
      const st = stepById.get(r.stepId);
      const shot = r.screenshotId && shotById.get(r.screenshotId);
      tb.append(
        h(
          'tr',
          {},
          h('td', { class: 'mono', text: st?.n ?? r.index + 1 }),
          h('td', { class: `r-${r.status}`, text: r.status }),
          h('td', { text: st?.description || r.action }),
          h('td', { class: 'mono', text: fmtMs(r.durationMs) }),
          h('td', { class: 'dim', text: [r.error, r.warning, r.usedSelector ? `via ${r.usedSelector.type}` : null].filter(Boolean).join(' · ') }),
          h('td', {}, shot ? h('img', { class: 'mini', src: shot.dataUrl, alt: 'Replay screenshot', onclick: () => lightbox(shot, `Run step ${st?.n} — ${r.status}`) }) : null),
        ),
      );
    }
    table.append(tb);
    const dataRows = run.data?.fields?.filter((f) => f.strategy !== 'recorded') || [];
    host.append(
      h(
        'details',
        { class: 'panel run', open: i === 0 },
        h(
          'summary',
          {},
          h('span', { class: `chip ${run.status}`, text: run.status }),
          h('span', { class: 'headline', text: report.headline }),
          h('span', { class: 'dim mono', text: `#${runs.length - i} · ${fmtDate(run.startedAt)}${run.endedAt ? ` · ${fmtMs(run.endedAt - run.startedAt)}` : ''}` }),
        ),
        h(
          'div',
          { class: 'run-body' },
          report.issues.length ? h('ul', { class: 'issues' }, report.issues.map((x) => h('li', { text: x }))) : null,
          dataRows.length ? h('div', { class: 'dim' }, 'Test data: ', dataRows.map((f) => `${f.label} = ${f.value} (${f.strategy})`).join(' · ')) : null,
          h('div', { style: { overflow: 'auto' } }, table),
        ),
      ),
    );
  });
}

function viewConsole(host) {
  const logs = cur.events.filter((e) => e.kind === 'console' && !e.runId);
  host.append(
    logs.length
      ? h('div', { class: 'panel' }, logs.map((l) => h('div', { class: `log ${l.level}` }, `[${l.level}] ${l.message}`, h('small', { text: `${fmtDate(l.ts)} · ${l.source || l.url || ''}` }), l.stack ? h('small', { text: l.stack }) : null)))
      : h('div', { class: 'panel panel-body dim', text: 'No console errors or warnings were captured.' }),
  );
}

function viewEvidence(host) {
  const runIdx = new Map(cur.runs.map((r, i) => [r.id, i + 1]));
  const stepN = new Map(cur.scenario.steps.map((s) => [s.id, s.n]));
  host.append(
    cur.screenshots.length
      ? h(
          'div',
          { class: 'gallery' },
          cur.screenshots.map((s) => {
            const cap = `${s.runId ? `run #${runIdx.get(s.runId) || '?'} · ` : ''}${stepN.has(s.stepEventId) ? `step ${stepN.get(s.stepEventId)} · ` : ''}${s.reason} · ${new Date(s.ts).toLocaleTimeString()}`;
            return h('figure', { class: 'panel' }, h('img', { src: s.dataUrl, alt: cap, loading: 'lazy', onclick: () => lightbox(s, `${cap} — ${s.url}`, s.runId ? null : cur.rawById.get(s.stepEventId)?.target) }), h('figcaption', { text: cap }));
          }),
        )
      : h('div', { class: 'panel panel-body dim', text: 'No screenshots (enable them in Settings).' }),
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
    if (!r || !vw) return;
    const k = img.clientWidth / vw;
    Object.assign(box.style, { left: `${r.x * k}px`, top: `${r.y * k}px`, width: `${Math.max(8, r.w * k)}px`, height: `${Math.max(8, r.h * k)}px` });
    box.classList.remove('hidden');
  };
  img.src = shot.dataUrl;
  $('lightbox').showModal();
}
$('lbClose').addEventListener('click', () => $('lightbox').close());
$('lightbox').addEventListener('click', (e) => e.target.id === 'lightbox' && $('lightbox').close());

// ================================================================== export

const FORMAT_HINTS = {
  ai: 'Paste into ChatGPT / Claude / Copilot',
  playwright: 'Runnable spec with API waits + assertions',
  cypress: 'cy.intercept aliases, iframe + drag helpers',
  postman: 'API calls grouped by step',
  har: 'Open in DevTools or any HAR viewer',
  testcase: 'Steps, expected results, issues',
  scenario: 'Machine-readable model',
  env: 'Variables the specs expect',
  backup: 'Re-import into the workbench',
  pack: 'Everything + screenshots in one ZIP',
};

function viewExport(host) {
  const list = h('div', { class: 'formats' }, Object.entries(FORMATS).map(([k, f]) => h('button', { class: k === exportFormat ? 'on' : '', onclick: () => ((exportFormat = k), renderView()) }, h('span', { text: f.label }), h('small', { text: FORMAT_HINTS[k] || '' }))));
  const radios = (name, value, options, onPick) => options.map(([v, label, hint]) => h('label', { class: 'radio' }, h('input', { type: 'radio', name, value: v, checked: value === v, onchange: () => onPick(v) }), h('span', {}, label, hint ? h('span', { class: 'dim', text: ` — ${hint}` }) : null)));
  const left = h(
    'section',
    { class: 'panel' },
    h('header', { class: 'panel-head' }, h('h3', { text: 'Format' })),
    list,
    h('div', { class: 'opt-group' }, h('h4', { text: 'Secrets' }), radios('secrets', exportSecrets, [['placeholder', 'Env placeholders', 'recommended'], ['include', 'Real values', 'private use only'], ['mask', 'Masked']], (v) => ((exportSecrets = v), renderView())), exportSecrets === 'include' ? h('div', { class: 'warnbox', text: 'Passwords, tokens and auth headers will be written into the file. Do not share or commit it.' }) : null),
    h('div', { class: 'opt-group' }, h('h4', { text: 'Test data in specs' }), radios('data', exportData, [['recommended', 'As the data plan recommends', 'fresh where needed'], ['recorded', 'Recorded values'], ['fresh', 'Generate everything fresh']], (v) => ((exportData = v), renderView()))),
  );
  const pre = h('pre', { class: 'code', text: 'Generating…' });
  const right = h(
    'section',
    { class: 'panel preview-pane' },
    h('header', { class: 'panel-head' }, h('h3', { text: FORMATS[exportFormat].label }), h('span', { class: 'grow' }), h('button', { class: 'btn sm', text: 'Copy', onclick: () => (lastExport?.content instanceof Uint8Array ? toast('Binary file — use Download') : lastExport && copy(lastExport.content)) }), h('button', { class: 'btn primary sm', text: 'Download', onclick: () => lastExport && download(lastExport) })),
    h('div', { class: 'panel-body' }, pre),
  );
  host.append(h('div', { class: 'export' }, left, right));
  exportSession(cur.session.id, exportFormat, { secrets: exportSecrets, data: exportData })
    .then((res) => {
      lastExport = res;
      if (res.content instanceof Uint8Array) {
        pre.textContent = `${res.filename} — ${fmtBytes(res.content.length)}\n\nREADME.md, ai-context.md, test-case.md, scenario.json, .env.example\ntests/playwright/*.spec.ts, tests/cypress/*.cy.js\napi/postman_collection.json, api/traffic.har\nscreenshots/ (one per step + page loads)\nsession-backup.json`;
      } else pre.textContent = res.content.length > 300000 ? `${res.content.slice(0, 300000)}\n\n… preview truncated — download for the full file` : res.content;
    })
    .catch((e) => (pre.textContent = `Export failed: ${e.message}`));
}

// ================================================================== settings

const SETTING_META = {
  captureScreenshots: ['Capture', 'Screenshot after each step', 'bool'],
  screenshotQuality: ['Capture', 'Screenshot JPEG quality (10–100)', 'number'],
  captureResponseBodies: ['Capture', 'Capture request/response bodies', 'bool'],
  maxBodyBytes: ['Capture', 'Max body kept per request (chars)', 'number'],
  captureConsole: ['Capture', 'Capture console errors and warnings', 'bool'],
  captureOutcomes: ['Capture', 'Capture expected results (toasts, alerts, validation, dialogs)', 'bool'],
  showOverlay: ['Capture', 'Show the in-page recording toolbar', 'bool'],
  maskPasswordsAtCapture: ['Capture', 'Mask passwords at capture time', 'bool'],
  ignoreUrlPatterns: ['Capture', 'Ignore requests whose URL contains (one per line)', 'text'],
  replayStepDelayMs: ['Replay', 'Pause between replayed steps (ms)', 'number'],
  replayTimeoutMs: ['Replay', 'Wait for elements up to (ms)', 'number'],
  replayWaitForNetworkIdle: ['Replay', 'Wait for network idle after each step', 'bool'],
  replayHighlight: ['Replay', 'Highlight elements while replaying', 'bool'],
  replayContinueOnFailure: ['Replay', 'Continue after a failed step', 'bool'],
  sensitiveHeaders: ['Export', 'Headers masked in exports (one per line)', 'text'],
};

async function openSettings() {
  cur = null;
  renderRail();
  $('empty').classList.add('hidden');
  $('sessionView').classList.add('hidden');
  $('settingsView').classList.remove('hidden');
  const s = await getSettings();
  const groups = {};
  for (const [key, [group, label, type]] of Object.entries(SETTING_META)) {
    let input;
    if (type === 'bool') input = h('input', { type: 'checkbox', name: key, checked: !!s[key] });
    else if (type === 'number') input = h('input', { type: 'number', name: key, value: s[key] });
    else input = h('textarea', { name: key, text: s[key] });
    (groups[group] ||= []).push(type === 'bool' ? h('label', { class: 'field inline' }, input, label) : h('label', { class: 'field' }, h('span', { text: label }), input));
  }
  $('settingsForm').replaceChildren(
    ...Object.entries(groups).map(([g, fields]) => h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h3', { text: g })), h('div', { class: 'panel-body' }, fields))),
    h('div', { class: 'save-row' }, h('button', { class: 'btn primary', type: 'submit', text: 'Save settings' }), h('button', { class: 'btn ghost', type: 'button', text: 'Restore defaults', onclick: async () => (await saveSettings({ ...DEFAULT_SETTINGS }), openSettings(), toast('Defaults restored')) })),
  );
}
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  for (const [key, [, , type]] of Object.entries(SETTING_META)) {
    const el = e.target.elements[key];
    patch[key] = type === 'bool' ? el.checked : type === 'number' ? Number(el.value) : el.value;
  }
  patch.screenshotQuality = Math.min(100, Math.max(10, patch.screenshotQuality || 60));
  await saveSettings(patch);
  toast('Settings saved');
});

// ================================================================== import + wiring

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
      idMap.set(oldId, await db.addEvent({ ...rest, sessionId: session.id, runId: null }));
    }
    for (const s of data.screenshots || []) {
      if (!s.runId) await db.putScreenshot({ ...s, id: `${s.id}_${session.id}`, sessionId: session.id, stepEventId: idMap.get(s.stepEventId) ?? null });
    }
    await loadSessions();
    location.hash = session.id;
    toast('Scenario imported');
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

$('search').addEventListener('input', renderRail);
$('btnSettings').addEventListener('click', () => (location.hash = 'settings'));
document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => ((view = b.dataset.view), renderView())));
$('sessionTitle').addEventListener('change', async (e) => {
  const s = await db.getSession(cur.session.id);
  s.name = e.target.value.trim() || s.name;
  await db.putSession(s);
  cur.session = s;
  await loadSessions();
});
$('btnRefresh').addEventListener('click', () => openSession(cur.session.id, { keepSelection: true }));
$('btnDelete').addEventListener('click', async () => {
  if (!confirm(`Delete "${cur.session.name}" with all its steps, API calls and screenshots? This cannot be undone.`)) return;
  await db.deleteSession(cur.session.id);
  cur = null;
  location.hash = '';
  await loadSessions();
});
$('btnReplay').addEventListener('click', () => openReplayDialog());

let refreshTimer = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (!cur) return;
  const id = cur.session.id;
  const relevant = (msg.type === 'state' && (msg.state.sessionId === id || msg.state.replay?.sessionId === id)) || ((msg.type === 'replay:progress' || msg.type === 'replay:done') && msg.sessionId === id);
  if (!relevant) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => view !== 'export' && !document.querySelector('dialog[open]') && openSession(id, { keepSelection: true }), msg.type === 'replay:done' ? 200 : 1500);
});

async function route() {
  const [id, action] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (id === 'settings') return openSettings();
  if (id) {
    await openSession(id);
    if (action === 'replay') openReplayDialog();
    return;
  }
  cur = null;
  $('sessionView').classList.add('hidden');
  $('settingsView').classList.add('hidden');
  $('empty').classList.remove('hidden');
  renderRail();
}
window.addEventListener('hashchange', route);

await loadSessions();
await route();
