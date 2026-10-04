import { z } from 'zod';
import { d2lDocumentResourceForUrl, resolveAdapter } from '@/core/adapters';
import { courseSchema, type PageContent } from '@/core/domain';
import { evaluateAssessmentContext } from '@/core/policy/assessment';
import { DOCUMENT_LIMITS } from '@/core/documents/contracts';
import {
  documentMessageSchema, documentResponseSchema, documentSourcesResponseSchema, documentsResponseSchema,
  fetchDocumentResponseSchema, indexedDocumentSchema, summarizeDocument,
  DOCUMENT_RESULT_LIMIT, type DocumentMessage, type IndexedDocument,
} from '@/core/documents/library';
import { openDatabase, getRecord, deleteRecord } from '@/core/storage/db';
import { readIndexedDocuments, saveIndexedDocument } from '@/core/storage/documents';
import { Repository } from '@/core/storage/repository';
import { STORE } from '@/core/storage/schema';
import { askContentScript } from './contentBridge';
import { withLock } from '@/platform/locks';

const HANDLE_TTL_MS = 5 * 60_000;
export const DOCUMENT_LIFECYCLE_KEY = 'motion.documentLifecycle';
export const DOCUMENT_LIFECYCLE_LOCK = 'motion.localDataLifecycle';
const lifecycleSchema = z.object({ epoch: z.string().uuid(), deleting: z.boolean() }).strict();
const sourcesKey = (tabId: number) => `motion.documentSources:${tabId}`;
const tokenKey = (token: string) => `motion.documentFetch:${token}`;
const localTokenKey = (token: string) => `motion.documentLocal:${token}`;
const localTokenSchema = z.object({ token: z.string().uuid(), epoch: z.string().uuid().nullable(),
  tabId: z.number().int().nonnegative().nullable(), expiresAt: z.number() }).strict();
const contextSchema = documentSourcesResponseSchema.extend({
  pageUrl: z.string().url().max(2_000), tabId: z.number().int().nonnegative(), expiresAt: z.number(),
  pendingToken: z.string().uuid().nullable(),
  epoch: z.string().uuid().nullable(),
});
const fetchTokenSchema = z.object({
  token: z.string().uuid(), handle: z.string().uuid(), tabId: z.number().int().nonnegative(),
  pageUrl: z.string().url().max(2_000), sourceUrl: z.string().url().max(2_000), title: z.string().min(1).max(500),
  format: z.enum(['pdf', 'pptx']), courseId: z.string().min(1).max(200).nullable(), expiresAt: z.number(),
}).strict();

function pageIdentity(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  return url.href;
}

class DocumentLibraryError extends Error {}
function refusal(message: string): never { throw new DocumentLibraryError(message); }

async function readDocumentEpoch(): Promise<string | null> {
  const raw = (await chrome.storage.session.get(DOCUMENT_LIFECYCLE_KEY))[DOCUMENT_LIFECYCLE_KEY];
  if (raw === undefined) return null;
  const lifecycle = lifecycleSchema.safeParse(raw);
  if (!lifecycle.success || lifecycle.data.deleting)
    return refusal('Your local library is being cleared. Finish clearing it before importing a document.');
  return lifecycle.data.epoch;
}
async function assertDocumentEpoch(expected: string | null): Promise<void> {
  if (await readDocumentEpoch() !== expected)
    refusal('Your local library was cleared during this import. Choose the document again.');
}

