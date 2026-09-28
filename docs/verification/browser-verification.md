# Browser verification

## 2026-09-28: model settings, streaming controls and branding

The provider browser suite now drives the shipped Settings and panel controls,
using synthetic D2L pages and a real local HTTP server for provider responses.
It checks refreshed account model choices, exact OpenAI and Claude selections
across settings reloads, the selected model in the outgoing OpenAI request,
Start/Send/Stop, cancellation on the network side, failed/incomplete/truncated
streams, and recovery with a subsequent completed reply.

This iteration fixes these user-visible defects: the initial goal appeared twice
in the conversation; streaming storage changes did not refresh the panel, so
Stop never appeared during a request; provider errors or EOF could commit
partial output as a successful answer; and a recovered provider left its old
blocker visible. Partial JSON plans stay out of the rendered conversation.
A live OpenAI request also exposed an HTTP 400: JSON mode requires a JSON
instruction in an input message, not just the separate `instructions` field.
The adapter now supplies a fixed developer input instruction for JSON requests,
and the synthetic browser server enforces that same requirement. Review also
covers late cancellation during response persistence and stale preview rows.

Settings now offers GPT-6 Luna/Sol/Astra, GPT-5.4 Mini/Nano, Claude Haiku 4.5,
Sonnet 5 and Opus 5.5, with task guidance and current provider pricing links.
Refresh models reads the account's supported text models only after disclosure,
host access and session-key checks. Unavailable explicit choices are blocked;
they are never silently replaced. Claude model listing follows bounded cursor
pagination. Model-list requests run for model turns and explicit refreshes,
rather than on every streamed panel-state refresh.

Motion's canonical M path now supplies the panel/settings mark, favicons and
all four manifest PNG sizes, including toolbar, extension manager and reminder
icons. The merged launcher popup uses the same mark and favicon. Packaged
light/dark panel, Settings and popup views and the 16px icon were visually
inspected. `test:popup-presence` passed 6/6, including rendered mark styling.

Final run evidence: `npm test` passed 1,061 tests across 82 files; typecheck, lint,
production build and packaging passed. `test:extension` passed 68/68,
`test:agent` passed 42/42 with its route-backed cloud-permission check skipped,
`test:chrome` passed 5/5 in branded Chrome 153.0.8010.54, and
`test:provider-stream` passed 16/16 after the final model resolver change. The
separate provider suite covers the skipped stream/cancel path with real local
HTTP responses; production provider hosts and native messaging remain optional.
The Chrome LanguageModel probe was present but its availability check timed
out within the test bound; downloaded on-device inference remains unverified.

A live production-extension check with a student-configured OpenAI session key
passed after the JSON-mode fix: models and Responses returned HTTP 200, the
selected model was `gpt-6-luna`, and the panel rendered a completed synthetic
coursework greeting with no provider blockers. The key was entered only through
Settings, never read into a test script or logged, and the isolated test browser
was closed after verification. No real coursework was sent.

## Optional remembered-key verification: 2026-09-28

The native host/installer/package suite passed 12/12. Direct macOS Keychain
set/update/get/delete checks used a synthetic, temporary account and cleaned it
up. The Chrome native-messaging suite passed 6/6: the real Settings save stored
an isolated synthetic canary in macOS Keychain, browser restart removed the
session cache, Test connection restored the key from the vault for a local
HTTP provider, and Forget removed the vault entry and session copy. No canary
appeared in local browser storage, diagnostics, UI text or captured logs.

The native test build uses required native messaging and localhost provider
permissions solely for automation. Production regression tests assert that
native messaging and cloud hosts remain optional. Settings unit tests cover
permission denial and the request being initiated in the save gesture. Failure
regressions cover malformed native replies, disconnect/timeout, failed deletion,
interrupted saves and deletion ordering; pending intent disables retrieval and
allows a subsequent Forget to retry cleanup.

Windows Credential Manager and Linux Secret Service backends are implemented
but have not run on those operating systems. macOS Keychain with Chrome is
verified. Live Claude inference and downloaded Chrome-local inference remain
unverified; the live cloud inference evidence above is OpenAI only.

Synthetic browser checks establish integration behavior, not live account
access or live institutional markup. Real provider inference and a downloaded
on-device model are separate checks. No real coursework belongs in fixtures.

## Historical run: 2026-09-17

Latest verification run: 2026-09-17. `npm run test:extension` passed 67/67,
`npm run test:agent` passed 32/32 (one check still SKIPs: the route-backed
provider stream/cancel, because headless Chromium does not grant the optional
OpenAI host permission from a scripted click), `npm run test:chrome` passed
5/5, and `npm run test:provider-stream` passed 5/5 against the
`dist-e2e-provider` build. Unit evidence from the same tree: `npm test` 958
passed across 77 files, with typecheck, lint and build clean.

Three defects were found and fixed by this run:

- The side panel's `send()` switch had no case for `scan-all-courses` or
  `build-checklist`, so both buttons did nothing when clicked.
