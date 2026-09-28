# CLAUDE.md

Instructions for Claude Code in this repository.

**Read [`AGENTS.md`](AGENTS.md) first — it is authoritative for all agents.**
Its rules on attribution, commit style, module boundaries, and safety apply
here in full and are not repeated below.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Type check | `npm run typecheck` |
| Unit + fixture tests | `npm test` |
| Single suite | `npx vitest run src/core/policy` |
| Lint | `npm run lint` |
| Build extension | `npm run build` (emits `dist/`) |

Node 22+. npm is the only package manager; commit `package-lock.json`.

## Architecture constraints

```
src/core/       platform-agnostic — no chrome.*, no React
  domain/       Zod schemas and types (authoritative)
  adapters/     the ONLY place LMS selectors may live
  parse/        due-date and text parsing
  ai/           provider contracts, prompts, selection and redaction
  agent/        intents, plans, trusted refs and tool guards
  session/      AgentSession state and transitions
  graph/        course links and queries
  policy/       risk classification, approvals, assessment restriction
  storage/      IndexedDB schema, migrations, repositories
src/platform/   thin mockable wrappers over chrome.*
src/background/ MV3 service worker — owns ALL orchestration
src/content/    observer + typed actor — snapshot/handle actions only
src/sidepanel/  React UI — talks to the worker via typed messages only
src/ui/         design system: tokens and components
```

Service workers are ephemeral. Never hold state in a module-level variable;
persist it and read it back on each event.

## Work coordination

Keep product decisions, bounded implementation, and targeted checks explicit.
When files overlap, serialize the work and record the relevant decision in the
changed artifact. Browser verification is a separate, targeted check against
the built extension; its evidence remains pending until that check runs.

## Design

The visual direction, tokens, and their rationale live in
[`docs/DESIGN.md`](docs/DESIGN.md). Palette changes must keep
`src/ui/tokens.contrast.test.ts` passing; it enforces WCAG 2.2 AA rather than
trusting a claim of compliance.