async function readSafePage(tabId: number): Promise<PageContent> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url) return refusal('This page is no longer available. Open the lecture page and try again.');
  const adapter = resolveAdapter(tab.url);
  if (!adapter || new URL(tab.url).protocol !== 'https:') return refusal('Open a supported LMS lecture page before importing a document.');
  const pageType = adapter.classifyUrl(tab.url);
  if (!pageType || pageType === 'unsupported') return refusal('Open a supported LMS lecture page before importing a document.');
  const observation = (await chrome.storage.session.get(`observation:${tabId}`))[`observation:${tabId}`];
  const observedRestriction = z.object({ restricted: z.boolean().optional() }).safeParse(observation);
  if ((observedRestriction.success && observedRestriction.data.restricted)
    || evaluateAssessmentContext({ pageType, url: tab.url, pageTitle: tab.title }).restricted)
    return refusal('Motion cannot index documents inside an active assessment. Return to the lecture page first.');
  const content = await askContentScript(tabId);
  if (!content || pageIdentity(content.url) !== pageIdentity(tab.url))
    return refusal('Motion could not confirm this page. Wait for it to load and try again.');
  if (evaluateAssessmentContext({ pageType: content.pageType, url: content.url, pageTitle: content.title, visibleText: content.text }).restricted)
    return refusal('Motion cannot index documents inside an active assessment. Return to the lecture page first.');
  if (content.pageType === 'signed-out' || content.pageType === 'unsupported')
    return refusal('Sign in to your LMS and open the lecture page before importing a document.');
  if (content.pageType !== pageType) return refusal('Motion could not confirm this page. Wait for it to load and try again.');
  const latest = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!latest?.url || pageIdentity(latest.url) !== pageIdentity(content.url))
    return refusal('The page changed while Motion was reading it. Choose the document again.');
  if (evaluateAssessmentContext({ pageType, url: latest.url, pageTitle: latest.title, visibleText: content.text }).restricted)
    return refusal('Motion cannot index documents inside an active assessment. Return to the lecture page first.');
  return content;
}

async function assertLocalContext(tabId?: number): Promise<void> {
  const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const ids = new Set([active?.id, tabId].filter((value): value is number => value !== undefined));
  for (const id of ids) {
    const tab = await chrome.tabs.get(id).catch(() => undefined);
    if (tab?.url && evaluateAssessmentContext({ pageType: resolveAdapter(tab.url)?.classifyUrl(tab.url) ?? 'unsupported',
      url: tab.url, pageTitle: tab.title }).restricted)
      refusal('Motion cannot index documents inside an active assessment. Return to the lecture page first.');
    if (tab?.url && resolveAdapter(tab.url)) await readSafePage(id);
  }
}

async function courseForPage(content: PageContent): Promise<string | null> {
  const adapter = resolveAdapter(content.url);
  const externalId = adapter?.courseIdForUrl(content.url);
  if (!externalId) return null;
  const db = await openDatabase();
  try {
    const courses = await new Repository(db, STORE.courses, courseSchema).all();
    return courses.records.find((course) => course.platformId === adapter?.id && course.externalId === externalId)?.id ?? null;
  } finally { db.close(); }
}

/** Called under the lifecycle lock: choices are bounded even across many tabs. */
async function pruneDocumentContexts(currentTab?: number): Promise<void> {
  const values = await chrome.storage.session.get(null);
  const remove = new Set<string>();
  const retained: { key: string; context: z.infer<typeof contextSchema> }[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith('motion.documentSources:')) continue;
    const parsed = contextSchema.safeParse(raw);
    if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
      remove.add(key);
      if (parsed.success && parsed.data.pendingToken) remove.add(tokenKey(parsed.data.pendingToken));
    } else retained.push({ key, context: parsed.data });
  }
  const others = retained.filter(({ context }) => context.tabId !== currentTab).sort((a, b) => a.context.expiresAt - b.context.expiresAt);
  const cap = currentTab === undefined ? 20 : 19;
  for (const entry of others.slice(0, Math.max(0, others.length - cap))) {
    remove.add(entry.key);
    if (entry.context.pendingToken) remove.add(tokenKey(entry.context.pendingToken));
  }
  const pending = new Set(retained.filter(({ key }) => !remove.has(key)).map(({ context }) => context.pendingToken).filter(Boolean));
  for (const [key, raw] of Object.entries(values)) {
    if (key.startsWith('motion.documentFetch:')) {
      const parsed = fetchTokenSchema.safeParse(raw);
      if (!parsed.success || parsed.data.expiresAt <= Date.now() || !pending.has(parsed.data.token)) remove.add(key);
    }
  }
  if (remove.size) await chrome.storage.session.remove([...remove]);
}

