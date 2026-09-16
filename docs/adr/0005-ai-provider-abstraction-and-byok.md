# ADR 0005 — AI provider abstraction and BYOK

- **Status:** Accepted
- **Date:** 2026-09-16

## Decision

Use a provider abstraction for Chrome local AI, OpenAI and Anthropic. User API
keys are session-only in `chrome.storage.session` with
`setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})`. `SecretStore` reserves a
future native-messaging keychain companion. Motion does not add fake encryption.

Cloud requests go directly from the browser to fixed provider endpoints; Motion
is not a proxy. Settings requests optional provider host permissions just in
time. Before coursework is sent, the student accepts disclosure for that
provider. The selected provider is used without silent fallback. A model request
contains the student's message, session plan/state labels, relevant notes, and
bounded excerpts from pages read for the session, capped at 8,000 characters per
source and 24,000 characters per request; excluded sources are omitted.

Supported consequential actions such as submission, posting, uploading and
sending require a fresh target-bound confirmation for every use. Motion never
acts inside a graded, timed or proctored attempt.

## Trade-offs

Any code running in a trusted extension context can read a session key, and the
key is lost on browser restart. Direct requests avoid a server and its
retention surface, but provider privacy/retention is outside Motion's control.
