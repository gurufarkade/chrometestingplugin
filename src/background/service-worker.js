// QA Scenario Recorder — background service worker.
// Owns the recording state machine, persists everything to IndexedDB, takes
// screenshots, watches navigations/document requests and drives replays.

import * as db from '../shared/db.js';
import { STATUS, getSettings, splitLines } from '../shared/settings.js';
import { diffApiCalls, matchesAnyPattern, sameRoute } from '../shared/analysis.js';

const CONTENT_FILES = [
  'src/content/selectors.js',
  'src/content/overlay.js',
  'src/content/replayer.js',
  'src/content/recorder.js',
];
const MAIN_WORLD_FILES = ['src/content/page-hook.js'];
const SKIP_ON_REPLAY = new Set(['note']);
const MAX_RUNS_KEPT = 20;

const EMPTY_STATE = {
  status: STATUS.IDLE,
  sessionId: null,
  tabId: null,
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  assertMode: false,
  counts: { steps: 0, network: 0, console: 0, errors: 0, screenshots: 0 },
  replay: null, // { sessionId, runId, tabId, index, total }
};

let state = null;
let settingsCache = null;
let lastSeq = 0;
let replayCancelled = false;
const cidToEventId = new Map();

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const nextSeq = () => (lastSeq = Math.max(Date.now() * 1000, lastSeq + 1));
const isActive = () => state && (state.status === STATUS.RECORDING || state.status === STATUS.PAUSED);

async function loadState() {
  if (state) return state;
  const { recState } = await chrome.storage.session.get('recState');
  state = recState ? { ...structuredClone(EMPTY_STATE), ...recState } : structuredClone(EMPTY_STATE);
  return state;
}

async function settings() {
  if (!settingsCache) settingsCache = await getSettings();
  return settingsCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settingsCache = null;
    pushStateToTab();
  }
});

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 300);
}
async function saveState() {
  clearTimeout(saveTimer);
  await chrome.storage.session.set({ recState: state });
  updateBadge();
  broadcast({ type: 'state', state: publicState() });
}

function publicState() {
  const now = Date.now();
  let elapsedMs = 0;
  if (state.startedAt) {
    const pausedNow = state.status === STATUS.PAUSED ? now - state.pausedAt : 0;
    elapsedMs = (state.endedAt || now) - state.startedAt - state.pausedTotal - pausedNow;
  }
  return { ...state, elapsedMs };
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup/dashboard may be closed
}

async function sendToTab(tabId, msg, timeoutMs = 0) {
  const p = chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  if (!timeoutMs) return p;
  return Promise.race([p, sleep(timeoutMs).then(() => Promise.reject(new Error(`Timed out after ${timeoutMs}ms`)))]);
}

