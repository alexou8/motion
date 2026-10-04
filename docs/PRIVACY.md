# Motion privacy policy

Last updated: October 4, 2026

Motion is a coursework browser extension published by Alex Ou. Privacy questions and deletion requests can be sent to [alexoudev8@gmail.com](mailto:alexoudev8@gmail.com).

## Information Motion handles

Motion reads supported D2L Brightspace course pages to organize course names, task titles, instructions, deadlines, source URLs, and relevant excerpts. It stores coursework records, notes, checklists, drafts, chat messages, session plans, workflow progress, approval decisions, and settings in your browser profile. Course material or text you provide may include personal information or communications.

Motion uses the active tab's URL and title to identify supported coursework and records tabs associated with a Motion workspace. It does not build a browsing history of unrelated sites. It does not read or retain content from a page it detects as a graded, timed, or proctored attempt.

If you enable deadline scanning for a supported host, Motion reads that site's course and calendar data using your existing signed-in browser session. These read-only requests go to your LMS. Motion does not collect your LMS password or copy its session cookies or tokens into its records.

Motion has no account system, analytics, advertising, install tracking, or telemetry. It has no developer-operated server receiving your coursework.

When you choose a PDF or PPTX source in Library, Motion downloads it from the supported course destination and indexes selectable text locally with page or slide numbers, course and source metadata. Bundled parsers process the file on your device. Indexing does not send files or their text to an AI provider. You can search, read, reindex, or remove individual indexes.

## Local storage and processing

Coursework, document indexes, and session records are stored in the extension's IndexedDB database. Preferences, scanning summaries, reminder state, and theme/view choices are stored locally in the browser. Motion does not sync this data through Chrome sync. Local records are protected by your device and browser profile; Motion does not independently encrypt them.

Chrome's on-device model, when available and selected, processes model turns locally. Chrome may need to download its model before use. Model availability depends on your browser, device, and Chrome configuration. Deadline organization does not require an AI provider.

Reminders are off by default. After you enable them, notifications use locally stored task titles and due dates. Notifications can be visible to others using or viewing your device. Stored submission status suppresses reminders; Motion cannot guarantee a fresh submission status while your LMS is unavailable.

## Optional cloud AI providers

When you select OpenAI or Anthropic, accept the cloud-processing disclosure, and grant permission for that provider, Motion sends your message or goal, relevant session state, notes, and bounded excerpts directly to the selected provider over HTTPS. Sources you exclude are omitted from that model turn. Motion does not proxy these requests through a Motion server or silently switch providers.

Provider API keys are sent to the selected provider to authenticate requests. Keys are held in trusted browser-session storage by default and disappear when the browser session ends. They are never saved in browser local storage, Chrome sync, IndexedDB, logs, or ordinary files. If you explicitly choose to remember a key and install the optional local companion, it is saved in your operating system's credential vault. The companion connects locally and has no server.

Provider processing and retention are governed by the selected provider's terms and privacy policies: [OpenAI](https://openai.com/policies/privacy-policy/) and [Anthropic](https://www.anthropic.com/legal/privacy). Any usage fees are charged by that provider. Revoking cloud disclosure, removing the provider's permission, or selecting the local provider prevents subsequent cloud turns.

## Coursework actions and sharing

Motion may prepare coursework, notes, or drafts at your direction. A supported consequential submission, upload, post, or send requires a fresh approval for that specific target and action. Approving one action does not approve future actions. Approved content goes to the selected course destination. Motion refuses actions inside detected graded, timed, or proctored attempts.

Motion does not sell user data, use it for advertising, or use it to determine creditworthiness or lending eligibility. Information is used only to provide the coursework features you choose. Motion's use and transfer of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Retention and deletion

Local records remain until you delete them or remove the extension. Settings → Data & privacy → Delete all Motion data removes coursework records, local Motion preferences, session data, and configured provider keys. If removal of a remembered key fails because the companion is unavailable, Motion reports that failure; restore companion access and retry, or remove the credential directly from your OS credential vault. Forget key in AI settings removes an individual provider key.

Deleting local records does not retract content you already submitted to an LMS or sent to a cloud provider. Those services control their copies. Uninstalling the browser extension removes its browser-profile data but does not uninstall the optional companion or guarantee removal of its OS-vault credentials; use Forget key before uninstalling.

## Policy changes and contact

This policy will be updated when Motion's data practices change. The date above identifies the latest revision. For support and privacy questions, contact [alexoudev8@gmail.com](mailto:alexoudev8@gmail.com) or use [Motion's issue tracker](https://github.com/alexou8/motion/issues). Avoid posting private coursework or API keys in public issues.

Motion is independent and is not affiliated with or endorsed by Wilfrid Laurier University, D2L, OpenAI, or Anthropic.
