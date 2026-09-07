# ADR 0001 — Build the extension on Vite + CRXJS rather than WXT

- **Status:** Accepted
- **Date:** 2026-09-07

## Context

Motion is a Manifest V3 Chrome extension with a React side panel, a service
worker, and content scripts. Two credible toolchains exist:

- **WXT** — an extension-oriented framework with file-based entrypoints, a
  generated manifest, and cross-browser output. Latest release `0.21.4`.
- **Vite + `@crxjs/vite-plugin`** — a Vite plugin that handles MV3 bundling and
  HMR while leaving the manifest under direct authorship. Latest release
  `2.7.1`.

## Decision

Use **Vite 8 with `@crxjs/vite-plugin` 2.7.1**.

## Rationale

1. **Maturity.** CRXJS is on a stable major (`2.7.1`); WXT is still pre-1.0
   (`0.21.4`) and its API surface can still move underneath us.
2. **The manifest is a design artifact, not build output.** Motion's permission
   scope is a privacy commitment we make to students and defend in a Chrome Web
   Store review. Keeping `manifest.config.ts` hand-authored means a permission
   is added only by a person editing the list, and it shows up plainly in a
   diff. A generated manifest makes that a derived side effect of adding an
   entrypoint.
3. **The MV3 lifecycle is the substance of this project.** Resumable workflows
   across service-worker suspension are the hard engineering problem Motion
   exists to solve. A framework that smooths over the lifecycle would hide the
   thing worth demonstrating and worth getting right.
4. **Dependency surface.** CRXJS is one plugin; WXT brings a framework and its
   own module resolution, config, and conventions.

## Consequences

- We hand-write the manifest and the entrypoint wiring that WXT would generate.
  Accepted: it is a small, one-time cost.
- Cross-browser output (Firefox) is not free. Motion targets Chrome for the MVP;
  a port would need work CRXJS does not do for us. Revisit only if a real
  requirement appears.
- If CRXJS becomes unmaintained, migration to WXT or a raw Rollup config is
  possible because the manifest and entrypoints are already explicit.
