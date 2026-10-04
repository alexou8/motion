import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { courseSchema, pageContentSchema, type PageContent } from '@/core/domain';
import { DOCUMENT_LIMITS } from '@/core/documents/contracts';
import { documentSourcesResponseSchema, fetchDocumentResponseSchema, indexedDocumentSchema } from '@/core/documents/library';
import { deleteDatabase, openDatabase, putRecord } from '@/core/storage/db';
import { STORE } from '@/core/storage/schema';
import { handleDocumentMessage, fetchDocumentBytes, forgetDocumentTab } from './documents';
import { handleAiMessage } from './aiHandlers';
import { SessionSecretStore, type StorageArea } from '@/platform/ai/secrets';
import { askContentScript } from './contentBridge';

vi.mock('./contentBridge', () => ({ askContentScript: vi.fn() }));

// All course names, identifiers and lecture text in this suite are synthetic.
const ORIGIN = 'https://mylearningspace.wlu.ca';
const PAGE = `${ORIGIN}/d2l/le/content/123/viewContent/456/View`;
const FILE = `${ORIGIN}/content/enforced/123-SYNTHETIC/Lecture%201.pdf?ou=123`;
const NOW = '2026-10-03T12:00:00.000Z';
const parsed = { format: 'pdf' as const, units: [{ number: 1, text: 'Synthetic photosynthesis lecture text.' }],
  totalUnits: 1, truncated: false, warnings: [] };
let session: Record<string, unknown>;
let content: PageContent;
let url: string;
let tabTitle: string;
let activeId: number;

function response(bytes = new TextEncoder().encode('%PDF-1.7\nSynthetic document'), overrides: { mime?: string; status?: number; url?: string; redirected?: boolean; length?: string } = {}) {
  const headers = new Headers({ 'Content-Type': overrides.mime ?? 'application/pdf' });
  if (overrides.length) headers.set('Content-Length', overrides.length);
  const result = new Response(bytes.buffer as ArrayBuffer, { headers, status: overrides.status ?? 200 });
  Object.defineProperty(result, 'url', { value: overrides.url ?? FILE });
  Object.defineProperty(result, 'redirected', { value: overrides.redirected ?? false });
  return result;
}

async function sources() {
  return documentSourcesResponseSchema.parse(await handleDocumentMessage({ type: 'get-document-sources', tabId: 1 }));
}
async function fetched() {
  const source = (await sources()).sources[0]!;
  return fetchDocumentResponseSchema.parse(await handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: source.handle }));
}
async function storeLocal(title = 'Synthetic lecture', courseId: string | null = null) {
  const { token } = await handleDocumentMessage({ type: 'begin-document-import' }) as { token: string };
  return handleDocumentMessage({ type: 'store-document-local', token, title, courseId, parsed }) as Promise<{ document: ReturnType<typeof indexedDocumentSchema.parse> }>;
}

