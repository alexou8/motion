# Browser verification

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
| 13. Provider stream/cancel | Attempted; not verified | `test:agent` now installs a context route for the OpenAI Responses SSE endpoint and checks stream accumulation plus request failure after Stop. Chromium headless did not grant the optional OpenAI host permission, so the route-backed browser checks were skipped. Provider SSE parsing, abort, timeout and retry behavior remain covered by focused unit tests. |
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
- Authenticated content-script requests by extension id and sender-tab absence;
  foreign and tab-bearing requests are rejected before actor dispatch.
- Made chargeable provider POST failures outcome-unknown on network loss,
  timeout and ambiguous 500/502/504 responses, with bounded retries only for
  explicit rate-limit/overload responses. The response timeout remains active
  while an SSE body is being consumed.

No Chrome permissions were broadened, no real LMS or provider endpoint was
contacted, and the canary key was synthetic: `sk-test-CANARY1234567890`.

Run evidence: `test:extension` 62/62, `test:agent` 29/29 (provider stream/cancel
skipped because headless Chromium did not grant the optional host permission),
and `test:chrome` 5/5. Logs are in `.motion-local/e2e-*.log`.
