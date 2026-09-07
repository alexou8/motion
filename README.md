# Motion — From Coursework to Completion

An asynchronous learning workspace for getting coursework done.

Motion is a Chrome extension that turns scattered LMS pages, deadlines, notes and
assignments into one visible, student-controlled workflow. It reads the course
pages you are already authorized to see, pulls out what is due and what is asked
of you, keeps notes linked back to their source, and runs longer jobs in the
background while showing you every step it takes.

> Motion takes coursework all the way to a draft you review — then stops. It
> does not submit your work and does not act inside a graded quiz attempt. You
> read it, rewrite it in your own words, and hand it in yourself. That boundary
> is enforced in code and covered by tests, not just stated here.

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
  institution deployments such as Laurier's MyLearningSpace.
- **Turns an assignment into a checklist.** Every item traces back to the
  sentence in the instructions it came from. When nothing on the page is
  actually stated as a requirement, Motion says so rather than inventing one.
- **Drafts the work.** Outlines, first drafts, sections, discussion replies,
  revisions — written from your requirements and your own notes, on-device.
  Anything the material could not support comes back marked
  `[needs a source]` so you can see exactly what to check.
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
  Low-risk work happens; anything else stops and asks, with the specific target
  and effect spelled out.

## Design principles

1. **Visible progress.** Every long-running job exposes its state and its
   blockers. No spinner that means nothing.
2. **Student control.** Consequential actions are reviewable and editable before
   they happen.
3. **Source provenance.** An extracted fact you cannot trace is a rumour.
4. **Local-first privacy.** Data stays on the device. See
   [ADR 0002](docs/adr/0002-local-first-no-backend.md).
5. **Adapter isolation.** LMS quirks stay behind one boundary. See
   [ADR 0003](docs/adr/0003-adapter-isolation.md).
6. **Resumable reliability.** Designed for a service worker that dies mid-task.
7. **Learning before automation.** Motion helps you understand and prepare; it
   does not stand in for you.
8. **Calm clarity.** A side panel beside a busy LMS should recede, not compete.

## Getting started

Requires Node 22+.

```bash
npm install
npm test          # unit, adapter fixture, and policy tests
npm run typecheck
npm run build     # emits dist/
```

### Install it in Chrome

**Download the latest merged build:** [motion-extension-latest.zip](https://github.com/alexou8/motion/releases/latest/download/motion-extension-latest.zip)

This download is refreshed after every pull request merged into `main`, but only
after the extension passes its type checks, tests, build, and package validation.

1. Download and unzip `motion-extension-latest.zip`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.
4. Open a D2L or MyLearningSpace course page and click the Motion icon.

Builds for open pull requests remain available from GitHub Actions. Tagged
version releases (`v*`) continue to provide permanent versioned downloads.

**From a checkout:**

```bash
npm run dist     # build + package
```

That writes `motion-extension-<version>.zip`. Unzip it and load the folder as
above, or load `dist/` directly with **Load unpacked**.

Chrome 116 or newer. Drafting additionally needs Chrome's built-in on-device
model — Motion says so plainly if it is unavailable rather than failing when you
press the button.

## Privacy

Motion requests the narrowest permissions that make the current feature work,
and the supported domains are visible in the extension's options. It stores data
locally in IndexedDB, makes no network requests of its own, and bundles its
fonts rather than loading them from a CDN — so using Motion does not tell a
third party that you are using it.

Drafting runs on Chrome's built-in on-device model, so your coursework, notes
and drafts are never sent anywhere ([ADR 0004](docs/adr/0004-on-device-model.md)).
Motion never stores passwords or session tokens, and never bypasses
institutional authentication.

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

## Licence

MIT for Motion's own source. Bundled fonts are licensed separately — see
[`LICENSES.md`](LICENSES.md).
