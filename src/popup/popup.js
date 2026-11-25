import { STATUS } from '../shared/settings.js';
import { exportSession, download } from '../shared/export-service.js';

const $ = (id) => document.getElementById(id);
let state = null;
let timer = null;

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra }).then((res) => {
    if (res?.error) throw new Error(res.error);
    return res;
  });
}

function flash(text, isError = false) {
  const m = $('msg');
  m.textContent = text;
  m.className = `msg${isError ? ' error' : ''}`;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => m.classList.add('hidden'), isError ? 6000 : 2500);
}

async function act(type, extra) {
  try {
    const res = await send(type, extra);
    if (res && res.status) render(res);
    return res;
  } catch (e) {
    flash(e.message, true);
    return null;
  }
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function render(s) {
  state = s;
  const st = s.status;
  const chip = $('status');
  chip.textContent = { idle: 'Idle', recording: '● Recording', paused: 'Paused', stopped: 'Stopped', replaying: '▶ Replaying' }[st] || st;
  chip.className = `chip ${st}`;

  const active = st === STATUS.RECORDING || st === STATUS.PAUSED;
  $('nameRow').classList.toggle('hidden', active || st === STATUS.REPLAYING);
  $('btnStart').disabled = active || st === STATUS.REPLAYING;
  $('btnPause').disabled = !active;
  $('btnPause').textContent = st === STATUS.PAUSED ? 'Resume' : 'Pause';
  $('btnStop').disabled = !active;
  $('btnRerun').disabled = !s.sessionId || st === STATUS.REPLAYING;
  $('btnReset').disabled = !s.sessionId || st === STATUS.REPLAYING;
  $('tools').classList.toggle('hidden', st !== STATUS.RECORDING);
  $('btnAssert').classList.toggle('on', !!s.assertMode);
  $('btnAssert').textContent = s.assertMode ? '✓ Click element…' : '✓ Assert element';

  const c = s.counts || {};
  $('sSteps').textContent = c.steps ?? 0;
  $('sApi').textContent = c.network ?? 0;
  $('sShots').textContent = c.screenshots ?? 0;
  $('sErr').textContent = c.errors ?? 0;
  $('sTime').textContent = fmtTime(s.elapsedMs || 0);

  const hasSession = !!s.sessionId || !!s.lastRun;
  for (const id of ['btnCopyAi', 'btnPack']) $(id).disabled = !hasSession || active || st === STATUS.REPLAYING;

  // replay progress
  const r = s.replay;
  $('replayBox').classList.toggle('hidden', st !== STATUS.REPLAYING);
  if (r) {
    $('replayLabel').textContent = `Replaying step ${r.index + 1} of ${r.total}`;
    $('replayBar').style.width = `${Math.round(((r.index + 1) / Math.max(1, r.total)) * 100)}%`;
  }

  clearInterval(timer);
  if (st === STATUS.RECORDING) {
    const base = Date.now() - (s.elapsedMs || 0);
    timer = setInterval(() => ($('sTime').textContent = fmtTime(Date.now() - base)), 500);
  }
  renderLastRun();
  renderDataHint().catch(() => {});
  renderSaveCard().catch(() => {});
  renderTarget().catch(() => {});
  $('nextCard').classList.toggle('hidden', !s.sessionId || st === STATUS.REPLAYING);
  $('targetRow').classList.toggle('hidden', st === STATUS.REPLAYING);
}

// ------------------------------------------------------------------ target project / suite

const targetKey = (t) => (t ? `${t.projectId}|${t.suiteId}` : '');
async function renderTarget() {
  const db = await import('../shared/db.js');
  const projects = await db.listProjects();
  const sel = $('targetSel');
  const want = targetKey(state?.target);
  sel.replaceChildren(new Option('No suite — keep in Unsorted', ''));
  for (const p of projects) {
    const group = document.createElement('optgroup');
    group.label = p.name;
    for (const s of p.suites) group.append(new Option(`${s.name} (${s.scenarioIds.length})`, `${p.id}|${s.id}`));
    sel.append(group);
  }
  sel.append(new Option('+ New project / suite…', 'new'));
  sel.value = [...sel.options].some((o) => o.value === want) ? want : '';
  $('projectNames').replaceChildren(...projects.map((p) => new Option(p.name)));
  const active = state?.status === STATUS.RECORDING || state?.status === STATUS.PAUSED;
  $('targetInfo').textContent = want ? (active ? 'this recording is filed here' : 'new recordings go here') : '';
}

$('targetSel').addEventListener('change', async () => {
  const v = $('targetSel').value;
  if (v === 'new') {
    $('newTarget').classList.remove('hidden');
    $('newProject').focus();
    return;
  }
  $('newTarget').classList.add('hidden');
  const [projectId, suiteId] = v ? v.split('|') : [];
  await act('setTarget', { target: v ? { projectId, suiteId } : null });
});
$('btnCancelTarget').addEventListener('click', () => {
  $('newTarget').classList.add('hidden');
  renderTarget();
});
$('btnCreateTarget').addEventListener('click', async () => {
  try {
    const db = await import('../shared/db.js');
    const { createProject, addSuite } = await import('../shared/projects.js');
    const pName = $('newProject').value.trim();
    const sName = $('newSuite').value.trim() || 'Smoke';
    if (!pName) throw new Error('Enter a project name');
    const projects = await db.listProjects();
    let project = projects.find((p) => p.name.toLowerCase() === pName.toLowerCase());
    if (!project) {
      let baseUrl = '';
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (/^https?:/.test(tab?.url || '')) baseUrl = new URL(tab.url).origin;
      } catch {}
      project = createProject({ name: pName, baseUrl });
    }
    let suite = project.suites.find((s) => s.name.toLowerCase() === sName.toLowerCase());
    if (!suite) ({ project, suite } = addSuite(project, sName));
    await db.putProject(project);
    $('newTarget').classList.add('hidden');
    $('newProject').value = $('newSuite').value = '';
    await act('setTarget', { target: { projectId: project.id, suiteId: suite.id } });
    flash(`New scenarios will be filed in ${project.name} › ${suite.name}`);
  } catch (e) {
    flash(e.message, true);
  }
});

