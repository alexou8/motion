# ADR 0002 — Ship the MVP local-first, with no backend

- **Status:** Accepted
- **Date:** 2026-09-07

## Context

The product brief describes an optional backend: accounts, a course/task sync
API, a durable workflow service, a model gateway, and audit storage. None of it
is required for a student to get value from the first release.

## Decision

The MVP stores everything in the browser (IndexedDB) and makes no network
requests of its own. No accounts, no sync, no server.

## Rationale

1. **The data is sensitive and the cheapest way to protect it is not to collect
   it.** Deadlines, drafts, grades and course enrolment are academic records.
   Data that never leaves the device cannot be breached on a server, subpoenaed
   from one, or retained past its usefulness.
2. **A backend does not test the risky hypothesis.** The open question is
   whether adapter-based extraction and resumable workflows are reliable enough
   to trust. That is answerable entirely on-device.
3. **Cost of reversal is low.** Repositories sit behind a typed interface, so a
   sync implementation can be added later without the domain layer knowing.

## Consequences

- No cross-device sync. A student using two laptops has two separate workspaces.
  This is a real limitation and is stated plainly in the README rather than
  papered over.
- No server-side audit trail. The audit log is local, which means it is evidence
  for the student, not for an institution.
- Model-assisted features (summaries, study guides) are out of the MVP slice,
  since they require a gateway. The note model already distinguishes generated
  text so the capability can be added without a schema change.
- Introducing a backend later requires a new ADR covering authentication,
  retention defaults, deletion, and what leaves the device.
