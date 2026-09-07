# Design direction

## The brief, restated

A panel roughly 400px wide, docked beside a learning-management system that is
already visually loud, open for hours while a student works. It has to answer
three questions in about two seconds: *where am I, what needs me, and what is
Motion doing right now.*

That form factor rules a lot out before taste enters. There is no hero. There is
no room for a card grid. Anything decorative costs a line of coursework.

## What was rejected, and why

Running the design-system generator on this brief returned a landing-page
pattern (hero → product video → CTA), a teal/orange palette and Plus Jakarta
Sans. It was rejected under that skill's own query contract: the pattern did not
fit the product surface, and the palette and typeface are the SaaS default —
which is to say, not a choice.

Also avoided, as the current tells of generated design: cream-and-terracotta,
near-black with an acid accent, purple gradients, glassmorphism, identical
rounded cards for everything, tracked-out all-caps eyebrow labels, and `→`
appended to link text.

## The one idea: the track

Motion's single visual device is a continuous vertical rule — a **track** — that
workflow steps, tasks and deadlines sit against. Position along the track
encodes sequence. The marker encodes state by **shape**, not colour:

| Marker | State |
| --- | --- |
| Filled | Done |
| Ring | Active now |
| Hollow | Pending |
| Dashed | Skipped |
| Square | Blocked, waiting on you |
| Cross | Failed |

Shape-first is an accessibility requirement (status must not be carried by
colour alone) and it happens to be the more legible choice at this width. Colour
reinforces; it never does the work by itself.

This is where the boldness is spent. Everything around it stays quiet.

## Colour

The panel sits *next to* the LMS, not on top of it, so it recedes: a cool,
low-chroma slate base with one signal hue.

`amber` means exactly one thing in this product: **Motion needs you.** Reserving
a colour for a single meaning is what makes it scannable — a student learns in
a day that amber is the only thing they must act on.

All pairs are verified against WCAG 2.2 AA in both themes by
`src/ui/tokens.contrast.test.ts`. That test caught a real error: one border
token could not serve both decorative hairlines and meaningful boundaries, so
`rule` (hairline, exempt under 1.4.11) and `edge` (input borders, the track,
markers — held to 3:1) are now separate tokens.

## Type

**IBM Plex Sans**, self-hosted. Institutional and engineered rather than
friendly-startup, which suits academic infrastructure, and it holds up at the
11–13px sizes this panel lives at.

**IBM Plex Mono** is restricted to figures that must align in a column — due
dates, weights, counts. It is never used for labels or prose. A mono face on
small labels is itself a generated-design tell; using it only where column
alignment is a genuine functional need is the distinction.

The scale is tight (11 / 13 / 15 / 18px). Hierarchy comes from weight and space,
because a wide type scale wastes horizontal room the panel does not have.

Fonts are bundled, not fetched: a CDN request would tell a third party that a
student is using Motion, every time the panel opens.

## Motion (the behaviour, not the product)

Animation only explains a state change or preserves spatial continuity. No
entrance animations, no hover flourishes, nothing looping.

- Compositor properties only (`transform`, `opacity`).
- Interaction feedback never exceeds 200ms, `ease-out` on entrance.
- `prefers-reduced-motion` is respected, and no animation blocks interaction.

A student watching a workflow progress needs to see *that a step changed*. That
is the entire budget.

## States that must exist

A workspace that runs long jobs is mostly not in its happy path. Every surface
is designed for: loading, empty, success, partial, stale, offline, blocked,
permission-denied, error, retrying, paused and cancelled.

Empty states get one clear next action. Errors appear next to the thing that
failed, say what happened, and never lose the student's edits.

## Accessibility floor

Keyboard-operable throughout with visible focus; semantic elements over ARIA;
native `<dialog>` for the approval confirmation so focus handling is the
platform's job rather than hand-rolled; 24×24px minimum targets; usable at 200%
zoom; status never conveyed by colour alone; live regions for workflow progress
so a screen-reader user learns a step finished without hunting for it.

## Voice

Plain verbs, sentence case, no filler. A button says what happens
("Prepare workspace"), and the confirmation uses the same word. Errors do not
apologise and are never vague. Motion never claims to have done something it
only prepared.
