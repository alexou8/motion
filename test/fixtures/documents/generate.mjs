// All documents in this directory are synthetic, authored for parser tests.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

function pdf(objects) {
  let source = '%PDF-1.4\n% Synthetic Motion parser fixture\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, 'latin1'));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(source, 'latin1');
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(source, 'latin1');
}
const stream = (source) => `<< /Length ${Buffer.byteLength(source, 'latin1')} >>\nstream\n${source}\nendstream`;

writeFileSync(new URL('./synthetic-lecture.pdf', import.meta.url), pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
  stream('BT /F1 18 Tf 72 720 Td (Synthetic lecture: local indexing) Tj 0 -30 Td (Caf\\351 study notes and source provenance.) Tj ET'),
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
  stream('BT /F1 18 Tf 72 720 Td (Synthetic page two: spaced repetition.) Tj ET'),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
]));

writeFileSync(new URL('./synthetic-image-only.pdf', import.meta.url), pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
  stream('q 100 0 0 100 72 650 cm /Im1 Do Q'),
  '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff\nendstream',
]));
writeFileSync(new URL('./synthetic-corrupt.pdf', import.meta.url), '%PDF-1.4\nSynthetic intentionally corrupt test document.\n');

const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const ct = 'http://schemas.openxmlformats.org/package/2006/content-types';
const slide = (text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${p}" xmlns:a="${a}"><p:cSld name="Synthetic slide"><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
export const syntheticSlideParts = {
  '[Content_Types].xml': `<Types xmlns="${ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
  '_rels/.rels': `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${r}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  'ppt/presentation.xml': `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${rel}"><Relationship Id="rId3" Type="${r}/slide" Target="slides/slide1.xml"/><Relationship Id="rId9" Type="${r}/slide" Target="slides/slide2.xml"/></Relationships>`,
  'ppt/slides/slide1.xml': slide('Synthetic second slide: café &amp; Unicode &#x1F393;.'),
  'ppt/slides/slide2.xml': slide('Synthetic first slide: retrieval practice.'),
  'ppt/notesSlides/notesSlide1.xml': slide('Synthetic speaker notes must never enter the slide index.'),
};
const archive = (parts) => zipSync(Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])), { level: 6, mtime: new Date(2024, 0, 1) });
writeFileSync(new URL('./synthetic-slides.pptx', import.meta.url), archive(syntheticSlideParts));
writeFileSync(new URL('./synthetic-malicious-xml.pptx', import.meta.url), archive({ ...syntheticSlideParts,
  'ppt/slides/slide2.xml': `<!DOCTYPE p:sld [<!ENTITY stolen SYSTEM "https://example.invalid/synthetic">]>${slide('&stolen;')}`,
}));
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log('Generated only synthetic PDF and PPTX parser fixtures.');
