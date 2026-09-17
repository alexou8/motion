# Browser verification

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
