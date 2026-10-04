# Motion snapshot-based reviewer walkthrough

Captured 2026-10-04T21:58:41.852Z from production dist version 0.1.2.

Video: reviewer-demo.webm (1280×800, VP8 WebM, silent with visible captions; chapter timestamps are approximate). Reproduce after a production build with `node scripts/capture-reviewer-demo.mjs`.

The demonstration captures the actual production side-panel/options documents in headless Chromium, sampling their rendered UI into a separate captioned recording window. Course/API responses come only from synthetic repository fixtures. All unmatched HTTPS requests are aborted; Chromium DNS is disabled. No live LMS, AI provider, account, credential, or real course data is used.

- 0:00 — A focused workspace: On an ordinary website, Motion explains that the page is unsupported. Settings and your saved work remain accessible.
- 0:05 — Choose what to read: This Brightspace course is a synthetic fixture. Scanning stays off until the student explicitly enables it.
- 0:09 — Source-linked deadlines: The real extension scans local fixture responses, saves two deadlines, and filters them to PSYCH101. Exact times and source links stay visible.
- 0:13 — Plan this week: Week view separates this week from later coursework. Changing views preserves the selected course.
- 0:17 — Keep later work visible: List view retains the deadline two weeks away. Dates use the browser time zone; students check the LMS before submitting.
- 0:22 — Local document library: Students can explicitly import a PDF or PowerPoint. Indexing is local and does not require an AI provider. This recording shows the import control, not a completed import.
- 0:26 — Optional AI: Local AI depends on the review device. OpenAI and Anthropic require disclosure, endpoint permission, and the student’s own key. No key is entered here.
- 0:30 — Reminders start off: Students choose whether to enable reminders, then configure lead times and quiet hours. The fresh-profile checkbox is off.
- 0:34 — Clear privacy controls: Settings explains local records and optional cloud requests. Delete all Motion data removes browser records and configured keys; it does not alter the LMS.

Observed: two scanned deadlines, PSYCH101 course filter, List and Week views, and fresh-profile reminders off. Unexpected external requests: 0. Production UI page errors: 0.

Limits: this is a reviewer aid, not an authenticated institution test or reviewer login. No completed file import, AI generation, native-companion installation, consequential submission/upload/post, active assessment, deletion, or real browser-toolbar/side-panel opening is demonstrated. The extension documents are captured directly; browser chrome is not recorded.
