import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parsePptx } from './pptx';
import { SlideArchive } from './zip';

const fixture = (name = 'synthetic-slides.pptx') =>
  new Uint8Array(readFileSync(resolve('test/fixtures/documents', name)));
const parts = () => unzipSync(fixture());
const edit = (changes: Record<string, string | Uint8Array>) =>
  zipSync({
    ...parts(),
    ...Object.fromEntries(
      Object.entries(changes).map(([name, value]) => [
        name,
        typeof value === 'string' ? strToU8(value) : value,
      ]),
    ),
  });

describe('local PowerPoint text indexing', () => {
  it('uses presentation order and preserves slide provenance and Unicode', () => {
    const result = parsePptx(fixture());
    expect(result.format).toBe('pptx');
    expect(result.totalUnits).toBe(2);
    expect(result.units).toEqual([
      { number: 1, text: 'Synthetic first slide: retrieval practice.' },
      { number: 2, text: 'Synthetic second slide: café & Unicode 🎓.' },
    ]);
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain('speaker notes');
  });

  it('does not substitute a filename sort when order metadata is missing', () => {
    const xml = new TextDecoder().decode(parts()['ppt/presentation.xml']);
    expect(() =>
      parsePptx(edit({ 'ppt/presentation.xml': xml.replace(/<p:sldIdLst>.*?<\/p:sldIdLst>/, '') })),
    ).toThrow('not a supported');
  });

  it('rejects external entities and malformed relationship targets', () => {
    expect(() => parsePptx(fixture('synthetic-malicious-xml.pptx'))).toThrow('unsupported XML');
    const xml = new TextDecoder().decode(parts()['ppt/_rels/presentation.xml.rels']);
    for (const target of [
      'https://example.invalid/slide.xml',
      '../notesSlides/slide1.xml',
      'slides/%73lide1.xml',
    ]) {
      expect(() =>
        parsePptx(
          edit({ 'ppt/_rels/presentation.xml.rels': xml.replace('slides/slide1.xml', target) }),
        ),
      ).toThrow();
    }
    expect(() =>
      parsePptx(
        edit({
          'ppt/_rels/presentation.xml.rels': xml.replace(
            'Target="slides/slide1.xml"',
            'Target="slides/slide1.xml" TargetMode="External"',
          ),
        }),
      ),
    ).toThrow();
  });

  it('refuses macro-enabled presentations and empty archives', () => {
    expect(() => parsePptx(edit({ 'ppt/vbaProject.bin': new Uint8Array([1]) }))).toThrow(
      'not a supported',
    );
    expect(() => parsePptx(zipSync({}))).toThrow();
  });

  it('discloses image-only slides and truncates long selectable text', () => {
    const xml = new TextDecoder().decode(parts()['ppt/slides/slide2.xml']);
    const imageOnly = parsePptx(
      edit({ 'ppt/slides/slide2.xml': xml.replace(/<a:t>.*?<\/a:t>/, '<a:t/>') }),
    );
    expect(imageOnly.units[0]?.text).toBe('');
    expect(imageOnly.warnings.join()).toContain('Some pages');
    // Store uncompressed to test the text bound independently of ZIP ratios.
    const updated = {
      ...parts(),
      'ppt/slides/slide2.xml': strToU8(
        xml.replace(/<a:t>.*?<\/a:t>/, `<a:t>${'Synthetic '.repeat(1400)}</a:t>`),
      ),
    };
    const result = parsePptx(zipSync(updated, { level: 0 }));
    expect(result.units[0]?.text.length).toBeLessThanOrEqual(12_000);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join()).toContain('Only part');
  });
});

describe('bounded slide ZIP extraction', () => {
  it('rejects archive traversal, high compression ratios and oversized XML', () => {
    expect(() => new SlideArchive(edit({ '../synthetic.xml': '<x/>' }))).toThrow();
    expect(() => new SlideArchive(edit({ 'synthetic.xml': 'x'.repeat(2_000_000) }))).toThrow();
    expect(() =>
      new SlideArchive(
        zipSync({ 'synthetic.xml': strToU8('x'.repeat(2 * 1024 * 1024 + 1)) }, { level: 0 }),
      ).readXml('synthetic.xml'),
    ).toThrow();
  });

  it('rejects corrupt archive metadata and CRC values', () => {
    const damaged = fixture();
    damaged[0] = 0;
    expect(() => new SlideArchive(damaged)).toThrow();
    const crc = zipSync({ 'synthetic.xml': strToU8('<x>synthetic</x>') }, { level: 0 });
    const view = new DataView(crc.buffer);
    view.setUint32(14, 0, true);
    const central = crc.findIndex(
      (value, index) =>
        value === 0x50 &&
        crc[index + 1] === 0x4b &&
        crc[index + 2] === 0x01 &&
        crc[index + 3] === 0x02,
    );
    view.setUint32(central + 16, 0, true);
    expect(() => new SlideArchive(crc).readXml('synthetic.xml')).toThrow();
  });

  it('checks actual inflated bytes instead of trusting metadata', () => {
    const archive = zipSync({
      'synthetic.xml': strToU8('<x>' + 'synthetic '.repeat(100) + '</x>'),
    });
    const view = new DataView(archive.buffer);
    view.setUint32(22, 1, true);
    const central = archive.findIndex(
      (value, index) =>
        value === 0x50 &&
        archive[index + 1] === 0x4b &&
        archive[index + 2] === 0x01 &&
        archive[index + 3] === 0x02,
    );
    view.setUint32(central + 24, 1, true);
    expect(() => new SlideArchive(archive).readXml('synthetic.xml')).toThrow();
  });
});