export async function forgetDocumentTab(tabId: number): Promise<void> {
  await withLock(DOCUMENT_LIFECYCLE_LOCK, async () => {
    const values = await chrome.storage.session.get(null);
    const remove = [sourcesKey(tabId)];
    for (const [key, raw] of Object.entries(values)) {
      if (key.startsWith('motion.documentFetch:')) {
        const parsed = fetchTokenSchema.safeParse(raw);
        if (!parsed.success || parsed.data.tabId === tabId) remove.push(key);
      } else if (key.startsWith('motion.documentLocal:')) {
        const parsed = localTokenSchema.safeParse(raw);
        if (!parsed.success || parsed.data.tabId === tabId) remove.push(key);
      }
    }
    await chrome.storage.session.remove(remove);
  });
}

async function getSources(tabId: number, epoch: string | null) {
  const content = await readSafePage(tabId);
  const adapter = resolveAdapter(content.url);
  if (adapter?.id !== 'd2l' || !['content-module', 'content-topic', 'assignment'].includes(content.pageType))
    return refusal('Open a lecture topic, content module, or assignment with a PDF or PowerPoint file.');
  const sources = content.resources.flatMap((resource) => {
    const safe = d2lDocumentResourceForUrl(resource.sourceUrl, content.url, resource.format);
    return safe ? [{ ...safe, title: resource.title, handle: crypto.randomUUID() }] : [];
  }).filter((resource, index, all) => all.findIndex((other) => other.sourceUrl === resource.sourceUrl) === index).slice(0, 50);
  const context = contextSchema.parse({ sources, courseId: await courseForPage(content),
    pageUrl: pageIdentity(content.url), tabId, expiresAt: Date.now() + HANDLE_TTL_MS, pendingToken: null, epoch });
  await withLock(DOCUMENT_LIFECYCLE_LOCK, async () => {
    await assertDocumentEpoch(epoch);
    await pruneDocumentContexts(tabId);
    const old = contextSchema.safeParse((await chrome.storage.session.get(sourcesKey(tabId)))[sourcesKey(tabId)]);
    if (old.success && old.data.pendingToken) await chrome.storage.session.remove(tokenKey(old.data.pendingToken));
    await chrome.storage.session.set({ [sourcesKey(tabId)]: context });
  });
  return documentSourcesResponseSchema.parse({ sources: context.sources, courseId: context.courseId });
}

async function currentSource(tabId: number, handle: string) {
  const stored = contextSchema.safeParse((await chrome.storage.session.get(sourcesKey(tabId)))[sourcesKey(tabId)]);
  if (!stored.success || stored.data.tabId !== tabId || stored.data.expiresAt <= Date.now())
    return refusal('This document choice expired. Refresh the document list and choose it again.');
  const context = stored.data;
  await assertDocumentEpoch(context.epoch);
  const source = context.sources.find((entry) => entry.handle === handle);
  if (!source) return refusal('Motion could not confirm this document. Refresh the document list and choose it again.');
  const content = await readSafePage(tabId);
  if (pageIdentity(content.url) !== context.pageUrl || !content.resources.some((resource) =>
    resource.sourceUrl === source.sourceUrl && resource.format === source.format
    && d2lDocumentResourceForUrl(resource.sourceUrl, content.url, resource.format)))
    return refusal('The lecture page or document changed. Refresh the document list and choose it again.');
  return { source, context };
}

