// Browser-side glue: load a session from IndexedDB and run the pure exporters.
import * as db from './db.js';
import { getSettings, splitLines } from './settings.js';
import {
  buildScenario,
  buildEvidencePack,
  toAiContext,
  toPlaywright,
  toCypress,
  toPostman,
  toHar,
  toTestCaseMarkdown,
  toBackup,
  envExample,
  slugify,
} from './exporters.js';

export const FORMATS = {
  ai: { label: 'AI context (Markdown)', ext: 'ai-context.md', mime: 'text/markdown' },
  playwright: { label: 'Playwright spec (TypeScript)', ext: 'spec.ts', mime: 'text/plain' },
  cypress: { label: 'Cypress spec (JavaScript)', ext: 'cy.js', mime: 'text/plain' },
  postman: { label: 'Postman collection', ext: 'postman_collection.json', mime: 'application/json' },
  har: { label: 'HAR (HTTP archive)', ext: 'har', mime: 'application/json' },
  testcase: { label: 'Manual test case / bug report (Markdown)', ext: 'test-case.md', mime: 'text/markdown' },
  scenario: { label: 'Scenario JSON', ext: 'scenario.json', mime: 'application/json' },
  env: { label: '.env.example', ext: 'env.example', mime: 'text/plain' },
  backup: { label: 'Session backup (re-importable JSON)', ext: 'session.json', mime: 'application/json' },
  pack: { label: 'Evidence pack (.zip — everything + screenshots)', ext: 'evidence.zip', mime: 'application/zip' },
};

export async function loadScenario(sessionId, { secrets = 'placeholder', data = 'recommended' } = {}) {
  const session = await db.getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const [events, screenshots, settings] = await Promise.all([db.getEvents(sessionId), db.getScreenshots(sessionId), getSettings()]);
  const scenario = buildScenario(session, events, {
    secrets,
    data,
    sensitiveHeaders: splitLines(settings.sensitiveHeaders),
    screenshots: screenshots.map(({ id, stepEventId, reason, runId }) => ({ id, stepEventId, reason, runId })),
  });
  return { session, events, screenshots, scenario };
}

/** @returns {{ filename: string, mime: string, content: string|Uint8Array }} */
export async function exportSession(sessionId, format, opts = {}) {
  const { session, events, screenshots, scenario } = await loadScenario(sessionId, opts);
  const f = FORMATS[format];
  if (!f) throw new Error(`Unknown format ${format}`);
  const base = slugify(session.name);
  let content;
  switch (format) {
    case 'ai':
      content = toAiContext(scenario);
      break;
    case 'playwright':
      content = toPlaywright(scenario);
      break;
    case 'cypress':
      content = toCypress(scenario);
      break;
    case 'postman':
      content = JSON.stringify(toPostman(scenario), null, 2);
      break;
    case 'har':
      content = JSON.stringify(toHar(scenario, chrome.runtime.getManifest().version), null, 2);
      break;
    case 'testcase':
      content = toTestCaseMarkdown(scenario);
      break;
    case 'scenario':
      content = JSON.stringify(scenario, null, 2);
      break;
    case 'env':
      content = envExample(scenario);
      break;
    case 'backup':
      content = JSON.stringify(toBackup(session, events, opts.includeScreenshots ? screenshots : undefined, { includeSecrets: opts.secrets === 'include' }), null, 2);
      break;
    case 'pack':
      content = buildEvidencePack(scenario, screenshots.filter((s) => !s.runId), { session, events });
      break;
    default:
      throw new Error(`Unknown format ${format}`);
  }
  return { filename: `${base}.${f.ext}`, mime: f.mime, content, scenario };
}

export function download({ filename, mime, content }) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
