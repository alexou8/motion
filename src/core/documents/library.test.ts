import { describe, expect, it } from 'vitest';
import { authorizeMessage } from '../messaging/authorize';
import { indexedDocumentSchema, summarizeDocument } from './library';

// The course and document examples in this suite are synthetic.
const parsed = { format: 'pdf' as const, units: [{ number: 1, text: 'Synthetic lecture text.' }],
  totalUnits: 1, truncated: false, warnings: [] };
const token = '00000000-0000-4000-8000-000000000001';
const extension = 'synthetic-motion';
const policy = { extensionOrigin: `chrome-extension://${extension}`, isSupportedHost: () => true };

describe('document context boundaries', () => {
  it.each([
    { type: 'begin-document-import' },
    { type: 'get-document-sources', tabId: 1 },
    { type: 'fetch-document', tabId: 1, handle: token },
    { type: 'store-document', token, parsed },
    { type: 'store-document-local', token, parsed, title: 'Synthetic lecture' },
    { type: 'get-documents', query: 'Synthetic' },
    { type: 'get-document', id: 'synthetic-document' },
    { type: 'delete-document', id: 'synthetic-document' },
  ])('accepts $type only from browser-asserted extension UI', (message) => {
    expect(authorizeMessage(message, { runtimeId: extension, extensionId: extension,
      senderUrl: `chrome-extension://${extension}/sidepanel.html` }, policy).ok).toBe(true);
    const page = authorizeMessage(message, { runtimeId: extension, extensionId: extension, tabId: 1,
      senderUrl: 'https://school.brightspace.com/d2l/le/content/123/home', frameId: 0 }, policy);
    expect(page.ok).toBe(false);
    if (!page.ok) expect(page.reason).toContain('may not send');
  });

  it('rejects a fake local import provenance URL at the message boundary', () => {
    expect(authorizeMessage({ type: 'store-document-local', token, parsed, title: 'Synthetic lecture',
      sourceUrl: 'https://school.brightspace.com/content/enforced/123-SYNTHETIC/lecture.pdf' },
    { runtimeId: extension, extensionId: extension, senderUrl: `chrome-extension://${extension}/sidepanel.html` }, policy).ok).toBe(false);
  });

  it('preserves sorted unit and total-text validation after adding stored metadata', () => {
    const document = { ...parsed, id: 'synthetic-document', courseId: null, title: 'Synthetic lecture',
      sourceUrl: null, sourcePageUrl: null, capturedAt: '2026-10-03T12:00:00.000Z' };
    expect(indexedDocumentSchema.safeParse(document).success).toBe(true);
    expect(indexedDocumentSchema.safeParse({ ...document, totalUnits: 2,
      units: [{ number: 2, text: 'Synthetic page 2' }, { number: 1, text: 'Synthetic page 1' }] }).success).toBe(false);
    expect(indexedDocumentSchema.safeParse({ ...document, totalUnits: 20,
      units: Array.from({ length: 20 }, (_, index) => ({ number: index + 1, text: 'x'.repeat(12_000) })) }).success).toBe(false);
  });

  it('provides short text matches with page numbers, title-only results and honest no-text metadata', () => {
    const document = indexedDocumentSchema.parse({ ...parsed, id: 'synthetic-document', courseId: null,
      title: 'Synthetic biology lecture', sourceUrl: null, sourcePageUrl: null, capturedAt: '2026-10-03T12:00:00.000Z',
      units: [{ number: 1, text: `Synthetic ${'introduction '.repeat(200)} photosynthesis ${'conclusion '.repeat(200)}` }] });
    const textMatch = summarizeDocument(document, 'photosynthesis');
    expect(textMatch?.matches[0]?.number).toBe(1);
    expect(textMatch?.matches[0]?.text).toContain('photosynthesis');
    expect(textMatch?.matches[0]?.text.length).toBeLessThanOrEqual(350);
    expect(summarizeDocument(document, 'biology')).toMatchObject({ id: document.id, matches: [] });
    expect(summarizeDocument(document, 'absent')).toBeNull();
    expect(summarizeDocument({ ...document, units: [{ number: 1, text: ' ' }] })).toMatchObject({ hasText: false, indexedUnitCount: 1, matches: [] });
  });
});
