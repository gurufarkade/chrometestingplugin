# QA Scenario Recorder (Chrome extension)

Record a manual test once, and get everything needed to **re-run it, prove it, and automate it**:
every UI action with smart locators, every API call with request/response bodies, a screenshot
after each step, console errors, and one-click exports for **AI assistants, Playwright, Cypress,
Postman and HAR**.

Works on any website or web app — no SDK, no app changes. Manifest V3, plain JavaScript, no build step.

---

## Install (1 minute)

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
3. Pin **QA Scenario Recorder** from the puzzle-piece menu.

> Tabs that were already open before installing are picked up automatically when you press Start.

### Try it on the bundled demo app

```powershell
node demo/server.js
```

Open <http://localhost:4321>, sign in with `qa@example.com` / `Passw0rd!`, filter products, add
to cart, tick *Express delivery*, press *Apply coupon* (a deliberate 500 error), place the order
and open it. That one scenario exercises forms, a dropdown, a checkbox, a modal dialog, SPA
routing, authenticated APIs and a failing API.

---

## Using it

| Button / shortcut | What it does |
|---|---|
| **Start** · `Alt+Shift+R` | Starts recording the current tab (optionally name the scenario first) |
| **Pause / Resume** · `Alt+Shift+P` | Nothing is captured while paused (UI or API) |
| **Stop** · `Alt+Shift+R` | Saves the scenario |
| **Rerun** | Replays the scenario in the current tab and reports pass/fail per step plus an API diff |
| **Reset** | Discards the current capture |
| **✓ Assert element** · `Alt+Shift+A` | Next click on the page records an assertion (text / value / checked; **Shift**-click = visible only; **Esc** cancels) |
| **✓ Assert URL** | Asserts the current URL |
| **📷 Evidence** · `Alt+Shift+S` | Extra screenshot as a checkpoint step |
| **Note / Bug** | Tester note pinned to the timeline; *Bug* notes go to bug reports with a screenshot |

A small toolbar on the page (drag it anywhere) shows the live step/API count and has the same
controls. It is hidden automatically while screenshots are taken.

### Dashboard

**Open dashboard** from the popup to review a scenario:

- **Steps**: readable description, ranked locator, page context (form / dialog / table row), the API
  calls each step triggered, and the screenshot with the clicked element highlighted.
  Edit values, change assertion types, add notes, skip steps for replay, or delete them.
- **Network**: every fetch/XHR (plus page loads and form posts), with filters, headers,
  pretty-printed bodies and **Copy as cURL**.
- **Console**: errors, warnings, uncaught exceptions and unhandled rejections.
- **Screenshots**: gallery of recording and replay screenshots.
- **Replays**: per-step results (with screenshots), the locator that matched, URL checks, and an
  **API diff** against the recording: status changes, missing calls, new calls, and calls more than 2× slower.
- **Export**: see below. **Import** (sidebar) restores a scenario a teammate shared.

---

## Exports

| Format | Use it for |
|---|---|
| **AI context (Markdown)** | Paste into ChatGPT / Claude / Copilot. It contains instructions for the AI, the environment, credentials, test data, every step with ranked locators and DOM context, the API calls per step with sample bodies, an API inventory, console errors, tester notes, the last replay result, and the full scenario as JSON. |
| **Playwright spec (TS)** | Runnable `test.step`s using `getByTestId` / `getByRole` / `getByLabel`, `waitForResponse` + status assertions for key APIs, `toHaveURL` after navigations, the viewport, and env-based credentials. |
| **Cypress spec** | `cy.intercept` aliases + `cy.wait('@alias')` status checks, `cy.get`/`cy.contains` locators, `{ log: false }` for secrets. |
| **Postman collection** | API calls grouped by the step that triggered them, with `{{baseUrl}}`, auth headers turned into variables, and status/latency tests. |
| **HAR** | Open in Chrome DevTools or any HAR viewer, or attach it to a bug. |
| **Manual test case / bug report** | Steps, expected results, evidence links, and observed issues (bug notes, failing APIs, console errors). |
| **Evidence pack (.zip)** | All of the above plus `screenshots/`, `.env.example` and a re-importable backup. |

