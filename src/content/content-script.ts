/**
 * Motion's content script.
 *
 * It runs inside a page Motion does not control and holds no privileged
 * capability. It reads, and it reports. It never clicks, submits, navigates or
 * modifies the document — extraction is a pure `(url, document) -> domain`
 * call, so "read-only" is a property of the code's shape rather than a flag
 * someone has to remember to check.
 */
import { resolveAdapter } from '@/core/adapters';
import { evaluateAssessmentContext } from '@/core/policy';
import type { Message } from '@/core/messaging';

const EXTRACT_REQUEST = 'motion:extract';
const CONTENT_REQUEST = 'motion:extract-content';

function send(message: Message): void {
  // A failure here means the worker is asleep or the panel is closed; neither
  // is worth surfacing to the student on a page they are reading.
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function currentUrl(): string {
  // location.href rather than anything the page can set, and re-read each time
  // because these are single-page apps that navigate without a reload.
  return window.location.href;
}

/**
 * Look at the page and report what kind it is. Runs on load and after
 * client-side navigation.
 */
function observe(): void {
  const url = currentUrl();
  const adapter = resolveAdapter(url);
  if (!adapter) return;

  const detection = adapter.detectPage({
    url,
    document,
    now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (!detection) return;

  // Restricted mode is decided here, before anything is read into a payload,
  // so an assessment page's content never leaves the tab at all.
  const assessment = evaluateAssessmentContext({
    pageType: detection.pageType,
    url,
    pageTitle: document.title,
    visibleText: document.body?.innerText?.slice(0, 4_000) ?? '',
  });

  send({
    type: 'page-observed',
    url,
    pageType: detection.pageType,
    title: document.title.slice(0, 500),
    detectionConfidence: detection.confidence,
    warnings: detection.warnings.slice(0, 50),
    restricted: assessment.restricted,
  });
}

/** Full extraction, only when the worker asks and only when not restricted. */
function extract(requestId: string): void {
  const url = currentUrl();
  const adapter = resolveAdapter(url);
  if (!adapter) return;

  const now = new Date();
  const input = {
    url,
    document,
    now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  const detection = adapter.detectPage(input);
  const assessment = evaluateAssessmentContext({
    pageType: detection?.pageType ?? 'unsupported',
    url,
    pageTitle: document.title,
    visibleText: document.body?.innerText?.slice(0, 4_000) ?? '',
  });
  if (assessment.restricted) {
    send({
      type: 'extraction-result',
      requestId,
      url,
      course: null,
      tasks: [],
      content: null,
      warnings: [assessment.reason],
    });
    return;
  }

  send({
    type: 'extraction-result',
    requestId,
    url,
    course: adapter.extractCourse(input),
    tasks: adapter.extractTasks(input),
    content: adapter.extractPageContent(input),
    warnings: detection?.warnings ?? [],
  });
}

/**
 * Returns the page's content for the worker to analyse. Refuses on a restricted
 * page, so instructions are never harvested from a graded attempt.
 */
function readContent(): { content: unknown } | { refused: string } {
  const url = currentUrl();
  const adapter = resolveAdapter(url);
  if (!adapter) return { refused: 'Motion does not support this page.' };

  const input = {
    url,
    document,
    now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const detection = adapter.detectPage(input);
  const assessment = evaluateAssessmentContext({
    pageType: detection?.pageType ?? 'unsupported',
    url,
    pageTitle: document.title,
    visibleText: document.body?.innerText?.slice(0, 4_000) ?? '',
  });
  if (assessment.restricted) return { refused: assessment.reason };

  return { content: adapter.extractPageContent(input) };
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  // The only instructions this script accepts, and neither carries page data in.
  if (typeof raw !== 'object' || raw === null) return undefined;
  const message = raw as { type?: unknown; requestId?: unknown };

  if (message.type === EXTRACT_REQUEST) {
    extract(typeof message.requestId === 'string' ? message.requestId : crypto.randomUUID());
    return undefined;
  }

  if (message.type === CONTENT_REQUEST) {
    sendResponse(readContent());
    return undefined;
  }

  return undefined;
});

observe();

/**
 * D2L navigates without a full page load, so the URL can change under a
 * long-lived content script. Polling the URL is cruder than the Navigation API
 * but works in every Chrome version Motion supports, and the cost is one
 * string comparison per second.
 */
let lastUrl = currentUrl();
setInterval(() => {
  const url = currentUrl();
  if (url === lastUrl) return;
  lastUrl = url;
  observe();
}, 1_000);
