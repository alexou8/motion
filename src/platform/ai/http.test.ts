import { describe, expect, it, vi } from 'vitest';
import {
  assertAllowlisted,
  classifyHttpError,
  EndpointNotAllowedError,
  parseSSEStream,
  requestWithRetry,
  type FetchLike,
} from './http';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}

describe('assertAllowlisted', () => {
  it('accepts the fixed provider endpoints', () => {
    expect(() => assertAllowlisted('https://api.openai.com/v1/responses')).not.toThrow();
    expect(() => assertAllowlisted('https://api.anthropic.com/v1/messages')).not.toThrow();
  });

  it('rejects any other host, including a look-alike', () => {
    expect(() => assertAllowlisted('https://api.openai.com.evil.com/v1/responses')).toThrow(EndpointNotAllowedError);
    expect(() => assertAllowlisted('https://evil.example/v1/responses')).toThrow(EndpointNotAllowedError);
  });

  it('rejects a non-https scheme even for an allowlisted-looking host', () => {
    expect(() => assertAllowlisted('http://api.openai.com/v1/responses')).toThrow(EndpointNotAllowedError);
  });
});

describe('requestWithRetry', () => {
  it('refuses to call a non-allowlisted endpoint', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    await expect(
      requestWithRetry({ url: 'https://evil.example/steal', init: {}, fetchImpl }),
    ).rejects.toThrow(EndpointNotAllowedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a 429 up to the bound, then returns the final response', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      calls += 1;
      return jsonResponse({ error: 'rate' }, { status: 429 });
    }) as unknown as FetchLike;

    const response = await requestWithRetry({
      url: 'https://api.openai.com/v1/models',
      init: {},
      fetchImpl,
      maxRetries: 2,
    });
    expect(response.status).toBe(429);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('honours a short retry-after header before succeeding', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, { status: 429, headers: { 'retry-after': '0' } });
      return jsonResponse({ ok: true });
    }) as unknown as FetchLike;

    const response = await requestWithRetry({ url: 'https://api.openai.com/v1/models', init: {}, fetchImpl });
    expect(response.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not sleep past the retry-after cap — returns the rate-limited response instead', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '120' } }),
    ) as unknown as FetchLike;

    const start = Date.now();
    const response = await requestWithRetry({ url: 'https://api.openai.com/v1/models', init: {}, fetchImpl });
    expect(response.status).toBe(429);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('redacts a known secret from a thrown network error', async () => {
    const key = 'sk-test-CANARY1234567890';
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new TypeError(`network down, key was ${key}`);
    }) as unknown as FetchLike;

    await expect(
      requestWithRetry({ url: 'https://api.openai.com/v1/models', init: {}, fetchImpl, knownSecrets: [key], maxRetries: 0 }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining(key) });
  });

  it('propagates cancellation distinctly from a network error', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as FetchLike;

    const pending = requestWithRetry({ url: 'https://api.openai.com/v1/models', init: {}, fetchImpl, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ cancelled: true });
  });
});

describe('classifyHttpError', () => {
  it('maps 401/403 to invalid-key for both providers', () => {
    expect(classifyHttpError('openai', 401, {})).toBe('invalid-key');
    expect(classifyHttpError('anthropic', 403, {})).toBe('invalid-key');
  });

  it('maps openai insufficient_quota distinctly from plain rate limiting', () => {
    expect(classifyHttpError('openai', 429, { error: { code: 'insufficient_quota' } })).toBe('insufficient-quota');
    expect(classifyHttpError('openai', 429, { error: { code: 'rate_limit_exceeded' } })).toBe('rate-limited');
  });

  it('maps 404 to model-unavailable', () => {
    expect(classifyHttpError('openai', 404, {})).toBe('model-unavailable');
    expect(classifyHttpError('anthropic', 404, {})).toBe('model-unavailable');
  });

  it('maps anthropic rate_limit_error and overloaded to rate-limited', () => {
    expect(classifyHttpError('anthropic', 429, { error: { type: 'rate_limit_error' } })).toBe('rate-limited');
    expect(classifyHttpError('anthropic', 529, { error: { type: 'overloaded_error' } })).toBe('rate-limited');
  });

  it('maps anthropic credit-balance 400 to insufficient-quota', () => {
    expect(classifyHttpError('anthropic', 400, { error: { message: 'Your credit balance is too low' } })).toBe('insufficient-quota');
  });

  it('maps a bare 5xx to network-error', () => {
    expect(classifyHttpError('openai', 500, {})).toBe('network-error');
  });
});

describe('parseSSEStream', () => {
  function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i]));
          i += 1;
        } else {
          controller.close();
        }
      },
    });
  }

  it('parses a complete event in one chunk', async () => {
    const events = [];
    for await (const e of parseSSEStream(streamFromChunks(['event: delta\ndata: {"x":1}\n\n']))) events.push(e);
    expect(events).toEqual([{ event: 'delta', data: '{"x":1}' }]);
  });

  it('reassembles an event split across multiple chunks', async () => {
    const events = [];
    const chunks = ['event: delta\ndat', 'a: {"x":1}', '\n\n'];
    for await (const e of parseSSEStream(streamFromChunks(chunks))) events.push(e);
    expect(events).toEqual([{ event: 'delta', data: '{"x":1}' }]);
  });

  it('parses multiple events across chunk boundaries', async () => {
    const events = [];
    const chunks = ['event: delta\ndata: a\n\nevent: delta\nda', 'ta: b\n\n'];
    for await (const e of parseSSEStream(streamFromChunks(chunks))) events.push(e);
    expect(events).toEqual([
      { event: 'delta', data: 'a' },
      { event: 'delta', data: 'b' },
    ]);
  });

  it('handles multi-line data fields by joining with newlines', async () => {
    const events = [];
    for await (const e of parseSSEStream(streamFromChunks(['data: line1\ndata: line2\n\n']))) events.push(e);
    expect(events).toEqual([{ event: undefined, data: 'line1\nline2' }]);
  });
});
