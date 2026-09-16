# Local AI runtime probe — evidence (2026-09-16)

Throwaway MV3 extension (manifest: storage, offscreen) evaluating `typeof LanguageModel`
and `LanguageModel.availability({expectedInputs/Outputs: text en})` in each context.

| Browser | Service worker | Extension page (same class as side panel) | Offscreen document |
| --- | --- | --- | --- |
| Google Chrome 152.0.7977.83 stable, fresh profile (CDP Extensions.loadUnpacked) | function, `downloadable` | function, `downloadable` | function, `downloadable` |
| Playwright Chromium 153.0.8010.12 | function, availability() **never resolves** (8s timeout) | function, never resolves | not measured |

Conclusions:
- The Prompt API *is* exposed in the extension service worker on current Chrome; the
  "not available in Web Workers" limitation does not apply to extension service workers here.
- Inference itself was not exercised: the on-device model was not downloaded (multi-GB,
  hardware-gated). Background inference reliability (worker suspension during a long
  prompt) is therefore unproven, so Motion treats background local execution as a
  runtime-detected capability and prefers the side-panel document host when connected.
- `availability()` can hang indefinitely when the model component is absent (Chromium):
  every call must be time-bounded.
