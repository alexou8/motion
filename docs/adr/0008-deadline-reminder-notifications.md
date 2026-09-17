# ADR 0008: Opt-in deadline reminder notifications

## Status

Accepted

## Context

Students need advance notice of locally observed D2L deadlines. The feature
must remain local-first, opt-in, and read-only toward the LMS. Chrome's
`notifications` permission is required to show a reminder after the service
worker wakes from an alarm.

## Decision

Declare only the narrow `notifications` permission. Store reminder preferences
and deterministic sent IDs in `chrome.storage.local`, with reminders disabled
by default. Use `chrome.alarms` names prefixed with `motion-reminder:` and
reconcile only that prefix, so workflow alarms remain independent. Re-load and
validate the task and preferences before every notification; submitted,
graded, archived, overdue, low-confidence, and active-assessment work never
produces a reminder.

Quiet-hour collisions move to the end of quiet hours. If that time is after
the due time, the reminder is skipped. This rule is visible in Reminders
settings and is covered by planner tests.

## Consequences

Chrome shows an OS-level notification only after the student opts in. The
notification can reveal the task title and due time to anyone who can see the
device's notifications, so the permission and local-only data use are called
out in the security and Web Store documentation. No LMS write permission or
network permission is added.
