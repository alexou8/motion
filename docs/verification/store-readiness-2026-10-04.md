# Motion store preparation verification — October 4, 2026

## Scope and review

Compared Motion with WATnow's public repository: course filters, complete future
lists, explicit clock times, date-change visibility, and usable cached data.
Motion already had scanning, reminder preferences, correction history, and a
week view. This change closes presentation gaps rather than introducing a
second deadline system. No WATnow source or artwork was copied.

Source and diff reviewed against `docs/REVIEW.md`: core remains independent of
Chrome/React; no boundary contracts, assessment policy, approvals, actor
capabilities, or provider transport were broadened. The cached-deadline screen
returns before any coursework rendering in restricted mode. Viewing cached data
initiates no LMS request. Local course filtering changes only presentation.
The unused scripting permission was removed; no permission or dependency was
added. No database migration or version change was needed.

Date display and bucketing use the same browser zone. Known clock times are
visible with a zone abbreviation; assumed times retain review warnings.
Calendar-day arithmetic handles DST without rounding 24-hour durations. Earlier
same-day deadlines are overdue. The list includes distant work, and Week keeps
uncertain dates in a separate review section.

The new original M/book-fold/upward-arrow mark uses purple and gold. The warm
neutrals, bundled fonts, tracks, and layout are retained. Full-colour logo
rendering replaces a monochrome mask; the popup browser test now proves the
image decodes and occupies visible space. Both semantic palettes meet the
existing contrast suite.

## Checks run

| Command/check                                   | Actual result                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                             | Passed; also run by the production build                                                                                                                                                                                                                |
| `npm test -- --reporter=dot`                    | 96 files, 1,266 tests passed                                                                                                                                                                                                                            |
| `npm run lint`                                  | Passed                                                                                                                                                                                                                                                  |
| `npm run build`                                 | Passed; production bundle and worker graph verified                                                                                                                                                                                                     |
| `npm run test:package`                          | 14 checks passed, including rejecting test-provider hosts, required native messaging, scripting, oversized descriptions, missing/wrong icons, source maps, test files, development runtime, dynamic execution, exposed extension UI, and path traversal |
| `MOTION_CAPTURE_STORE=1 npm run test:extension` | 74/74 browser checks passed against synthetic LMS routes                                                                                                                                                                                                |
| `npm run test:popup-presence`                   | 6/6 checks passed                                                                                                                                                                                                                                       |
| `npm run test:agent`                            | 45/45 checks passed; optional cloud stream branch skipped because headless Chromium did not grant its host permission                                                                                                                                                                                                                                     |
| `npm run test:release` | 17 integrity checks passed |
| `npm run test:coursework` | 18/18 browser checks passed |
| `npm run test:documents` | 23/23 browser checks passed |
| `npm run package`                               | Produced `motion-extension-0.1.1.zip`; 40 files, 889,600 bytes                                                                                                                                                                                          |
| ZIP validation                                  | Every entry passed CRC verification; manifest and full license notices at archive root; no store assets or test files                                                                                                                                   |
| `git diff --check`                              | Passed                                                                                                                                                                                                                                                  |

Verification was repeated after integrating main `167c420`, retaining the new
coursework library, document parsers, reproducible ZIP functions, and shared
release workflow. The store gate runs at the production CLI boundary; a test
proves it rejects an altered test-host build before writing a ZIP. The restricted
unit assertion permits only the accessibility skip link, while still rejecting
coursework links and controls. Privacy disclosures include local document indexes.

Initial concurrent browser runs had timing failures in panel transitions, pointer
observations, and document indexing. Sequential reruns passed. The smoke test now
waits for the restricted screen and composer to render rather than relying only
on a fixed delay. No action or assessment assertion was removed.

The unit suite emits an existing jsdom diagnostic about unimplemented
`HTMLFormElement.requestSubmit` in an actor test and an expected failure-path
model warning. Neither caused a test failure. Vite emits its existing advisory
about extensionless imports under a future native config loader; this build
completed successfully.

Browser checks cover course-filter behavior in both views, distant deadlines,
confirmed API dates without uncertainty warnings, uncertain saved dates retaining
warnings, signed-out caching, assessment refusal, worker restart, and no
horizontal overflow at 320px in light/dark themes. The agent check also covers
panel/settings layout at 200% zoom. All course fixtures are synthetic; these
checks contacted no real LMS or AI provider.

The Week browser assertion was corrected to distinguish confirmed API dates
from other uncertain saved tasks: each confirmed row must remain free of a
review warning, and uncertain rows must retain their warning. The existing
high-confidence Later unit fixture now explicitly declares a known time rather
than inheriting `timeAssumed: true`; its no-warning assertion was strengthened.

## Submission artifacts

- ZIP: `motion-extension-0.1.1.zip`.
- SHA-256: `693bb8070a7fd159db0a08382e11488ec25c614f83b19ee0e7123c9ff5545f20`.
- Listing copy, publisher Alex Ou, contact alexoudev8@gmail.com, permission and
  privacy declarations: `CHROMEWEBSTORE.md`.
- Privacy policy source: `docs/PRIVACY.md`.
- 1280×800 light/dark listing screenshots and required 440×280 promotional tile:
  `docs/store-assets/`. Screenshots were visually inspected after rendering and
  show actual built UI with synthetic records. Composition waits for fonts and
  images to decode and reuses the loaded composition for both themes, preventing
  missing text when Chromium loads the same bundled fonts in a second document. Raw 400×740 panel captures accompany the store files.
- 16/32/48/128px PNG icons generated from the canonical SVG; the 128px asset
  contains a 96px tile with transparent padding.
- Full bundled font/runtime library licenses included in the extension package.

## Remaining submission requirements and limits

The policy source has not been published. A stable public HTTPS policy URL must
be hosted and verified signed out before submission. Chrome Web Store developer
registration/verification and dashboard declarations must be completed by the
publisher. Confirm the uploaded version is greater than any existing version of
the same store item. Supply permitted reviewer access or a demonstration if
needed; do not share a student's password.

Current live-institution markup, custom HTTPS institution hosts outside the
built-in content-script matches, provider/account availability, and OS-vault
installation for a store-assigned extension ID require their own validation.
Existing per-provider/native transport evidence is in
`browser-verification.md`. Reminder suppression uses stored submission status;
a fresh LMS submission-status recheck remains a roadmap item.

The ZIP and listing materials are locally prepared. Privacy-policy publication,
Chrome Web Store submission, and store approval remain outstanding. Static packaging checks supplement browser testing and
are not a complete security audit or a guarantee of store acceptance.
