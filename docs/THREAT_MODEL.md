# Threat model

Scope: the Motion Chrome extension as built — local-first, no backend, no model
calls. Findings below came from an adversarial architecture review; each names
the control and its current status. Nothing is marked mitigated unless the code
implementing the control exists.

Status values: **Mitigated** (implemented and tested) · **Planned** (design
settled, not yet built) · **Accepted** (understood, not addressed, with reason).

## Assets

Coursework metadata (deadlines, weights, grades), student notes and drafts,
course URLs and enrolment, and the student's browsing session with their
institution. Motion never holds credentials.

## Trust boundaries

See [`SECURITY.md`](SECURITY.md). Summary: the LMS page is hostile, the content
script is page-adjacent and unprivileged, the service worker is the only
privileged context, the side panel renders and asks.

---

## T1 — Malicious page content becomes stored XSS

An attacker who can post to a discussion board controls text Motion extracts,
stores, and later renders in the side panel.

**Prompt injection is not the MVP risk** — there is no model. The risk is
rendering and interpretation.

- Motion stores extracted **text, never page HTML**. — *Planned (content script)*
- The panel renders through React text nodes; `dangerouslySetInnerHTML` is
  banned repo-wide. — *Planned (lint rule)*
- Extracted URLs pass a scheme allowlist (`https:` only) at both storage and
  use; `javascript:`, `data:` and extension URLs are rejected. — *Planned*
- Length and count limits on extracted fields, so a pathological page cannot
  exhaust storage or wedge the UI. — *Planned*
- Page-derived strings never become selectors, action types, or workflow
  parameters. — *Planned (closed action allowlist, see T5)*

## T2 — Message spoofing into the service worker

**Zod proves a message's shape, not its sender's authority.** Conflating the two
was a real gap in the original design.

The worker must verify, for every message: `sender.id === chrome.runtime.id`;
that the sender's role (content script vs. extension UI) may invoke that message
type at all; that content messages carry `sender.tab` with an expected HTTPS
origin; and that any claimed tab, window or URL is derived from `sender` rather
than trusted from the payload. — *Planned*

`externally_connectable` is not declared, so no web page may message the
extension directly. — *Mitigated (manifest omits it)*

## T3 — Extension-page XSS defeats the whole sender model

The side panel shares the extension origin. If hostile content achieves XSS
there, every sender check sees a legitimate extension origin.

Prevention is the only real control: strict extension CSP, no dynamic code or
HTML sinks, and keeping repository and approval-mutation APIs **out of the side
panel bundle** so the panel can only ask the worker for narrow commands rather
than perform CRUD itself. — *Planned*

## T4 — Duplicate or lost side effects after a worker restart

IndexedDB and `chrome.tabs`/`chrome.tabGroups` cannot commit atomically
together. A crash after the Chrome call but before recording produces a
duplicate; recording first and crashing produces a lost action.

Side-effecting steps are modelled as durable intents moving
`prepared → applied → reconciled`, each with a reconciliation strategy that can
inspect real browser state after a restart. — *Planned*

## T5 — Prohibited actions reached through a generic capability

Blocking action *names* is worthless if a workflow can invoke generic scripting,
a DOM click, a form action, or an arbitrary navigation. The academic-integrity
boundary would be bypassed without ever naming a prohibited action.

The prohibition is enforced again at the lowest capability-dispatch layer, and
workflows are given a **closed allowlist of concrete, parameter-validated
actions** — never generic page mutation or script execution. — *Planned*

Policy-level refusal, including refusal ahead of reading approval status, is
already implemented. — *Mitigated (`src/core/policy`, tested)*

## T6 — Approval replay

An approval record is effectively a bearer token. Without binding, one approval
could authorize a different action, a later attempt, or a different target.

An approval binds to the workflow id, workflow definition version, stable step
id, attempt generation, canonical action type, target origin, and a hash of the
immutable action parameters; expiry is checked immediately before dispatch and
the approval is consumed atomically for exactly one attempt. — *Partially
mitigated*: expiry, prohibition-first checking and status handling are
implemented and tested; parameter binding and atomic consumption are *Planned*.

## T7 — Concurrent execution of the same workflow

Messages, alarms and startup recovery can all observe the same queued workflow
and run it twice. An in-memory guard does not survive a worker restart and is
therefore not a control.

Steps are claimed via an atomic IndexedDB compare-and-swap carrying a lease and
attempt generation; completion must match the generation it claimed. — *Planned*

## T8 — Resuming at the wrong step after an extension update

A persisted cursor *index* changes meaning when steps are inserted, reordered or
removed by an update, so an old workflow can resume into the wrong action.

Workflows persist a stable `stepId`, the workflow type and its definition
version, and define upgrade-or-cancel behaviour per version. — *Planned*

## T9 — Over-broad host permissions

Broad host access would let Motion read unrelated browsing.

Built-in host permissions cover D2L hosts only; anything else is an optional
permission requested just-in-time and revocable, and the supported set is
visible in the extension options. `activeTab` is deliberately unused — it does
not function from a side panel. — *Partially mitigated (manifest); options UI
Planned*

## T10 — Permission prompts lost by asynchronous orchestration

`chrome.permissions.request()` needs a live user gesture, which is lost at the
first `await`. A workflow parked in `awaiting-permission` can never
autonomously acquire permission later.

A dedicated permission gateway is invoked synchronously from the UI gesture;
the workflow persists and resumes only once the outcome is known. — *Planned*

## T11 — Supply-chain compromise of a dependency

Runtime dependencies are React, Zod, clsx and tailwind-merge. The lockfile is
committed, `npm audit` reports zero vulnerabilities, and no remote code is
loaded at runtime, so a compromised *build* dependency cannot reach users
without a rebuild and reload. — *Partially mitigated*; automated dependency
review is *Planned*.

## T12 — Attaching data to the wrong course after re-extraction

URLs and CSS selectors alone are unstable identity. Without durable identity,
re-extraction or a future sync could attach a note to the wrong course.

Provenance records the platform, canonical URL, page type, capture time and
extraction version today; institution/tenant and account identity plus an
evidence excerpt are *Planned* before any sync exists. — *Partially mitigated*

---

## Accepted risks

- **Local storage is not encrypted at rest** beyond the browser profile's own
  protections. Motion does not claim otherwise. Someone with the unlocked
  device and profile can read the data. Encrypting it in the extension would
  require a key the extension also holds, which protects against very little
  while making recovery and support worse.
- **A fully compromised browser profile or extension page is game over.** No
  in-extension control meaningfully survives that; prevention is the control.
- **No cross-device sync**, so no server-side breach surface — and no
  server-side recovery if the profile is lost.
