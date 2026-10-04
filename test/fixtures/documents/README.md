# Synthetic document fixtures

Every file in this directory is synthetic test data. No fixture contains real
course content, student information, identifiers, credentials or grades.

`node test/fixtures/documents/generate.mjs` reproduces the fixtures:

- `synthetic-lecture.pdf`: two pages of selectable text, including WinAnsi Unicode.
- `synthetic-image-only.pdf`: one page containing an image and no selectable text.
- `synthetic-corrupt.pdf`: a deliberately invalid PDF.
- `synthetic-slides.pptx`: two slides in presentation relationship order (slide2,
  then slide1), Unicode text, and excluded speaker notes.
- `synthetic-malicious-xml.pptx`: an external-entity declaration that must be rejected.

Oversized and dishonest compressed archives are generated in tests so that large
binary files are not committed. These files exercise text extraction; the parser
does not render slides, run embedded code, decode image text or perform OCR.
