# Third-party licences

## Bundled fonts

`src/assets/fonts/` contains a latin subset of **IBM Plex Sans** and **IBM Plex Mono**,
copyright IBM Corp., licensed under the **SIL Open Font License, Version 1.1**.

Full licence: <https://github.com/IBM/plex/blob/master/LICENSE.txt>

`src/assets/fonts/source-serif-4-var.woff2` is a latin subset of **Source Serif 4**
(variable weight), copyright Adobe, taken from `@fontsource-variable/source-serif-4`
5.3.0 and licensed under the **SIL Open Font License, Version 1.1**. The full licence
text ships beside the font as `src/assets/fonts/OFL-source-serif-4.txt`.

The files are bundled rather than loaded from a font CDN so the extension makes no
third-party network request at runtime. See `docs/SECURITY.md`.