$('btnNext').addEventListener('click', async () => {
  const res = await act('nextScenario', { name: $('nextName').value });
  if (!res) return;
  $('nextName').value = '';
  saveCardFor = null;
  const p = res.previous;
  if (p?.empty) flash('Previous recording had no steps and was dropped. Recording the next scenario.');
  else if (p) flash(`Saved "${p.name}"${p.filedIn ? ` to ${p.filedIn}` : ' (Unsorted)'}. Recording the next scenario.`);
  else flash('Recording a new scenario.');
});

// ------------------------------------------------------------------ save scenario to a suite

let saveCardFor = null;
async function renderSaveCard() {
  const card = $('saveCard');
  if (!state?.sessionId || state.status !== STATUS.STOPPED) return card.classList.add('hidden');
  const db = await import('../shared/db.js');
  const { suitesOf } = await import('../shared/projects.js');
  const [session, projects] = await Promise.all([db.getSession(state.sessionId), db.listProjects()]);
  if (!session) return card.classList.add('hidden');
  const inSuites = suitesOf(projects, session.id);
  $('savedIn').textContent = inSuites.length ? `in ${inSuites.map((x) => `${x.project.name} › ${x.suite.name}`).join(', ')}` : 'not in a suite yet';
  if (saveCardFor !== session.id) {
    saveCardFor = session.id;
    $('saveName').value = session.name;
    const sel = $('saveSuite');
    sel.replaceChildren();
    for (const p of projects) {
      const group = document.createElement('optgroup');
      group.label = p.name;
      for (const s of p.suites) group.append(new Option(`${s.name} (${s.scenarioIds.length})`, `${p.id}|${s.id}`));
      sel.append(group);
    }
    sel.append(new Option(projects.length ? '+ New project or suite…' : '+ Create a project and suite…', 'new'));
    let last = null;
    try {
      last = localStorage.getItem('qa.lastSuite');
    } catch {}
    if (last && [...sel.options].some((o) => o.value === last)) sel.value = last;
  }
  card.classList.remove('hidden');
}

$('btnSaveScenario').addEventListener('click', async () => {
  const sid = state?.sessionId;
  const choice = $('saveSuite').value;
  try {
    const db = await import('../shared/db.js');
    const session = await db.getSession(sid);
    session.name = $('saveName').value.trim() || session.name;
    await db.putSession(session);
    if (choice === 'new') return act('openDashboard', { sessionId: `${sid}/save` });
    const [projectId, suiteId] = choice.split('|');
    const { addToSuite } = await import('../shared/projects.js');
    const project = await db.getProject(projectId);
    await db.putProject(addToSuite(project, suiteId, sid));
    try {
      localStorage.setItem('qa.lastSuite', choice);
    } catch {}
    flash(`Saved to ${project.name} › ${project.suites.find((s) => s.id === suiteId).name}`);
    renderSaveCard();
  } catch (e) {
    flash(e.message, true);
  }
});

async function renderLastRun() {
  const box = $('lastRun');
  const lr = state?.lastRun;
  if (!lr || state.status === STATUS.REPLAYING) return box.classList.add('hidden');
  const { getSession } = await import('../shared/db.js');
  const session = await getSession(lr.sessionId);
  const run = session?.runs?.find((x) => x.id === lr.runId);
  if (!run) return box.classList.add('hidden');
  const counts = { passed: 0, failed: 0, skipped: 0, 'not-run': 0 };
  run.results.forEach((x) => (counts[x.status] = (counts[x.status] || 0) + 1));
  const d = run.report?.apiDiff || run.apiDiff || {};
  const issues = [];
  const failed = run.results.find((x) => x.status === 'failed');
  if (failed) issues.push(`Step ${failed.index + 1}: ${failed.error}`);
  if (d.statusChanged?.length) issues.push(`${d.statusChanged.length} API status change(s)`);
  if (d.missing?.length) issues.push(`${d.missing.length} recorded API call(s) not seen`);
  if (run.consoleErrors) issues.push(`${run.consoleErrors} console error(s)`);
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('span');
  title.textContent = `Last replay: ${counts.passed} passed · ${counts.failed} failed · ${counts['not-run']} not run`;
  const chip = document.createElement('span');
  chip.className = `chip ${run.status}`;
  chip.textContent = run.status;
  head.append(title, chip);
  box.append(head);
  if (issues.length) {
    const ul = document.createElement('ul');
    for (const i of issues) {
      const li = document.createElement('li');
      li.textContent = i;
      ul.append(li);
    }
    box.append(ul);
  }
  box.classList.remove('hidden');
}

