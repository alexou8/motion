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
| Risk, approval and assessment policy | **Done** | `src/core/policy`; 21 tests incl. forged-approval and replay cases. Opening a graded attempt stores nothing and drops the previous observation, so the panel goes idle rather than offering the last course page; it does not yet say *why* it went idle |
| Page detection | **Partial** | Route table covers the D2L routes listed in `docs/MANUAL-TESTING.md`, tested against synthetic fixtures and against the built extension in a real Chromium (`npm run test:extension`); **not verified against a live authenticated deployment** |
| Typed messaging + sender authorization | **Partial** | Implemented and unit-tested; the worker/content-script/panel path is exercised in a real browser by `npm run test:extension`, including a page script failing to reach the worker |
| Extension shell (worker, panel, popup) | **Partial** | Worker, side panel and options page load in Chromium 141 and the panel renders state from the worker (`npm run test:extension`); panel views beyond the connection states are unfinished |
| Basic tab grouping | **Not started** | — |

## Phase B — Course organization

| Item | Status |
| --- | --- |
| D2L adapter and synthetic fixtures | **Partial** — being rewritten onto route-based selectors after the first pass was found to depend on invented `data-*` attributes |
| MyLearningSpace (institution deployment) support | **Partial** — host matching, a skin fixture and a stock/skin equivalence test pass; the live signed-in matrix in `docs/MANUAL-TESTING.md` has not been run |
| Deadline extraction with provenance and confidence | **Partial** — domain model and parser exist; not yet wired to storage |
| Course dashboard | **Not started** |
| Task correction and archive | **Not started** — model supports it (`corrections`, `studentEdited`) |
| Source-linked notes | **Not started** — schema exists |

## Phase C — Workflow execution

| Item | Status |
| --- | --- |
| State machine with durable checkpoints | **Not started** — design revised after review; see below |
| Step claiming via compare-and-swap lease | **Not started** |
| Durable intents (`prepared → applied → reconciled`) | **Not started** |
| Pause, resume, retry, cancel | **Not started** |
| Idempotent tab and tab-group operations | **Not started** |
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
