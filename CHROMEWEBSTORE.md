# Chrome Web Store Listing — Motion

> Last Updated: 2026-09-07

## Store Listing

**Extension Name**

Motion — From Coursework to Completion

**Short Description**

Organizes LMS coursework into source-linked deadlines, notes, checklists, and drafts that stay on your device.

**Detailed Description**

Motion turns scattered LMS course pages into one visible, student-controlled coursework workspace.

FEATURES
• Finds coursework and deadlines on supported D2L Brightspace pages.
• Keeps each extracted item linked to the page and text it came from.
• Creates source-linked notes and assignment checklists.
• Helps draft and review coursework using Chrome's on-device model when available.
• Shows progress and asks before consequential browser actions.
• Stands back on detected graded attempts.

HOW TO USE
1. Open a supported D2L Brightspace or MyLearningSpace course page.
2. Click the Motion toolbar icon to open the side panel.
3. Choose what to read, organize, or review.

PRIVACY
Coursework data stays in your browser profile. Motion makes no network requests of its own, uses no analytics, and does not share your data with third parties.

SUPPORT
Report bugs or request features at https://github.com/alexou8/motion/issues.

**Category**

Productivity

**Single Purpose**

Organizes coursework from supported LMS pages into a local, source-linked student workspace.

**Primary Language**

English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `src/assets/icons/icon-128.png` |
| Screenshot 1 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile | 440×280 | ⬜ Not created | |

### Screenshot Notes

Show the side panel beside a synthetic course page with extracted work and source links visible. Do not include real student names, course identifiers, grades, or coursework.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Keeps the student's courses, tasks, notes, checklists, workflow progress, and approvals in the local browser profile. |
| `sidePanel` | permissions | Provides the persistent coursework workspace beside the LMS page the student is reading. |
| `tabs` | permissions | Identifies the active supported LMS page, reads its title and URL, and communicates with Motion's reader on that tab. |
| `tabGroups` | permissions | Groups tabs opened for an approved coursework workflow so the student can find and control them. |
| `scripting` | permissions | Currently unused. Remove this permission before Web Store submission unless a user-facing feature is implemented that requires it. |
| `alarms` | permissions | Resumes or retries opted-in background workflows after the extension has been suspended. |
| `https://*.brightspace.com/*` | host_permissions | Reads supported D2L Brightspace course pages to extract user-requested coursework information. |
| `https://*.desire2learn.com/*` | host_permissions | Reads supported legacy D2L course pages to extract user-requested coursework information. |
| `https://mylearningspace.wlu.ca/*` | host_permissions | Reads Wilfrid Laurier University MyLearningSpace course pages to extract user-requested coursework information. |
| `https://*/*` | optional_host_permissions | Lets a student explicitly grant access to one additional HTTPS institution host when its D2L deployment uses a custom domain. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes — website content and user-created coursework records are processed and stored locally to provide the requested features. They are not transmitted off-device by Motion.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Authentication info | No | No | Not accessed or stored | No |
| Personal communications | No | No | Not accessed or stored | No |
| Web history | Limited | No | Stores source URLs only for supported course content the student asks Motion to organize | No |
| User activity | Limited | No | Stores workflow state and approval decisions inside the browser profile | No |
| Website content | Yes | No | Extracts course names, instructions, tasks, deadlines, and student-selected notes | No |

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL:** TBD before submission. Publish a policy matching `docs/DATA.md`, `docs/SECURITY.md`, and `docs/adr/0002-local-first-no-backend.md` at a stable public URL.

## Distribution

**Visibility:** Public

**Regions:** All regions

## Developer Info

**Publisher Name:** TBD before submission

**Contact Email:** TBD before submission

**Support URL:** https://github.com/alexou8/motion/issues

**Homepage URL:** https://github.com/alexou8/motion

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-09-07 | Initial draft listing; corrected service-worker packaging and toolbar side-panel opening. | Draft |

## Review Notes

### Known Issues / Limitations

- Chrome 116 or newer is required.
- The manifest currently declares the unused `scripting` permission; remove it before submission unless an implemented feature requires it.
- Draft assistance additionally requires Chrome's on-device model and degrades with an explanation when it is unavailable.
- The privacy policy URL, publisher name, contact email, and at least one synthetic-data screenshot must be supplied before submission.
