# Academic integrity policy

Motion is a learning and workflow-support tool. It is not a system for producing
or submitting assessed work. This document states where the line is, and points
at the code and tests that enforce it — the policy is executable, not a promise.

Enforcement lives in [`src/core/policy/`](../src/core/policy/) and is covered by
`src/core/policy/policy.test.ts`.

## Four tiers

### Allowed — no approval needed

Local, reversible, and confined to information the student can already see.

- Reading a page the student has open and is authorized to view
- Extracting deadlines, requirements and course structure
- Creating and editing local notes
- Opening a tab, creating a tab group
- Organizing information Motion already holds

### Approval required — the student confirms first

Changes student-controlled state, or prepares something with an external effect.

- Editing a draft the student owns
- Creating a checklist
- Adding a calendar event
- Preparing (not sending) a message

### Restricted — Motion drops to learning-support mode

On a page that is, or might be, a graded attempt, Motion stops working as a
workspace. It will not read the attempt into storage, draft anything, or take
any action. It can explain concepts and show notes the student already made.

Detection is deliberately over-inclusive: the known attempt page type, plus URL
patterns and page-text signals (`time remaining`, `question N of M`, `proctor`,
`lockdown browser`). Institution deployments and third-party quiz tools do not
all use canonical routes, so route matching alone is not enough.

A false positive costs a student a convenience. A false negative costs them an
integrity violation. The asymmetry decides the default.

### Prohibited — never, regardless of approval

- Submitting an assignment
- Answering or acting within a graded quiz, test or exam
- Modifying or deleting remote course data

These are not high-risk actions behind a scarier dialog. `isApprovalUsable()`
checks the prohibition *before* it reads approval status, so a forged, replayed
or corrupted approval record cannot reach them. There is a test for exactly that
case.

Motion also never bypasses proctoring, access controls, time limits, or
institutional authentication.

## Why "with approval" is not enough for the prohibited tier

A student can consent to almost anything Motion does to their own notes. They
cannot consent on behalf of the third party in the relationship — the instructor
and institution assessing their work. Submitting work that Motion authored
misrepresents authorship to someone who never agreed to it. Consent from one
party does not settle a question that involves two.

## What this means for marketing

Motion is never described as finishing assignments, acing quizzes, or completing
coursework for a student. Claims like those would be false given the code, and
would attract exactly the users the product should not serve.

## Ambiguity

When Motion cannot tell whether a page is assessed, it restricts and explains
why, naming what it can still do. Failing safe is more useful than failing
silently: a student who understands the restriction can work around it honestly.
