# 1. Plain JavaScript, no build step

Date: 2026-11-24 · Status: accepted

## Context

The extension must be loadable with **Load unpacked** by QA engineers who may not run Node tooling, and content scripts in Manifest V3 cannot be ES modules. A bundler (Vite/webpack + TypeScript) would give types and shared imports, at the price of a build step for every change and a `dist/` that must be the folder people load.

## Decision

Ship plain JavaScript with no build step.

- Extension pages and the service worker use **ES modules** (`src/shared/*.js`).
- Content scripts are **classic scripts** that attach to one namespace, `globalThis.QA` (`QA.sel`, `QA.steps`, `QA.outcomes`, …), loaded in manifest order.
- Pure content-side logic (e.g. the Step builder) is written DOM-free so Node tests can load it with `vm` into a fake `QA` namespace.

## Consequences

- The repository folder *is* the extension; `npm` is only needed to run tests.
- No static types: interfaces are documented at the top of each module and protected by tests at the module's interface.
- Code shared between content scripts and extension pages must be duplicated or kept DOM/namespace-agnostic.
