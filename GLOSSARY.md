# Glossary

The language of QA Scenario Recorder. Use these words exactly in code, UI and docs.

**Scenario** — One recorded manual test: everything a tester did from Start to Stop on one tab, plus what the application did in response. _Avoid_: session (that word is only the storage record), recording, test.

**Step** — One meaningful thing the tester did: navigate, click, fill, select, check/uncheck, press a key, hover, drag, upload, assert, note, screenshot. A step is semantic ("fill Email with …"), never a raw browser event. _Avoid_: action, event.

**Interaction** — A raw browser event (click, input, change, keydown, mouseover, dragstart, drop…) observed by the recorder before it becomes a Step. Interactions are many; Steps are few.

**Target** — The element a Step acts on, described well enough to find it again: role, accessible name, label, text, attributes, context, field constraints and its Locator candidates.

**Locator** — An expression that finds a Target again (Playwright `getByRole(...)`, a CSS selector, …). A Target has several **Locator candidates**, ranked best-first; each knows whether it was **unique** when recorded.

**Scope** — The nearest container that makes an otherwise repeated Target unique: a table row, list item, card, dialog or form, identified by its text. "The *Add to cart* button **in the row containing** *Mechanical keyboard*".

**Frame** — The document a Target lives in. The top document has no Frame; an iframe is identified by its name and URL.

**Context** — Human-readable surroundings of a Target (dialog title, form name, row text, region). Used for descriptions, not for finding the element.

**Outcome** — Something the application showed in response to a Step without the tester asking: a toast, alert, validation message, opened dialog, or page-title change. Outcomes are captured automatically.

**Assertion** — An explicit check the tester added (or promoted from an Outcome): text, contains, value, checked, visible, hidden, URL. Assertions fail a Run; unconfirmed Outcomes only warn.

**API call** — One HTTP request/response the page made (fetch, XHR, or a document load/form post), with headers and bodies. An API call is **triggered by** the Step it followed.

**Endpoint** — API calls grouped by method + normalised route (`GET /api/orders/:id`).

**Test data field** — A value the tester typed or chose that a Scenario depends on. It has a **kind** (email, phone, first name, date, amount…), **constraints** (max length, pattern, min/max, options) and a **strategy**:
- **recorded** — reuse exactly what was typed,
- **fresh** — generate a new realistic value of the same kind,
- **custom** — a value the tester supplies.

**Data plan** — The list of Test data fields of a Scenario with a recommended strategy and the reason (e.g. "sign-up form: email must be unique → fresh").

**Secret** — A Test data field that must not leak: passwords, OTPs, tokens. Secrets are exported as environment variables.

**Run** — One replay of a Scenario. It produces a **Run report**: a result per Step (passed, failed, skipped, not run), warnings, and an **API diff** against the recording.

**Evidence** — Screenshots, API calls, console errors and notes that prove what happened in a Scenario or Run.