function updateBadge() {
  const map = {
    [STATUS.RECORDING]: ['REC', '#d93025'],
    [STATUS.PAUSED]: ['II', '#f29900'],
    [STATUS.REPLAYING]: ['▶', '#1a73e8'],
  };
  const [text, color] = map[state.status] || ['', '#000'];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function contentConfigFor(tabId) {
  let mode = 'off';
  if (state.tabId === tabId) {
    if (state.status === STATUS.RECORDING) mode = 'record';
    else if (state.status === STATUS.PAUSED) mode = 'paused';
  }
  if (state.status === STATUS.REPLAYING && state.replay?.tabId === tabId) mode = 'replay';
  const s = settingsCache || {};
  return {
    mode,
    assertMode: state.assertMode && mode === 'record',
    counts: state.counts,
    replay: mode === 'replay' ? state.replay : null,
    settings: {
      captureResponseBodies: s.captureResponseBodies ?? true,
      maxBodyBytes: s.maxBodyBytes ?? 100000,
      captureConsole: s.captureConsole ?? true,
      showOverlay: s.showOverlay ?? true,
      maskPasswordsAtCapture: s.maskPasswordsAtCapture ?? false,
    },
  };
}

async function pushStateToTab() {
  await settings();
  const tabs = new Set([state?.tabId, state?.replay?.tabId].filter(Boolean));
  for (const tabId of tabs) sendToTab(tabId, { type: 'config', config: contentConfigFor(tabId) }).catch(() => {});
}

async function ensureContentScripts(tabId) {
  try {
    const pong = await sendToTab(tabId, { type: 'ping' }, 800);
    if (pong?.ok) return true;
  } catch {
    /* not injected yet (tab opened before install) */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: MAIN_WORLD_FILES, world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  await sleep(100);
  return true;
}

function defaultSessionName(tab) {
  let host = 'page';
  try {
    host = new URL(tab.url).host;
  } catch {}
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${host} · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ------------------------------------------------------------------ events

async function addEvent(kind, payload, { runId = null, tabId } = {}) {
  const event = {
    ...payload,
    kind,
    sessionId: runId ? state.replay.sessionId : state.sessionId,
    runId,
    tabId: tabId ?? state.tabId,
    seq: nextSeq(),
    ts: payload.ts || Date.now(),
  };
  event.id = await db.addEvent(event);
  if (!runId) {
    if (kind === 'step') state.counts.steps++;
    if (kind === 'network') state.counts.network++;
    if (kind === 'console') {
      state.counts.console++;
      if (payload.level === 'error') state.counts.errors++;
    }
    scheduleSave();
  }
  return event;
}

async function addStep(step) {
  const s = await settings();
  if (s.maskPasswordsAtCapture && step.sensitive && step.value) {
    step.value = '********';
    step.masked = true;
  }
  return addEvent('step', step);
}

async function updateStep(cid, patch) {
  let id = cidToEventId.get(cid);
  if (!id) {
    const events = await db.getEvents(state.sessionId, { runId: null, kind: 'step' });
    id = events.find((e) => e.cid === cid)?.id;
  }
  if (!id) return null;
  const ev = await db.getEvent(id);
  if (!ev) return null;
  const s = await settings();
  Object.assign(ev, patch);
  if (s.maskPasswordsAtCapture && ev.sensitive && ev.value) {
    ev.value = '********';
    ev.masked = true;
  }
  await db.putEvent(ev);
  return ev;
}

async function handleContentEvent(msg, tabId) {
  await loadState();
  const replaying = state.status === STATUS.REPLAYING && state.replay?.tabId === tabId;
  const recordingHere = state.status === STATUS.RECORDING && state.tabId === tabId;
  if (!replaying && !recordingHere) return { ignored: true };
  const runId = replaying ? state.replay.runId : null;
  const s = await settings();

  if (msg.kind === 'network') {
    if (matchesAnyPattern(msg.entry.url, splitLines(s.ignoreUrlPatterns))) return { ignored: true };
    await addEvent('network', msg.entry, { runId, tabId });
    return { ok: true };
  }
  if (msg.kind === 'console') {
    await addEvent('console', msg.entry, { runId, tabId });
    return { ok: true };
  }
  if (msg.kind === 'step' && recordingHere) {
    // Serialise step writes so an 'update' (typing) never overtakes its 'add'.
    const job = stepQueue.then(() => processStep(msg, tabId));
    stepQueue = job.catch(() => null);
    return job;
  }
  return { ignored: true };
}

let stepQueue = Promise.resolve();

async function processStep(msg, tabId) {
  let ev;
  if (msg.op === 'update') ev = await updateStep(msg.cid, msg.step);
  if (!ev) {
    if (!msg.step.action) return { ignored: true }; // update for a step we no longer know
    ev = await addStep({ ...msg.step, cid: msg.cid });
    cidToEventId.set(msg.cid, ev.id);
  }
  if (msg.screenshot) queueScreenshot({ tabId, stepEventId: ev.id, reason: ev.action, delay: msg.screenshotDelay ?? 350 });
  if (ev.action === 'assert' && state.assertMode) {
    state.assertMode = false;
    await saveState();
    pushStateToTab();
  }
  return { ok: true, id: ev.id, counts: state.counts };
}

// ------------------------------------------------------------------ screenshots

let shotChain = Promise.resolve();
let lastShotAt = 0;

function queueScreenshot(opts) {
  const job = async () => {
    if (opts.delay) await sleep(opts.delay);
    return captureNow(opts);
  };
  const p = shotChain.then(job, job);
  shotChain = p.catch(() => null);
  return p.catch((e) => {
    console.warn('[QA Recorder] screenshot failed', e?.message || e);
    return null;
  });
}

async function captureNow({ tabId, stepEventId = null, reason = 'step', runId = null }) {
  const s = await settings();
  if (!s.captureScreenshots) return null;
  const sessionId = runId ? state.replay?.sessionId : state.sessionId;
  if (!sessionId) return null;
  const wait = 600 - (Date.now() - lastShotAt); // Chrome allows ~2 captures/sec
  if (wait > 0) await sleep(wait);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active) return null;
  await sendToTab(tabId, { type: 'overlay:visibility', visible: false }, 400).catch(() => {});
  await sleep(40);
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: s.screenshotQuality });
  } finally {
    lastShotAt = Date.now();
    sendToTab(tabId, { type: 'overlay:visibility', visible: true }).catch(() => {});
  }
  const shot = {
    id: uid('shot'),
    sessionId,
    runId,
    stepEventId,
    reason,
    ts: Date.now(),
    url: tab.url,
    title: tab.title,
    width: tab.width,
    height: tab.height,
    dataUrl,
  };
  await db.putScreenshot(shot);
  if (!runId) {
    state.counts.screenshots++;
    scheduleSave();
  }
  return shot.id;
}

