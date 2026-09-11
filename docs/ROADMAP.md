# Roadmap

Status is evidence-based. **Done** means implemented *and* covered by tests that
run in `npm test`. **Partial** names exactly what is missing. Nothing is marked
done because it was designed or documented.

Last reconciled against the tree: see `git log` for the most recent commit.

## Phase A — Foundation

| Item | Status | Evidence |
| --- | --- | --- |
| Repository and tooling | **Done** | Vite 8 + CRXJS, strict TS, Vitest; `npm audit` clean; [ADR 0001](adr/0001-build-tooling.md) |
| Documentation and ADRs | **Done** | `docs/`, three ADRs, `AGENTS.md`, `CLAUDE.md` |
| Design-system foundation | **Done** | `src/ui/tokens.css`; WCAG AA enforced by `tokens.contrast.test.ts` |
| Local persistence + migrations | **Done** | `src/core/storage`; migration replay, corrupted-row recovery tested |
| Risk, approval and assessment policy | **Done** | `src/core/policy`; 21 tests incl. forged-approval and replay cases. A graded attempt records that the tab is restricted and nothing else — no URL, title, warnings or content — and the panel shows restricted mode for that tab, including when a course page is open in another tab (`npm run test:extension`) |
| Page detection | **Partial** | Route table covers the D2L routes listed in `docs/MANUAL-TESTING.md`, tested against synthetic fixtures and against the built extension in a real Chromium (`npm run test:extension`). Dashboard, course home, content module, assignment list, assignment, discussion list, quiz list, grades, calendar and unrecognised routes are now confirmed on a live authenticated MyLearningSpace account — see the run recorded in `docs/MANUAL-TESTING.md`. Announcements, `navigateContent` topics and a live expired session remain unverified |
| Typed messaging + sender authorization | **Partial** | Implemented and unit-tested, both directions Zod-validated; the worker/content-script/panel path is exercised in a real browser by `npm run test:extension`, including a page script failing to reach the worker |
| Extension shell (worker, panel, popup) | **Partial** | Worker, side panel and options page load in Chromium 141 and the panel renders state from the worker (`npm run test:extension`). The panel now has a header (mark, new chat, settings), task buttons into the existing views, a chat about the page and a bottom composer; the options page is a full settings screen (Permissions, Privacy & data, Capabilities, About) whose delete reports a blocked database honestly. Warm light and dark palettes and a bundled Source Serif 4 heading face, AA-verified in both themes (`tokens.contrast.test.ts`). Unit-tested; the settings page, the bundled font and the composer's restricted-mode absence are checked in a real Chromium by `npm run test:extension` |
| Basic tab grouping | **Partial** | **Prepare workspace** opens the assignment and its readable same-origin links in a named, Motion-owned group (`src/core/workspace`, `src/background/router.ts`). Unit-tested against an in-memory browser: link allowlist, no duplicate workspace, restricted mode inside Motion's own group, and closing only owned tabs still in the group. The toolbar icon opens the panel and adopts the current tab into the same group — recorded as the student's, so closing the workspace ungroups it and never closes it; refused on restricted, signed-out, unsupported and already-grouped tabs (unit-tested). Not yet exercised in a real browser or on a live LMS |

## Phase B — Course organization

| Item | Status |
| --- | --- |
| D2L adapter and synthetic fixtures | **Partial** — route-based selectors, with fixtures rebuilt from the structure the live deployment actually serves. A list row, not a link, is now the unit of extraction: D2L puts several links to the same work on one row |
| MyLearningSpace (institution deployment) support | **Partial** — the live signed-in matrix has now been run once and is recorded in `docs/MANUAL-TESTING.md`. It found five defects that synthetic fixtures had missed: assignments named after their submission-count link, a duplicate task per discussion topic, a quiz list locked into restricted mode by a quiz's own name, a course renamed by every page visited, and a panel that rendered the workspace over unsupported and signed-out pages. All five are fixed and pinned by fixtures modelled on the real markup |
| Deadline extraction with provenance and confidence | **Partial** — domain model and parser exist; not yet wired to storage |
| Course dashboard | **Not started** |
| Task correction and archive | **Not started** — model supports it (`corrections`, `studentEdited`) |
| Source-linked notes | **Not started** — schema exists |

