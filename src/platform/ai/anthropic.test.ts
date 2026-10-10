import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic';
import type { FetchLike } from './http';
import type { SecretStore } from './secrets';

const CANARY = 'sk-ant-CANARY1234567890';

function fakeSecrets(key: string | null): SecretStore {
  return {
    persistence: 'session',
    async get() {
      return key;
    },
    async set() {},
    async forget() {},
    async has() {
      return key !== null;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(frames: readonly string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join('')));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('AnthropicProvider', () => {
  it('reports not-configured when no key is set', async () => {
    const provider = new AnthropicProvider({ secrets: fakeSecrets(null) });
    expect((await provider.availability()).status).toBe('not-configured');
  });

  it('only calls the allowlisted Messages endpoint with required headers', async () => {
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(CANARY);
      expect(headers['anthropic-version']).toBe('2023-06-01');
      return jsonResponse({ type: 'message', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    }) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks current-generation models for low effort and leaves older models alone', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
      return jsonResponse({ type: 'message', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    }) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'claude-haiku-5-5' });
    await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'claude-haiku-4-5' });
    expect(bodies[0]?.output_config).toEqual({ effort: 'low' });
    expect(bodies[1]?.output_config).toBeUndefined();
  });

  it('follows Anthropic model pages with an encoded cursor', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (url === 'https://api.anthropic.com/v1/models?limit=20') {
        return jsonResponse({
          data: [{ id: 'claude-first' }],
          has_more: true,
          last_id: 'claude first',
        });
      }
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=20&after_id=claude+first');
      return jsonResponse({
        data: [{ id: 'claude-second' }],
        has_more: false,
        last_id: 'claude-second',
      });
    }) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });

    await expect(provider.listModels()).resolves.toEqual(['claude-first', 'claude-second']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a model list that exceeds the 100-model bound instead of truncating it', async () => {
    let page = 0;
    const fetchImpl = vi.fn(async (_url: unknown, _init: unknown) => {
      page += 1;
      return jsonResponse({
        data: Array.from({ length: 20 }, (_, index) => ({ id: `claude-${page}-${index}` })),
        has_more: true,
        last_id: `cursor-${page}`,
      });
    }) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });

    await expect(provider.listModels()).rejects.toMatchObject({ kind: 'bad-response' });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('never includes the API key in a thrown error message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { type: 'authentication_error' } }, 401)) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ kind: 'invalid-key', message: expect.not.stringContaining(CANARY) });
  });

  it('classifies statuses: 401 invalid-key, 429 rate-limited, 404 model-unavailable, credit-balance 400 insufficient-quota, 529 rate-limited', async () => {
    const cases: [Response, string][] = [
      [jsonResponse({}, 401), 'invalid-key'],
      [jsonResponse({ error: { type: 'rate_limit_error' } }, 429), 'rate-limited'],
      [jsonResponse({ error: { type: 'not_found_error' } }, 404), 'model-unavailable'],
      [jsonResponse({ error: { message: 'Your credit balance is too low' } }, 400), 'insufficient-quota'],
      [jsonResponse({ error: { type: 'overloaded_error' } }, 529), 'rate-limited'],
    ];
    for (const [response, kind] of cases) {
      const fetchImpl = vi.fn(async () => response.clone()) as unknown as FetchLike;
      const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
      await expect(
        provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toMatchObject({ kind });
    }
  });

  it('surfaces a network failure after a chargeable POST as outcome-unknown', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connection lost after send');
    }) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ kind: 'outcome-unknown' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours retry-after (bounded) before succeeding', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '0' } });
      return jsonResponse({ type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    }) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    const result = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('parses content_block_delta text_delta SSE frames, handling a split chunk', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel',
      'lo"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i]));
          i += 1;
        } else controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    const out: string[] = [];
    for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) out.push(delta);
    expect(out.join('')).toBe('Hello world');
  });

  it('ignores supported non-text deltas while completing text output', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reasoning"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"signature"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])) as unknown as FetchLike,
    });
    const output: string[] = [];

    for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) output.push(delta);
    expect(output.join('')).toBe('answer');
  });

  it('stops streaming when aborted mid-stream', async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n'));
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    const out: string[] = [];
    for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })) {
      out.push(delta);
      controller.abort();
      break;
    }
    expect(out).toEqual(['a']);
  });

  it('maps a mid-stream overloaded_error to a retryable overload, not a bad response', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
        `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${CANARY}"}}\n\n`,
      ])) as unknown as FetchLike,
    });
    const output: string[] = [];

    await expect((async () => {
      for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) output.push(delta);
    })()).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 30_000, message: expect.not.stringContaining(CANARY) });
    expect(output.join('')).toBe('partial');
  });

  it.each([
    ['authentication_error', 'invalid-key'],
    ['permission_error', 'forbidden'],
    ['rate_limit_error', 'rate-limited'],
    ['api_error', 'outcome-unknown'],
    ['mystery_error', 'bad-response'],
  ])('maps a mid-stream %s event to %s', async (type, kind) => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        `event: error\ndata: {"type":"error","error":{"type":"${type}","message":"boom"}}\n\n`,
      ])) as unknown as FetchLike,
    });
    await expect((async () => {
      for await (const _ of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) void _;
    })()).rejects.toMatchObject({ kind });
  });

  it('surfaces a redacted request-rejection detail from a mid-stream invalid_request_error', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        `event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"bad ${CANARY}"}}\n\n`,
      ])) as unknown as FetchLike,
    });
    await expect((async () => {
      for await (const _ of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) void _;
    })()).rejects.toMatchObject({
      kind: 'bad-request',
      message: expect.stringContaining('invalid_request_error'),
    });
    await expect((async () => {
      for await (const _ of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) void _;
    })()).rejects.toMatchObject({ message: expect.not.stringContaining(CANARY) });
  });

  it('ignores unknown delta types instead of failing the stream', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"citations_delta","citation":{"x":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])) as unknown as FetchLike,
    });
    const output: string[] = [];
    for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) output.push(delta);
    expect(output.join('')).toBe('ok');
  });

  it('keeps the text of a stream that ends with the max_tokens stop reason and reports truncation', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])) as unknown as FetchLike,
    });

    const output: string[] = [];
    const onTruncated = vi.fn();
    for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], onTruncated })) output.push(delta);
    expect(output.join('')).toBe('partial');
    expect(onTruncated).toHaveBeenCalledWith('max-tokens');
  });

  it('keeps partial text on a refusal stop and flags it, but rejects a refusal with no text', async () => {
    const refusalFrames = (text: string) => [
      ...(text ? [`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${text}"}}\n\n`] : []),
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const onTruncated = vi.fn();
    const withText = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl: vi.fn(async () => sseResponse(refusalFrames('so far'))) as unknown as FetchLike });
    const out: string[] = [];
    for await (const delta of withText.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], onTruncated })) out.push(delta);
    expect(out.join('')).toBe('so far');
    expect(onTruncated).toHaveBeenCalledWith('refusal');

    const empty = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl: vi.fn(async () => sseResponse(refusalFrames(''))) as unknown as FetchLike });
    await expect((async () => {
      for await (const _ of empty.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) void _;
    })()).rejects.toMatchObject({ kind: 'bad-response', message: expect.stringMatching(/declined/) });
  });

  it('rejects a stream that ends without message_stop', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      ])) as unknown as FetchLike,
    });

    await expect((async () => {
      for await (const _ of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) {
        void _;
      }
    })()).rejects.toMatchObject({ kind: 'bad-response' });
  });

  it('returns the partial text of a max_tokens HTTP response and reports truncation', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => jsonResponse({
        type: 'message',
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: 'max_tokens',
      })) as unknown as FetchLike,
    });

    const onTruncated = vi.fn();
    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], onTruncated }),
    ).resolves.toBe('partial');
    expect(onTruncated).toHaveBeenCalledWith('max-tokens');
  });

  it('does not report truncation for a normal end_turn', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => jsonResponse({ type: 'message', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' })) as unknown as FetchLike,
    });
    const onTruncated = vi.fn();
    await expect(provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], onTruncated })).resolves.toBe('done');
    expect(onTruncated).not.toHaveBeenCalled();
  });

  it('reports a connect timeout as a timeout with its own message, not a cancellation', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as FetchLike;
      const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
      const settled = provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await settled;
      expect(error.kind).toBe('timeout');
      expect(error.message).toBe('Anthropic took too long to respond. The request may have been processed and charged. Retry?');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a stream that goes silent as a timeout after the text already received', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n'));
        },
      }), { status: 200 })) as unknown as FetchLike;
      const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
      const output: string[] = [];
      const settled = (async () => {
        for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) output.push(delta);
      })().catch((e) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await settled).toMatchObject({ kind: 'timeout' });
      expect(output).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('HTTP failures', () => {
    const run = (response: () => Response, method: 'generate' | 'listModels' = 'generate') => {
      const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl: vi.fn(async () => response()) as unknown as FetchLike });
      return method === 'generate'
        ? provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] })
        : provider.listModels();
    };

    it.each([400, 413, 422])('reports a %i as a rejected request with the provider detail, not a connection problem', async (status) => {
      const error = await run(() => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: `max_tokens too large ${CANARY}` } }, status)).catch((e) => e);
      expect(error).toMatchObject({ kind: 'bad-request', message: expect.stringContaining('max_tokens too large') });
      expect(error.message).not.toContain(CANARY);
      expect(error.message).not.toMatch(/connection/i);
    });

    it('reports a 403 as missing model permission rather than an invalid key', async () => {
      const error = await run(() => jsonResponse({ type: 'error', error: { type: 'permission_error', message: 'no access' } }, 403)).catch((e) => e);
      expect(error.kind).toBe('forbidden');
      expect(error.message).toMatch(/doesn’t have permission to use this model/);
      expect(error.message).not.toMatch(/no longer valid/);
    });

    it('keeps 401 as an invalid key', async () => {
      await expect(run(() => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'x' } }, 401))).rejects.toMatchObject({ kind: 'invalid-key' });
    });

    it('treats 529 as a retryable overload with a default retry hint', async () => {
      const error = await run(() => jsonResponse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529)).catch((e) => e);
      expect(error).toMatchObject({ kind: 'rate-limited', retryAfterMs: 30_000 });
      expect(error.message).toMatch(/overloaded/i);
    });

    it('honours a retry-after in HTTP-date form', async () => {
      // Beyond the inline-wait cap, so the 429 is returned rather than slept on.
      const when = new Date(Date.now() + 120_000).toUTCString();
      const error = await run(() => new Response('{}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': when },
      })).catch((e) => e);
      expect(error.kind).toBe('rate-limited');
      expect(error.retryAfterMs).toBeGreaterThan(100_000);
      expect(error.retryAfterMs).toBeLessThanOrEqual(120_000);
    });

    it('explains a GET 5xx as a provider problem, not a connection problem', async () => {
      const error = await run(() => jsonResponse({}, 500), 'listModels').catch((e) => e);
      expect(error.kind).toBe('server-error');
      expect(error.message).not.toMatch(/connection/i);
    });
  });

  it('rejects an HTTP response without text content', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => jsonResponse({
        type: 'message',
        content: [{ type: 'text' }],
        stop_reason: 'end_turn',
      })) as unknown as FetchLike,
    });

    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ kind: 'bad-response' });
  });
});
