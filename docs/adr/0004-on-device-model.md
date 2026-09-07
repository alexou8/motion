# ADR 0004 — Draft with Chrome's on-device model, not a hosted API

- **Status:** Accepted
- **Date:** 2026-09-07
- **Supersedes:** part of [ADR 0002](0002-local-first-no-backend.md), which
  deferred model-assisted features on the grounds that they would require a
  gateway.

## Context

Motion needs to draft coursework — outlines, full drafts, discussion replies,
revisions — for the student to review, edit and submit themselves. That requires
generation, which ADR 0002 assumed meant a server: a model gateway, an account,
a retention policy, and a stream of a student's coursework leaving their machine.

Chrome ships a built-in on-device model (`LanguageModel`) that extensions can
use in the service worker, popup and side panel with no additional manifest
permission.

## Decision

Use the browser's on-device model. No backend, no API key, no account.

## Rationale

1. **It keeps the privacy promise exactly as written.** ADR 0002's real
   commitment was that a student's academic work does not leave the device.
   An on-device model honours that while still allowing drafting; a hosted API
   would have forced the promise to be rewritten.
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

## What this does not change

Motion still does not submit assessed work, answer or act inside a graded
attempt, or modify remote course data. Drafting produces text in the student's
own workspace, labelled as generated, which they read and rewrite. The
submission remains theirs to make.