## Phase C — Workflow execution

| Item | Status |
| --- | --- |
| State machine with durable checkpoints | **Partial** — `src/core/workflows/engine.ts` persists every transition and resumes by stable step id, not index; the transition table forbids leaving a terminal state (`engine.test.ts`: "resumption identifies steps by stable id", "transition table"). Unit-tested against a store, not across a real worker restart |
| Step claiming via compare-and-swap lease | **Partial** — one execution claims a workflow at a time, and a lease left by a killed worker is reclaimed (`engine.test.ts`, "concurrency"). Not exercised across real service-worker contexts |
| Durable intents (`prepared → applied → reconciled`) | **Partial** — a prepared intent is reconciled instead of repeating the effect, and the effect runs when reconciliation finds no evidence (`engine.test.ts`, "durable intents"); used by Prepare workspace's tab opening |
| Pause, resume, retry, cancel | **Partial** — implemented and unit-tested (`engine.test.ts`, "student controls", "failure handling", "recovery"): pause drops the lease, cancel is terminal, retry resets attempts, retries use alarms with backoff. The panel exposes them; not yet run end to end in a real browser |
| Idempotent tab and tab-group operations | **Partial** — opening is idempotent per operation id, and a step interrupted between opening and grouping is finished under its original key rather than repeated (`src/background/capabilities.test.ts`); not yet covered by a real worker restart |
| Worker suspension and restart tests | **Not started** |

An earlier engine draft was discarded before it shipped: it used an in-memory
concurrency guard and a persisted cursor *index*, both of which fail exactly
when they matter (a worker restart, and an extension update that reorders
steps). See [`THREAT_MODEL.md`](THREAT_MODEL.md) T7 and T8.

## Phase D — Learning assistance

| Item | Status | Evidence |
| --- | --- | --- |
| Requirement extraction → checklist | **Done** | `src/core/assist/requirements.ts`; source-linked, refuses to invent items |
| Draft composition (outline, draft, section, reply, revision) | **Done** | `src/core/assist/compose.ts` + on-device model; [ADR 0004](adr/0004-on-device-model.md) |
| Draft-vs-requirements review | **Done** | `src/core/assist/draftReview.ts`; reports "no evidence", not "missing" |
| AI labelling | **Done** | `origin: 'generated'` stored with the text, not applied by the UI |
| Prompt-injection defence | **Done** | Context fenced, delimiters neutralised, instruction last; tested with a planted directive |
| Chat about the current page | **Partial** | `src/core/assist/chat.ts`, `handleAskAboutPage` in `src/background/router.ts`, `src/sidepanel/views/ChatView.tsx`. On-device model only; ephemeral, stored nowhere; page text and earlier turns fenced; refused before any read beside a graded attempt, with no composer shown there. Unit-tested against a fake model. Not yet run against Chrome's real on-device model, which was unavailable on the test machine; which hosted model a student may bring is undecided (`docs/development/ai-account-handoff.md`, Track 2) |
| Practice questions and study guides | **Not started** | — |
| Citation and formatting checks | **Partial** | Numeric constraints (word counts) checked exactly; citation style not yet |
| Assessment restriction enforcement | **Done** | `src/core/policy/assessment.ts`, tested |

## Phase E — Expansion

Not started, and deliberately gated: Canvas, Moodle, Blackboard and any backend
each require an ADR first. Multi-LMS work does not begin until the D2L path is
reliable end to end.

## Explicitly out of scope for the MVP

Assignment submission, graded-quiz actions, and deletion of LMS data are not
"later" — they are refused in code. Discussion posting waits
for a production-ready approval path. No accounts, no sync, no backend
([ADR 0002](adr/0002-local-first-no-backend.md)).
