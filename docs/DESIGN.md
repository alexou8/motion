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
- **Use.** The toolbar icon opens a small launcher popup. Its explicit
  Start/Continue action opens the side panel and starts or resumes the selected
  workspace; the toolbar click alone does not create an automatic group. The
  panel is the main surface: a header, Motion's task actions, a chat about the
  current page, and a composer at the bottom.
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

## The mark

Motion's mark is a rising **M**: a lavender book-fold joins a gold upward
arrow on a purple tile. It connects coursework with progress and remains
recognizable at toolbar size. This original artwork uses Laurier-inspired
purple and gold without university crests, wordmarks, or claims of endorsement.
The colours `#330072` and `#f2a900` also appear in [Laurier's public site stylesheet](https://www.wlu.ca/_ato/dist/css/ato.min.css?v=3), checked October 4, 2026.

`src/assets/brand/motion-mark.svg` is the canonical artwork. Panel, popup and
options use the full-colour image; all three documents use it as a favicon.
`scripts/make-icons.mjs` generates the 16, 32, 48 and 128px PNGs from that source.
The 128px icon has a 96px tile and 16px transparent padding on each side.
Do not redraw the mark inside a component or create surface-specific variants.

## Colour

On October 4, 2026 the owner requested purple-and-gold branding while retaining
the current light/dark UI and interaction design. Warm paper-and-ink neutrals,
fonts, spacing, tracks, and shape-based status markers remain unchanged.

**Purple** is the light-mode accent for primary actions and focus; a readable
**lavender** serves the same role in dark mode. **Gold** is the brand arrow.
The accent does not carry task status. **Ochre** continues to mean **Motion
needs you**, reinforced by the existing square blocked marker.

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

- **Header:** the mark and "Motion" in the serif, with an accessible Settings
  control. The home view presents the current page, suggestions and a composer;
  an explicit **Sessions** control returns to the durable session list.
- **Home navigation:** Workspace contains the composer, sessions and deadlines;
  Coursework browses the saved assignment, quiz, discussion and material index.
  Native buttons expose the current page, navigation focuses the main content,
  and a skip link bypasses the header. Coursework remains available away from
  a supported LMS page. Restricted assessment mode hides both navigation and
  active-session controls.
- **Coursework:** a compact summary and labelled search/course/status filters,
  with type filters and source-linked rows on the track. Undated lecture
  materials say "No deadline"; uncertain dates retain their review warning.
  Submitted and graded work can be browsed explicitly. Results render in batches
  of 40 with a Show more control, keeping a large course usable in the panel.
- **Body:** the connection state first, and honestly — idle, unsupported,
  permission needed, signed out and restricted each keep their own view. On a
  page that carries coursework, the home view offers contextual suggestions;
  an active session presents Now, Needs you, the conversation, plan, activity,
  workspace, sources and artifacts.
- **Composer:** pinned to the bottom. Enter sends, Shift+Enter adds a line.
  Where the chat cannot work, the composer is disabled and says why in a line
  above it — beside a graded attempt, on a page Motion cannot read, or when
  Chrome has no on-device model.

## The chat

The chat answers questions about the page in front of the student using the
selected provider. Chrome's on-device model stays local when available; BYOK
cloud mode sends only the disclosed, bounded turn context directly to the
selected provider after permission. Provider selection is defined by ADR 0005;
session keys remain the default, with optional OS-vault storage in ADR 0009.

- It is scoped to the active AgentSession and persists locally with that session
  in IndexedDB, so returning to a session can show its conversation. It is not
  a cloud transcript or a cross-session history; provider requests follow the
  selected provider's disclosed path.
- Every answer carries a label saying it was generated and should be checked
  against the page, and names the page it was about, so an old answer is not
  read as describing a new page.
- While an answer streams, the conversation shows reply text rather than the
  model's structured plan. Incomplete or failed responses never become completed
  replies or executable plans. Stop is available during provider setup too.
- **Beside a graded attempt the chat reads nothing and answers nothing.** The
  worker refuses before it asks the page or the model; the panel only says so.
- Page text reaches the model fenced as quoted data, through the same
  prompt-injection defence as drafting (`src/core/assist/compose.ts`).

## Settings

A full page: the M mark and serif title, with navigation for **AI**, **Browser
access**, **Agent behaviour**, **Reminders**, **Privacy & data** and **About**,
and content in bordered cards. Its job
is unchanged — to make three promises inspectable: which sites Motion can read,
that access can be revoked, and that deleting data really deletes it (and says
so honestly when the browser blocks it). **Agent behaviour** exposes the
implemented opt-in configurable actions; consequential actions always require
their own fresh approval.

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