beforeEach(async () => {
  await deleteDatabase();
  session = {};
  url = PAGE;
  tabTitle = 'Synthetic lecture';
  activeId = 1;
  content = pageContentSchema.parse({ pageType: 'content-topic', url: PAGE, title: tabTitle,
    text: 'Synthetic lecture topic', capturedAt: NOW, resources: [{ sourceUrl: FILE, title: 'Synthetic lecture PDF', format: 'pdf' }] });
  vi.mocked(askContentScript).mockImplementation(async () => content);
  vi.stubGlobal('chrome', {
    storage: { session: {
      get: vi.fn(async (key: string | null) => key === null ? { ...session } : { [key]: session[key] }),
      set: vi.fn(async (values: Record<string, unknown>) => Object.assign(session, structuredClone(values))),
      remove: vi.fn(async (key: string | string[]) => { for (const entry of Array.isArray(key) ? key : [key]) delete session[entry]; }),
    } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: id === 1 ? url : 'https://example.org', title: tabTitle })),
      query: vi.fn(async () => [{ id: activeId }]),
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  const db = await openDatabase();
  await putRecord(db, STORE.courses, courseSchema.parse({ id: 'd2l:123', externalId: '123', name: 'Synthetic course',
    platformId: 'd2l', lastVerifiedAt: NOW }));
  db.close();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('observed lecture document imports', () => {
  it('issues page-bound choices, downloads only that choice, and stores worker-owned provenance', async () => {
    const downloaded = await fetched();
    expect(atob(downloaded.base64)).toContain('%PDF-');
    expect(fetch).toHaveBeenCalledWith(FILE, expect.objectContaining({ credentials: 'include', redirect: 'error', method: 'GET' }));
    const result = await handleDocumentMessage({ type: 'store-document', token: downloaded.token, parsed }) as { document: unknown };
    const document = indexedDocumentSchema.parse(result.document);
    expect(document).toMatchObject({ title: 'Synthetic lecture PDF', courseId: 'd2l:123', sourceUrl: FILE, sourcePageUrl: PAGE,
      units: [{ number: 1, text: 'Synthetic photosynthesis lecture text.' }] });
    expect(session['motion.documentRevision']).toEqual(expect.any(String));
    expect(await handleDocumentMessage({ type: 'get-document', id: document.id })).toEqual({ document });
    await expect(handleDocumentMessage({ type: 'store-document', token: downloaded.token, parsed })).rejects.toThrow(/expired/);
  });

  it('re-indexes the same source without duplicating it', async () => {
    const first = await fetched();
    const saved = await handleDocumentMessage({ type: 'store-document', token: first.token, parsed }) as { document: { id: string } };
    const second = await fetched();
    const again = await handleDocumentMessage({ type: 'store-document', token: second.token,
      parsed: { ...parsed, units: [{ number: 1, text: 'Synthetic updated lecture text.' }] } }) as { document: { id: string } };
    expect(again.document.id).toBe(saved.document.id);
    const list = await handleDocumentMessage({ type: 'get-documents' }) as { total: number; documents: { matches: { text: string }[] }[] };
    expect(list.total).toBe(1);
    expect(list.documents[0]?.matches[0]?.text).toBe('Synthetic updated lecture text.');
  });

  it('ignores forged external, wrong-course, login and arbitrary endpoints in a content response', async () => {
    content.resources = [
      { sourceUrl: 'https://evil.example/lecture.pdf', title: 'Synthetic external', format: 'pdf' },
      { sourceUrl: `${ORIGIN}/content/enforced/999-SYNTHETIC/lecture.pdf`, title: 'Synthetic wrong course', format: 'pdf' },
      { sourceUrl: `${ORIGIN}/d2l/login?file=lecture.pdf`, title: 'Synthetic login', format: 'pdf' },
      { sourceUrl: `${ORIGIN}/d2l/lms/quizzing/user/attempt/1?file=lecture.pdf`, title: 'Synthetic attempt', format: 'pdf' },
    ];
    expect((await sources()).sources).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects forged handles and arbitrary caller URLs', async () => {
    await sources();
    await expect(handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: crypto.randomUUID() })).rejects.toThrow(/confirm/);
    await expect(handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: crypto.randomUUID(), sourceUrl: FILE })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects expired choices, stale navigation, removed resources and changed pages during a download', async () => {
    let source = (await sources()).sources[0]!;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    await expect(handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: source.handle })).rejects.toThrow(/expired/);
    vi.restoreAllMocks();
    source = (await sources()).sources[0]!;
    url = `${ORIGIN}/d2l/le/content/123/viewContent/999/View`;
    await expect(handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: source.handle })).rejects.toThrow(/confirm/);
    url = PAGE;
    content.resources = [];
    await expect(handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: source.handle })).rejects.toThrow(/changed/);
    content.resources = [{ sourceUrl: FILE, title: 'Synthetic lecture', format: 'pdf' }];
    source = (await sources()).sources[0]!;
    vi.mocked(fetch).mockImplementation(async () => { url = `${ORIGIN}/d2l/home`; return response(); });
    await expect(handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: source.handle })).rejects.toThrow(/confirm/);
  });

  it('rejects route, stored observation and embedded assessment restrictions before any fetch or storage', async () => {
    const downloaded = await fetched();
    url = `${ORIGIN}/d2l/lms/quizzing/user/attempt/1`;
    await expect(sources()).rejects.toThrow(/assessment/);
    await expect(storeLocal()).rejects.toThrow(/assessment/);
    await expect(handleDocumentMessage({ type: 'store-document', token: downloaded.token, parsed })).rejects.toThrow(/assessment/);
    url = PAGE;
    session['observation:1'] = { restricted: true };
    await expect(sources()).rejects.toThrow(/assessment/);
    delete session['observation:1'];
    content.text = 'Synthetic embedded assessment: Time remaining 20 minutes';
    await expect(sources()).rejects.toThrow(/assessment/);
    await expect(storeLocal()).rejects.toThrow(/assessment/);
    expect(await handleDocumentMessage({ type: 'get-documents' })).toMatchObject({ total: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects expired or forged receipts, mismatched formats and invalid aggregate parser output', async () => {
    await expect(handleDocumentMessage({ type: 'store-document', token: crypto.randomUUID(), parsed })).rejects.toThrow(/expired/);
    const downloaded = await fetched();
    await expect(handleDocumentMessage({ type: 'store-document', token: downloaded.token, parsed: { ...parsed, format: 'pptx' } })).rejects.toThrow(/changed/);
    await expect(handleDocumentMessage({ type: 'store-document', token: downloaded.token, parsed: { ...parsed, units: [{ number: 2, text: 'Synthetic invalid numbering' }] } })).rejects.toThrow();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    await expect(handleDocumentMessage({ type: 'store-document', token: downloaded.token, parsed })).rejects.toThrow(/expired/);
  });
  it('rejects mismatched page-type reports and an assessment appearing during the final browser check', async () => {
    content.pageType = 'quiz-list';
    await expect(sources()).rejects.toThrow(/confirm/);
    content.pageType = 'content-topic';
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({ id: 1, url: PAGE, title: 'Synthetic lecture' } as chrome.tabs.Tab)
      .mockResolvedValueOnce({ id: 1, url: PAGE, title: 'Synthetic proctor attempt' } as chrome.tabs.Tab);
    await expect(sources()).rejects.toThrow(/assessment/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('forgets source choices and both kinds of pending receipts when their tab closes or navigates', async () => {
    const remote = await fetched();
    const local = await handleDocumentMessage({ type: 'begin-document-import', tabId: 1 }) as { token: string };
    await forgetDocumentTab(1);
    expect(session['motion.documentSources:1']).toBeUndefined();
    expect(session[`motion.documentFetch:${remote.token}`]).toBeUndefined();
    expect(session[`motion.documentLocal:${local.token}`]).toBeUndefined();
    await expect(handleDocumentMessage({ type: 'store-document-local', token: local.token, title: 'Synthetic stale import', parsed })).rejects.toThrow(/expired/);
  });
  it('prunes expired choices and orphan receipts and caps source contexts across many tabs', async () => {
    await sources();
    const context = session['motion.documentSources:1'] as { expiresAt: number };
    for (let index = 100; index < 125; index++) session[`motion.documentSources:${index}`] = { ...context, tabId: index };
    session['motion.documentSources:999'] = { ...context, tabId: 999, expiresAt: Date.now() - 1 };
    session['motion.documentFetch:synthetic-malformed'] = { malformed: true };
    await sources();
    expect(Object.keys(session).filter((key) => key.startsWith('motion.documentSources:'))).toHaveLength(20);
    expect(session['motion.documentSources:999']).toBeUndefined();
    expect(session['motion.documentFetch:synthetic-malformed']).toBeUndefined();
  });
  it('keeps only the newest receipt when two downloads race for the same source', async () => {
    const source = (await sources()).sources[0]!;
    const results = await Promise.all([handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: source.handle }),
      handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: source.handle })]);
    expect(results).toHaveLength(2);
    expect(Object.keys(session).filter((key) => key.startsWith('motion.documentFetch:'))).toHaveLength(1);
  });
});

