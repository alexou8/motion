# ADR 0004 — Draft with Chrome's on-device model, not a hosted API

- **Status:** Superseded by [ADR 0005](0005-ai-provider-abstraction-and-byok.md)
  and [ADR 0006](0006-chrome-local-ai-runtime.md)
- **Date:** 2026-09-07
- **Supersedes:** part of [ADR 0002](0002-local-first-no-backend.md), which
  deferred model-assisted features on the grounds that they would require a
  gateway.

## Context

Motion needs to draft coursework — outlines, full drafts, discussion replies,
revisions — for the student to review and edit. Supported consequential actions
may also be carried out only after fresh confirmation. That requires
generation, which ADR 0002 assumed meant a server: a model gateway, an account,
a retention policy, and a stream of a student's coursework leaving their machine.

Chrome ships a built-in on-device model (`LanguageModel`) that extensions can
use in the service worker, popup and side panel with no additional manifest
permission.

## Historical decision

Use the browser's on-device model. No backend, no API key, no account. This
was the original decision; the current provider abstraction and runtime
composition are defined by ADRs 0005 and 0006.

## Rationale

1. **It keeps the local default.** An on-device model keeps coursework on the
   device while still allowing drafting; the later BYOK decision defines the
   explicit cloud exception.
2. **Nothing to secure that does not exist.** No gateway, no stored prompts, no
   retention default, no breach surface, no bill.
3. **The failure mode is honest.** Availability is checked and reported to the
   student in plain terms. Motion says the model is unavailable rather than
   degrading into something that looks like it worked.

## Consequences

- **The model is small.** Output quality is below a frontier model, which makes
  the "read it, check it, rewrite it" framing accurate rather than decorative.
- **Availability is not guaranteed.** It depends on the Chrome version, the
  platform, and a one-time download. Every drafting entry point handles
  `unavailable`, `downloadable` and `downloading` explicitly.
- **Context is limited**, so prompts are assembled from the checklist and the
  student's own notes rather than whole pages.
- If a hosted model is ever added, it needs its own ADR covering what leaves the
  device, retention, deletion, and how the student is told.

## Current safety policy

Motion may submit, post, upload or send supported coursework only after a fresh,
target-bound, single-use confirmation each time. It never answers or acts inside
a graded, timed or proctored attempt. Drafting remains labelled as generated in
the student's workspace.
