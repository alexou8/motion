# Chrome Web Store submission audit — October 4, 2026

## Outcome

Motion 0.1.2 has a production upload package, current listing materials,
permission/data-use justifications, reviewer instructions and a public privacy
policy. Chrome Web Store submission and approval have not occurred. The
developer dashboard, any authenticated reviewer access requirements and the
existing store item's version must be checked by the publisher.

The audit followed `docs/REVIEW.md`, including independent reviews of packaging
and the security changes. Final source review found no remaining concrete
blocker in the changes. Automated integration uses synthetic coursework and
provider data; it does not establish complete live-institution/provider coverage.

## Changes and review

- Optional host permissions now name only OpenAI and Anthropic. The broad
  optional HTTPS wildcard and unsupported custom-institution claims are gone.
  No required permission or dependency was added.
- Connection tests, model listing and model requests enforce disclosure and
  provider permission at the network boundary after credential reads. Model
  turns also require the current selected provider.
- A shared transient cancellation registry covers streams, workflow generation,
  connection tests and model-list operations. Disclosure/permission revocation,
  provider switching, forgetting keys and deletion abort cloud operations.
  Session Stop and source exclusion abort relevant session work. Late output
  cannot attach or execute a canceled model plan. Durable state remains in
  storage; live abort handles are not persistent authority.
- Actor dispatch checks cancellation after settings reads and rejects
  configurable actions whose ongoing consent was revoked. Target-bound,
  single-use consequential approvals and assessment refusal remain required.
- Source context is rebuilt from the current session before sending. Excluded
  direct source context and same-URL reference metadata are omitted; prior
  conversation/notes may still contain material. Privacy text explains this
  limit and that already transmitted data cannot be retracted.
- HTTP response-body cancellation now handles an abort between response headers
  and body listener installation. Tests cover late credentials, slow bodies,
  in-flight generation and cancellation during post-stream plan persistence.
- Packaging validates the full imported worker graph, Chrome/module-worker
  compatibility, resource files/exposure and all runtime license notices.
  Bundled Scheduler/core-js licensing is included alongside PDF.js/fflate and
  the existing font/runtime licenses.
- Settings links to the policy and accurately explains session keys, optional
  OS-vault storage and cloud behavior. Store images use the real production UI
  with synthetic coursework, including course filtering and distant deadlines.
  Final light/dark screenshots and the promotional tile were visually inspected.
  Each theme rebuilds the listing composition to avoid a Chromium repaint that
  omitted unchanged copy from the dark screenshot.
- A captioned, snapshot-based reviewer walkthrough records the actual production
  panel/options documents with synthetic fixtures. It shows scanning opt-in,
  two discovered deadlines, course filtering, List/Week views, the import
  control and AI/reminder/privacy settings. The run recorded zero unexpected
  external requests and zero UI page errors. No live course/provider or
  consequential action appears; the chapter guide records its limits.

## Public policy

URL: <https://alexou8.github.io/motion/privacy.html>.

The standalone GitHub Pages site is built from `docs/PRIVACY.md`, with the
extension's bundled artwork/fonts and their licenses. It adds no scripts,
analytics, forms or cookies. It has light/dark styles, section links and keyboard
skip navigation. Its hosting disclosure links to GitHub's privacy statement.

Published only policy/site files on the separate `gh-pages` branch. The final
published policy commit is `9599f0f8e2f941fb49e86f85429c987878eb4d7c`.
Anonymous HTTP requests verified the public Markdown matches the local source
byte for byte. Browser checks verified HTTP 200, bundled font loading, working
keyboard skip navigation, no third-party resource requests or uncaught errors,
and no overflow at 320/640/1280px. Maintenance: `docs/site-hosting.md`.
The initial audit was local. The authorized publication follow-up increments
the existing GitHub version 0.1.1 to 0.1.2 and uses the reviewed PR/release
workflows; this does not submit an extension to the Chrome Web Store.

## Final validation