// ------------------------------------------------------------------ recording controls

async function startRecording({ tabId, name }) {
  await loadState();
  if (isActive() || state.status === STATUS.REPLAYING) throw new Error('A recording or replay is already in progress.');
  const tab = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/.test(tab.url || '')) {
    throw new Error('This page cannot be recorded (browser/internal pages are restricted). Open the application under test first.');
  }
  await settings();
  await ensureContentScripts(tabId);
  const env = await sendToTab(tabId, { type: 'env' }, 1500).catch(() => ({}));
  const session = {
    id: uid('sess'),
    name: name?.trim() || defaultSessionName(tab),
    createdAt: Date.now(),
    startUrl: tab.url,
    title: tab.title,
    status: 'recording',
    environment: { ...(env || {}), extensionVersion: chrome.runtime.getManifest().version },
    runs: [],
  };
  await db.putSession(session);
  state = { ...structuredClone(EMPTY_STATE), status: STATUS.RECORDING, sessionId: session.id, tabId, startedAt: Date.now() };
  cidToEventId.clear();
  const first = await addStep({ action: 'goto', url: tab.url, title: tab.title, ts: Date.now() });
  await saveState();
  await pushStateToTab();
  queueScreenshot({ tabId, stepEventId: first.id, reason: 'start', delay: 100 });
  return publicState();
}

async function pauseRecording() {
  await loadState();
  if (state.status !== STATUS.RECORDING) return publicState();
  state.status = STATUS.PAUSED;
  state.pausedAt = Date.now();
  state.assertMode = false;
  await saveState();
  await pushStateToTab();
  return publicState();
}

async function resumeRecording() {
  await loadState();
  if (state.status !== STATUS.PAUSED) return publicState();
  state.pausedTotal += Date.now() - state.pausedAt;
  state.pausedAt = 0;
  state.status = STATUS.RECORDING;
  await saveState();
  await pushStateToTab();
  return publicState();
}

async function stopRecording() {
  await loadState();
  if (!isActive()) return publicState();
  if (state.status === STATUS.PAUSED) await resumeRecording();
  const tabId = state.tabId;
  state.endedAt = Date.now();
  const session = await db.getSession(state.sessionId);
  if (session) {
    session.status = 'completed';
    session.endedAt = state.endedAt;
    session.durationMs = publicState().elapsedMs;
    session.summary = { ...state.counts };
    await db.putSession(session);
  }
  state.status = STATUS.STOPPED;
  state.assertMode = false;
  await saveState();
  sendToTab(tabId, { type: 'config', config: contentConfigFor(-1) }).catch(() => {});
  return publicState();
}

