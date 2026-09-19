# Roadmap

Status is evidence-based. **Done** means implemented *and* covered by tests that
run in `npm test`. **Partial** names exactly what is missing. Nothing is marked
done because it was designed or documented.

Last reconciled for source status on 2026-09-17; final browser-matrix counts
remain pending.

## Phase A — Foundation

| Item | Status | Evidence |
| --- | --- | --- |
| Repository and tooling | **Done** | Vite 8 + CRXJS, strict TS, Vitest; `npm audit` clean; [ADR 0001](adr/0001-build-tooling.md) |
| Documentation and ADRs | **Done** | `docs/`, three ADRs, `AGENTS.md`, `CLAUDE.md` |
| Design-system foundation | **Done** | `src/ui/tokens.css`; WCAG AA enforced by `tokens.contrast.test.ts` |
| Local persistence + migrations | **Done** | `src/core/storage`; migration replay, corrupted-row recovery tested |
| Risk, approval and assessment policy | **Done** | `src/core/policy`; 21 tests incl. forged-approval and replay cases. A graded attempt records that the tab is restricted and nothing else — no URL, title, warnings or content — and the panel shows restricted mode for that tab, including when a course page is open in another tab (`npm run test:extension`) |
| Page detection | **Partial** | Route table covers the D2L route shapes listed in `docs/MANUAL-TESTING.md`, tested against synthetic fixtures and the built extension in Chromium (`npm run test:extension`). Dashboard, course home, content module, `viewContent` topics, assignment list, assignment, discussion list, quiz list, grades, calendar, unrecognised routes, and `/d2l/lms/news/main.d2l` announcements are live-verified. This change also fixes stale course fallback, quiz collapse from `javascript://` links, URL-variant duplicate ids, availability dates being treated as due dates, page-name course titles, and the signed-out body-script stub. A 2026-09-18 live follow-up found that this deployment does not emit `navigateContent`; its topic navigation uses `viewContent` and module `Home?...` routes, while a constructed `navigateContent` URL returns the LMS 404 page. A live expired session remains unverified |
| Typed messaging + sender authorization | **Partial** | Both directions are Zod-validated; worker results the panel renders are centrally validated in `src/sidepanel/responses.ts`. Content actor channel authentication and one-shot capability enforcement are under final source/browser review; the current browser run does not yet prove extension-page forgery resistance. |
| Extension shell (worker, panel, popup) | **Partial** | Worker, side panel, default-popup launcher and options page are implemented; unit and extension coverage exercise validated popup intents, synchronous side-panel opening, panel state, product mark and presence layer. Browser verification of the current build remains pending. |
| Basic tab grouping | **Partial** | **Prepare workspace** and explicit popup Start/Continue actions open or resume a named Motion workspace. Grouping and student-tab adoption are explicit and policy-checked; a toolbar click alone does not create a group. Unit-tested against an in-memory browser and synthetic D2L pages; live LMS and current browser-matrix behavior remain unverified |

## Phase B — Course organization

| Item | Status |
| --- | --- |
| D2L adapter and synthetic fixtures | **Partial** — route-based selectors, with fixtures rebuilt from the structure the live deployment actually serves. A list row, not a link, is now the unit of extraction: D2L puts several links to the same work on one row |
| MyLearningSpace (institution deployment) support | **Partial** — live verification covers the recorded route shapes; synthetic fixtures pin the deployment-specific markup fixes for submission-count titles, duplicate discussion rows, quiz-list restricted-mode detection, page-name course titles, and the signed-out body-script stub. No live identifiers or course records are retained |
| Deadline extraction with provenance and confidence | **Partial** — extraction, storage upsert, discovery, reminders, and correction history are implemented and focused-tested; live LMS behavior remains unverified |
| Course dashboard | **Not started** |
| Task correction and archive | **Partial** — corrections, canonical-id migration, dependent repointing, and archive tombstones are implemented and focused-tested; live LMS behavior remains unverified |
| Source-linked notes | **Not started** — schema exists |