**Credentials.** Password, OTP and secret fields are detected automatically, and the username is
paired with its password. You choose per export:

- *Env placeholders* (default) — `<TEST_PASSWORD>`, read from `process.env` / `Cypress.env`
- *Include real values* — for a private AI or local use
- *Mask*

Passwords are also scrubbed from captured request bodies, and `Authorization`/`Cookie`/API-key
headers are masked unless you choose to include them.

---

## How it works

```
page (MAIN world)          content script (isolated)          service worker                    extension pages
─────────────────          ─────────────────────────          ──────────────                    ───────────────
page-hook.js               recorder.js  ── steps ──────────▶  state machine (record/pause/      popup  (controls)
 wraps fetch / XHR ──────▶  selectors.js (smart locators)      stop/replay), IndexedDB,          dashboard (review,
 console / errors           overlay.js  (toolbar, highlight)   screenshots (captureVisibleTab),   edit, replay, export)
                            replayer.js ◀── replay:exec ─────  webNavigation + webRequest,
                                                               replay driver + API diff
```

- **Smart locators.** For each element the recorder ranks candidates the way an SDET would:
  `data-testid`/`data-cy`/`data-qa` → stable `id` (framework-generated ids such as `:r1:`,
  `ember123` or `mui-…` are rejected) → ARIA role + accessible name → label → placeholder →
  `name` → `aria-label` → text → minimal CSS path (hashed CSS-in-JS classes are ignored) → XPath.
  Each candidate is checked for uniqueness at capture time. Clicks on icons inside buttons are
  attributed to the button.
- **Semantic steps, not raw events.** Typing merges into one `fill` per field. Checkbox and radio
  changes become `check`/`uncheck` (including clicks on their labels). Native selects become
  `select`. Clicks that only focus a text field are dropped. Double-clicks, right-clicks, Enter,
  Escape and shortcut keys are kept. Typed URLs, reloads and back/forward are recorded as navigation steps.
- **Context.** Each element carries its surrounding dialog, form, fieldset, table row and region,
  so descriptions read like *Click the "View order" button in the "Order confirmed" dialog*.
- **Replay.** Each step auto-waits for its element to be visible and enabled, trying locator
  candidates in order and picking the nearest match if a locator became ambiguous. Values are set
  through native setters, so React, Vue and Angular see the change. The replayer waits for network
  idle and for the expected URL after each step, and synthetic Enter submits the form like a real keypress.
- **Storage.** Everything stays local in IndexedDB. Nothing is sent anywhere.

## Development

```powershell
npm test          # unit tests: exporters, API diff, ZIP writer (Node 18+)
npm run check     # every file parses + every manifest/HTML/import reference resolves
npm run package   # dist/qa-scenario-recorder-<version>.zip for the Chrome Web Store
```

```
manifest.json
src/background/service-worker.js   state, storage, screenshots, navigation, replay driver
src/content/page-hook.js            MAIN-world fetch/XHR/console capture
src/content/selectors.js            element description + locator ranking/resolution
src/content/recorder.js             interaction → step translation, assert mode, messaging
src/content/replayer.js             step execution with auto-wait
src/content/overlay.js              in-page toolbar / highlighter (shadow DOM)
src/shared/exporters.js             scenario model + all export formats (pure, tested)
src/shared/analysis.js              URL normalisation, API diff, header masking
src/shared/zip.js                   dependency-free ZIP writer
src/popup/, src/dashboard/          UI
demo/                               sample app to practise on
tests/                              node:test suites
```

## Known limitations (and next steps)

- Records the **top frame of one tab**. Steps inside iframes and popup windows are not captured yet.
- Replay dispatches DOM events from the extension. A few apps reject untrusted events; a
  *"trusted input"* mode via the `chrome.debugger` API (CDP `Input.dispatch*`) is the natural next step.
  The same API would also capture service-worker and WebSocket traffic.
- File uploads are recorded (file names) but can't be replayed by an extension. The generated
  specs include a `setInputFiles` / `selectFile` TODO.
- Hover-only menus and drag-and-drop aren't recorded yet.
- Response bodies are kept for text/JSON responses up to the size limit set in Settings (default 100 KB each).
