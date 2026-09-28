# Popup / side-panel agent-presence baseline

Date: 2026-09-17  
Branch: `codex/popup-agent-presence-ux`  
Build under test: untouched `dist` produced before the browser runs.

## Evidence

- `npm run build`: passed (`tsc --noEmit`, Vite build, and extension-build
  verification).
- `npm run test:extension`: 67/67 checks passed.
- `npm run test:agent`: 32/32 checks passed. One check is intentionally
  skipped: extension-page provider stream/cancel, because headless Chromium
  did not grant the optional OpenAI host permission.
- No real LMS, provider endpoint, course content, or key was used. The browser
  fixtures and provider key in the run are synthetic.

## Synthetic rendered-control inventory

| Surface / control | Expected | Actual baseline | Outcome / visible feedback |
| --- | --- | --- | --- |
| Home composer | Label, multiline input, disabled empty `Start`, enabled non-empty `Start` | Present; agent session was created from the panel composer | Pass; session title rendered `CS101 · Example Assignment` |
| Home suggestions | Up to 3 page/deadline suggestion buttons | Rendered when synthetic state supplied suggestions | Pass in component coverage; no failing browser assertion |
| Home deadline view | `List` and `Week` pressed-state buttons | Present when deadlines exist | Pass in component coverage; preference is stored locally |
| Home discovery | Opt-in prompt has `Enable scanning` and `Not now`; opted-in state has checkbox and `Scan all courses` | Present on supported synthetic course state | Extension smoke exercised `Enable scanning` and `Scan all courses`; result/blocker is an `aria-live` message |
| Header | `Settings` icon button | Present | Pass; opens options page through the bridge |
| Session navigation | `Sessions` back button | Present in session view | Present; returns to Home/session list |
| Session message composer | Multiline `Message Motion` input and `Send` | Present | Present; empty send is disabled by validation |
| Session pause/resume | `Pause` while not paused; `Resume` while paused | Present conditionally | Bridge commands are `session-command` pause/resume; no browser assertion directly clicks these labels |
| Session stop | `Stop` only while streaming | Present conditionally | Provider stream/cancel browser check skipped; no production-provider network was contacted |
| Workspace adoption | `Add this tab` | Present | Pass; student tab was adopted while retaining student ownership |
| Workspace release | `Release` for each adopted tab | Present conditionally | Bridge emits target-bound `session-tab` release; baseline test verified ownership records, but did not click Release |
| Workspace listing | Motion-owned and student-owned tab rows with exact tab counts | Present | Pass; Motion group had 1 synthetic member and student tab stayed outside it |
| Configurable approval | `Deny` and `Allow once`; no always-allow control | Present for configurable actor request | Pass; field fill waited for approval and succeeded only after `Allow once` |
| Consequential approval | `Review` then dialog with `Confirm`; target/effect/payload and expiry | Present | Pass; fresh confirmation blocked submit, focus was trapped, Escape cancelled, and replay was rejected |
| Provider cards | Three provider choices: Chrome local, OpenAI, Anthropic | Three diagnostics in source/options tests; browser diagnostic reported local `function/unavailable` | Local diagnostics pass. Cloud card interaction was not completed in `test:agent` because the optional host permission caused the provider-stream check to skip |
| Cloud disclosure | One disclosure checkbox per cloud provider; selecting without acceptance is refused | Present in options implementation/tests | Unit coverage expects visible “Accept the cloud-processing disclosure…” feedback; not independently clicked in this baseline browser run |
| Cloud key controls | Per cloud provider: password API-key input, `Save for this browser session`, `Test connection`, `Forget key` | Present in options implementation/tests | Synthetic invalid-key path passed with student-readable “API key is no longer valid” feedback; synthetic key remained session-only and was forgotten |
| Provider model | Selected provider exposes a model select | Present in options implementation | Not independently browser-clicked in this baseline; preferences bridge is covered by options tests |

## Targeted bridge and feedback checks

The browser run confirmed the panel-to-worker paths for state retrieval,
extraction request, session creation, workspace preparation/adoption, typed
actor snapshot, approval decision, workflow pause/resume, and provider/key
diagnostics. The forged extension-page actor request was denied before the
synthetic submit. Unsupported/restricted page states rendered explicit refusal
copy; no uncaught page or service-worker console errors were observed.

Known gaps in this baseline are interaction coverage rather than observed
failures: `Pause`, `Resume`, and `Release` were not directly clicked in the
browser run; cloud provider stream/cancel was skipped by the documented
headless permission limitation; and the options provider disclosure/model
controls were inspected through implementation/unit coverage rather than a
dedicated browser assertion. No baseline product code was changed.
