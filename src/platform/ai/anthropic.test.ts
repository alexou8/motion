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

  it('does not treat an error event after partial output as success', async () => {
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
    })()).rejects.toMatchObject({ kind: 'bad-response', message: expect.not.stringContaining(CANARY) });
    expect(output.join('')).toBe('partial');
  });

  it('rejects a stream that ends with the max_tokens stop reason', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])) as unknown as FetchLike,
    });

    await expect((async () => {
      for await (const _ of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) {
        void _;
      }
    })()).rejects.toMatchObject({ kind: 'bad-response' });
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

  it('rejects a max_tokens HTTP response instead of returning partial text', async () => {
    const provider = new AnthropicProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => jsonResponse({
        type: 'message',
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: 'max_tokens',
      })) as unknown as FetchLike,
    });

    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ kind: 'bad-response' });
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