- Those commands resolved their target tab with a plain active-tab query,
  which returns the panel's own `chrome-extension://` page when the panel is
  focused. `resolveLmsTab()` now ignores tabs that cannot host an LMS page.
- A scan refused for an unsupported tab returned an error that nothing
  rendered, so the panel looked like it had hung. The refusal is now written
  through as a visible blocker.

Verification for VISION §31 was run against synthetic D2L fixtures only. The
Playwright run used Chrome for Testing 153.0.8010.12; the branded run used
Google Chrome 152.0.7977.83. The final output is preserved in
local run logs (`npm run test:extension`, `npm run test:agent`, and
`npm run test:chrome` reproduce them).

| §31 item | Coverage | Result and evidence |
| --- | --- | --- |
| 1. Extension installs | Automated | Pass in `test:agent` and `test:chrome`; unpacked `dist` loaded in both browsers. |
| 2. Panel opens | Automated | Pass; `chrome-extension://<id>/src/sidepanel/index.html` rendered Motion in both browsers. |
| 3. D2L detected | Automated | Pass; routed synthetic course-home and assignment pages reported supported D2L state. |
| 4. AgentSession created | Automated | Pass; panel composer created a session for the synthetic assignment. |
| 5. Tab group | Automated | Pass; real `Motion · …` group contained Motion-owned synthetic tabs. |
| 6. Related tabs safe | Automated | Pass; only allowlisted synthetic links were opened, and the student tab stayed outside the group. |
| 7. Ownership | Automated | Pass; explicit adoption recorded the student tab separately from Motion-owned tabs. |
| 8. Actor permitted | Automated | Pass; typed snapshot handles drove a synthetic field fill only after approval. |
| 9. Approval blocks | Automated | Pass; synthetic Submit remained unexecuted until the confirmation dialog was confirmed. |
| 10. Stale approval replay | Automated | Pass for single-use replay and for an expired target-bound approval after a CDP worker restart: resume created a replacement confirmation and the synthetic form remained unsubmitted. |
| 11. Worker interruption recovery | Automated | Pass; CDP-terminated service worker recovered the persisted AgentSession and workspace. |
| 12. Malicious page | Automated | Pass for the synthetic attacker text and consequence path; no submit or attacker navigation occurred without fresh approval. Model streaming against a live provider was not used. |
| 13. Provider stream/cancel | Verified | `test:agent` installs a context route for the OpenAI Responses SSE endpoint and checks stream accumulation plus request failure after Stop, but headless Chromium does not grant the optional OpenAI host permission from a scripted click, so that route-backed check is skipped there. `npm run test:provider-stream` (`test/e2e/provider-stream.mjs`) covers the same path against a separate `dist-e2e-provider` build (`npm run build:e2e-provider-hosts`) that declares a host permission as required rather than optional. Root cause of the earlier failure was two-fold: (1) Playwright's `context.route` cannot intercept a fetch made from the MV3 service worker (confirmed with request logging and by reading the SW console via CDP — `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` only adds requestfinished/requestfailed *observability* for the SW, not routing, and `newCDPSession` only accepts a Page/Frame, never a ServiceWorker), so `test/e2e/local-openai-server.mjs` (a real Node HTTP server on 127.0.0.1) now stands in for `api.openai.com`, and the `MOTION_E2E_PROVIDER_HOSTS=1` build points OpenAI's base URL and required host permission there (`E2E_PROVIDER_BASE_URL` in `src/platform/ai/http.ts`, `src/manifest.config.ts`, `src/background/providers.ts`) — the production build is unaffected (`E2E_PROVIDER_BASE_URL` is always `''` there; see the "production keeps the fixed OpenAI endpoints" tests in `src/platform/ai/http.test.ts` and `src/manifest.config.test.ts`). (2) A genuine, previously-undetected production bug: `OpenAIProvider`/`AnthropicProvider` stored the default `fetch` unbound (`deps.fetchImpl ?? fetch`), and `requestWithRetry` calls it as `options.fetchImpl(...)`, which a real MV3 service worker's stricter `WorkerGlobalScope` rejects with `TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation` — fixed in both providers by binding to `globalThis` (`fetch.bind(globalThis)`). All 5 checks in `test/e2e/provider-stream.mjs` pass, confirmed stable across 3 consecutive runs; deltas genuinely accumulate across ≥2 real SSE events and Stop genuinely aborts the in-flight request on the network side (observed via the local server's `req.on('aborted')`). |
| 14. Invalid key feedback | Automated | Pass; mocked 401 displayed “API key is no longer valid” with redacted, student-readable feedback. |
| 15. Key absent persistence | Automated | Pass; canary was absent from `chrome.storage.local`, all IndexedDB stores, panel state, and captured logs. |
| 16. Key absent logs | Automated | Pass; worker, panel, options, and content-page captures contained no canary. |
| 17. Forget key | Automated | Pass; forgetting removed the canary from `chrome.storage.session`. |
| 18. LanguageModel detection | Automated | Pass; direct panel and service-worker probes matched the UI diagnostic. In branded Chrome both reported `function/downloadable`. |
| 19. Local-AI fallback | Automated | Pass; unavailable local AI produced a resumable state and the options screen offered BYOK. |
| 20. 200% zoom/a11y | Manual + automated | Automated pass for no horizontal scroll in panel and settings at 200% zoom. Full keyboard and screen-reader behavior remains manual follow-up. |

