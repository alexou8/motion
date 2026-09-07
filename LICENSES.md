# Third-party licences

## Bundled fonts

`src/assets/fonts/` contains a latin subset of **IBM Plex Sans** and **IBM Plex Mono**,
copyright IBM Corp., licensed under the **SIL Open Font License, Version 1.1**.

Full licence: <https://github.com/IBM/plex/blob/master/LICENSE.txt>

The files are bundled rather than loaded from a font CDN so the extension makes no
third-party network request at runtime. See `docs/SECURITY.md`.
