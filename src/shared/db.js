// Tiny promise wrapper around IndexedDB. Shared by the service worker and the
// dashboard (both run on the extension origin, so they see the same database).
//
// Stores:
//   sessions    { id, name, createdAt, updatedAt, startUrl, title, status, environment, runs[] }
//   events      { id(auto), sessionId, runId|null, seq, ts, kind: step|network|console|navigation, ... }
//   screenshots { id, sessionId, runId|null, ts, dataUrl, stepId? }

const DB_NAME = 'qa-scenario-recorder';
const DB_VERSION = 2; // v2: projects store

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('events')) {
        const e = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        e.createIndex('sessionId', 'sessionId');
      }
      if (!db.objectStoreNames.contains('screenshots')) {
        const sc = db.createObjectStore('screenshots', { keyPath: 'id' });
        sc.createIndex('sessionId', 'sessionId');
      }
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

// ---------- sessions ----------
export async function putSession(session) {
  session.updatedAt = Date.now();
  return reqToPromise((await store('sessions', 'readwrite')).put(session));
}

export async function getSession(id) {
  return reqToPromise((await store('sessions')).get(id));
}

export async function listSessions() {
  const all = await reqToPromise((await store('sessions')).getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSession(id) {
  await clearSessionData(id);
  return reqToPromise((await store('sessions', 'readwrite')).delete(id));
}

/** Delete events + screenshots for a session (optionally only for one replay run). */
export async function clearSessionData(sessionId, { runId } = {}) {
  const db = await openDb();
  for (const name of ['events', 'screenshots']) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      const idx = tx.objectStore(name).index('sessionId');
      const cursorReq = idx.openCursor(IDBKeyRange.only(sessionId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        if (runId === undefined || cursor.value.runId === runId) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}

// ---------- events ----------
export async function addEvent(event) {
  return reqToPromise((await store('events', 'readwrite')).add(event));
}

export async function putEvent(event) {
  return reqToPromise((await store('events', 'readwrite')).put(event));
}

export async function getEvent(id) {
  return reqToPromise((await store('events')).get(id));
}

export async function deleteEvent(id) {
  return reqToPromise((await store('events', 'readwrite')).delete(id));
}

/** All events of a session, ordered by seq. `runId: null` => only the original recording. */
export async function getEvents(sessionId, { runId, kind } = {}) {
  const idx = (await store('events')).index('sessionId');
  let all = await reqToPromise(idx.getAll(IDBKeyRange.only(sessionId)));
  if (runId !== undefined) all = all.filter((e) => (e.runId ?? null) === runId);
  if (kind) all = all.filter((e) => e.kind === kind);
  return all.sort((a, b) => a.seq - b.seq || a.ts - b.ts);
}

// ---------- projects ----------
export async function putProject(project) {
  return reqToPromise((await store('projects', 'readwrite')).put(project));
}
export async function getProject(id) {
  return reqToPromise((await store('projects')).get(id));
}
export async function listProjects() {
  const all = await reqToPromise((await store('projects')).getAll());
  return all.sort((a, b) => a.name.localeCompare(b.name));
}
export async function deleteProject(id) {
  return reqToPromise((await store('projects', 'readwrite')).delete(id));
}

// ---------- screenshots ----------
export async function putScreenshot(shot) {
  return reqToPromise((await store('screenshots', 'readwrite')).put(shot));
}

export async function getScreenshot(id) {
  return reqToPromise((await store('screenshots')).get(id));
}

export async function getScreenshots(sessionId) {
  const idx = (await store('screenshots')).index('sessionId');
  const all = await reqToPromise(idx.getAll(IDBKeyRange.only(sessionId)));
  return all.sort((a, b) => a.ts - b.ts);
}