export async function fetchDocumentBytes(sourceUrl: string, format: 'pdf' | 'pptx'): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOCUMENT_LIMITS.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(sourceUrl, { method: 'GET', credentials: 'include', redirect: 'error',
      cache: 'no-store', signal: controller.signal, headers: { Accept: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } });
    if (!response.ok || response.redirected || (response.url && response.url !== sourceUrl))
      return refusal('The document is unavailable or your LMS session expired. Sign in and try again.');
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const allowed = format === 'pdf' ? ['application/pdf', 'application/octet-stream']
      : ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/octet-stream'];
    if (!allowed.includes(mime)) return refusal('The LMS returned a page instead of the selected document. Sign in and try again.');
    if (Number(response.headers.get('content-length')) > DOCUMENT_LIMITS.bytes)
      return refusal('This document exceeds the 20 MB indexing limit.');
    if (!response.body) return refusal('The document is empty or unavailable.');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (done) break;
      if (!result.value) continue;
      length += result.value.byteLength;
      if (length > DOCUMENT_LIMITS.bytes) return refusal('This document exceeds the 20 MB indexing limit.');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const signature = format === 'pdf' ? [0x25, 0x50, 0x44, 0x46, 0x2d] : [0x50, 0x4b, 0x03, 0x04];
    if (!signature.every((byte, index) => bytes[index] === byte))
      return refusal('This file is not a readable PDF or PowerPoint document.');
    return bytes;
  } catch (error) {
    if (error instanceof DocumentLibraryError) throw error;
    return refusal(controller.signal.aborted ? 'Document download timed out. Try again.'
      : 'Motion could not download the document. Sign in to your LMS and try again.');
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 16_384)
    binary += String.fromCharCode(...bytes.subarray(index, index + 16_384));
  return btoa(binary);
}

async function fetchSource(tabId: number, handle: string, epoch: string | null) {
  const { source, context } = await currentSource(tabId, handle);
  const bytes = await fetchDocumentBytes(source.sourceUrl, source.format);
  await currentSource(tabId, handle);
  const token = crypto.randomUUID();
  const receipt = fetchTokenSchema.parse({ ...source, token, tabId, pageUrl: context.pageUrl,
    courseId: context.courseId, expiresAt: Date.now() + HANDLE_TTL_MS });
  await withLock(DOCUMENT_LIFECYCLE_LOCK, async () => {
    await assertDocumentEpoch(epoch);
    const latest = contextSchema.safeParse((await chrome.storage.session.get(sourcesKey(tabId)))[sourcesKey(tabId)]);
    if (!latest.success || !latest.data.sources.some((entry) => entry.handle === handle))
      return refusal('This document choice expired. Refresh the document list and choose it again.');
    if (latest.data.pendingToken) await chrome.storage.session.remove(tokenKey(latest.data.pendingToken));
    await chrome.storage.session.set({ [tokenKey(token)]: receipt,
      [sourcesKey(tabId)]: { ...latest.data, pendingToken: token } });
  });
  return fetchDocumentResponseSchema.parse({ token, title: source.title, format: source.format, base64: base64(bytes) });
}

async function save(document: IndexedDocument, epoch: string | null) {
  await withLock(DOCUMENT_LIFECYCLE_LOCK, async () => {
    await assertDocumentEpoch(epoch);
    const db = await openDatabase();
    try { await saveIndexedDocument(db, document); } finally { db.close(); }
    await chrome.storage.session.set({ 'motion.documentRevision': crypto.randomUUID() });
  });
  return documentResponseSchema.parse({ document });
}

