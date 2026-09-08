# Manual live test procedure (D2L / MyLearningSpace)

Automated tests run against synthetic fixtures only. They cannot tell you
whether Motion works on a real, signed-in Brightspace deployment: no fixture
reproduces D2L's web components, its client-side navigation, or an institution
skin. This procedure is the check that does, and it must be run by a person with
their own account.

**Nothing in this procedure is currently recorded as passing.** Fill in the
matrix when you run it, and say which build you ran it against.

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

## Recording a defect

Record the route *shape*, not the URL — no org unit ids, course codes, student
names or query values. If a defect needs a fixture, hand-build a synthetic one
under `src/test/fixtures/d2l/` with invented values (`CS101`, `999999`,
`Example Assignment`) and the banner comment the other fixtures carry. Never
commit a raw DOM dump, HAR, screenshot, console log or browser profile.