## Phase C — Workflow execution

| Item | Status |
| --- | --- |
| State machine with durable checkpoints | **Partial** — `src/core/workflows/engine.ts` persists every transition and resumes by stable step id, not index; the transition table forbids leaving a terminal state (`engine.test.ts`: "resumption identifies steps by stable id", "transition table"). Unit-tested against a store and exercised through synthetic browser workflows; provider-backed inference remains unverified |
| Step claiming via compare-and-swap lease | **Partial** — one execution claims a workflow at a time, and a lease left by a killed worker is reclaimed (`engine.test.ts`, "concurrency"). Not exercised across real service-worker contexts |
| Durable intents (`prepared → applied → reconciled`) | **Partial** — tab opening and owned navigation reconcile against recorded/current browser state; interrupted actor writes are never replayed automatically because the page has no durable idempotency marker. Unit-tested in `engine.test.ts` and `capabilities.test.ts` |
| Pause, resume, retry, cancel | **Partial** — pause drops the lease, cancel is terminal, retry resets attempts, and retries use alarms with backoff. A current review still has a stop-generation status residual and actor/recovery error-path follow-up; not yet run end to end in a real browser |
| Idempotent tab and tab-group operations | **Partial** — opening is idempotent per operation id, and a step interrupted between opening and grouping is finished under its original key rather than repeated (`src/background/capabilities.test.ts`); not yet covered by a real worker restart |
| Worker suspension and restart tests | **Partial** — synthetic Chromium E2E terminates the service worker through CDP and verifies persisted AgentSession/workspace recovery; stale streaming-preview cleanup and live provider streaming/cancellation remain pending final evidence |

An earlier engine draft was discarded before it shipped: it used an in-memory
concurrency guard and a persisted cursor *index*, both of which fail exactly
when they matter (a worker restart, and an extension update that reorders
steps). See [`THREAT_MODEL.md`](THREAT_MODEL.md) T7 and T8.

## Phase D — Learning assistance

| Item | Status | Evidence |
| --- | --- | --- |
| Requirement extraction → checklist | **Done** | `src/core/assist/requirements.ts`; source-linked, refuses to invent items |
| Draft composition (outline, draft, section, reply, revision) | **Partial** | `src/core/assist/compose.ts` + composite local/provider abstraction; local and BYOK paths are implemented, while provider disclosure and real inference remain in progress; [ADRs 0004–0006](adr/0004-on-device-model.md) |
| Draft-vs-requirements review | **Done** | `src/core/assist/draftReview.ts`; reports "no evidence", not "missing" |
| AI labelling | **Done** | `origin: 'generated'` stored with the text, not applied by the UI |
| Prompt-injection defence | **Done** | Context fenced, delimiters neutralised, instruction last; tested with a planted directive |
| Chat about the current page | **Partial** | `src/core/assist/chat.ts`, `handleAskAboutPage` in `src/background/router.ts`, `src/sidepanel/views/ChatView.tsx`. Composite local/BYOK provider; session-scoped conversation, fenced page text and earlier turns, graded-attempt refusal before read. Unit-tested against a fake model; real local inference and cloud disclosure flow remain in progress |
| Practice questions and study guides | **Not started** | — |
| Citation and formatting checks | **Partial** | Numeric constraints (word counts) checked exactly; citation style not yet |
| Assessment restriction enforcement | **Done** | `src/core/policy/assessment.ts`, tested |

## Phase E — Expansion

Not started, and deliberately gated: Canvas, Moodle, Blackboard and any backend
each require an ADR first. Multi-LMS work does not begin until the D2L path is
reliable end to end.

## Explicitly out of scope for the MVP

Consequential assignment submission and discussion posting are available only
through a fresh, target-bound, single-use confirmation; Motion still refuses all
actions inside graded/timed/proctored attempts. Deletion of LMS data remains out
of scope. No accounts, no sync, no backend
([ADR 0002](adr/0002-local-first-no-backend.md)).
