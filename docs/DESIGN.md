# Design direction

## The brief, restated

A panel roughly 400px wide, docked beside a learning-management system that is
already visually loud, open for hours while a student works. It has to answer
three questions in about two seconds: *where am I, what needs me, and what is
Motion doing right now* — and, since 2026-09-11, a fourth: *what does this page
actually ask of me*, answered by a chat about the page.

That form factor rules a lot out before taste enters. There is no hero. There is
no room for a card grid. Anything decorative costs a line of coursework.

## What changed on 2026-09-11, and why

The product owner set a new direction: **the look of Claude, the use of
ChatGPT.**

- **Look.** A serif for headings, a sans for body, warm dark and light palettes
  that follow the system setting, and a terracotta accent. Claude's own faces
  (Copernicus, Styrene) are proprietary and do not ship; Motion uses **Source
  Serif 4** and **IBM Plex Sans**, both under the SIL Open Font License. Motion
  keeps its own name and mark — Claude-*like*, never Claude-branded.
- **Use.** The toolbar icon opens the side panel and starts Motion's tab group
  on the current tab. The panel is the main surface: a header, Motion's task
  actions, a chat about the current page, and a composer at the bottom.
  Settings live on a dedicated full-page screen.

This reverses one line of the earlier direction, which listed
cream-and-terracotta among the tells of generated design. The reversal is
deliberate and recorded here rather than quietly dropped: the owner chose a
specific, recognisable reference over avoiding a trend, and the warmth serves
the use — a document-like surface is easier to read beside an LMS for hours
than a cool dashboard. The rest of that list (acid accents on near-black,
purple gradients, glassmorphism, identical rounded cards for everything,
tracked-out all-caps eyebrows, `→` appended to link text) still stands.

## What survives: the track

Motion's single visual device is still a continuous vertical rule — a **track**
— that workflow steps, tasks and deadlines sit against. Position along the
track encodes sequence. The marker encodes state by **shape**, not colour:

| Marker | State |
| --- | --- |
| Filled | Done |
| Ring | Active now |
| Hollow | Pending |
| Dashed | Skipped |
| Square | Blocked, waiting on you |
| Cross | Failed |

Shape-first is an accessibility requirement (status must not be carried by
colour alone), and it is what keeps the redesign honest: the new palette changed
every colour and no state became ambiguous.

The track is also now Motion's **mark**: a short rule with one filled and one
ringed marker, drawn in the accent, in the panel header. It is Motion's own
glyph and imitates no other product's.

## Colour

Warm paper-and-ink neutrals in both themes, one accent.

**Terracotta** is the accent: primary actions and the focus ring. It does not
carry status.

**Ochre** (the old amber, pushed darker and yellower so it cannot be mistaken for
terracotta) still means exactly one thing: **Motion needs you.** Beside a warm
accent, colour alone would not keep the two apart; the square *blocked* marker
does, which is the shape-first rule earning its place.

Both palettes are verified against WCAG 2.2 AA by
`src/ui/tokens.contrast.test.ts`: body and muted text on paper, surface and the
sunken fill (where the composer and the student's chat turns sit), status
colours, text on the accent fill, and the 3:1 non-text bar for `edge` and the
focus ring. `rule` (decorative hairline, exempt under 1.4.11) and `edge`
(meaningful boundaries, held to 3:1) remain separate tokens. The dark theme
follows `prefers-color-scheme`, and `data-theme` can force either.

## Type

**Source Serif 4** for headings only: the panel's name, empty-state headings,
and the settings page's title and section headings. It is where the Claude-like
character lives; it is never used for body text, labels or buttons.

**IBM Plex Sans** for everything else — institutional rather than
friendly-startup, and it holds up at the 11–13px sizes the panel lives at.

**IBM Plex Mono** stays restricted to figures that must align in a column —
due dates, weights, counts.

The panel's scale stays tight (11 / 13 / 15 / 18px) because a wide scale wastes
horizontal room the panel does not have; the serif carries hierarchy instead of
size. Two larger steps (22 / 28px) exist for the full-page settings screen.

All faces are bundled `woff2` subsets with their licences in the repository.
Motion makes no network request for a font: a CDN request would tell a third
party that a student is using Motion, every time the panel opens.

## The panel

- **Header:** the mark and "Motion" in the serif; *New chat* and *Settings* as
  icon buttons with accessible names. There is no history button: the
  conversation is ephemeral (see below), and a button with nothing behind it is
  a defect, not a placeholder.
- **Body:** the connection state first, and honestly — idle, unsupported,
  permission needed, signed out and restricted each keep their own view. On a
  page that carries coursework, a row of **task buttons** (Workspace, Checklist,
  Draft review) opens Motion's existing views; below them, the background-work
  track; then the conversation.
- **Composer:** pinned to the bottom. Enter sends, Shift+Enter adds a line.
  Where the chat cannot work, the composer is disabled and says why in a line
  above it — beside a graded attempt, on a page Motion cannot read, or when
  Chrome has no on-device model.

## The chat

The chat answers questions about the page in front of the student, using
Chrome's on-device model (ADR 0004) — nothing leaves the machine. Which hosted
model a student may bring is still an open product decision
(`docs/development/ai-account-handoff.md`, Track 2).

- It is **ephemeral**: held in the panel's memory, forgotten on *New chat* or
  when the panel closes, stored nowhere.
- Every answer carries a label saying it was generated and should be checked
  against the page, and names the page it was about, so an old answer is not
  read as describing a new page.
- **Beside a graded attempt the chat reads nothing and answers nothing.** The
  worker refuses before it asks the page or the model; the panel only says so.
- Page text reaches the model fenced as quoted data, through the same
  prompt-injection defence as drafting (`src/core/assist/compose.ts`).

## Settings

A full page: the serif title, a left navigation of **Permissions**, **Privacy &
data**, **Capabilities** and **About**, and content in bordered cards. Its job
is unchanged — to make three promises inspectable: which sites Motion can read,
that access can be revoked, and that deleting data really deletes it (and says
so honestly when the browser blocks it). **Capabilities** explains the opt-in
consent model and shows an honest empty state until an optional capability
exists; it has no switch with nothing behind it.

## Motion (the behaviour, not the product)

Animation only explains a state change or preserves spatial continuity. No
entrance animations, no hover flourishes, nothing looping.

- Compositor properties only (`transform`, `opacity`).
- Interaction feedback never exceeds 200ms, `ease-out` on entrance.
- `prefers-reduced-motion` is respected, and no animation blocks interaction.

## States that must exist

A workspace that runs long jobs is mostly not in its happy path. Every surface
is designed for: loading, empty, success, partial, stale, offline, blocked,
permission-denied, error, retrying, paused and cancelled.

Empty states get one clear next action. Errors appear next to the thing that
failed, say what happened, and never lose the student's edits.

## Accessibility floor

Keyboard-operable throughout with visible focus; semantic elements over ARIA;
native `<dialog>` for the approval confirmation; 24×24px minimum targets; usable
at 200% zoom and at the narrowest panel width (360px); status never conveyed by
colour alone; live regions for workflow progress and for chat answers, so a
screen-reader user learns a step finished or an answer arrived without hunting
for it. Icon-only buttons always have an accessible name.

## Voice

Plain verbs, sentence case, no filler. A button says what happens
("Prepare workspace"), and the confirmation uses the same word. Errors do not
apologise and are never vague. Motion never claims to have done something it
only prepared, and never presents a generated answer without saying so.
