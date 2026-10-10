# Motion builds and releases

Motion ships through the Chrome Web Store for students, and distributes
unpacked developer builds on GitHub for review and testing. The GitHub
workflows do not publish to the Chrome Web Store or change the extension's
version automatically; store releases are uploaded by hand from a tagged
version (see `CHROMEWEBSTORE.md`).

## Download channels

| Channel                | Download                                                                                                                  | Behaviour                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Chrome Web Store       | The published listing                                                                                                     | The supported channel for students. Chrome installs updates automatically; no developer mode or manual reload is needed.      |
| Main development build | [motion-extension-latest.zip](https://github.com/alexou8/motion/releases/download/main-build/motion-extension-latest.zip) | Refreshed after a validated push to `main`, including merged pull requests. A prerelease that may include unfinished features. |
| Versioned release      | [Latest versioned release](https://github.com/alexou8/motion/releases/latest)                                             | Published by a matching `vX.Y.Z` tag. Published assets are never replaced by these workflows.                                  |
| Branch or pull request | The **Build** run's Artifacts section                                                                                     | An unpacked extension for review; artifacts expire after 30 days and require GitHub access.                                    |

Unzip the extension, open `chrome://extensions`, enable **Developer mode**, then
choose **Load unpacked** and select the folder containing `manifest.json`.
The optional keychain companion has a separate ZIP and installation instructions
inside it. Installing the extension does not install that companion.

The main download uses the explicit `main-build` tag. It does not use
`releases/latest`: that endpoint belongs to versioned releases. Main is a mutable
development channel; its tag and assets change together. Refreshing it briefly
makes the release a draft so students cannot download partially replaced assets.
A failed refresh leaves a draft until a successful rerun or later main build.

## One validation gate

`validate.yml` is shared by branch builds, pull requests, main builds and tagged
releases. It runs locked installation, type checking, unit tests, release integrity
tests, native companion tests, linting, production building, Chromium extension,
agent, launcher and coursework checks, and provider streaming/recovery checks.
It packages the production build only after those checks pass.

Release preparation additionally checks:

- `package.json`, both root lockfile versions and the built manifest agree.
- A release tag exactly matches `vX.Y.Z`; suffixes and version drift fail.
- The build uses Manifest V3, includes Motion's worker, launcher, side panel and
  settings, and every referenced manifest asset exists, including icons and CSS.
- Shipped host permissions exactly match the three reviewed LMS host patterns;
  extra provider grants and mandatory native messaging permissions fail.
- There are no symbolic links, source maps, `.env`, `.git` or `node_modules`
  entries in the extension archive.
- The ZIP matches every byte of the tested build, standard ZIP CRC checks pass,
  and the release assets' SHA-256 checksums match.

The extension ZIP uses sorted files, UTF-8 filenames and fixed ZIP timestamps.
Packaging the same build produces identical bytes; this does not claim the full
bundler or the optional companion produces identical builds across machines.

Build jobs have read-only repository access and do not inherit release secrets.
Publishing jobs receive repository write access only after validation, download
that run's exact artifact, and verify its source SHA and checksums. They do not
install dependencies or rebuild the extension. Actions are pinned to commit
SHAs; Dependabot proposes reviewed weekly updates to those pins.

## Publish a version

1. Choose a three-part Chrome-compatible version. Update `package.json`, the
   root version entries in `package-lock.json`, and `src/manifest.config.ts`
   together. Update release documentation and the roadmap with actual evidence.
2. Open and merge a reviewed pull request after the shared gate passes.
3. Tag the intended commit, for example `git tag -a v0.1.2 <commit> -m "Release 0.1.2"`,
   then push that specific tag with `git push origin v0.1.2`.
4. The **Release** workflow revalidates the tagged source, checks that the remote
   tag still resolves to that commit, creates a draft, uploads both ZIPs,
   `motion-release.json` and `SHA256SUMS`, then publishes it with generated notes.

Publishing jobs share a concurrency group so the Latest version decision and
publication cannot race. Up to 100 waiting publication jobs queue without
cancelling earlier version releases. Publishing an older version preserves a newer
Latest release. A successful versioned release is append-only through these workflows:
a rerun refuses to overwrite it. If an upload fails, the draft remains available
for the next rerun to finish. Authentication and API errors fail the run rather
than being treated as missing releases.

Main publication is serialized separately. Before updating its tag it checks
that the validated commit is still the head of `main`; superseded runs skip
publication. Direct pushes to main get the same validation as merged pull
requests. No pull request event has a publishing job with write access.

GitHub's repository-wide release immutability setting also prevents replacing
`main-build`, so it is incompatible with this mutable development channel.
Versioned assets are protected from replacement by this workflow; repository
administrators still control release and tag settings. If repository-enforced
immutability is enabled later, switch development builds to per-commit
prereleases before enabling it. The publisher refuses an immutable main release
instead of deleting or recreating it.

## Verify a download

Download both ZIPs, `motion-release.json` and `SHA256SUMS` from the same release
into one folder. `motion-release.json` records the source commit, version and
minimum Chrome version. In that folder run:

```bash
# Linux
sha256sum -c SHA256SUMS

# macOS
shasum -a 256 -c SHA256SUMS
```

Every listed file should report `OK`. Checksums detect corruption and a mismatch
between downloaded assets; they do not independently establish who published
those assets.

To inspect only the extension checksum on Windows PowerShell:

```powershell
Get-FileHash .\motion-extension-latest.zip -Algorithm SHA256
```

Compare that result with the matching filename's digest in `SHA256SUMS`.

## Recover a failed publication

Read the failed step first. Fix the input or API problem, then rerun the failed
workflow against the same source. Uploads can replace assets only on a draft;
main can be refreshed, but a published versioned release cannot. Never move a
versioned tag or upload a different ZIP under the same published version. Ship a
new version for corrections.

The local integrity suite is `npm run test:release`. GitHub publication and
repository settings must still be verified in an actual workflow run after this
change lands; local tests exercise publishing state transitions with synthetic
repository state and never contact a course or create a release.

## References

The workflow follows GitHub's [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
and [concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
rules, and the CLI's [release creation](https://cli.github.com/manual/gh_release_create)
and [release editing](https://cli.github.com/manual/gh_release_edit) behavior.
