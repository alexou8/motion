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

Not covered by this run, and still **not verified**: the calendar route, the
announcements route, `navigateContent` topics, a live expired session, and the
graded-attempt route — which was deliberately not opened on a real account and
is covered only by `npm run test:extension` against a synthetic attempt page.

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

## Recording a defect

Record the route *shape*, not the URL — no org unit ids, course codes, student
names or query values. If a defect needs a fixture, hand-build a synthetic one
under `src/test/fixtures/d2l/` with invented values (`CS101`, `999999`,
`Example Assignment`) and the banner comment the other fixtures carry. Never
commit a raw DOM dump, HAR, screenshot, console log or browser profile.