// ------------------------------------------------------------------ wiring

$('btnStart').addEventListener('click', () => act('start', { name: $('sessionName').value, target: state?.target ?? null }));
$('btnPause').addEventListener('click', () => act(state?.status === STATUS.PAUSED ? 'resume' : 'pause'));
$('btnStop').addEventListener('click', async () => {
  const res = await act('stop');
  if (res) flash('Recording saved. Open the dashboard to review or export.');
});
/** Decide how Rerun treats Test data: saved choice → use it; needs a decision → ask in the workbench; else recorded. */
async function rerunDecision(sessionId) {
  const { getSession, getEvents } = await import('../shared/db.js');
  const { buildDataPlan } = await import('../shared/test-data.js');
  const session = await getSession(sessionId);
  const steps = (await getEvents(sessionId, { runId: null, kind: 'step' })).filter((s) => !s.skip);
  const plan = buildDataPlan(steps);
  const needsInput = plan.fields.some((f) => f.strategy === 'custom');
  if (needsInput) return { ask: true, plan, why: 'needs a one-time code / custom value' };
  if (session?.dataChoice) return { data: { mode: 'recommended', ...session.dataChoice }, plan, why: 'uses your saved data choice' };
  if (plan.needsDecision) return { ask: true, plan, why: `${plan.intent} flow — fresh data recommended` };
  return { data: { mode: 'recorded' }, plan, why: 'reuses the recorded data' };
}

async function renderDataHint() {
  const el = $('dataHint');
  if (!state?.sessionId || state.status !== STATUS.STOPPED) return el.classList.add('hidden');
  const d = await rerunDecision(state.sessionId);
  el.replaceChildren(
    'Rerun ',
    Object.assign(document.createElement('b'), { textContent: 'opens a step-by-step review' }),
    d.plan.fields.length ? ` to confirm before it runs — test data: ${d.ask ? `you choose (${d.why})` : d.why}.` : ' to confirm before it runs.',
  );
  el.classList.remove('hidden');
}

// Every rerun is confirmed step by step in the workbench before it executes.
$('btnRerun').addEventListener('click', () => act('openDashboard', { sessionId: `${state?.sessionId}/replay` }));
$('btnStopReplay').addEventListener('click', () => act('stopReplay'));
$('btnReset').addEventListener('click', () => {
  const msg = 'Discard this recording? Its steps, API calls and screenshots are deleted and it is removed from any suite. This cannot be undone.\n\nTo keep it and record another, use "Save & next" instead.';
  if (confirm(msg)) act('reset').then((r) => r && flash('Recording discarded.'));
});
$('btnAssert').addEventListener('click', async () => {
  await act('assertMode');
  if (state?.assertMode) window.close(); // get out of the way so the user can click the element
});
$('btnAssertUrl').addEventListener('click', async () => {
  if (await act('assertUrl')) flash('URL assertion added');
});
$('btnShot').addEventListener('click', async () => {
  if (await act('screenshot')) flash('Evidence screenshot captured');
});
async function addNote() {
  const text = $('noteText').value.trim();
  if (!text) return;
  if (await act('note', { text, flag: $('noteBug').checked ? 'bug' : 'info' })) {
    $('noteText').value = '';
    $('noteBug').checked = false;
    flash('Note added');
  }
}
$('btnNote').addEventListener('click', addNote);
$('noteText').addEventListener('keydown', (e) => e.key === 'Enter' && addNote());
$('btnDashboard').addEventListener('click', () => act('openDashboard', { sessionId: state?.sessionId }));

function targetSessionId() {
  return state?.sessionId || state?.lastRun?.sessionId;
}
$('btnCopyAi').addEventListener('click', async () => {
  try {
    const { content } = await exportSession(targetSessionId(), 'ai', { secrets: 'placeholder' });
    await navigator.clipboard.writeText(content);
    flash('AI context copied — secrets are replaced by env placeholders. Use the dashboard to include real values.');
  } catch (e) {
    flash(e.message, true);
  }
});
$('btnPack').addEventListener('click', async () => {
  try {
    download(await exportSession(targetSessionId(), 'pack', { secrets: 'placeholder' }));
  } catch (e) {
    flash(e.message, true);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state') render(msg.state);
  if (msg.type === 'replay:done') send('getState').then(render);
});

send('getState').then(render).catch((e) => flash(e.message, true));
