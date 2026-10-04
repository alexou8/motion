# Optional OS keychain companion

Motion normally keeps provider API keys only for the current browser session. The
optional `com.motion.keychain` companion lets the extension save an OpenAI or
Anthropic key in your operating system's credential vault instead. Install it
only if you want that convenience. The extension still asks before it uses the
companion, and removing a key in Motion asks the vault to delete that key.

The installer does not ask for, print, or save an API key. It installs a small
local program and a Native Messaging manifest that permits exactly one Chrome
extension ID. It does not contact OpenAI, Anthropic, or any other network host.

## Install

Python 3.10 or newer is required for the local companion. The browser-only
extension does not need Python.

1. In Chrome, open `chrome://extensions`, enable Developer mode if necessary,
   and copy Motion's 32-character extension ID.
2. From the unpacked Motion repository or the companion archive, run:

   ```sh
   python3 native/install.py --install --extension-id YOUR_EXTENSION_ID --browser chrome
   ```

   The ID must be exactly 32 lowercase characters from `a` through `p`. The
   installer derives the only allowed Chrome origin from that ID. If an
   automation supplies `--allowed-origin`, it must exactly equal
   `chrome-extension://YOUR_EXTENSION_ID/`; wildcards and second IDs are
   rejected.
3. Restart Chrome, then enable OS keychain storage in Motion's settings.

By default, `--browser chrome` writes Chrome's per-user Native Messaging
manifest location. Use `--browser chromium` or `--browser brave` to install
for those browsers, or omit `--browser` to register all three. The manifest
launches a wrapper whose Python interpreter and host path are absolute and
installed with owner-only permissions on macOS and Linux.

For an isolated Chrome 146+ test run, use the same directory passed to Chrome's
`--user-data-dir`:

```sh
python3 native/install.py --install \
  --extension-id YOUR_EXTENSION_ID \
  --browser chrome \
  --profile-dir /absolute/path/to/chrome-user-data \
  --install-dir /absolute/path/to/test-companion
```

`--profile-dir` requires exactly `--browser chrome`; it avoids writing a
manifest to the regular Chrome profile. `--install-dir` is an absolute
companion location for an isolated install. The standard install location stays
unchanged when it is omitted.

To remove registrations, run the same command with `--uninstall`. The installer
keeps the shared copied host program while another Chrome, Chromium, or Brave
registration still references it, then removes it after the final recorded
registration is removed. Uninstalling does **not** remove an existing OS-vault
key. Use Motion's “Forget key” control first if you want to delete the key too.

If Motion or the companion is unavailable, remove the vault entry through your
OS credential manager: macOS Keychain uses service `com.motion.keychain.v1`
with account `openai` or `anthropic`; Windows uses target
`com.motion.keychain.v1/openai` or `com.motion.keychain.v1/anthropic`; Linux
Secret Service entries are labelled **Motion API key**. Uninstalling the
extension or companion alone leaves these entries in the OS vault.

## Supported platforms

- **macOS:** uses the Keychain Generic Password API through `Security.framework`
  with `ctypes`; it does not invoke the `security` command or place a key in a
  command argument.
- **Windows:** uses Credential Manager Generic Credentials through `ctypes`.
  The implementation is structurally tested, but it is implemented and
  unverified until a live Windows Credential Manager and Chrome channel test
  runs.
- **Linux:** uses the fixed `/usr/bin/secret-tool` or `/bin/secret-tool` command
  with an installed, unlocked Secret Service. A key is supplied to `store` only
  on standard input, never as an argument or environment value. If the utility
  or Secret Service is unavailable, Motion reports that vault storage is
  unavailable. Session-only storage remains available as an explicit choice.

A locked vault returns a locked status. No raw OS error text or request payload
is returned, and keys are never displayed in Motion's UI or included in error
messages. A successful `get` returns the key only to Motion's validated native
messaging client so it can make the provider request. If an OS backend cannot
start, the host still returns a framed `vault-unavailable` response to a valid
request.

## Native Messaging protocol

The host name is `com.motion.keychain`. Each stdin/stdout message is a JSON
object encoded as UTF-8 and preceded by a four-byte native-messaging length.
Motion limits frames to 16 KiB even though Chrome permits larger frames.

Requests are strictly version 1:

```json
{"version":1,"operation":"status","providerId":"openai"}
```

`operation` is exactly one of `status`, `get`, `set`, or `delete`.
`providerId` is exactly `openai` or `anthropic`. `set` additionally requires a
non-empty UTF-8 `key` of at most 4096 bytes. Unknown fields, other versions,
other providers, oversized frames, and malformed JSON receive only:

```json
{"version":1,"ok":false,"code":"invalid-request"}
```

Successful replies contain `{ "version": 1, "ok": true, "backend": ... }`.
`status` includes `present`; `get` includes `key` (a string or `null`) and
`present`; `set` and `delete` include the resulting `present` boolean.
Failures use only `vault-unavailable`, `vault-locked`, or `invalid-request`.

Chrome starts the host with the calling extension origin as its first argument.
The installed wrapper supplies its fixed allowed origin, and the host rejects
any caller origin that does not exactly match. Chrome also enforces the one
origin in the manifest. This is defense in depth for browser-origin mistakes;
it does not treat a local OS user who can run or replace local programs as a
separate security boundary. Neither path permits selecting an arbitrary provider, command,
path, or vault entry.

The protocol and manifest arrangement follow Chrome's [Native Messaging
requirements](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

## Validation and packaging

Run protocol, framing, synthetic macOS-vault, installer, and archive checks:

```sh
python3 -m unittest discover -s native/tests -v
python3 native/package.py
```

The packager creates `motion-keychain-companion-0.1.2.zip` containing only the
host source, installer source, README, and this document. It contains no
Native Messaging registrations, vault records, extension IDs, or API keys.
