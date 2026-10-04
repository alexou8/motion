import { afterEach, expect, it, vi } from 'vitest';
import { extractionResultSchema, LIMITS } from '../core/messaging/contracts';
import { extract, readContent } from './observer';

afterEach(() => vi.unstubAllGlobals());

it('refuses a synthetic embedded attempt whose visible hint lives in an open shadow root', () => {
  const pageDocument = new DOMParser().parseFromString(
    '<title>Synthetic topic</title><h1>Synthetic topic</h1><main><synthetic-assessment></synthetic-assessment></main>',
    'text/html',
  );
  const shadow = pageDocument.querySelector('synthetic-assessment')!.attachShadow({ mode: 'open' });
  shadow.append(pageDocument.createTextNode('Time remaining: 20 minutes'));
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', {
    location: new URL('https://mylearningspace.wlu.ca/d2l/le/content/999999/viewContent/100/View'),
  });
  vi.stubGlobal('document', pageDocument);
  vi.stubGlobal('chrome', { runtime: { sendMessage } });

  extract('33333333-3333-4333-8333-333333333333');
  const result = extractionResultSchema.parse(sendMessage.mock.calls[0]?.[0]);
  expect(result.course).toBeNull();
  expect(result.tasks).toEqual([]);
  expect(result.content).toBeNull();
  expect(result.warnings).toEqual([expect.stringMatching(/timed or proctored/)]);
  expect(readContent()).toEqual({ refused: expect.stringMatching(/timed or proctored/) });
});

it('bounds large synthetic lecture modules without losing their real deadline', () => {
  const topics = Array.from(
    { length: LIMITS.taskCount + 1 },
    (_, index) =>
      `<li class="d2l-datalist-item"><a href="/d2l/le/content/999999/viewContent/${index + 1}/View">Synthetic lecture ${index + 1}</a></li>`,
  ).join('');
  const pageDocument = new DOMParser().parseFromString(
    `<title>Synthetic module - TEST-101-A - Synthetic Course</title><h1>Synthetic module</h1><main><ul class="d2l-datalist">${topics}<li class="d2l-datalist-item"><a href="/d2l/le/content/999999/viewContent/9999/View">Synthetic reading response</a><span class="d2l-dates-text">Due on Nov 3, 2026 11:59 PM</span></li></ul></main>`,
    'text/html',
  );
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', {
    location: new URL('https://mylearningspace.wlu.ca/d2l/le/content/999999/Home'),
  });
  vi.stubGlobal('document', pageDocument);
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  extract('11111111-1111-4111-8111-111111111111');
  const messages = sendMessage.mock.calls.map(([message]) => message);
  const result = extractionResultSchema.parse(
    messages.find((message) => message.type === 'extraction-result'),
  );
  expect(result.tasks).toHaveLength(LIMITS.taskCount);
  expect(result.tasks[0]?.title).toBe('Synthetic reading response');
  expect(result.tasks[0]?.due.iso).not.toBeNull();
  expect(result.warnings[0]).toMatch(/502 items.*500.*remaining materials/);
  expect(messages.find((message) => message.type === 'page-observed')?.warnings).toEqual(
    result.warnings,
  );
  pageDocument.querySelector('ul')!.innerHTML =
    '<li class="d2l-datalist-item"><a href="/d2l/le/content/999999/viewContent/1/View">Synthetic lecture 1</a></li>';
  sendMessage.mockClear();
  extract('22222222-2222-4222-8222-222222222222');
  const smallerRead = sendMessage.mock.calls.map(([message]) => message);
  expect(smallerRead.find((message) => message.type === 'page-observed')?.warnings).toEqual([]);
  expect(
    extractionResultSchema.parse(
      smallerRead.find((message) => message.type === 'extraction-result'),
    ).tasks,
  ).toHaveLength(1);
});
