import { describe, expect, it } from 'vitest';
import { authorizeMessage, type AuthorizationPolicy, type SenderFacts } from './authorize';
import { maySend, type MessageType } from './contracts';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ORIGIN = `chrome-extension://${RUNTIME_ID}`;
const PAGE = 'https://mylearningspace.wlu.ca/d2l/home/12345';

const policy: AuthorizationPolicy = {
  isSupportedHost: (url) =>
    /^https:\/\/([^/]*\.)?(brightspace\.com|desire2learn\.com|mylearningspace\.wlu\.ca)\//.test(url),
  extensionOrigin: EXTENSION_ORIGIN,
};

const contentScript = (overrides: Partial<SenderFacts> = {}): SenderFacts => ({
  extensionId: RUNTIME_ID,
  runtimeId: RUNTIME_ID,
  tabId: 7,
  senderUrl: PAGE,
  frameId: 0,
  ...overrides,
});

const panel = (overrides: Partial<SenderFacts> = {}): SenderFacts => ({
  extensionId: RUNTIME_ID,
  runtimeId: RUNTIME_ID,
  senderUrl: `${EXTENSION_ORIGIN}/src/sidepanel/index.html`,
  ...overrides,
});

const observation = (url = PAGE) => ({
  type: 'page-observed' as const,
  url,
  pageType: 'course-home' as const,
  title: 'CP363 Database II',
  detectionConfidence: 'high' as const,
  warnings: [],
  restricted: false,
});

describe('sender identity', () => {
  it('rejects a message that did not come from this extension', () => {
    const result = authorizeMessage(
      observation(),
      contentScript({ extensionId: 'someotherextensionidsomeotherid' }),
      policy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/did not originate/i);
  });

  it('rejects a message with no sender id at all', () => {
    const result = authorizeMessage(observation(), contentScript({ extensionId: undefined }), policy);
    expect(result.ok).toBe(false);
  });

  it('accepts a well-formed observation from a supported page', () => {
    const result = authorizeMessage(observation(), contentScript(), policy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe('content-script');
      expect(result.tabId).toBe(7);
    }
  });
});

describe('role separation', () => {
  it('refuses to let a content script decide an approval', () => {
    const result = authorizeMessage(
      { type: 'decide-approval', approvalId: 'a1', approved: true },
      contentScript(),
      policy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/may not send/i);
  });

  it('refuses to let a content script drive a workflow', () => {
    const result = authorizeMessage(
      { type: 'workflow-command', workflowId: 'w1', command: 'resume' },
      contentScript(),
      policy,
    );
    expect(result.ok).toBe(false);
  });

  it('refuses to let the panel impersonate a page observation', () => {
    // The panel has no tab, so it is typed as extension-ui and rejected.
    const result = authorizeMessage(observation(), panel(), policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/may not send/i);
  });

  it('lets the panel send UI commands', () => {
    const result = authorizeMessage({ type: 'get-state' }, panel(), policy);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe('extension-ui');
  });

  it('every message type names at least one permitted role', () => {
    const types: MessageType[] = [
      'page-observed',
      'extraction-result',
      'request-extraction',
      'get-state',
      'decide-approval',
      'workflow-command',
      'correct-task',
    ];
    for (const type of types) {
      expect(maySend(type, 'content-script') || maySend(type, 'extension-ui')).toBe(true);
    }
  });
});

describe('content-script scrutiny', () => {
  it('rejects reports from a subframe', () => {
    const result = authorizeMessage(observation(), contentScript({ frameId: 3 }), policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/main frame/i);
  });

  it('rejects a page on an unsupported host', () => {
    const url = 'https://evil.example.com/d2l/home/1';
    const result = authorizeMessage(observation(url), contentScript({ senderUrl: url }), policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not on a host Motion supports/i);
  });

  it('rejects a non-HTTPS page', () => {
    const url = 'http://mylearningspace.wlu.ca/d2l/home/12345';
    const result = authorizeMessage(observation(url), contentScript({ senderUrl: url }), policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/HTTPS/i);
  });

  it('rejects a payload URL that does not match the sending page', () => {
    // A compromised page trying to attribute its content to another course.
    const result = authorizeMessage(
      observation('https://other.brightspace.com/d2l/home/999'),
      contentScript({ senderUrl: PAGE }),
      policy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match the sending page/i);
  });

  it('accepts a payload URL on the same origin but a different path', () => {
    const result = authorizeMessage(
      observation('https://mylearningspace.wlu.ca/d2l/le/content/12345/home'),
      contentScript({ senderUrl: PAGE }),
      policy,
    );
    expect(result.ok).toBe(true);
  });
});

describe('shape validation', () => {
  it('rejects an unknown message type', () => {
    const result = authorizeMessage({ type: 'run-arbitrary-thing' }, panel(), policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/malformed/i);
  });

  it.each([null, undefined, 42, 'string', []])('rejects a non-object payload: %s', (raw) => {
    expect(authorizeMessage(raw, panel(), policy).ok).toBe(false);
  });

  it('rejects a title beyond the length bound', () => {
    const result = authorizeMessage(
      { ...observation(), title: 'x'.repeat(5_000) },
      contentScript(),
      policy,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an oversized task list', () => {
    const result = authorizeMessage(
      {
        type: 'extraction-result',
        requestId: '00000000-0000-4000-8000-000000000000',
        url: PAGE,
        course: null,
        tasks: new Array(1_000).fill({}),
        content: null,
        warnings: [],
      },
      contentScript(),
      policy,
    );
    expect(result.ok).toBe(false);
  });
});