async function storeRemote(message: Extract<DocumentMessage, { type: 'store-document' }>, epoch: string | null) {
  const stored = fetchTokenSchema.safeParse((await chrome.storage.session.get(tokenKey(message.token)))[tokenKey(message.token)]);
  if (!stored.success || stored.data.token !== message.token || stored.data.expiresAt <= Date.now())
    return refusal('This document import expired. Choose the document again.');
  const receipt = stored.data;
  await assertLocalContext(receipt.tabId);
  const { source } = await currentSource(receipt.tabId, receipt.handle);
  if (source.sourceUrl !== receipt.sourceUrl || source.format !== message.parsed.format)
    return refusal('This document changed while it was being imported. Choose it again.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receipt.sourceUrl));
  const id = `document:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const document = indexedDocumentSchema.parse({ ...message.parsed, id, title: receipt.title,
    courseId: receipt.courseId, sourceUrl: receipt.sourceUrl, sourcePageUrl: receipt.pageUrl, capturedAt: new Date().toISOString() });
  const result = await save(document, epoch);
  await chrome.storage.session.remove(tokenKey(message.token));
  return result;
}

async function storeLocal(message: Extract<DocumentMessage, { type: 'store-document-local' }>, epoch: string | null) {
  const receipt = localTokenSchema.safeParse((await chrome.storage.session.get(localTokenKey(message.token)))[localTokenKey(message.token)]);
  if (!receipt.success || receipt.data.expiresAt <= Date.now() || receipt.data.epoch !== epoch)
    return refusal('This document import expired or your library was cleared. Choose the file again.');
  await assertLocalContext(receipt.data.tabId ?? message.tabId);
  if (message.tabId !== undefined) await assertLocalContext(message.tabId);
  const db = await openDatabase();
  try {
    if (message.courseId && !await new Repository(db, STORE.courses, courseSchema).get(message.courseId))
      return refusal('That course is no longer in your library. Choose a current course or import without a course.');
  } finally { db.close(); }
  const result = await save(indexedDocumentSchema.parse({ ...message.parsed, id: `document:${message.token}`,
    title: message.title, courseId: message.courseId ?? null, sourceUrl: null, sourcePageUrl: null, capturedAt: new Date().toISOString() }), epoch);
  await chrome.storage.session.remove(localTokenKey(message.token));
  return result;
}

async function beginLocalImport(tabId: number | undefined, epoch: string | null) {
  await assertLocalContext(tabId);
  const token = crypto.randomUUID();
  await withLock(DOCUMENT_LIFECYCLE_LOCK, async () => {
    await assertDocumentEpoch(epoch);
    await pruneDocumentContexts();
    const all = await chrome.storage.session.get(null);
    const old = Object.entries(all).filter(([key]) => key.startsWith('motion.documentLocal:'));
    const expired = old.filter(([, raw]) => { const receipt = localTokenSchema.safeParse(raw); return !receipt.success || receipt.data.expiresAt <= Date.now(); });
    if (expired.length) await chrome.storage.session.remove(expired.map(([key]) => key));
    if (old.length - expired.length >= 100) return refusal('Too many document imports are pending. Wait a few minutes and try again.');
    await chrome.storage.session.set({ [localTokenKey(token)]: localTokenSchema.parse({ token, epoch, tabId: tabId ?? null, expiresAt: Date.now() + HANDLE_TTL_MS }) });
  });
  return { token };
}

/** Only extension UI senders reach this handler; every request is still shape-checked. */
export async function handleDocumentMessage(raw: unknown): Promise<unknown> {
  const message = documentMessageSchema.parse(raw);
  const epoch = await readDocumentEpoch();
  switch (message.type) {
    case 'begin-document-import': return beginLocalImport(message.tabId, epoch);
    case 'get-document-sources': return getSources(message.tabId, epoch);
    case 'fetch-document': return fetchSource(message.tabId, message.handle, epoch);
    case 'store-document': return storeRemote(message, epoch);
    case 'store-document-local': return storeLocal(message, epoch);
    case 'get-documents': {
      const db = await openDatabase();
      try {
        const documents = (await readIndexedDocuments(db))
          .filter((document) => message.courseId === undefined || document.courseId === message.courseId)
          .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
          .flatMap((document) => { const summary = summarizeDocument(document, message.query); return summary ? [summary] : []; });
        return documentsResponseSchema.parse({ documents: documents.slice(0, DOCUMENT_RESULT_LIMIT), total: documents.length,
          truncated: documents.length > DOCUMENT_RESULT_LIMIT });
      } finally { db.close(); }
    }
    case 'get-document': {
      const db = await openDatabase();
      try {
        const parsed = indexedDocumentSchema.safeParse(await getRecord(db, STORE.documents, message.id));
        return { document: parsed.success ? parsed.data : null };
      } finally { db.close(); }
    }
    case 'delete-document': {
      const db = await openDatabase();
      try { await deleteRecord(db, STORE.documents, message.id); } finally { db.close(); }
      await chrome.storage.session.set({ 'motion.documentRevision': crypto.randomUUID() });
      return { deleted: true };
    }
  }
}
