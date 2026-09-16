# ADR 0006 — Chrome local AI runtime

- **Status:** Accepted
- **Date:** 2026-09-16

## Decision

The worker-side Chrome-local provider is composite: use the connected side-panel
`motion-inference` port first, then in-worker `LanguageModel` when available,
otherwise report the runtime's status or `needs-document-context`. Availability
checks are time-bounded to five seconds. Inference itself is not exercised.

## Probe evidence

| Runtime | Chrome 152 stable | Chromium 153 |
| --- | --- | --- |
| Service worker | `LanguageModel` function; downloadable | function; availability never resolved (8s probe timeout) |
| Extension page/side panel | function; downloadable | function; availability never resolved |
| Offscreen document | function; downloadable | not measured |

Evidence is recorded in [local-ai-probe.md](../verification/local-ai-probe.md).
The side-panel host is preferred because long worker inference reliability is
unproven.

