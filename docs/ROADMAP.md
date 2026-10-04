# Roadmap

Status is evidence-based. **Done** means implemented *and* covered by tests that
run in `npm test`. **Partial** names exactly what is missing. Nothing is marked
done because it was designed or documented.

Last updated 2026-10-04. The provider Settings and panel E2E checks cover
exact model selection, current and economical model choices, stream failures,
cancellation and recovery. See [browser verification](verification/browser-verification.md)
for this iteration's evidence and remaining live-account limitations. Older
phase entries below retain their original scope and evidence.

## Local lecture text indexing (2026-10-04)

- **Implemented and browser verified:** Library indexes selectable PDF text and
  PPTX slide text using bundled local workers. Search results retain page/slide
  numbers; students can read text, filter by course, reindex an LMS source or
  remove a local index. No AI provider receives indexed files or text.
- **Implemented:** observed MyLearningSpace PDF.js viewer file references and
  direct course-file links become page-bound source choices. Same-origin,
  same-course checks, expiry, assessment refusal and deletion-safe import
  tickets protect download and storage boundaries.
- **Verified with a private downloaded lecture:** the production extension
  indexed 22/22 pages and 11,741 characters in an isolated temporary profile.
  Only counts are recorded; course content is absent from fixtures/screenshots.
- **Installed-account follow-up:** authenticated observed-file fetching indexed
  22/22 lecture pages. Later-page text contained the original viewer's selectable text; reindexing,
  course association and panel persistence passed. Content, three assignment
  entries, one quiz-list entry and dashboard reads passed. The page reader stays
  available after saving coursework. No real attempt or course mutation was performed.
- **Limits:** no OCR, legacy `.ppt`, speaker notes or automatic whole-course
  crawling. PDF indexing needs Chromium 125+. Wider course/deployment coverage,
  live PowerPoint fetching and provider-backed work remain unverified. See
  [document verification](verification/document-indexing.md).

## Coursework overview and MyLearningSpace compatibility (2026-10-02)

- **Implemented:** a saved-coursework view with title/course search, course/type/
  status filters, source links and bounded rendering. It stays available on
  unsupported or signed-out tabs; restricted assessment mode hides it and any
  active session.
- **Implemented:** observed D2L content-module rows and supported `viewContent`
  topic headings become trackable materials, including slides/handouts without
  due dates. Undated materials do not become overdue items or date-review
  warnings. A duplicate undated shortcut cannot hide stronger deadline evidence.
- **Implemented:** large page reads respect the existing 500-task message limit,
  prioritize deadline evidence and display a notice when materials are omitted.
- **Implemented:** nested open-shadow dashboard links and native controls are
  discovered with bounded traversal. Saved coursework refreshes after extraction
  finishes, and status words in a resource title do not mark it submitted or graded.
- **Release tooling:** one shared validation gate precedes development and tagged
  publishing; extension ZIP packaging is deterministic and includes source/checksum
  metadata.
  Development downloads use a distinct prerelease channel. See [releases](releases.md).
- **Limits:** observed pages only; no whole-course lecture crawl. Authenticated
  MyLearningSpace behavior and GitHub publication are
  tracked separately from synthetic browser evidence in
  [coursework verification](verification/coursework-overview.md).

## Optional remembered provider keys

The student requested secure storage across browser restarts on 2026-09-28.
[ADR 0009](adr/0009-optional-os-keychain-companion.md) defines an opt-in local
companion backed by the OS credential vault; session keys remain the default.
Native transport, installer and restart evidence are tracked in
[browser verification](verification/browser-verification.md).

## Deadline usability and store preparation — October 4, 2026

Submission audit follow-up: optional HTTPS access is narrowed to OpenAI and
Anthropic. Cloud operations recheck mutable consent, and browser permission
revocation cancels active cloud requests. Actor dispatch rechecks cancellation
and configurable permission after settings reads. Production packaging verifies
all worker modules and runtime license notices. The public policy is hosted and
verified at <https://alexou8.github.io/motion/privacy.html>; the extension
changes are not submitted to the store. Final evidence is recorded in
[submission verification](verification/submission-readiness-2026-10-04.md).

