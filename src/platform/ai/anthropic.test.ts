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
      return jsonResponse({ content: [{ type: 'text', text: 'hi' }] });
    }) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }] });
    }) as unknown as FetchLike;
    const provider = new AnthropicProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    const result = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('parses content_block_delta text_delta SSE frames, handling a split chunk', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hel',
      'lo"}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":" world"}}\n\n',
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

  it('stops streaming when aborted mid-stream', async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"a"}}\n\n'));
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
});
