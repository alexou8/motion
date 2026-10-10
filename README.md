# Motion — From Coursework to Completion

An asynchronous learning workspace for getting coursework done.

Motion is a Chrome extension that turns scattered LMS pages, deadlines, notes and
assignments into one visible, student-controlled workflow. It reads the course
pages you are already authorized to see, pulls out what is due and what is asked
of you, keeps notes linked back to their source, and runs longer jobs in the
background while showing you every step it takes.

Its purple-and-gold rising M joins an open-book fold with an upward arrow,
moving from coursework toward completion. The same mark appears in the toolbar,
side panel, settings page and browser tabs; the workflow track inside the panel carries the detailed state.

> Motion can prepare coursework and perform supported consequential actions only
> after a fresh, target-specific confirmation each time. It never acts inside a
> graded, timed or proctored attempt. That boundary is enforced in code and
> covered by tests, not just stated here.

## Status

Early. This repository is a work in progress toward the MVP described in
[`docs/ROADMAP.md`](docs/ROADMAP.md). What is implemented, and what is only
scaffolded, is tracked there honestly — nothing below claims a capability the
tests do not cover.

## Why it exists

A student in three courses is working across an LMS, a slide deck, two readings,
a discussion board and a calendar — in nine tabs, with notes in a different app.
Generic task managers do not understand any of that structure. They can hold a
to-do list, but they cannot tell you that the thing due Friday has a rubric you
have not opened.

Motion knows what an assignment page is.

## What it does

- **Reads the LMS you are on.** D2L Brightspace first, including
  brightspace.com and desire2learn.com subdomains and Laurier's
  mylearningspace.wlu.ca. Other institution domains are not supported yet.
- **Keeps coursework in one view.** Browse saved assignments, quizzes,
  discussions and lecture materials by course, type, status or title. Slides
  and handouts without deadlines remain visible without invented due dates.
  Read a content module or a supported topic to add its items.
- **Searches inside lecture files.** Library indexes selectable PDF text and
  PowerPoint (.pptx) slide text locally, with page/slide references. Choose a
  file exposed by the current LMS topic or import a downloaded copy. It accepts
  files up to 20 MB and reports partial or image-only content honestly; OCR
  and legacy `.ppt` files are not supported. Indexing sends nothing to AI.
- **Turns an assignment into a checklist.** Every item traces back to the
  sentence in the instructions it came from. When nothing on the page is
  actually stated as a requirement, Motion says so rather than inventing one.
- **Drafts the work.** Outlines, first drafts, sections, discussion replies,
  revisions — generated through the selected local provider or, when you
  explicitly configure BYOK cloud mode, the provider you selected.
  Anything the material could not support comes back marked
  `[needs a source]` so you can see exactly what to check.
- **Lets you choose the AI model.** Settings offers named OpenAI and Claude
  models, including economical choices for routine coursework. Refresh models
  checks the models available to your API account; explicit unavailable choices
  are blocked rather than replaced. API keys last for the browser session by
  default; explicit opt-in can remember them in an OS credential vault through
  a separately installed companion.
- **Checks your draft against the rubric** before you hand it in, and tells you
  where it compared wording only rather than pretending to grade you.
- **Extracts deadlines with their receipts.** Every due date keeps the raw text
  it came from, the page it came from, when it was read, and how confident the
  parser was. Anything ambiguous is shown as needing review rather than
  presented as fact.
- **Keeps notes attached to their source.** A note remembers the course, page
  and URL it came from, and separates what you wrote from what was captured
  from a page and what was generated.
- **Runs work in the background.** Long jobs survive the browser suspending the
  extension, and show completed, active, pending, blocked and failed steps.
- **Asks before anything consequential.** Actions are classified by consequence.
  Low-risk work happens; submission, posting, uploading, sending and other
  consequential actions stop for a fresh, single-use confirmation bound to the
  specific target and effect.

## Design principles

1. **Visible progress.** Every long-running job exposes its state and its
   blockers. No spinner that means nothing.
2. **Student control.** Consequential actions are reviewable and editable before
   they happen.
3. **Source provenance.** An extracted fact you cannot trace is a rumour.
4. **Local-first privacy.** Motion has no Motion server or telemetry. Local
   mode keeps model work on-device; BYOK cloud mode sends only the disclosed
   step context to the selected provider. See [ADR 0005](docs/adr/0005-ai-provider-abstraction-and-byok.md).
5. **Adapter isolation.** LMS quirks stay behind one boundary. See
   [ADR 0003](docs/adr/0003-adapter-isolation.md).
6. **Resumable reliability.** Designed for a service worker that dies mid-task.
7. **Learning before automation.** Motion helps you understand and prepare; it
   does not stand in for you.
8. **Calm clarity.** A side panel beside a busy LMS should recede, not compete.

## Getting started

