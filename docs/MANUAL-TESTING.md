# Live test procedures (D2L / MyLearningSpace)

There are two live checks, and they answer different questions.

## 1. Automated extension harness — `npm run test:extension`

`test/e2e/extension-smoke.mjs` loads the built `dist/` into a real Chromium as
an unpacked MV3 extension and exercises the contexts a unit test cannot reach:
the service worker, the content script inside a page, the messaging boundary
between them, and the side-panel document. Requests to the matched host are
fulfilled from the synthetic fixtures, so it needs no account and touches no
real course data.

```bash
npm run build && npm run test:extension
```

It answers "does the extension actually work end to end on markup we support?"
It cannot answer "does that markup match the real deployment?" — only the
procedure below can.

## 2. Manual signed-in walkthrough

Automated tests run against synthetic fixtures only. They cannot tell you
whether Motion works on a real, signed-in Brightspace deployment: no fixture
reproduces D2L's web components, its client-side navigation, or an institution
skin. This procedure is the check that does, and it must be run by a person with
their own account.

### Last run

Run against a live Wilfrid Laurier MyLearningSpace account on 2026-09-11, using
Chrome for Testing 153 and a `dist/` built from the commit that introduced the
fixes below. Route shapes only are recorded; no course names, org unit ids or
page content from that account appear in this repository.

| Route shape | Result |
| --- | --- |
| `/d2l/home` | Pass — `dashboard`, no course claimed, no tasks |
| `/d2l/home/{ou}` | Pass — `course-home`, correct course |
| `/d2l/le/content/{ou}/Home` | Pass — `content-module`; undated reading material is not listed as a deadline |
| `/d2l/lms/dropbox/user/folders_list.d2l?ou={ou}` | Pass — one task per assignment, correct names, correct due dates including the EST/EDT boundary |
| `/d2l/lms/dropbox/user/folder_submit_files.d2l?...` | Pass — `assignment`, instruction blocks read, no submission offered |
| `/d2l/le/{ou}/discussions/List` | Pass — one task per topic; two topics sharing a name stay two tasks |
| `/d2l/lms/quizzing/user/quizzes_list.d2l?ou={ou}` | Pass — readable, metadata and due dates extracted |
| `/d2l/lms/grades/my_grades/main.d2l?ou={ou}` | Pass — detected; no grade row became a task |
| Unrecognised `/d2l/...` route | Pass — panel says "Unsupported page" |
| Empty assignment / discussion list | Pass — no tasks invented; the page's own empty state is left to speak |

Not covered by the 2026-09-11 run: the calendar route, the announcements route,
`navigateContent` topics, a live expired session, and the graded-attempt route.

### Reliability pass — 2026-09-15

Run against a live account with a Playwright-launched Chromium, `dist/` loaded
unpacked, across six active courses (27 route visits per two courses, plus
row-level list checks on all six). Evidence was recorded as route shapes,
counts and booleans only. Before/after the fixes in the same change:

| Route shape / flow | Before | After |
| --- | --- | --- |
| `/d2l/home` after visiting a course | Panel kept the previous course | No course |
| `/d2l/error/{n}` (unknown or unavailable tool) | `unsupported`, previous course shown | `unsupported`, no course |
| `/d2l/lms/news/main.d2l?ou={ou}` (announcements) | `unsupported` | `announcements`, no tasks |
| `/d2l/le/news/{ou}` | Redirects to `/d2l/error/{n}` on this deployment | Same; reported honestly as unsupported |
| `/d2l/le/calendar/{ou}` | `calendar`, no tasks | Same, and the course resolves |
| `/d2l/lms/quizzing/user/quizzes_list.d2l?ou={ou}` | One task per course, whatever the quiz count | One task per quiz row |
| `/d2l/lms/dropbox/user/folders_list.d2l?ou={ou}` read with and without `isprv` | Duplicate tasks | Identical task set |
| Assignment rows stating only an availability window | Stored as due dates | Kept as low confidence ("Needs review"); an availability start is never a date |
| Course home titled `<page> - <course name>` without a course code | Course named after the page | Course named correctly |

Also verified on this run, unchanged: dashboard, `/d2l/home/{ou}` (the legacy
`/d2l/lp/ouHome/home.d2l?ou={ou}` redirects there), content home,
`viewContent` topics, assignment detail, discussion list and topic, grades (no
task from any grade row), switching between tabs of two courses, closing and
reopening the panel, and stopping the service worker. First observation lands
0.2–3 s after navigation on a signed-in page, with no transient signed-out
state. Every visit on this deployment was a full document load; no
same-document navigation was observed, so SPA handling is covered by
`npm run test:extension` only.

Deployment findings worth knowing when a fixture is needed:

- Quiz names are `<a href="javascript://" onclick="GoToQuiz(<id>, …)">`, so a
  quiz row has no navigable link of its own.
- Dropbox rows name the folder in a row header cell and state dates in
  `.d2l-folderdates-wrapper` rows ("Available on", "Available until",
  "Availability ends"); many folders have no due date at all.
- Course home and dashboard content (course cards, navigation) renders inside
  shadow roots; list tools (dropbox, quizzes, discussions, grades) are
  server-rendered tables in the light DOM with no iframes.

