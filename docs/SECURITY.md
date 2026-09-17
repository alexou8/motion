# Security

## Trust boundaries

Motion spans four contexts with different privileges. Data crossing any arrow is
untrusted until validated.

```
  LMS page  ──▶  content script  ──▶  service worker  ──▶  IndexedDB
 (hostile)      (page-adjacent)      (privileged)          (local)
                                            │
                                            ▼
                                     side panel (React)
```

1. **The LMS page is hostile input.** Not because institutions are malicious, but
   because a page aggregates content from instructors, classmates, uploaded
   files and third-party tools. A discussion post is attacker-controlled text.
2. **The content script is page-adjacent.** It shares a DOM with hostile content.
   It observes and may execute only worker-authorized, typed, handle-based
   actor operations; it receives no selectors, scripts, arbitrary URLs, or
   policy authority. Actor-channel authentication and browser-level forgery
   coverage remain under active review; until that evidence is complete,
   extension-page compromise remains a residual risk.
   Actor exceptions must also resolve to a typed failure or bounded disconnect;
   the current error-to-hang path remains a review follow-up.
3. **The service worker is the only privileged context.** All orchestration —
   tabs, tab groups, permissions, storage writes, approvals — happens here.
4. **The side panel renders, and asks.** It owns no Chrome orchestration and
   performs no scraping.

For opt-in all-course deadline discovery, the flow remains local:
`Learn (same-origin credentialed GET) → content script → service worker → IndexedDB`.
The content script is never given a cross-origin URL or an LMS write operation;
401/403 stops the scan and asks the student to sign in. Discovery refuses on a
restricted assessment page.

## Rules

### Input
- Every message crossing a context boundary is validated against a Zod schema
  before use. A message that does not parse is dropped, not coerced.
- The service worker verifies the *sender* of every message, not just its shape.
  A message claiming to be from a content script must actually come from an
  extension context, on a URL an adapter claims.
- Page text is stored and rendered as plain text. Motion never stores page HTML
  and never renders page-derived content as markup, so a crafted post cannot
  become script in the panel.
- Extracted URLs are validated and scheme-checked before they are ever opened or
  linked; `javascript:` and `data:` are rejected.

### Prompt injection
Course pages and linked documents are untrusted text. When model-assisted
features arrive, page content is passed as *data to be summarized*, never as
instructions. Page text cannot grant a permission, change a risk
classification, approve an action, or widen scope. The approval gate is
evaluated in the service worker from the persisted risk table — nothing a page
says participates in that decision.

### Consequential actions

Supported submission, posting, uploading, sending and other consequential actions require a fresh,
target-bound, single-use confirmation every time. No setting can act as permanent consent. Motion
never acts inside a graded, timed or proctored attempt.

### Permissions
- Request the narrowest scope the current feature needs.
- The `notifications` permission is used only for deadline reminders that the
  student explicitly enables in Settings. Reminder plans and the sent-record
  are local; Motion does not send notification data to a server. Reminders are
  suppressed for submitted, graded, archived, overdue, low-confidence and
  active-assessment items.
- All-course deadline scanning needs no additional Chrome permission: it uses
  the existing D2L host access and same-origin, credentialed GET requests only,
  after a host-specific first-run opt-in. It never uploads LMS responses.
- Host access beyond the built-in D2L hosts is an *optional* permission,
  requested just-in-time and revocable.
- `activeTab` is deliberately not used: it only grants access on a direct user
  gesture and does not work from a side panel, so relying on it would be a bug
  wearing a permission's clothes.
- Supported domains are visible to the student in the extension options.

### Code
- No remote code. Everything executable ships in the package — a hard Chrome Web
  Store requirement and a sane one.
- No `eval`, no `new Function`, no inline scripts or handlers.
- Fonts are bundled, not fetched. A font CDN request would disclose Motion usage
  to a third party on every panel open.

### Data
- Local mode makes no model network request. BYOK cloud mode makes a direct
  request from the browser to the selected provider only after disclosure and
  just-in-time host permission. The request contains the student's message,
  session plan/state labels, relevant notes, and bounded excerpts from pages
  Motion read for the session: at most 8,000 characters per source and 24,000
  characters per request, excluding sources the student excluded. There is no
  Motion proxy or telemetry.
- Never stored: passwords, session tokens or cookies copied from pages, model
  API keys, browsing history unrelated to a supported course page. BYOK keys
  live only in `chrome.storage.session` under `TRUSTED_CONTEXTS`, are never
  logged or fake-encrypted, and disappear on browser restart.
- Local storage is *not* claimed to be encrypted. It is browser-profile storage
  with browser-profile protections. Claiming otherwise would give students a
  false sense of what a shared or compromised machine exposes.
- The student can export and delete everything. Deletion removes the database,
  which is tested.

### Logging
Course content, URLs, drafts, grades and identifiers never go to logs or error
reports. Developer detail in structured errors excludes the payload.

## Reporting

This is a student project, not a funded product with a security team. If you
find something, open an issue — but do not include real course data in it.
