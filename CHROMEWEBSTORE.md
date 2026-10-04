# Chrome Web Store Listing — Motion

> Last updated: 2026-10-04. Local submission materials prepared; not submitted or approved.

## Store listing

**Extension name:** Motion — From Coursework to Completion

**Short description** (matches the manifest; 110 characters):

Organize Brightspace coursework with source-linked deadlines, reminders, and guided work sessions you control.

**Detailed description** (paste the text below into the dashboard):

Motion organizes Brightspace coursework into a student-controlled workspace beside your course page.

See source-linked deadlines across your courses. Filter by course, switch between list and week views, and see exact due times in your local time zone. Distant deadlines remain visible, uncertain dates are flagged for review, and recently moved dates show their previous date. Saved deadlines stay visible when you are signed out or viewing another page.

Enable scanning on a supported course site to find deadlines across your courses. Turn on local reminders with separate lead times for assignments, quizzes, discussions, and other coursework. Reminders respect quiet hours and stop for tasks recorded as submitted or archived. Check Learn for the current submission status and deadline before handing in work.

Use Coursework to search and filter saved tasks and materials. Library can index selectable PDF text and PowerPoint slide text locally, keeping page or slide numbers and source links. No AI provider receives documents during indexing. Local document parsing requires Chromium 125 or newer.

Start a guided work session to build a checklist, prepare a draft, or review coursework with Chrome's on-device model when available, or OpenAI or Anthropic if you choose and configure one. Follow progress, pause work, and review consequential actions before approving them. Motion does not act inside detected graded, timed, or proctored attempts.

Open a supported D2L Brightspace or MyLearningSpace page, click the Motion toolbar icon, and choose an action in the launcher to open the side panel. AI setup and reminder preferences live in Settings. Chrome 116 or newer is required; on-device AI additionally depends on browser and device support.

Coursework records stay in your browser profile. Motion has no server, ads, or telemetry. Cloud AI is optional: after disclosure and permission, relevant messages and excerpts go directly to your selected provider. API keys last for the browser session by default. Remembering a key requires explicit opt-in and a separately installed OS credential-vault companion. Supported submissions, uploads, posts, and sends require fresh approval for each specific action.

Motion is independent and is not affiliated with or endorsed by Wilfrid Laurier University or D2L.

Support: alexoudev8@gmail.com
Bug reports: https://github.com/alexou8/motion/issues

**Category:** Productivity

**Single purpose:** Help students organize and complete coursework from supported Brightspace pages in a source-linked workspace they control.

**Primary language:** English

## Graphics and assets

| Asset                  | Dimensions     | File                                     | Status                                                       |
| ---------------------- | -------------- | ---------------------------------------- | ------------------------------------------------------------ |
| Store icon             | 128×128 PNG    | `src/assets/icons/icon-128.png`          | Generated; padded purple-and-gold artwork                    |
| Toolbar icons          | 16, 32, 48 PNG | `src/assets/icons/`                      | Generated from the canonical SVG                             |
| Light screenshot       | 1280×800 PNG   | `docs/store-assets/screenshot-light.png` | Capture from production extension using synthetic coursework |
| Dark screenshot        | 1280×800 PNG   | `docs/store-assets/screenshot-dark.png`  | Capture from production extension using synthetic coursework |
| Small promotional tile | 440×280 PNG    | `docs/store-assets/promo-440x280.png`    | Required; generated from canonical branding                  |

Screenshots combine an actual 400px-wide production side-panel capture with listing copy. They explicitly label the coursework as synthetic. The isolated browser harness contacts no live LMS or AI provider. Regenerate after a UI change with `MOTION_CAPTURE_STORE=1 npm run test:extension` following `npm run build`. Raw panel captures are included for inspection, not store upload. No store graphics or fixtures enter the extension ZIP.

## Permissions justification

| Permission                         | Declaration   | Dashboard justification                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                          | required      | Stores local coursework preferences, consent, scanning summaries, reminder state, and workflow metadata. Provider keys default to trusted session storage.                                                                                                                                                                                          |
| `sidePanel`                        | required      | Keeps the student's coursework workspace visible beside a supported course page.                                                                                                                                                                                                                                                                    |
| `tabs`                             | required      | Identifies the active course tab by URL/title, routes reads to its observer, and manages tabs for the student's explicit workspace actions. Unrelated browsing history is not retained.                                                                                                                                                             |
| `tabGroups`                        | required      | Organizes explicitly prepared workspace tabs and lets the student resume or close Motion-owned tabs without closing student-owned tabs.                                                                                                                                                                                                             |
| `alarms`                           | required      | Runs opted-in reminder checks and durable workflow retries when Chrome suspends the background worker.                                                                                                                                                                                                                                              |
| `notifications`                    | required      | Delivers opted-in local deadline reminders using stored coursework and quiet-hour preferences.                                                                                                                                                                                                                                                      |
| `nativeMessaging`                  | optional      | Connects to the separately installed local OS credential-vault companion only when the student explicitly enables remembered provider keys or checks the companion.                                                                                                                                                                                 |
| `https://*.brightspace.com/*`      | required host | Reads supported Brightspace coursework pages and course deadline data.                                                                                                                                                                                                                                                                              |
| `https://*.desire2learn.com/*`     | required host | Reads supported legacy D2L coursework pages and course deadline data.                                                                                                                                                                                                                                                                               |
| `https://mylearningspace.wlu.ca/*` | required host | Reads supported Laurier MyLearningSpace coursework pages and course deadline data.                                                                                                                                                                                                                                                                  |
| `https://*/*`                      | optional host | Enables just-in-time requests for a specific HTTPS provider endpoint or a student-selected institution host. Each request is narrowed to one origin; the wildcard is never requested as a whole. Cloud requests use only the selected fixed provider endpoint. Custom institution support beyond the built-in hosts needs separate live validation. |