async function resetCapture() {
  await loadState();
  if (state.status === STATUS.REPLAYING) throw new Error('Stop the replay first.');
  const { sessionId, tabId } = state;
  if (sessionId) await db.deleteSession(sessionId);
  state = structuredClone(EMPTY_STATE);
  cidToEventId.clear();
  await saveState();
  if (tabId) sendToTab(tabId, { type: 'config', config: contentConfigFor(-1) }).catch(() => {});
  return publicState();
}

async function setAssertMode(on) {
  await loadState();
  if (state.status !== STATUS.RECORDING) throw new Error('Assertions can only be added while recording.');
  state.assertMode = on ?? !state.assertMode;
  await saveState();
  await pushStateToTab();
  return publicState();
}

async function addNote({ text, flag = 'info' }) {
  await loadState();
  if (!isActive()) throw new Error('Start a recording to add notes.');
  const ev = await addStep({ action: 'note', value: text, flag, ts: Date.now() });
  if (flag === 'bug') queueScreenshot({ tabId: state.tabId, stepEventId: ev.id, reason: 'bug' });
  await saveState();
  return publicState();
}

async function manualScreenshot() {
  await loadState();
  if (!isActive()) throw new Error('Start a recording to capture evidence.');
  const ev = await addStep({ action: 'screenshot', value: 'Manual evidence screenshot', ts: Date.now() });
  await queueScreenshot({ tabId: state.tabId, stepEventId: ev.id, reason: 'manual' });
  await saveState();
  return publicState();
}

// ------------------------------------------------------------------ navigation + document requests

const TYPED_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page']);

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await loadState();
  const replaying = state.status === STATUS.REPLAYING && state.replay?.tabId === d.tabId;
  const recording = state.status === STATUS.RECORDING && state.tabId === d.tabId;
  if (!replaying && !recording) return;
  const runId = replaying ? state.replay.runId : null;
  const history = (d.transitionQualifiers || []).includes('forward_back');
  if (recording) {
    if (history) await addStep({ action: 'goto', url: d.url, via: 'history', ts: d.timeStamp });
    else if (d.transitionType === 'reload') await addStep({ action: 'reload', url: d.url, ts: d.timeStamp });
    else if (TYPED_TRANSITIONS.has(d.transitionType)) await addStep({ action: 'goto', url: d.url, via: 'address-bar', ts: d.timeStamp });
  }
  await addEvent('navigation', { url: d.url, transitionType: d.transitionType, spa: false, ts: d.timeStamp }, { runId, tabId: d.tabId });
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await loadState();
  const replaying = state.status === STATUS.REPLAYING && state.replay?.tabId === d.tabId;
  const recording = state.status === STATUS.RECORDING && state.tabId === d.tabId;
  if (!replaying && !recording) return;
  await addEvent('navigation', { url: d.url, transitionType: d.transitionType, spa: true, ts: d.timeStamp }, {
    runId: replaying ? state.replay.runId : null,
    tabId: d.tabId,
  });
});

chrome.webNavigation.onCompleted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await loadState();
  if (state.status === STATUS.RECORDING && state.tabId === d.tabId) {
    queueScreenshot({ tabId: d.tabId, reason: 'page-load', delay: 300 });
  }
});

const pendingDocs = new Map();
const DOC_FILTER = { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] };

function decodeRequestBody(body) {
  if (!body) return null;
  if (body.formData) return new URLSearchParams(Object.entries(body.formData).flatMap(([k, vs]) => vs.map((v) => [k, v]))).toString();
  if (body.raw?.length) {
    try {
      return body.raw.map((r) => (r.bytes ? new TextDecoder().decode(r.bytes) : `[file ${r.file || ''}]`)).join('');
    } catch {
      return '[binary]';
    }
  }
  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    pendingDocs.set(d.requestId, {
      api: 'document',
      method: d.method,
      url: d.url,
      resourceType: d.type,
      requestBody: decodeRequestBody(d.requestBody),
      startTime: d.timeStamp,
    });
  },
  DOC_FILTER,
  ['requestBody'],
);

