# 2. Replay with DOM events, not the Chrome DevTools Protocol

Date: 2026-11-24 · Status: accepted (revisit if trusted input becomes necessary)

## Context

Replay could drive the page in two ways:

1. **DOM events** from the content script (`pointerdown/mousedown/…/click`, native value setters + `input`/`change`, synthetic `DragEvent`s).
2. **CDP via `chrome.debugger`** (`Input.dispatchMouseEvent`, `Input.insertText`, `DOM.setFileInputFiles`), which produces *trusted* input and can also upload files and capture WebSocket traffic.

CDP shows a permanent "… started debugging this browser" banner, needs the `debugger` permission (a scary install warning that many companies block), and conflicts with DevTools being open on the same tab — which is exactly where QA engineers live.

## Decision

Replay uses DOM events. Every action goes through the replayer in the content script, which resolves the Target with auto-wait and dispatches framework-friendly events.

## Consequences

- Works with React/Vue/Angular/plain forms and with DevTools open; no extra permission.
- Apps that check `event.isTrusted`, and file uploads, can't be replayed; the Run reports them clearly and the exported Playwright/Cypress code (which *does* use trusted input) remains the path to full automation.
- If CDP is added later it should be a second **adapter** behind the same replay seam (`executeStep(step) → result`), selectable in Settings, not a rewrite.
