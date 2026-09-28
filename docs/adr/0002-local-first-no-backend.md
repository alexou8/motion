# ADR 0002 — Ship the MVP local-first, with no backend

- **Status:** Accepted (local-first remains; optional user-selected cloud AI
  now exists under ADR 0005)
- **Date:** 2026-09-07

## Context

The product brief describes an optional backend: accounts, a course/task sync
API, a durable workflow service, a model gateway, and audit storage. None of it
is required for a student to get value from the first release.

## Decision

The MVP stores coursework and workflow state in the browser, has no account,
sync service or Motion server, and makes no Motion-owned telemetry requests.
An explicitly selected BYOK provider may receive disclosed model-turn context;
ADR 0005 defines that exception.

## Rationale

1. **The data is sensitive and the default is not to collect it remotely.**
   Deadlines, drafts, grades and course enrolment are academic records. Local
   mode keeps them on-device; BYOK is an explicit, disclosed exception to this
   default.
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
- Model-assisted features use the selected local or BYOK provider directly;
  they do not require a Motion gateway. Cloud turns are disclosed, bounded and
  sent directly to the selected provider, while provider keys remain
  session-only. This ADR still excludes a Motion model gateway, account, sync
  service and telemetry.
- Introducing a backend later requires a new ADR covering authentication,
  retention defaults, deletion, and what leaves the device.
