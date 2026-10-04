# Local document indexing verification

Verified on 2026-10-04. Committed fixtures and screenshots contain synthetic
material. This follow-up adds PDF/PPTX text indexing to the earlier
[coursework and MyLearningSpace work](coursework-overview.md).

## Verified behaviour

Library imports selectable PDF text and PowerPoint (.pptx) slide text with
bundled local workers. Search returns page/slide references and bounded text
snippets; the text preview starts on the matching unit and receives keyboard
focus. Students can associate local files with a course, reindex an observed
LMS file, retain indexes across panel reloads and remove individual indexes.
Indexing does not send files or text to a provider.

The production extension ran in a temporary Chromium profile with external
networking blocked. Synthetic MyLearningSpace responses exercised observed
PDF.js viewer references and direct PPTX links through the content observer,
worker-issued source handle, bounded credentialed fetch, parser and local store.
Tests verified source/topic provenance, Unicode, presentation relationship
order, deduplication and excluded speaker notes. Image-only files disclose
missing text; corrupt PDFs and unsafe slide XML create no index.

Data deletion was tested in that browser: all indexes disappeared and the open
library refreshed to an empty state. An import ticket issued before deletion could not recreate
data. A synthetic graded attempt removed library/text/import controls and the
worker refused document sources. No real assessment attempt was opened.

## Private lecture check and live-account limit

A lecture PDF was downloaded through the authenticated MyLearningSpace browser
and then imported into the built extension's isolated temporary profile. It
indexed **22/22 pages and 11,741 characters**. Only these counts were recorded;
the file, extracted text, student details and real course identifiers are absent
from repository fixtures, logs and screenshots. Its index and temporary profile
were removed after verification. Screenshots were captured before this import.

This verifies the actual lecture file's local decoding and storage. It does not
verify authenticated extension downloading or the full installed extension
against the signed-in account. Browser control rejected the extension-manager
URL, so that installed-account check remains **unverified**. No alternative
profile, cookie transfer or policy workaround was used.

The remaining check needs the current `dist/` build loaded with **Load unpacked**
in the signed-in Chromium browser. On a lecture topic, open Library, choose
**Find files on this page**, index the observed file and compare a later-page
search result and source topic with the original. Repeat read-only coursework
tracking on content, assignment and quiz-list pages without starting an attempt.
The [manual checklist](../MANUAL-TESTING.md#local-document-library) records the
full steps.

## Automated evidence

| Check                                                  | Result                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                    | Passed                                                                                               |
| `npm test`                                             | 95 files, 1,250 tests passed                                                                         |
| `npm run lint`                                         | Passed                                                                                               |
| `npm run build`                                        | Passed; service-worker AST check rejects DOM globals                                                 |
| `npm run test:documents` with axe and private PDF      | 26/26 checks passed                                                                                  |
| `npm run test:extension`                               | 68/68 checks passed                                                                                  |
| `npm run test:agent`                                   | 45/45 checks passed; optional real-provider stream branch skipped by headless permissions            |
| `npm run test:popup-presence`                          | 6/6 checks passed                                                                                    |
| `npm run test:coursework` with axe                     | 18/18 checks passed                                                                                  |
| Provider test build and `npm run test:provider-stream` | 16/16 local synthetic provider checks passed                                                         |
| `npm run test:release`                                 | 17 tests passed                                                                                      |
| `npm run test:keychain`                                | 12 tests passed                                                                                      |
| Extension and companion packaging                      | Passed; 39-file extension and 4-file companion ZIPs passed CRC checks; parser license texts included |

Library and Coursework light/dark views had zero scoped axe violations for WCAG
2 A/AA, WCAG 2.1/2.2 AA and best-practice tags. Library reflow passed at 360px
and 180px. These automated checks do not establish full accessibility conformance.
The existing Vite future-config-loader notice remains non-failing.

Boundary tests cover worker deadlines and cancellation, Chromium 125 PDF gating,
malformed payloads, ZIP size/inflation/CRC limits, strict XML, course identity,
assessment refusal, stale page handles, deletion epochs, schema migration and
concurrent library capacity. The deferred-tab cancellation regression proves
that cancellation stops the credentialed download from starting.

## Reproduction and limits

```bash
npm ci
npm run build
npm run test:documents
```

For the optional accessibility audit and synthetic screenshots:

```bash
MOTION_AXE_PATH=/absolute/path/to/axe.min.js \
MOTION_SCREENSHOTS_DIR=docs/verification/screenshots \
npm run test:documents
```

`MOTION_REAL_DOCUMENT_PATH` optionally adds a downloaded private PDF after the
synthetic screenshots. It logs only counts and deletes the temporary profile.
The normal CI path has 23 checks; axe adds two and the private-file probe adds
one. CI does not receive real lecture files or authenticated credentials.

Limits are 20 MB, 30 seconds, 200 pages/slides, 200,000 total characters,
12,000 characters per unit and 100 saved indexes. PDF indexing needs Chromium
125+; the extension shell and PPTX path retain the Chrome 116 minimum. There
is no OCR, legacy `.ppt`, visual reconstruction, speaker-note indexing or
automatic whole-course crawl. Real provider inference and actual GitHub release
publication remain separate verification work.

## Screenshots

Production extension with synthetic lecture material:

![Light Library with a synthetic slide-text search](screenshots/library-light.png)

![Dark Library with a synthetic slide-text search](screenshots/library-dark.png)