## Bugs fixed

- Updated the smoke test to assert the five settings sections actually
  rendered by the options screen.
- Updated restricted-mode smoke coverage to require the explanation while
  rejecting page-reading, drafting, and acting affordances.
- Preserved abort cancellation after response headers by passing the request
  signal through SSE parsing and mapping provider aborts to a user-readable
  cancellation error. Focused provider tests pass.
- Actor-channel authentication and consequential-capability forgery resistance
  are now browser-verified: the `forged extension-page actor request is denied
  before submit` check in `test/e2e/agent-session.mjs` opens a port from an
  extension page, replays a submit against a real snapshot handle, and asserts
  the port is disconnected with no reply and nothing submitted.
- Rechecked restricted pages live immediately before snapshot/read operations,
  so a stale session observation cannot authorize page access.
- Made chargeable provider POST failures outcome-unknown on network loss,
  timeout and ambiguous 500/502/504 responses, with bounded retries only for
  explicit rate-limit/overload responses. The response timeout remains active
  while an SSE body is being consumed.

No Chrome permissions were broadened, no real LMS or provider endpoint was
contacted, and the canary key was synthetic: `sk-test-CANARY1234567890`.

Run evidence (2026-09-17): `test:extension` 67/67, `test:agent` 32/32 (the
route-backed provider stream/cancel check still SKIPs because headless
Chromium does not grant the optional host permission), `test:chrome` 5/5, and
`test:provider-stream` 5/5.

## Integrated presence/popup run (2026-09-17)

The integrated tree was rebuilt after the popup, presence, and side-panel
changes were ready. Synthetic-only browser evidence, run serially in one
exclusive browser slot:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 976/977 tests passed across 80 files; one existing owner test
  failed in `src/background/capabilities.test.ts` because it still expects the
  old actor call shape. The actual call now includes the typed `{ type, handle,
  snapshotId }` payload and approval flags. The failure was not hidden or
  changed here.
- `npm run build`: passed, including service-worker bundle verification.
- `npm run test:extension`: 67/67 passed; no uncaught panel or worker errors.
- `npm run test:agent`: 35/35 passed. This includes workspace metadata with no
  raw tab IDs, the truthful no-Focus-control state when only the current tab is
  exposed, Release cleanup, actor fill/approval/replay/restart, key redaction,
  and 200% zoom. The optional-host provider stream/cancel check remains a
  documented skip in this headless run.
- `npm run test:chrome`: 5/5 passed in branded Chrome 152.0.7977.83.
- `npm run build:e2e-provider-hosts`: passed.
- `npm run test:provider-stream`: 5/5 passed against the local synthetic SSE
  server; deltas accumulated and Stop aborted the request.

The popup launcher and presence unit suites are included in `npm test`; the
real-browser extension checks above verify the resulting panel/workspace flow.
The toolbar gesture itself is not claimed as automated: browser checks open
the shipped extension documents directly, while toolbar invocation remains a
manual Chrome check. Closed-shadow presence internals are likewise covered by
unit tests; the browser run asserts the surrounding actor outcome and has no
real LMS or provider traffic.

Visual QA snapshots from the integrated unpacked build were inspected locally:
`.motion-local/integrated-panel.png` (Motion header, mark, settings affordance,
unsupported-page guidance) and `.motion-local/integrated-popup.png` (canonical
mark, supported launcher hierarchy, Open Motion and Settings controls). The
standalone visual probe uses direct extension URLs and therefore is not toolbar
gesture evidence.

## Final frozen-source verification (2026-09-18)

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 997/997 tests passed across 81 files (jsdom emits the existing
  non-fatal `HTMLFormElement.prototype.requestSubmit` diagnostic).
- `npm run build`: passed; service-worker DOM-global verification passed.
- `npm run test:extension`: 68/68 checks passed.
- `npm run test:agent`: 42/42 checks passed; the optional provider-host check
  remains an expected headless skip.
- `npm run test:chrome`: 5/5 checks passed in branded Chrome 152.0.7977.83.
- `npm run build:e2e-provider-hosts` and `npm run test:provider-stream`: passed;
  provider stream suite 5/5.
- `npm run test:popup-presence`: 5/5 checks passed: a real popup button
  gesture, no popup loading loop, typed synthetic actor snapshot, restricted
  attempt refusal, and synthetic-only data.

The authenticated actor path now has browser evidence for fill, click pulse,
scroll-to, and focus-element. A read-only CDP observer inspected the closed
shadow tree and verified target geometry, bounded redacted previews, cleanup,
reduced-motion and pointer-off behavior, with restricted-route refusal. The
physical toolbar invocation remains a manual Chrome check; popup button handoff
is covered by `test:popup-presence`.