async function finishDoc(d, error) {
  const entry = pendingDocs.get(d.requestId);
  pendingDocs.delete(d.requestId);
  if (!entry) return;
  await loadState();
  const replaying = state.status === STATUS.REPLAYING && state.replay?.tabId === d.tabId;
  const recording = state.status === STATUS.RECORDING && state.tabId === d.tabId;
  if (!replaying && !recording) return;
  const s = await settings();
  if (matchesAnyPattern(entry.url, splitLines(s.ignoreUrlPatterns))) return;
  const headers = {};
  for (const h of d.responseHeaders || []) headers[h.name] = h.value;
  Object.assign(entry, {
    id: uid('doc'),
    status: d.statusCode || 0,
    statusText: d.statusLine || '',
    responseHeaders: headers,
    mimeType: headers['content-type'] || headers['Content-Type'] || '',
    endTime: d.timeStamp,
    duration: Math.round(d.timeStamp - entry.startTime),
    error: error || null,
    ts: entry.startTime,
  });
  await addEvent('network', entry, { runId: replaying ? state.replay.runId : null, tabId: d.tabId });
}

chrome.webRequest.onCompleted.addListener((d) => finishDoc(d), DOC_FILTER, ['responseHeaders']);
chrome.webRequest.onErrorOccurred.addListener((d) => finishDoc(d, d.error), DOC_FILTER);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadState();
  if (isActive() && state.tabId === tabId) await stopRecording();
  if (state.status === STATUS.REPLAYING && state.replay?.tabId === tabId) replayCancelled = true;
});

// ------------------------------------------------------------------ replay

async function waitForTabComplete(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Tab was closed');
    if (tab.status === 'complete') return tab;
    await sleep(100);
  }
  throw new Error(`Page did not finish loading within ${timeoutMs}ms`);
}

async function waitForContent(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let injected = false;
  while (Date.now() < end) {
    try {
      const pong = await sendToTab(tabId, { type: 'ping' }, 600);
      if (pong?.ok) return true;
    } catch {}
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!injected && tab?.status === 'complete') {
      injected = true;
      await ensureContentScripts(tabId).catch(() => {});
    }
    await sleep(200);
  }
  throw new Error('Page script did not become ready (is this page restricted?)');
}

/** For each step index, the last URL the recording navigated to before the next step. */
function expectedUrlsAfterSteps(steps, navs) {
  return steps.map((step, i) => {
    const from = step.ts;
    const to = steps[i + 1]?.ts ?? Infinity;
    const inWindow = navs.filter((n) => n.ts >= from && n.ts < to);
    return inWindow.length ? inWindow[inWindow.length - 1].url : null;
  });
}

async function executeStep(step, tabId, s) {
  if (step.action === 'goto') {
    await chrome.tabs.update(tabId, { url: step.url });
    await sleep(150);
    await waitForTabComplete(tabId, s.replayTimeoutMs * 2);
    await waitForContent(tabId, s.replayTimeoutMs);
    return { ok: true };
  }
  if (step.action === 'reload') {
    await chrome.tabs.reload(tabId);
    await sleep(150);
    await waitForTabComplete(tabId, s.replayTimeoutMs * 2);
    await waitForContent(tabId, s.replayTimeoutMs);
    return { ok: true };
  }
  if (step.action === 'upload') {
    return { ok: true, skipped: true, warning: 'File uploads cannot be replayed by an extension; automate with setInputFiles().' };
  }
  if (step.action === 'screenshot') return { ok: true };

  await waitForContent(tabId, s.replayTimeoutMs);
  let res;
  try {
    res = await sendToTab(
      tabId,
      { type: 'replay:exec', step, options: { timeoutMs: s.replayTimeoutMs, highlight: s.replayHighlight } },
      s.replayTimeoutMs + 3000,
    );
  } catch (e) {
    // The action may have triggered a navigation that tore down the message port.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && (tab.status === 'loading' || /port closed|receiving end/i.test(e.message))) res = { ok: true, warning: 'Page navigated during action' };
    else throw e;
  }
  return res || { ok: false, error: 'No response from page' };
}