describe('bounded authenticated document downloads', () => {
  it.each([
    ['login HTML', { mime: 'text/html' }, '%PDF-1.7'],
    ['wrong MIME', { mime: 'image/png' }, '%PDF-1.7'],
    ['redirect', { redirected: true }, '%PDF-1.7'],
    ['changed target', { url: `${ORIGIN}/d2l/login` }, '%PDF-1.7'],
    ['unauthorized', { status: 401 }, '%PDF-1.7'],
    ['invalid signature', {}, '<html>Login</html>'],
    ['declared excess size', { length: String(DOCUMENT_LIMITS.bytes + 1) }, '%PDF-1.7'],
  ])('rejects %s', async (_name, metadata, body) => {
    vi.mocked(fetch).mockResolvedValue(response(new TextEncoder().encode(body), metadata));
    await expect(fetchDocumentBytes(FILE, 'pdf')).rejects.toThrow();
  });
  it('rejects an oversized streaming body without trusting content-length', async () => {
    const result = response(new Uint8Array(DOCUMENT_LIMITS.bytes + 1));
    vi.mocked(fetch).mockResolvedValue(result);
    await expect(fetchDocumentBytes(FILE, 'pdf')).rejects.toThrow(/20 MB/);
  });
  it('accepts PPTX ZIP signature and generic binary MIME while rejecting PDF masquerading as PPTX', async () => {
    const target = `${ORIGIN}/content/enforced/123-SYNTHETIC/slides.pptx`;
    vi.mocked(fetch).mockResolvedValue(response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), { mime: 'application/octet-stream', url: target }));
    expect((await fetchDocumentBytes(target, 'pptx')).byteLength).toBe(5);
    vi.mocked(fetch).mockResolvedValue(response(new TextEncoder().encode('%PDF-1.7'), { mime: 'application/octet-stream', url: target }));
    await expect(fetchDocumentBytes(target, 'pptx')).rejects.toThrow(/not a readable/);
  });
  it('aborts a stalled request and gives a bounded safe timeout message', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('Synthetic request aborted')));
    }));
    const request = expect(fetchDocumentBytes(FILE, 'pdf')).rejects.toThrow('Document download timed out. Try again.');
    await vi.advanceTimersByTimeAsync(DOCUMENT_LIMITS.timeoutMs);
    await request;
  });
  it('does not echo network errors that could include private paths', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('This synthetic private network path must not reach the panel'));
    await expect(fetchDocumentBytes(FILE, 'pdf')).rejects.toThrow('Motion could not download the document. Sign in to your LMS and try again.');
  });
});