Chrome Web Store submission materials are in [CHROMEWEBSTORE.md](CHROMEWEBSTORE.md),
with the exact upload package and checks in
[submission verification](docs/verification/submission-readiness-2026-10-04.md).
The [public privacy policy](https://alexou8.github.io/motion/privacy.html) is
published; the extension has not been submitted or approved. Developer-dashboard
fields and any requested authenticated reviewer access remain publisher steps.

Requires Node 22+.

```bash
npm install
npm test          # unit, adapter fixture, and policy tests
npm run typecheck
npm run build     # emits dist/
```

Working in VS Code? `code motion.code-workspace` opens the repository with its
build, test, and Chrome-debugging configuration already set up —
see [`docs/development/vscode.md`](docs/development/vscode.md).

### Install it in Chrome

**From the Chrome Web Store (recommended):** install Motion from its store
listing. Chrome keeps it updated automatically. After installing, open a
Brightspace course page and click the Motion toolbar icon.

**Developer builds.** To try unreleased changes, download the latest main build: [motion-extension-latest.zip](https://github.com/alexou8/motion/releases/download/main-build/motion-extension-latest.zip)

This development prerelease refreshes after a passing `main` build, including
merged pull requests. All release paths use the same type, unit, lint, browser
and package checks. Tagged versions remain separate permanent releases and
include SHA-256 checksums. See [release instructions](docs/releases.md) for
versioned downloads, integrity verification and recovery.

1. Download and unzip `motion-extension-latest.zip`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.
4. Open [MyLearningSpace](https://mylearningspace.wlu.ca/d2l/home) or another
   supported D2L course page and click the Motion toolbar icon.
   Use the popup's explicit Start/Continue action to open the side panel and
   begin or resume the workspace; the toolbar click alone does not create an
   automatic group.

Builds for open pull requests remain available from GitHub Actions. Tagged
version releases (`v*`) continue to provide permanent versioned downloads.

**From a checkout:**

```bash
npm run dist     # build + package
```

That writes `motion-extension-<version>.zip`. Unzip it and load the folder as
above, or load `dist/` directly with **Load unpacked**.

After replacing an unpacked build, click Motion's **Reload** control on the
browser's Extensions page, then refresh already-open LMS pages. Reopening the
panel alone can leave the old worker and content scripts running alongside the
new interface. See Chrome's [component reload guidance](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world).

Chrome 116 or newer; PDF text indexing requires Chromium 125 or newer.
Drafting additionally needs Chrome's built-in on-device
model — Motion says so plainly if it is unavailable rather than failing when you
press the button.

## Privacy

Motion requests the narrowest permissions that make the current feature work,
and the supported domains are visible in the extension's options. It stores
coursework data locally in IndexedDB and bundles its fonts rather than loading
them from a CDN. Local model mode stays on-device; BYOK cloud mode is described
below.

In local mode, model work stays on-device. In BYOK cloud mode, only during a
model turn after disclosure acceptance, Motion sends your message, session
plan/state labels, relevant notes, and bounded excerpts from pages Motion read
for that session to the selected provider. Each source excerpt is at most
8,000 characters and each request is at most 24,000 characters; excluded
sources are omitted. Coursework data stays in IndexedDB; provider keys default
to trusted session storage. Explicit opt-in stores keys only in the OS vault
through the optional companion. Motion never stores LMS passwords or session tokens, and
never bypasses institutional authentication. See [DATA](docs/DATA.md).

Details and threat model: [`docs/SECURITY.md`](docs/SECURITY.md),
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements and acceptance criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Boundaries, data flow, extension lifecycle |
| [`docs/DATA.md`](docs/DATA.md) | Data model, provenance, retention, deletion |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Trust boundaries and secure-development rules |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Threats, controls, residual risk |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased milestones with evidence-based status |
| [`docs/adr/`](docs/adr/) | Architecture decision records |
| [`SKILLS.md`](SKILLS.md) | Installed agent skills and when they apply |
| [`docs/development/vscode.md`](docs/development/vscode.md) | VS Code workspace, tasks, and extension debugging |

## Chrome Web Store submission

Run `npm run dist` to build and package the production extension. The package
gate rejects test permissions, missing icons, development files, and missing
bundled licenses. Listing copy, screenshots, permission explanations, and the
remaining dashboard steps are in [CHROMEWEBSTORE.md](CHROMEWEBSTORE.md); the
privacy policy source is [docs/PRIVACY.md](docs/PRIVACY.md). Preparing a ZIP does
not publish the extension or its policy.

## Licence

MIT for Motion's own source. Bundled fonts are licensed separately — see
[`LICENSES.md`](LICENSES.md).

### Remember API keys securely

Motion defaults to keys that last for the browser session. If you prefer to
enter a key once, install the optional local [keychain companion](docs/keychain-companion.md)
and choose **Remember key securely on this device** in Settings. The companion
is a small local program that stores the key in your OS credential vault and
lets Motion retrieve it after a restart. It has no server. **Forget key** removes
both the remembered key and the current session copy.
