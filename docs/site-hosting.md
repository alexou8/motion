# Public privacy policy

Motion's policy is a standalone static page on GitHub Pages. It uses the same
bundled brand artwork and licensed fonts as the extension, readable light/dark
styles, section navigation, and a keyboard skip link. There are no scripts,
analytics, cookies, third-party fonts, or contact forms on the page. GitHub
operates the hosting infrastructure under its own privacy policy.

`docs/PRIVACY.md` is the authoritative disclosure source. The page builder
copies its headings, paragraphs and links without summarizing or changing them.
The generated site and its fonts/licenses stay outside the extension package.

To update the published policy:

1. Edit `docs/PRIVACY.md` and its revision date when data practices change.
2. Run `npm run build:site`, then review `.motion-site/privacy.html` in a browser,
   including narrow screens, keyboard navigation and the full disclosure text.
3. With publisher authorization and authenticated GitHub CLI access, run
   `node scripts/publish-policy-site.mjs --publish`.
4. Verify the public page while signed out at
   <https://alexou8.github.io/motion/privacy.html>, compare its downloaded
   `privacy.md` with the source, and update `CHROMEWEBSTORE.md`.

Publishing creates or advances only the separate `gh-pages` branch and configures
Pages for that branch. It does not push the extension's working branch or publish
an extension release. Updates preserve branch history and existing Pages files;
a conflicting Pages configuration stops publication. Keep the policy URL stable
across extension releases.