async function startReplay({ sessionId, tabId }) {
  await loadState();
  if (isActive()) await stopRecording();
  if (state.status === STATUS.REPLAYING) throw new Error('A replay is already running.');
  sessionId = sessionId || state.sessionId;
  if (!sessionId) throw new Error('Nothing to replay yet — record a scenario first.');
  const session = await db.getSession(sessionId);
  if (!session) throw new Error('Session not found.');
  const s = await settings();
  const allSteps = await db.getEvents(sessionId, { runId: null, kind: 'step' });
  const navs = await db.getEvents(sessionId, { runId: null, kind: 'navigation' });
  const steps = allSteps.filter((st) => !SKIP_ON_REPLAY.has(st.action) && !st.skip);
  const expectedUrls = expectedUrlsAfterSteps(steps, navs);

  const run = { id: uid('run'), startedAt: Date.now(), tabId, status: 'running', results: [], total: steps.length };
  session.runs = [...(session.runs || []), run].slice(-MAX_RUNS_KEPT);
  await db.putSession(session);

  replayCancelled = false;
  const prev = { sessionId: state.sessionId, tabId: state.tabId, counts: state.counts, startedAt: state.startedAt, endedAt: state.endedAt };
  state = { ...state, status: STATUS.REPLAYING, replay: { sessionId, runId: run.id, tabId, index: 0, total: steps.length } };
  await saveState();
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});

  // Run asynchronously; the popup/dashboard listen for progress broadcasts.
  (async () => {
    let failed = false;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (replayCancelled) {
        run.results.push({ stepId: step.id, index: i, action: step.action, status: 'not-run' });
        continue;
      }
      if (failed && !s.replayContinueOnFailure) {
        run.results.push({ stepId: step.id, index: i, action: step.action, status: 'not-run' });
        continue;
      }
      state.replay.index = i;
      scheduleSave();
      await pushStateToTab();
      const t0 = Date.now();
      const result = { stepId: step.id, index: i, action: step.action, status: 'passed' };
      try {
        const res = await executeStep(step, tabId, s);
        if (!res.ok) throw new Error(res.error || 'Step failed');
        if (res.skipped) result.status = 'skipped';
        if (res.warning) result.warning = res.warning;
        if (res.usedSelector) result.usedSelector = res.usedSelector;
        if (res.actual !== undefined) result.actual = res.actual;

        await sleep(150);
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'loading') {
          await waitForTabComplete(tabId, s.replayTimeoutMs * 2);
          await waitForContent(tabId, s.replayTimeoutMs);
        }
        const expected = expectedUrls[i];
        if (expected && step.action !== 'goto' && step.action !== 'reload') {
          const end = Date.now() + Math.min(s.replayTimeoutMs, 8000);
          let current = (await chrome.tabs.get(tabId)).url;
          while (!sameRoute(current, expected) && Date.now() < end) {
            await sleep(200);
            current = (await chrome.tabs.get(tabId)).url;
          }
          result.urlCheck = { expected, actual: current, match: sameRoute(current, expected) };
          if (!result.urlCheck.match) result.warning = `Expected to land on ${expected} but was ${current}`;
        }
        if (s.replayWaitForNetworkIdle) await sendToTab(tabId, { type: 'replay:waitIdle', timeoutMs: 5000 }, 6000).catch(() => {});
      } catch (e) {
        result.status = 'failed';
        result.error = e.message || String(e);
        failed = true;
      }
      result.durationMs = Date.now() - t0;
      result.screenshotId = await queueScreenshot({ tabId, stepEventId: step.id, reason: `replay-${result.status}`, runId: run.id });
      run.results.push(result);
      await persistRun(sessionId, run);
      broadcast({ type: 'replay:progress', sessionId, run });
      if (s.replayStepDelayMs) await sleep(s.replayStepDelayMs);
    }

    run.endedAt = Date.now();
    run.status = replayCancelled ? 'cancelled' : run.results.some((r) => r.status === 'failed') ? 'failed' : 'passed';
    const recordedNet = await db.getEvents(sessionId, { runId: null, kind: 'network' });
    const replayNet = await db.getEvents(sessionId, { runId: run.id, kind: 'network' });
    const replayConsole = await db.getEvents(sessionId, { runId: run.id, kind: 'console' });
    run.apiDiff = diffApiCalls(recordedNet, replayNet);
    run.consoleErrors = replayConsole.filter((c) => c.level === 'error').length;
    await persistRun(sessionId, run);

    state = {
      ...structuredClone(EMPTY_STATE),
      ...prev,
      status: prev.sessionId ? STATUS.STOPPED : STATUS.IDLE,
      replay: null,
      lastRun: { sessionId, runId: run.id, status: run.status },
    };
    await saveState();
    sendToTab(tabId, { type: 'config', config: contentConfigFor(-1) }).catch(() => {});
    sendToTab(tabId, { type: 'replay:done', status: run.status }).catch(() => {});
    broadcast({ type: 'replay:done', sessionId, run });
  })();

  return publicState();
}

