# Reviewing changes to Motion

Every review of code, an implementation, or a fix — by a person or an agent,
of human- or AI-written work — follows this guide. `AGENTS.md` makes it
binding. Most of what gets written here is generated, so the reviewer, not the
generator, owns the result.

The review checklist below is adapted from *Engineer's Guide to Reviewing
AI-Generated Code*. The Motion-specific rules come from the product owner's
consent and safety decisions and design direction, recorded here so this file
stands on its own.

## Start with the problem

- State the problem, the constraints and the intended behaviour in your own
  words before reading the diff. If you cannot, stop and find out.
- Review structure, interfaces, data flow, state changes and failure paths
  first. Not every line deserves equal attention; the ones that can break the
  safety boundaries do.
- A change that is tidier but does not move the stated problem is not done.

## Motion's non-negotiables

A change that weakens any of these is rejected, however it is framed:

- **Assessment boundary.** Motion never submits assessed work, acts inside a
  graded attempt, or modifies remote course data. A restricted page yields no
  content, no links, and no tab operations — including a tab inside Motion's
  own group. No setting, consent or approval may route around
  `src/core/policy/assessment.ts`. If a design makes a boundary look like a
  setting, the design is wrong.
- **Managing tabs is not acting in a page.** Motion may create, arrange and
  close *its own* tabs. It never clicks, types or submits inside a page. The
  content script reads and reports and holds no privileged capability.
- **Ownership is recorded, never inferred.** A tab is Motion's because Motion
  recorded opening it in this browser session — not because it sits in
  Motion's group. Tabs the student opened or moved are the student's.
- **Consent is opt-in, per capability, revocable, and not per use.** A fresh
  install sends nothing anywhere and drives nothing. Consent to one capability
  is not consent to another. Revoking stops queued work immediately.
- **Privacy claims must be true on every path.** A claim true only on the
  default path, stated without qualification, is a defect.
- **Ephemeral worker.** No state in module scope; persist and read back per
  event. Anything with an external effect is idempotent and survives a worker
  restart mid-step.
- **Permissions.** No new Chrome permission without an ADR and a visible,
  argued diff to `src/manifest.config.ts`.

## The checklist

### 1. Correctness and edge cases
Happy path, invalid and empty input, boundaries, partial failure. State
transitions, concurrency (two presses, two triggers), idempotency and restart.
Errors are handled on purpose — never swallowed, never turned into a
misleading success. The panel says what went wrong in plain language.

### 2. Design and architecture
The change respects the module boundaries in `CLAUDE.md`: `src/core` stays
platform-agnostic, LMS routes and selectors live only in `src/core/adapters`,
the worker owns orchestration, the panel talks through typed messages. Prefer
the simplest design that meets the requirement. If you cannot explain why a
block is shaped the way it is, simplify it or ask.

### 3. Readability and maintainability
Names show state changes. Comments explain *why* or record a trade-off; a
comment that restates the code is removed. Delete dead code, duplication and
unrelated edits. Match the surrounding file's style.

### 4. Security and privacy
Validate every cross-context payload with Zod at the boundary — including
responses from Motion's own worker, a native host, or a provider. Authorize by
browser-asserted sender role, never by what a payload claims. Treat every page
string and link as hostile. Keep course content, prompts and drafts out of
logs and error messages. A new trust boundary needs a `docs/THREAT_MODEL.md`
entry in the same change, with a status that matches the code.

### 5. Reliability and operability
Retries never duplicate a side effect. Cancellation stops the next effect, not
only the final commit. Retries use `chrome.alarms`, never timers. Failure
degrades to an honest message rather than a hang.

### 6. Performance and scale
No unbounded loops or loads over page data; respect the limits in
`src/core/messaging/contracts.ts`. Think about a course with hundreds of tasks
and a student with dozens of tabs, not the fixture.

### 7. APIs and dependencies
Check unfamiliar Chrome APIs against `minimum_chrome_version` and the
installed `@types/chrome`. No new dependency without a stated reason. Watch for
invented interfaces and APIs from a different version.

### 8. Tests and verification
Tests assert outcomes — what the student sees, what is stored, which tabs
exist — not that a mock was called. A test must fail when the requirement
breaks. Every safety boundary a change touches gets a test proving it holds.
Fixtures are synthetic. Run `npm run typecheck`, `npm test`, `npm run lint`,
`npm run build` and `npm run test:extension`, and report actual output. Green
tests are evidence, not proof: anything browser-dependent is marked
"implemented but not verified" until it has run in a real browser.

### 9. Scope and production readiness
Keep the diff focused. Consider schema migrations, in-flight workflows across
an extension update, and rollback. Update `docs/ROADMAP.md` with evidence-based
status, and any doc whose claims the change affects.

## Design review

For anything visible, check against [`DESIGN.md`](DESIGN.md) and the direction
set on 2026-09-11 (to be folded into `DESIGN.md` as it is built):

- **Look:** Claude-like — a serif for headings (a bundled open-licence face;
  Claude's own fonts are proprietary and may not ship), IBM Plex Sans for body,
  a warm dark and light palette following the system setting, a terracotta
  accent. Motion keeps its own name and mark; it does not imitate another
  product's branding.
- **Use:** ChatGPT-like — the side panel is the main surface, with a chat
  about the current page plus Motion's own task actions (prepare workspace,
  checklist, draft review); the toolbar icon opens the panel and starts
  Motion's tab group on the current tab; settings live on a dedicated
  full-page options screen.
- Fonts are bundled; Motion makes no network request for them.
- Colour pairs pass `src/ui/tokens.contrast.test.ts`; keyboard operable;
  status never by colour alone; usable at the narrowest panel width.

## Red flags

- A simple requirement produced a large or heavily abstracted diff.
- Coverage from tests that only exercise lines or verify mocks.
- An unfamiliar API or security pattern accepted without verification.
- A broad `catch` that hides the real failure.
- A threat-model or roadmap status that claims more than the code does.
- "It works locally" as the only evidence.

## The bar

Before approving, you can say: I can explain how the parts work together and
why the important decisions exist; I verified the riskiest assumptions and
failure modes; I would be comfortable debugging this in production.
