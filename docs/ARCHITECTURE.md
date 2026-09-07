# Architecture

## Contexts and boundaries

```
┌─ LMS page (hostile input) ──────────────────────────────────────┐
│  content script — reads the DOM, never acts on it               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ typed message, validated + sender-checked
┌───────────────────────────▼─────────────────────────────────────┐
│  service worker (the only privileged context)                   │
│    workflow engine · approval gate · tab + tab-group manager    │
│    permission gateway · audit log                               │
└───────┬───────────────────────────────────┬─────────────────────┘
        │ IndexedDB                          │ narrow typed commands
┌───────▼──────────┐              ┌──────────▼─────────────────────┐
│  local storage   │              │  side panel (React)            │
│  courses, tasks, │              │  renders state, asks for       │
│  notes, workflows│              │  approval. No orchestration,   │
│  approvals, audit│              │  no scraping, no direct CRUD.  │
└──────────────────┘              └────────────────────────────────┘
```

### Rules that keep the boundaries real

- `src/core/**` imports neither `chrome.*` nor React. It is testable in plain
  Node with jsdom.
- Only `src/core/adapters/**` may contain LMS selectors or routes
  ([ADR 0003](adr/0003-adapter-isolation.md)).
- The side panel holds no repository or approval-mutation API. If the panel is
  ever XSS'd, the attacker inherits a narrow command surface rather than
  database access (see [threat T3](THREAT_MODEL.md)).
- Content scripts cannot act. Extraction is a pure `(url, document) → domain`
  function, so "read-only" is a property of the code shape, not a flag someone
  must remember to check.

## Layout

```
src/core/         platform-agnostic
  domain/         Zod schemas — the authoritative types
  adapters/       LMS adapters; the only home for selectors and routes
  parse/          due-date and text parsing
  policy/         risk classification, approvals, assessment restriction
  storage/        IndexedDB schema, migrations, validate-on-read repositories
  workflows/      the resumable state machine
src/platform/     capability wrappers over chrome.* (semantic, not thin mirrors)
src/background/   MV3 service worker
src/content/      content script
src/sidepanel/    React UI
src/ui/           design tokens and components
```

## The Manifest V3 lifecycle problem

A service worker is killed after roughly 30 seconds of inactivity, mid-task,
without warning. Motion's central engineering constraint is that **correctness
must not depend on the worker staying alive.** Concretely:

1. **No state in module-level variables.** Anything that matters is persisted
   and re-read on each event. An in-memory "currently running" set is not a
   concurrency control, because it does not survive the restart it is meant to
   protect against.

2. **Steps are claimed, not just started.** A step is claimed through an atomic
   IndexedDB compare-and-swap carrying a lease and an attempt generation.
   Messages, alarms and startup recovery can all observe the same workflow
   concurrently; only one may hold the claim, and a completion is only accepted
   if it matches the generation that claimed it.

3. **Resumption is by stable step id, not by index.** A persisted cursor index
   silently changes meaning when an extension update inserts or reorders steps,
   which would resume an old workflow into the wrong action. Workflows persist
   the workflow type, its definition version, and a stable step id, and define
   upgrade-or-cancel behaviour per version.

4. **Side effects are durable intents, not awaited calls.** IndexedDB and
   `chrome.tabs` cannot commit in one transaction, so any crash between them
   either duplicates or loses the action. Side-effecting steps move through
   `prepared → applied → reconciled`; each capability knows how to inspect real
   browser state after a restart and reconcile. Tabs carry a discoverable
   operation marker, because tab ids are not durable across sessions and URL
   matching would collide with a tab the student opened themselves.

5. **Recovery needs a trigger.** Stored state does not wake a worker. Listeners
   are registered synchronously at the top level, and recovery runs on startup,
   on install, on relevant inbound events, and on `chrome.alarms` for scheduled
   retries — never `setTimeout`.

6. **Work runs as bounded steps**, not one long orchestration loop, so being
   killed costs at most one step.

## Permissions and user gestures

`chrome.permissions.request()` requires a live user gesture, which is lost at
the first `await`. A workflow parked awaiting permission therefore cannot
acquire it later on its own. Permission requests go through a dedicated gateway
invoked synchronously from the UI gesture, and the workflow only persists and
resumes once the result is known.

`activeTab` is not used: it grants access only on a direct gesture and does not
work from a side panel.

## Data flow: the reference journey

1. Student opens an assignment in D2L. The content script detects the page via
   its route and reports a normalized `PageDetection` to the worker.
2. The worker resolves the course, stores it with provenance, and tells the
   panel what it knows.
3. Student chooses **Prepare workspace**. The worker creates a workflow —
   persisted before any step runs.
4. Steps execute one at a time, each claimed, each persisting its output and its
   transition in a single transaction so a restart cannot advance past work it
   did not save.
5. Anything above low risk stops and asks, naming the target and the effect.
6. The panel shows completed, active, pending, blocked and failed steps, the
   sources visited, and the controls to pause, resume, retry or cancel.

## Testing strategy

| Layer | What it proves |
| --- | --- |
| Unit | Date parsing incl. DST and ambiguity, risk classification, approval expiry and replay, schema migrations, corrupted-row recovery |
| Adapter fixtures | Detection and extraction against synthetic D2L HTML, including a different institution skin and a deliberately broken page |
| Component | Every workflow and approval state, keyboard operation, focus, announcements |
| Browser | Install, side panel, messaging, tab groups, worker suspension and resume |

Fixtures are synthetic. A student's real LMS account is never used in automated
tests, and no real course content is committed.
