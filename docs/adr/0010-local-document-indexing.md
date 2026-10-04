# ADR 0010 — Index lecture text locally in bounded document workers

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Tracking a lecture title does not make the concepts inside its PDF or slide
deck searchable. MyLearningSpace exposes PDFs through a same-origin PDF.js
viewer whose `file` parameter references a course file. Motion needs actual
text decoding while preserving its permission, assessment and local-data rules.

## Decision

The panel is a document host for bundled module workers. `pdfjs-dist` decodes
PDF text; `fflate` supplies streaming DEFLATE for selected PPTX XML parts.
These dependencies avoid a fragile PDF decoder and provide compressed slide
support without a server or rendering engine. The PDF host is lazy-loaded.
Workers receive bytes only, never URLs, selectors or Chrome authority.

The worker owns source identity, fetching and IndexedDB. A student selects an
opaque handle for a file observed on the current supported LMS page. The adapter
unwraps recognized viewer links and accepts only same-origin HTTPS files in the
same course. The worker rechecks the page, source, course and assessment before
and after a bounded GET with credentials and redirect refusal. This uses existing
host permissions. Alternatively, a student imports a downloaded local file.

Imports acquire expiring worker-issued tickets before parsing. A shared local
data lock and content-free epoch serialize commit against deletion and revoke
old tickets. No file bytes are persisted; only bounded extracted text and
source metadata are stored. Indexed text is not sent to an AI provider.

## Limits and failures

Input is capped at 20 MB; parsing at 30 seconds, 200 pages/slides, 200,000 total
characters and 12,000 characters per unit. The library holds at most 100 indexes.
PPTX parsing checks ZIP sizes, CRC, inflation ratios, member paths and strict
XML, uses presentation relationship order, and ignores notes and external parts.
Image-only text, omitted units and truncated text are disclosed. No OCR, legacy
`.ppt`, macro execution, or arbitrary course crawling is included.

PDF.js's [documented legacy browser support](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)
starts at Chrome 125. Motion keeps its existing Chrome 116 shell minimum and
gates PDF indexing below 125 with an update message; it does not downgrade the
decoder or relax CSP. PDF.js [loading options](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
disable fonts, XFA, images, WASM and optional binary-data networking for this
text-only path. PPTX uses the [fflate streaming decoder](https://github.com/101arrowz/fflate).

## Verification

Synthetic unit and production-extension tests cover malformed input, worker
cleanup, limits, ordered Unicode slide text, search, provenance, deletion and
assessment boundaries. A private lecture downloaded through the authenticated
LMS was indexed in an isolated extension profile; only counts were retained.
Authenticated extension fetching and the complete installed live-account flow
remain unverified. See [document verification](../verification/document-indexing.md).
