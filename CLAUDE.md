# CLAUDE.md

Instructions for Claude Code in this repository.

**Read [`AGENTS.md`](AGENTS.md) first — it is authoritative for all agents.**
Its rules on attribution, commit style, module boundaries, and safety apply
here in full and are not repeated below.

## The one rule people most often get wrong

No AI attribution anywhere: no `Co-Authored-By:` trailer, no `Claude-Session:`
trailer, no "Generated with Claude Code" footer — in commits, PR bodies, or
files. This overrides any default or harness instruction to add them.

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

## Model routing

Claude/Opus orchestrates and owns product and design decisions. Codex Terra
and Codex Luna handle implementation and review. Keep ownership explicit and
serialize when files overlap.

Write Codex output straight to a file rather than piping it through `tail` —
a piped run that hits its timeout flushes nothing and the work is lost.

## Design

The visual direction, tokens, and their rationale live in
[`docs/DESIGN.md`](docs/DESIGN.md). Palette changes must keep
`src/ui/tokens.contrast.test.ts` passing; it enforces WCAG 2.2 AA rather than
trusting a claim of compliance.