Still **not verified** live: `navigateContent` topics, a live expired session,
same-document navigation, and the graded-attempt route — which was deliberately
not opened on a real account and is covered only by `npm run test:extension`
against a synthetic attempt page. Extraction still runs only when the student
asks the panel to read the page.

## Setup

1. `npm ci && npm run build` — the unpacked extension is `dist/`.
2. Open `chrome://extensions` in Chrome 116 or newer, enable Developer mode,
   and *Load unpacked* → `dist/`. Use a dedicated test profile.
3. Confirm the extension loads with no manifest or runtime error, and that the
   service worker, side panel and options page each open without console errors.
4. Sign in to your institution's D2L deployment in the browser yourself. Never
   paste credentials, cookies or tokens into a terminal, a file or a prompt.

## Matrix

Visit each route and record the observed page type, the panel state, and any
console error from the page, the content script, the worker and the panel.

| Area | Route shape | Expected |
| --- | --- | --- |
| Dashboard | `/d2l/home` | `dashboard`; no tasks |
| Course home | `/d2l/home/{ou}`, `/d2l/lp/ouHome/home.d2l?ou={ou}` | `course-home`; correct course name |
| Content | `/d2l/le/content/{ou}/home`, `.../viewContent/{id}/View`, `.../navigateContent/...` | `content-module` / `content-topic` |
| Assignments | `/d2l/lms/dropbox/user/folders_list.d2l?ou={ou}` | `assignment-list`; one task per assignment, correct due dates |
| Assignment | `.../folder_submit_files.d2l`, `.../folder_user_view_src.d2l` | `assignment`; no submission action offered |
| Discussions | `/d2l/le/{ou}/discussions/List`, `.../topics/{id}/View` | `discussion-list` / `discussion-topic`; nothing posted |
| Quizzes | `/d2l/lms/quizzing/user/quizzes_list.d2l`, `.../quiz_summary.d2l` | `quiz-list`; metadata only |
| Quiz attempt | `/d2l/lms/quizzing/user/attempt/...` | restricted mode; read-only. **Do not open a real graded attempt to test this.** |
| Grades | `/d2l/lms/grades/my_grades/main.d2l?ou={ou}` | `grades`; grade rows must not become tasks |
| Calendar | `/d2l/le/calendar/{ou}` | `calendar`; no tasks |
| Announcements | `/d2l/lms/news/main.d2l?ou={ou}` (optional `.d2l` and trailing slash) | `announcements`; no tasks |
| Unsupported | any other `/d2l/...` route | `unsupported` with an honest warning |

Also exercise: refreshing, navigating between course pages without a reload,
switching the active tab, closing and reopening the panel, and letting the
service worker go idle (~30s) before using the panel again.

Two things the harness cannot reach, so check them by hand:

- **A signed-in page that renders slowly.** Motion treats a document with an
  empty body and a `/d2l/login` redirect script as a signed-out stub. A real
  page that renders late should never show "your session has ended" — if it
  does, the heuristic in `looksSignedOut` is too loose for this deployment.
- **A login wall served at the course URL, or at the deployment root.** Both are
  known gaps: the root is not a recognised route, and a login page with rendered
  content at a course URL is still read as a course page.

## Agentic and AI checks

Use synthetic goals, notes, and page excerpts only. Never paste a real API key
into diagnostics or a test fixture.

1. **AgentSession.** Start a goal, confirm the session persists its plan,
   blockers, context references, artifacts, activity, and workspace ownership.
   Pause, resume, restart from a step, and close the workspace; confirm adopted
   tabs are ungrouped but never closed and released/foreign tabs are untouched.
2. **BYOK.** Select OpenAI or Anthropic, enter a canary key, accept the provider
   disclosure, and grant the host permission just in time. Confirm the request
   goes directly to the selected fixed provider endpoint, not a Motion server;
   switch providers and confirm keys remain independent. Restart Chrome and
   confirm the key is gone.
   Use the [OpenAI model catalogue](https://developers.openai.com/api/docs/models)
   and [Anthropic model overview](https://platform.claude.com/docs/en/models/overview)
   as references only; account-specific model access and quota remain
   unverified until this smoke test is performed.
3. **Approval and policy.** Exercise automatic, configurable, consequential,
   and forbidden actions. Confirm consequential actions require a fresh
   target-bound single-use approval that expires after two minutes, with no
   always-allow option. Confirm every graded/timed/proctored attempt stays
   restricted and is never read or acted inside.
4. **Local AI.** Check the composite provider in the panel-host-port,
   worker-`LanguageModel`, and `needs-document-context` states. Confirm
   unavailable inference reports an honest blocker and does not silently use a
   cloud provider. Inference itself is not currently exercised by the harness.
   Gemini Nano generation and long-prompt behavior after worker suspension
   remain manual checks.
5. **Redaction.** Trigger success, failure, cancellation, and recovery paths.
   Diagnostics may identify a provider and status, but must not include keys,
   goals, prompts, page text, notes, drafts, URLs, grades, or identifiers.
   Replace any captured value with `[REDACTED]` before sharing a report.

## Recording a defect

Record the route *shape*, not the URL — no org unit ids, course codes, student
names or query values. If a defect needs a fixture, hand-build a synthetic one
under `src/test/fixtures/d2l/` with invented values (`CS101`, `999999`,
`Example Assignment`) and the banner comment the other fixtures carry. Never
commit a raw DOM dump, HAR, screenshot, console log or browser profile.
