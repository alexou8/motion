# ADR 0003 — Confine LMS knowledge to adapters

- **Status:** Accepted
- **Date:** 2026-09-07

## Context

LMS markup is hostile to automation: institutions skin D2L differently, markup
changes without notice, and the same logical page differs across deployments
(`mylearningspace.wlu.ca` is a D2L Brightspace instance with its own theme,
navigation wrapper, and course-naming conventions).

## Decision

All platform-specific knowledge — hostnames, routes, DOM selectors, quirks —
lives under `src/core/adapters/`. Nothing else in the codebase may contain a
selector or branch on an LMS. Adapters are pure readers: given a URL and a
`Document`, they return normalized domain objects. They never click, submit,
navigate, or mutate the page.

## Rationale

1. **Selector drift is inevitable; blast radius should not be.** When Laurier
   re-themes MyLearningSpace, the fix must be one file and its fixtures.
2. **Testability.** A pure `(url, document) -> domain` function is testable
   against saved HTML fixtures with no browser and no LMS account.
3. **Read-only by construction.** Keeping extraction incapable of acting means
   the academic-integrity boundary does not depend on remembering to check a
   flag in the extraction path.

## Consequences

- Adding a platform means writing an adapter and fixtures, not touching the UI.
- Adapters must degrade rather than guess. A missing selector yields a warning
  and fewer results; it never yields a plausible-looking fabricated deadline.
  A wrong deadline is worse than an absent one, because a student will act on it.
- Fixtures are authored synthetic HTML. Real course pages are never committed:
  they contain student data, and Motion's tests must be runnable by anyone.