async function persistRun(sessionId, run) {
  const session = await db.getSession(sessionId);
  if (!session) return;
  session.runs = (session.runs || []).map((r) => (r.id === run.id ? structuredClone(run) : r));
  await db.putSession(session);
}

// ------------------------------------------------------------------ messaging

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab.id;
}

const handlers = {
  async getState() {
    await loadState();
    return publicState();
  },
  async start(msg) {
    return startRecording({ tabId: msg.tabId ?? (await activeTabId()), name: msg.name });
  },
  pause: pauseRecording,
  resume: resumeRecording,
  stop: stopRecording,
  reset: resetCapture,
  assertMode: (msg) => setAssertMode(msg.on),
  note: (msg) => addNote(msg),
  screenshot: manualScreenshot,
  async assertUrl() {
    await loadState();
    if (state.status !== STATUS.RECORDING) throw new Error('Assertions can only be added while recording.');
    const tab = await chrome.tabs.get(state.tabId);
    await addStep({ action: 'assert', assert: { type: 'url', expected: tab.url }, url: tab.url, title: tab.title, ts: Date.now() });
    await saveState();
    return publicState();
  },
  async replay(msg) {
    return startReplay({ sessionId: msg.sessionId, tabId: msg.tabId ?? (await activeTabId()) });
  },
  async stopReplay() {
    replayCancelled = true;
    return publicState();
  },
  async openDashboard(msg) {
    const url = chrome.runtime.getURL(`src/dashboard/dashboard.html${msg.sessionId ? `#${msg.sessionId}` : ''}`);
    await chrome.tabs.create({ url });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Messages from content scripts
    if (sender.tab && msg.type === 'content:ready') {
      await loadState();
      await settings();
      return contentConfigFor(sender.tab.id);
    }
    if (sender.tab && msg.type === 'content:event') return handleContentEvent(msg, sender.tab.id);
    if (sender.tab && msg.type === 'content:control') {
      // Buttons on the in-page overlay
      const fn = handlers[msg.action];
      return fn ? fn(msg) : { error: 'unknown action' };
    }
    // Messages from popup / dashboard
    const fn = handlers[msg.type];
    if (!fn) return undefined;
    return fn(msg);
  })()
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ error: e.message || String(e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  await loadState();
  try {
    if (command === 'toggle-recording') {
      if (isActive()) await stopRecording();
      else await startRecording({ tabId: await activeTabId() });
    } else if (command === 'toggle-pause') {
      if (state.status === STATUS.RECORDING) await pauseRecording();
      else if (state.status === STATUS.PAUSED) await resumeRecording();
    } else if (command === 'assert-mode') {
      await setAssertMode();
    } else if (command === 'manual-screenshot') {
      await manualScreenshot();
    }
  } catch (e) {
    console.warn('[QA Recorder]', e.message);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  updateBadge();
});
