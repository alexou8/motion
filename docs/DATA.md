# Data

Everything Motion stores lives in the browser, in IndexedDB, under the
extension's origin. There is no server ([ADR 0002](adr/0002-local-first-no-backend.md)).

## Stores

| Store | Holds | Key | Indexes |
| --- | --- | --- | --- |
| `courses` | Course identity and term | `id` | `byPlatform` |
| `tasks` | Assignments, quizzes, discussions with due dates | `id` | `byCourse`, `byDue` |
| `notes` | Source-linked notes, block by block | `id` | `byCourse`, `byTask` |
| `checklists` | Requirements extracted from instructions | `id` | `byTask` |
| `workflows` | Workflow state and step history | `id` | `byStatus`, `byUpdatedAt` |
| `approvals` | Approval requests and their decisions | `id` | `byWorkflow`, `byStatus` |
| `auditEvents` | Browser actions and consequential decisions | `seq` (auto) | `byAt`, `byWorkflow` |
| `meta` | Schema and housekeeping values | `key` | — |

Schema version and migrations: `src/core/storage/schema.ts`. Migrations are an
ordered, replayable list so a database at any older version applies only the
steps it missed; a build-time invariant keeps the version equal to the migration
count. Migration replay from version 0 and row survival across reopen are tested.

## Provenance

Every extracted record carries where it came from:

```
sourceUrl          canonical page URL
pageTitle          the page's title at capture time
platformId         which adapter produced it (e.g. "d2l")
pageType           normalized page kind
capturedAt         when it was read
extractionVersion  which parser version produced it
strategy           which extraction strategy matched
```

`extractionVersion` exists so a later, better parser can identify rows produced
by an older one and offer to re-verify them, rather than silently trusting them.

## Due dates keep their evidence

A due date is not just an instant. Motion stores:

- `raw` — the exact page text, always, even when parsing succeeded
- `iso` — the resolved instant, or `null` when nothing parseable was found
- `zoneEvidence` — `explicit` when the page named a zone, `assumed-local`
  otherwise, `none` when nothing parsed
- `timeAssumed` — true when the page gave a date but no clock time
- `confidence` — `confirmed` / `high` / `medium` / `low`

LMS pages rarely state a timezone. Recording that the zone was *assumed* rather
than quietly resolving against the browser's zone is the difference between a
time a student can trust and one that is wrong twice a year — and around a DST
boundary, a "11:59 PM" deadline can land an hour off.

Anything below `high` is presented as needing review, not as fact.

## Corrections are additive

When a student fixes an extracted value, the original is kept:

```
corrections: [{ field, originalValue, correctedValue, correctedAt }]
studentEdited: true
```

`studentEdited` stops a later rescan from overwriting the student's answer. The
original is retained so a mistaken correction is recoverable, and so Motion can
tell whether its parser or the student was right when they later disagree.

## Notes distinguish who wrote what

Note blocks carry an `origin` of `captured`, `student`, or `generated`, with
`generatedBy` naming the model for generated blocks. This is what makes "clearly
label AI-generated content" a property of the data rather than a UI convention
that a future screen might forget.

## What is never stored

Passwords. Session tokens or cookies copied from pages. Model API keys. Page
HTML. Browsing history unrelated to a supported course page. Anything from a
page detected as a graded attempt.

## Retention and deletion

Nothing expires on its own; a student's own course history is theirs to keep.
Deletion removes the IndexedDB database outright, which is covered by a test so
"delete my data" is verified rather than asserted. Export is planned alongside
the options UI.

## Encryption

Local data is **not** encrypted beyond the protections the browser profile
already provides, and Motion does not claim otherwise. Encrypting it inside the
extension would require the extension to hold the key too, which protects
against very little while making recovery worse. Someone with the unlocked
device and profile can read it. That is stated in
[`THREAT_MODEL.md`](THREAT_MODEL.md) under accepted risks rather than hidden.