[WATnow's public repository](https://github.com/EricJujianZou/watnow) provided
comparison points: course filtering, full future lists, exact times, moved dates,
and cached coursework. Motion keeps its existing workspace design, opt-in
scanning, and assessment/approval boundaries.

- **Implemented and unit-tested:** course filtering shared by List/Week, a Later
  section in List, exact known times in the displayed browser zone, uncertainty
  warnings in Week, elapsed same-day deadlines marked overdue, DST-safe calendar
  grouping, and cached deadlines on signed-out/idle/unsupported/permission screens.
- **Browser verified with synthetic coursework:** course discovery, both view
  groups, signed-out caching, uncertainty warnings, narrow light/dark layouts,
  restricted-mode refusal, and popup artwork loading. See
  [current verification](verification/store-readiness-2026-10-04.md).
- **Branding:** original rising M with purple/gold artwork, purple/lavender action
  accents, preserved warm backgrounds and typography; contrast checks pass.
- **Local store materials:** production ZIP, full bundled licenses, icon sizes,
  listing screenshots and promo tile, a synthetic reviewer walkthrough recording,
  publisher/contact details, permission
  justifications, and privacy policy source. Removed unused scripting permission.
  Packaging now rejects test permissions, missing/wrong icons, development files,
  unsafe execution patterns, and absent license notices.
- **Submission still requires:** developer-dashboard
  registration/verification and disclosures, any reviewer access requirements,
  and current live-LMS checks. No publication or store approval is claimed.
- **Remaining improvement:** verify submission state from a readable LMS page
  before a reminder, preserving assessment boundaries and existing permissions.
  Current reminders suppress tasks whose stored status is submitted/archived.

## Phase A — Foundation

| Item | Status | Evidence |
| --- | --- | --- |
| Repository and tooling | **Done** | Vite 8 + CRXJS, strict TS, Vitest; `npm audit` clean; [ADR 0001](adr/0001-build-tooling.md) |
| Documentation and ADRs | **Done** | `docs/`, three ADRs, `AGENTS.md`, `CLAUDE.md` |
| Design-system foundation | **Done** | `src/ui/tokens.css`; WCAG AA enforced by `tokens.contrast.test.ts` |
| Local persistence + migrations | **Done** | `src/core/storage`; migration replay, corrupted-row recovery tested |
| Risk, approval and assessment policy | **Done** | `src/core/policy`; 21 tests incl. forged-approval and replay cases. A graded attempt records that the tab is restricted and nothing else — no URL, title, warnings or content — and the panel shows restricted mode for that tab, including when a course page is open in another tab (`npm run test:extension`) |
| Page detection | **Partial** | Route table covers the D2L route shapes listed in `docs/MANUAL-TESTING.md`, tested against synthetic fixtures and the built extension in Chromium (`npm run test:extension`). Dashboard, course home, content module, assignment list, assignment, discussion list, quiz list, grades, calendar, unrecognised routes, and `/d2l/lms/news/main.d2l` announcements are live-verified. This change also fixes stale course fallback, quiz collapse from `javascript://` links, URL-variant duplicate ids, availability dates being treated as due dates, page-name course titles, and the signed-out body-script stub. `navigateContent` topics and a live expired session remain unverified |
| Typed messaging + sender authorization | **Partial** | Both directions are Zod-validated; worker results the panel renders are centrally validated in `src/sidepanel/responses.ts`; actor snapshots and clicks reject external, insecure, and script link destinations. Content actor channel authentication and one-shot capability enforcement are under final source/browser review; the current browser run does not yet prove extension-page forgery resistance. |
| Extension shell (worker, panel, popup) | **Partial** | Worker, side panel, default-popup launcher and options page pass unit and production-extension browser checks. The installed launcher, panel and observer also passed the read-only follow-up in one signed-in course. Wider installation/platform coverage remains pending. |
| Basic tab grouping | **Partial** | **Prepare workspace** and explicit popup Start/Continue actions open or resume a named Motion workspace. Grouping and student-tab adoption are explicit and policy-checked; a toolbar click alone does not create a group. Unit-tested against an in-memory browser and synthetic D2L pages; live LMS and current browser-matrix behavior remain unverified |

## Phase B — Course organization

| Item | Status |
| --- | --- |
| D2L adapter and synthetic fixtures | **Partial** — route-based selectors, with fixtures rebuilt from the structure the live deployment actually serves. A list row, not a link, is now the unit of extraction: D2L puts several links to the same work on one row |
| MyLearningSpace (institution deployment) support | **Partial** — live verification covers the recorded route shapes; synthetic fixtures pin the deployment-specific markup fixes for submission-count titles, duplicate discussion rows, quiz-list restricted-mode detection, page-name course titles, and the signed-out body-script stub. No live identifiers or course records are retained |
| Deadline extraction with provenance and confidence | **Partial** — extraction, storage upsert, discovery, reminders, and correction history are implemented and focused-tested; live LMS behavior remains unverified |
| Course dashboard | **Partial** — saved-coursework filters and local PDF/PPTX text indexing are browser verified; one installed signed-in course passed observed PDF indexing and read-only list tracking; no whole-course lecture crawl or deployment-wide verification |
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
concurrency guard and a persisted cursor _index_, both of which fail exactly
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
