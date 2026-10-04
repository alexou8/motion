import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_LIMITS,
  documentWarnings,
  parsedDocumentSchema,
  validateDocumentBytes,
} from './contracts';

const document = () => ({
  format: 'pdf' as const,
  units: [{ number: 1, text: 'Synthetic text.' }],
  totalUnits: 1,
  truncated: false,
  warnings: [],
});

describe('document parsing contracts', () => {
  it('accepts synthetic extracted text and numbered empty pages', () => {
    expect(parsedDocumentSchema.parse(document()).units[0]?.text).toBe('Synthetic text.');
    expect(
      parsedDocumentSchema.parse({ ...document(), units: [{ number: 1, text: '' }] }).units,
    ).toHaveLength(1);
  });

  it.each([
    { units: [{ number: 0, text: '' }] },
    { units: [{ number: 2, text: '' }] },
    {
      units: [
        { number: 1, text: '' },
        { number: 1, text: '' },
      ],
      totalUnits: 2,
    },
    {
      units: [
        { number: 2, text: '' },
        { number: 1, text: '' },
      ],
      totalUnits: 2,
    },
    { totalUnits: 2 },
    { units: [] },
    { units: [{ number: 1, text: 'x'.repeat(DOCUMENT_LIMITS.unitChars + 1) }] },
    {
      units: Array.from({ length: 201 }, (_, index) => ({ number: index + 1, text: '' })),
      totalUnits: 201,
    },
    {
      units: Array.from({ length: 20 }, (_, index) => ({
        number: index + 1,
        text: 'x'.repeat(10_001),
      })),
      totalUnits: 20,
    },
    { warnings: ['x'.repeat(241)] },
    { unexpected: 'payload' },
  ])('rejects invalid provenance, limits and undisclosed partial results: %j', (override) => {
    expect(parsedDocumentSchema.safeParse({ ...document(), ...override }).success).toBe(false);
  });

  it('allows disclosed partial indexing', () => {
    expect(
      parsedDocumentSchema.safeParse({ ...document(), totalUnits: 300, truncated: true }).success,
    ).toBe(true);
  });

  it('rejects empty and oversized bytes before workers start', () => {
    expect(() => validateDocumentBytes(new Uint8Array())).toThrow('empty');
    expect(() => validateDocumentBytes(new Uint8Array(DOCUMENT_LIMITS.bytes + 1))).toThrow('20 MB');
    expect(() => validateDocumentBytes(new Uint8Array(DOCUMENT_LIMITS.bytes))).not.toThrow();
  });

  it('states the limits of image-only, mixed and partial documents honestly', () => {
    expect(documentWarnings({ units: [{ number: 1, text: '' }], truncated: false }).join()).toMatch(
      /No selectable text.*OCR/,
    );
    expect(
      documentWarnings({
        units: [
          { number: 1, text: '' },
          { number: 2, text: 'Synthetic' },
        ],
        truncated: false,
      }).join(),
    ).toContain('Some pages');
    expect(documentWarnings({ ...document(), truncated: true }).join()).toContain('Only part');
  });
});