OpenAI (`https://api.openai.com/*`) and Anthropic (`https://api.anthropic.com/*`) are runtime origin requests covered by the optional HTTPS pattern, not additional manifest declarations. The unused `scripting` permission was removed. No permission was added.

## Privacy and data use

**Does Motion handle user data?** Yes. Do not claim that all data always stays on-device: cloud AI and approved course actions can transmit content.

The dashboard disclosures must cover optional features as well as the default local mode. These are conservative declarations based on the data Motion can process; there is no advertising or developer telemetry.

| Data category                       | Handled                                                               | Off-device transmission and purpose                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Personally identifiable information | Can occur in coursework or student-entered text                       | Relevant included content may reach the selected AI provider or an approved course destination; no identity profiling |
| Health information                  | No dedicated collection                                               | Not requested for any Motion feature                                                                                  |
| Financial/payment information       | No dedicated collection                                               | No billing integration or payment-data collection                                                                     |
| Authentication information          | Yes: provider API keys                                                | Sent only to the selected provider for authentication; LMS passwords and copied session tokens are not collected      |
| Personal communications             | Can occur in student-entered messages/drafts and course material      | Relevant included content may reach the selected provider or approved course destination                              |
| Web history                         | Limited course/source URLs                                            | Relevant source references may be included in a provider turn; no unrelated browsing-history log                      |
| User activity                       | Coursework sessions, approval decisions, workspace and reminder state | Relevant session state may reach the selected provider; no usage analytics                                            |
| Location                            | No geographic location                                                | Browser time zone is used locally to display dates and plan quiet hours                                               |
| Website content                     | Yes: supported coursework and bounded excerpts                        | Read from the LMS; optionally sent to selected AI provider or approved course destination                             |

**Data use certifications:** data is not sold, used for unrelated purposes, or used for creditworthiness/lending. Use and transfer complies with the Chrome Web Store User Data Policy, including Limited Use requirements.

**Remote code:** none. Executable code and fonts are bundled. Cloud models return data, not executable scripts; the actor accepts only validated typed operations.

## Privacy policy

Policy source: `docs/PRIVACY.md`. It includes provider authentication, local retention, the optional OS vault, deletion failure behavior, and approved LMS actions.

**Public privacy policy URL: still required.** Publish this exact policy to a stable public HTTPS page, verify it is accessible while signed out, and enter that URL in the dashboard. The policy has not been publicly hosted.

## Distribution and developer information

**Visibility:** Public

**Regions:** All regions

**Publisher name:** Alex Ou

**Contact email:** alexoudev8@gmail.com

**Support:** https://github.com/alexou8/motion/issues

**Homepage:** https://github.com/alexou8/motion

## Version history

| Version | Date       | Changes                                                                                                                                                                              | Status                     |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| 0.1.1   | 2026-10-04 | Rising M mark; Laurier-inspired purple/gold branding; complete and filterable deadline list; exact times and calendar fixes; cached deadlines; package validation and listing assets | Local draft; not submitted |
| 0.1.0   | 2026-09-07 | Initial draft listing and service-worker packaging                                                                                                                                   | Draft                      |

## Validation and submission checklist

Required local checks: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, `npm run test:package`, `npm run test:extension`. `npm run package` refuses development/test permission sets, missing or wrongly sized icons, source maps, fixture files, unsafe code patterns, web-accessible extension UI, and missing bundled licenses. Static checks supplement browser testing and do not guarantee store approval.

Upload `motion-extension-0.1.1.zip` as-is; `manifest.json` is at the archive root. Upload the two 1280×800 screenshots, 128px icon, and 440×280 promotional tile separately. Store graphics and policy source are excluded from the extension package.

Before submission:

- Publish and verify the public privacy-policy URL.
- Complete Chrome Web Store developer account registration/verification and any required dashboard contact/distribution fields.
- Confirm 0.1.1 exceeds any version already uploaded for the same store item; no version was changed in this task.
- Complete the disclosure and permission fields using the text above, including optional cloud behavior.
- Provide reviewer instructions for the authenticated LMS if the dashboard requests them. Never share a student's password; arrange permitted reviewer access or supply a current demonstration recording.
- Run the current live MyLearningSpace checklist in `docs/MANUAL-TESTING.md`. Synthetic browser tests prove package integration, not current institution markup or all remote course-action flows.

Local-model availability varies. Custom institutions outside the built-in content-script matches and production OS-vault installation need separate validation. No remote submission, account change, policy publication, or store approval is claimed.
