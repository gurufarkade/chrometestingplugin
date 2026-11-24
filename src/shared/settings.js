// Shared settings + constants (ES module; used by background, popup and dashboard).

export const STATUS = Object.freeze({
  IDLE: 'idle',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  REPLAYING: 'replaying',
});

export const DEFAULT_SETTINGS = Object.freeze({
  // Capture
  captureScreenshots: true,
  screenshotQuality: 60, // JPEG 0-100
  captureResponseBodies: true,
  maxBodyBytes: 100_000,
  captureConsole: true,
  showOverlay: true,
  maskPasswordsAtCapture: false, // if true, replay of login steps needs env values
  ignoreUrlPatterns: [
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'hotjar.com',
    'segment.io',
    'sentry.io',
    'clarity.ms',
    'facebook.com/tr',
    'newrelic.com',
    'nr-data.net',
    'browser-intake-datadoghq',
    'hot-update.json',
    'sockjs-node',
    '__webpack_hmr',
  ].join('\n'),
  // Replay
  replayStepDelayMs: 400,
  replayTimeoutMs: 10_000,
  replayWaitForNetworkIdle: true,
  replayHighlight: true,
  replayContinueOnFailure: false,
  // Export
  sensitiveHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization'].join('\n'),
});

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