describe('local indexed library', () => {
  it('imports local files off-LMS, searches lecture text with page numbers, filters courses and deletes records', async () => {
    activeId = 2;
    const local = (await storeLocal('Synthetic biology.pdf', 'd2l:123')).document;
    const standalone = (await storeLocal('Synthetic unrelated')).document;
    expect(local).toMatchObject({ sourceUrl: null, sourcePageUrl: null, courseId: 'd2l:123' });
    const result = await handleDocumentMessage({ type: 'get-documents', query: 'photosynthesis', courseId: 'd2l:123' });
    expect(result).toMatchObject({ total: 1, documents: [{ id: local.id, hasText: true, indexedUnitCount: 1,
      matches: [{ number: 1, text: 'Synthetic photosynthesis lecture text.' }] }] });
    expect(await handleDocumentMessage({ type: 'get-documents', query: 'absent synthetic term' })).toMatchObject({ total: 0 });
    expect(await handleDocumentMessage({ type: 'get-documents', courseId: null })).toMatchObject({ documents: [{ id: standalone.id }], total: 1 });
    await handleDocumentMessage({ type: 'delete-document', id: local.id });
    expect(await handleDocumentMessage({ type: 'get-document', id: local.id })).toEqual({ document: null });
    expect(await handleDocumentMessage({ type: 'get-documents' })).toMatchObject({ total: 1 });
  });
  it('refuses invented course associations and ignores invalid stored rows', async () => {
    await expect(storeLocal('Synthetic lecture', 'd2l:unknown')).rejects.toThrow(/course/);
    const db = await openDatabase();
    await putRecord(db, STORE.documents, { id: 'synthetic-corrupt', units: 'bad' });
    db.close();
    expect(await handleDocumentMessage({ type: 'get-documents' })).toMatchObject({ total: 0 });
    expect(await handleDocumentMessage({ type: 'get-document', id: 'synthetic-corrupt' })).toEqual({ document: null });
  });
  it('bounds summary responses and snippets while reporting undisplayed matching documents', async () => {
    activeId = 2;
    for (let index = 0; index < 42; index++) await storeLocal(`Synthetic lecture ${index}`);
    const result = await handleDocumentMessage({ type: 'get-documents' }) as { documents: unknown[]; total: number; truncated: boolean };
    expect(result.documents).toHaveLength(40);
    expect(result.total).toBe(42);
    expect(result.truncated).toBe(true);
  });
  it('revokes local parsing tickets and remote choices when all local data is deleted', async () => {
    const { token } = await handleDocumentMessage({ type: 'begin-document-import' }) as { token: string };
    const remote = await fetched();
    await storeLocal();
    const storage = chrome.storage.session as unknown as StorageArea;
    const local: StorageArea = { get: async () => ({}), set: async () => undefined, remove: async () => undefined };
    expect(await handleAiMessage({ type: 'delete-local-data', confirm: 'DELETE' }, {
      secrets: new SessionSecretStore(storage), sessionStorage: storage, localStorage: local,
      deleteDatabase: () => deleteDatabase(),
    })).toEqual({ deleted: true });
    await expect(handleDocumentMessage({ type: 'store-document-local', token, title: 'Synthetic delayed parse', parsed })).rejects.toThrow(/cleared/);
    await expect(handleDocumentMessage({ type: 'store-document', token: remote.token, parsed })).rejects.toThrow(/expired/);
    expect(await handleDocumentMessage({ type: 'get-documents' })).toMatchObject({ total: 0 });
    const restarted = (await storeLocal('Synthetic new import after deletion')).document;
    expect(restarted.title).toBe('Synthetic new import after deletion');
  });
  it('rejects an old epoch if deletion happens during an in-flight fetch and creates no new receipt', async () => {
    const source = (await sources()).sources[0]!;
    vi.mocked(fetch).mockImplementation(async () => {
      session['motion.documentLifecycle'] = { epoch: crypto.randomUUID(), deleting: false };
      return response();
    });
    await expect(handleDocumentMessage({ type: 'fetch-document', tabId: 1, handle: source.handle })).rejects.toThrow(/cleared/);
    expect(Object.keys(session).some((key) => key.startsWith('motion.documentFetch:'))).toBe(false);
  });
});