| Command | Actual result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test -- --reporter=dot` | 96 files; 1,292 tests passed |
| `npm run lint` | Passed |
| `npm run build` | Passed; production manifest/package and full worker graph verified |
| `npm run test:package` | 22/22 passed |
| `npm run test:release` | 17/17 passed |
| `MOTION_CAPTURE_STORE=1 npm run test:extension` | 74/74 passed; store images refreshed |
| `npm run test:agent` | 47/47 passed; optional host-grant stream branch skipped in headless Chrome |
| `npm run build:e2e-provider-hosts && npm run test:provider-stream` | Build passed; 16/16 checks passed with a real local HTTP stand-in |
| `npm run test:documents` | 23/23 passed |
| `npm run test:coursework` | 18/18 passed |
| `npm run test:popup-presence` | 6/6 passed |
| `npm run test:chrome` | 5/5 passed in branded Chrome 154.0.8037.93 |
| `npm run test:keychain` | 12/12 native unit tests passed |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run package` and `unzip -t` | Package produced; all 41 entries passed CRC verification |
| `node scripts/capture-reviewer-demo.mjs` | Passed through capture and bundled video encoding; zero unexpected requests (including worker traffic), zero UI page errors |
| `git diff --check` | Passed |

The agent harness now explicitly proves revoked disclosure and absent host
permission cause zero requests. Its synthetic invalid-key check retains its
original authentication-error assertion, with only the permission-query result
simulated while fetch stays fake. The separate provider-stream harness verifies
actual network streaming, cancellation and failure recovery against loopback;
production endpoints/grants remain unchanged by that test build.

Vite reports the existing future native-config-loader advisory for an
extensionless config import. The unit suite emits the expected local-model
failure-path warning. Neither caused a failure. Branded Chrome exposes
LanguageModel but its availability probe timed out; on-device generation was
not verified in this pass.

The branded-Chrome availability check was run during the initial 0.1.1 audit.
The publication follow-up changes version metadata to 0.1.2, repeats local
validation and regenerates the production ZIP and reviewer recording. The
shared GitHub gate validates the PR, merged main commit and release tag.

## Upload artifacts

- Extension ZIP: `motion-extension-0.1.2.zip` — 895,112 bytes, 41 files.
- SHA-256: `39f036ae2f80136a555bb5bd7cd1b7771e132f0e3b4e36a85199354c5624fa88`.
- Manifest at archive root; no test builds, website, policy source, store assets,
  credentials or source maps in the extension ZIP.
- Listing/permission/privacy copy and reviewer walkthrough: `CHROMEWEBSTORE.md`.
- Store images: `docs/store-assets/screenshot-light.png`,
  `screenshot-dark.png` (1280×800), `promo-440x280.png` (440×280).
- Store icon: `src/assets/icons/icon-128.png` (128×128).
- Reviewer walkthrough: `docs/store-assets/reviewer-demo.webm` (1280×800,
  37.44 seconds), with `reviewer-demo.md` chapter guide. Opening and representative
  chapter frames were decoded and visually inspected; no additional runtime
  changes entered the upload ZIP.

## Publisher steps and practical limits

1. Complete the developer account/dashboard fields and upload the exact ZIP,
   images and current privacy URL. Use the copy in `CHROMEWEBSTORE.md`.
2. For an existing item, confirm 0.1.2 exceeds the dashboard's previous upload.
   No store item URL was supplied. The GitHub release version was incremented
   after confirming that v0.1.1 was already published.
3. Supply the prepared recording and reviewer instructions through the
   dashboard's reviewer channel. If authenticated access is requested, supply
   permitted synthetic reviewer access. Never provide a student's password.
   No demonstration account or public authenticated LMS demo was created.
4. Complete the current signed-in walkthrough in `docs/MANUAL-TESTING.md` before
   broad distribution. Existing live observations are recorded separately;
   this audit performed no real course mutation or new live-LMS walkthrough.

Other institution domains are unsupported. PDF parsing requires Chromium 125+
while the remaining extension retains Chrome 116 minimum. Real provider account
model availability/quota, live consequential course flows and installation of
the native companion using the eventual store-assigned extension ID need their
own validation. Fresh submission-status rechecking before reminders remains a
roadmap improvement; the listing explains stored-status behavior.
