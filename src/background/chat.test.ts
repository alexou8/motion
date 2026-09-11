import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, deleteDatabase } from '@/core/storage/db';
import { STORE } from '@/core/storage/schema';
import { askAboutPageSchema } from '@/core/messaging';
import type { LanguageModelCapability, ModelAvailability, GenerationRequest } from '@/platform/languageModel';
import { handleAskAboutPage, handleMessage } from './router';

const TAB = 3;
const URL = 'https://mylearningspace.wlu.ca/d2l/lms/content/999/view';
let session: Record<string, unknown> = {};
let contentUrl = URL;
let sendMessage: ReturnType<typeof vi.fn>;

class FakeModel implements LanguageModelCapability {
  state: ModelAvailability = 'available';
  requests: GenerationRequest[] = [];
  error?: Error;
  availability = vi.fn(async () => this.state);
  async generate(request: GenerationRequest): Promise<string> {
    this.requests.push(request);
    if (this.error) throw this.error;
    return '  A useful answer.  ';
  }
  async *generateStream(): AsyncIterable<string> { yield ''; }
}

beforeEach(async () => {
  await deleteDatabase('motion');
  session = {};
  contentUrl = URL;
  sendMessage = vi.fn(async () => ({ content: {
    pageType: 'course-home', title: 'Synthetic page', url: contentUrl, text: 'Page text', headings: ['Heading'],
    links: [], capturedAt: '2026-09-11T12:00:00.000Z', instructionBlocks: [], warnings: [],
  } }));
  vi.stubGlobal('chrome', {
    storage: { session: {
      get: vi.fn(async (key: string) => ({ [key]: session[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => Object.assign(session, values)),
    } },
    tabs: { sendMessage, query: vi.fn(async () => [{ id: TAB }]) },
    runtime: { id: 'test-extension-id' },
  });
});

async function observe(restricted = false, url = URL) {
  await handleMessage({ type: 'page-observed', url, pageType: restricted ? 'quiz-attempt' : 'course-home', title: 'Synthetic page', detectionConfidence: 'high', warnings: [], restricted }, TAB);
}

describe('asking about a page', () => {
  it('returns an answer and stores no chat data', async () => {
    await observe();
    const model = new FakeModel();
    const result = await handleAskAboutPage(askAboutPageSchema.parse({ type: 'ask-about-page', tabId: TAB, question: 'What is this?', history: [] }), model);
    expect(result).toEqual({ answer: 'A useful answer.', label: expect.any(String) });
    expect(model.requests[0]!.context[0]!.text).toContain('Page text');
    expect(model.requests[0]!.instruction).toContain('What is this?');
    expect(Object.keys(session)).toEqual([`observation:${TAB}`]);
    const db = await openDatabase();
    for (const store of [STORE.notes, STORE.checklists]) expect(await new Promise<unknown[]>((resolve, reject) => { const req = db.transaction(store).objectStore(store).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); })).toHaveLength(0);
  });

  it('does not read restricted or unsupported tabs', async () => {
    await observe(true);
    const restrictedModel = new FakeModel();
    expect(await handleAskAboutPage({ type: 'ask-about-page', tabId: TAB, question: 'q', history: [] }, restrictedModel)).toMatchObject({ answer: null, reason: expect.stringContaining('graded attempt') });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(restrictedModel.availability).not.toHaveBeenCalled();
    await observe(false, URL);
    session[`observation:${TAB}`] = { url: URL, pageType: 'unsupported', title: '', restrictionReason: null, warnings: [], observedAt: new Date().toISOString() };
    const unsupportedModel = new FakeModel();
    expect((await handleAskAboutPage({ type: 'ask-about-page', tabId: TAB, question: 'q', history: [] }, unsupportedModel)).answer).toBeNull();
    expect(unsupportedModel.availability).not.toHaveBeenCalled();
    session = {};
    const unobservedModel = new FakeModel();
    expect((await handleAskAboutPage({ type: 'ask-about-page', tabId: TAB, question: 'q', history: [] }, unobservedModel)).reason).toContain('course page it can read');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('declines unavailable, changed, and failing model cases safely', async () => {
    await observe();
    const unavailable = new FakeModel(); unavailable.state = 'unavailable';
    expect((await handleAskAboutPage({ type: 'ask-about-page', tabId: TAB, question: 'q', history: [] }, unavailable)).reason).toContain('does not have an on-device model');
    expect(sendMessage).not.toHaveBeenCalled();
    contentUrl = 'https://mylearningspace.wlu.ca/d2l/home/other';
    const changed = new FakeModel();
    expect((await handleAskAboutPage({ type: 'ask-about-page', tabId: TAB, question: 'q', history: [] }, changed)).reason).toContain('page changed');
    expect(changed.requests).toHaveLength(0);
    contentUrl = URL;
    const failing = new FakeModel(); failing.error = new Error('Page text secret');
    const result = await handleAskAboutPage({ type: 'ask-about-page', tabId: TAB, question: 'q', history: [] }, failing);
    expect(result.reason).not.toContain('Page text secret');
  });

  it('routes a parsed worker message', async () => {
    await observe();
    const result = await handleMessage(askAboutPageSchema.parse({ type: 'ask-about-page', tabId: TAB, question: 'q', history: [] }));
    expect(result).toHaveProperty('answer');
  });
});
