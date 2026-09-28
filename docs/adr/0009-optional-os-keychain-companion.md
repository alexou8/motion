# ADR 0009 — Optional OS keychain companion

- **Status:** Accepted
- **Date:** 2026-09-28
- **Supersedes:** ADR 0005’s session-only storage restriction when the student explicitly chooses OS keychain storage.

## Decision

Session-only keys remain the default. A student may opt into remembering a
provider key in the operating system’s credential vault through an optional
local native-messaging companion. This avoids re-entering a key after every
browser restart without putting it in extension local/sync storage or adding a
Motion server.

The companion stores only OpenAI and Anthropic API keys in macOS Keychain,
Windows Credential Manager, or Linux Secret Service. It uses the OS credential
API; raw keys never appear in files, process arguments, logs, IndexedDB or
browser local/sync storage. Browser local storage contains only provider mode
metadata, including incomplete save/delete intent. A retrieved key may be cached in `chrome.storage.session` with
`TRUSTED_CONTEXTS` for the current browser session.

`nativeMessaging` is an optional permission, requested from the Settings save
or companion-check gesture. The companion must be installed separately for an
exact extension ID. Chrome’s host manifest restricts `allowed_origins`, and the
host independently validates the caller’s extension origin. The worker exposes
only typed provider-specific operations to authenticated extension UI; content
scripts and pages cannot request vault access. Native messages are bounded and
validated. The host has no networking, scraping, arbitrary command execution,
file access API or provider endpoint selection.

Saving in the vault requires an explicit setting. Selecting session-only
storage deletes an earlier remembered key before changing its mode. Forget key
deletes both the vault entry and the session cache; a failed vault deletion is
reported honestly and disables subsequent retrieval until an explicit save or
successful deletion. Pending save metadata also allows a key written just before
a worker interruption to be deleted on retry. Missing, locked or uninstalled vaults produce an actionable
message rather than falling back to plaintext persistence. Uninstalling the
companion removes its registration and program, not the student’s keys; students
must forget keys first or delete the entries through the OS vault.

## Trade-offs

A companion adds a one-time installation and an OS runtime prerequisite. Vault
availability and unlock prompts differ across operating systems. The current
installer is a source distribution rather than a signed app-store installer;
platform-specific checks must be reported separately. Native access is optional
so students who prefer a browser-only extension keep session storage.

An OS vault protects storage at rest, not a compromised trusted extension or
OS account. Provider requests still require disclosure and provider host access,
and keys must still be sent to the selected provider for authentication.

## References

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Apple Keychain services](https://developer.apple.com/documentation/security/keychain-services)
- [Windows Credential Manager](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)
- [Companion installation](../keychain-companion.md)
