# ADR 0007 — Agent sessions and consequence policy

- **Status:** Accepted
- **Date:** 2026-09-16

## Decision

Persist an `AgentSession` as the unit of a student goal, conversation, plan,
blockers, artifacts, sources and workspace. A workspace records tabs Motion
opened separately from tabs the student adopted; group membership alone never
establishes ownership.

Content is an observer plus a handle-based typed actor. Model output passes
layered prompts, Motion-issued references, a guard, policy and actor
defense-in-depth. Policy tiers are `automatic`, `configurable`,
`fresh-confirmation` and `forbidden`. Fresh approvals are target-bound,
single-use and valid for two minutes. No always-allow setting exists for
consequential actions, and the graded-attempt boundary is forbidden.

No chain-of-thought is persisted. A `pendingModelRequest` is persisted before
a provider request; recovery marks it blocked/retryable and does not resend it,
because a paid request may already have happened.

