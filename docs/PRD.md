# Product requirements

## Problem

A student in several courses works across an LMS, readings, slides, a discussion
board, a calendar and a dozen tabs, with notes in an unrelated app. Generic task
managers hold a list but understand none of that structure; an AI chat window
answers questions but does not know what is due Friday or which rubric has not
been opened.

## Users

**Primary:** university and college students, especially those in asynchronous
or blended courses, managing several LMS courses, or who struggle with
organization, context switching and deadlines. Students who rely on structured,
accessible workflows are a first-class case, not an afterthought.

**Secondary:** adult and continuing-education learners, certificate students,
TAs organizing course information, and students on institution-specific LMS
deployments such as Laurier's MyLearningSpace.

## Where Motion helps, and where it stops

Motion assists with coursework directly: explaining what an assignment asks
for, extracting grading criteria, building a checklist, identifying missing
sections in a draft, suggesting an outline, comparing a draft against a rubric,
checking citations and formatting, explaining an error in code or a
calculation, and generating practice questions before an assessment.

Motion may prepare work and perform permitted typed browser actions, but the
consequence policy requires fresh confirmation for consequential actions. It
never acts inside a graded/timed/proctored attempt, submits assessed work, or
modifies remote course data. The boundary is enforced in `src/core/policy`.

## MVP scope

1. Chrome side panel and extension shell
2. D2L Brightspace page and course detection, including institution deployments
3. Deadline extraction with provenance, confidence and student correction
4. Source-linked local notes
5. Assignment requirement extraction into a checklist
6. Resumable workflow progress UI
7. Automatic tab-group creation
8. Permission and approval foundations
9. Local-first storage with a versioned schema
10. Clear restricted behaviour on graded assessments
11. AgentSession workspaces with provider selection and resumable model turns

Excluded: multi-LMS coverage, autonomous quiz answering, assignment submission,
discussion posting, general web automation, accounts, sync, any backend.

## Acceptance criteria

### A1 — Page and course detection
- On a supported D2L page, Motion names the course and page type within one
  second of the panel opening.
- On an institution deployment (MyLearningSpace), detection and extraction
  produce the same results as on a stock tenant for equivalent content.
  *Verified by a fixture-equivalence test, not by inspection.*
- On an unsupported page, Motion says so plainly and offers what it can still
  do. It never guesses a page type.

### A2 — Deadline extraction
- Each extracted deadline shows its source page, the raw text it came from, and
  when it was read.
- A date that could not be parsed unambiguously is shown as needing review, not
  as a fact.
- A student can correct, add, or archive any item; a later rescan never
  overwrites a corrected value.
- Ambiguous formats, missing years, missing times and DST boundaries are covered
  by tests.

### A3 — Source-linked notes
- A note retains course, page title, URL and capture time.
- Captured, student-written and generated text are visually distinguishable, and
  generated text is labelled wherever it appears.

### A4 — Requirement checklist
- Requirements extracted from an assignment link back to the instruction text
  they came from.
- A student can edit, add and remove items.

### A5 — Workflows
- A workflow shows its state, its completed / active / pending / skipped /
  blocked / failed steps, the sources it visited, and any warnings.
- Pause, resume, retry and cancel all work from the panel.
- **A workflow interrupted by service-worker suspension resumes without losing
  a completed step or repeating a side effect.** This is the load-bearing
  requirement; it is verified by a simulated-restart test, not by observation.

### A6 — Tab groups
- Related pages open in one named group, e.g. `Motion · CP363 · Assignment 2`.
- Motion never closes, reorders destructively, or steals focus from tabs it does
  not own; tabs the student moved or closed are treated as the student's
  decision.

### A7 — Consequence policy
- Automatic actions are low-risk and bounded; configurable actions require the
  student setting; consequential actions require a target-bound, single-use,
  two-minute fresh confirmation.
- No setting can make a fresh-confirmation or forbidden action always allowed.
- A prohibited action is refused even when an approval record claims approval.

### A8 — Restricted mode
- On a page that is or might be a graded attempt, Motion refuses page content,
  drafting and actions, and explains why in the panel.
- Detection is over-inclusive by design; a quiz *list* is not treated as an
  attempt.

### A9 — Accessibility
- Fully keyboard-operable with visible focus; usable at 200% zoom and at the
  narrowest supported panel width.
- Status is never conveyed by colour alone.
- Workflow progress is announced to screen readers.
- Colour pairs meet WCAG 2.2 AA, enforced by a test.

### A10 — Privacy
- Local mode uses the selected on-device provider when available. BYOK cloud
  mode requires disclosure acceptance and sends the goal/message, trusted
  session state and bounded relevant excerpts to the selected provider only,
  during the model turn.
- Keys live only in session storage; IndexedDB, telemetry and Motion servers
  receive none. Local data can be deleted in full.

## Success

A student opens an assignment, chooses **Prepare workspace**, and gets a named
tab group, a source-linked checklist and a notes page — while continuing to
browse, with every step visible and every consequential action theirs to approve.
