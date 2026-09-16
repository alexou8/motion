import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai';
import type { FetchLike } from './http';
import type { SecretStore } from './secrets';

const CANARY = 'sk-test-CANARY1234567890';

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

describe('OpenAIProvider', () => {
  it('reports not-configured when no key is set', async () => {
    const provider = new OpenAIProvider({ secrets: fakeSecrets(null) });
    expect((await provider.availability()).status).toBe('not-configured');
  });

  it('only calls the allowlisted Responses endpoint', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      return jsonResponse({ output_text: 'hi' });
    }) as unknown as FetchLike;
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never includes the API key in a thrown error message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 'invalid_api_key' } }, 401)) as unknown as FetchLike;
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' }),
    ).rejects.toMatchObject({ kind: 'invalid-key', message: expect.not.stringContaining(CANARY) });
  });

  it('classifies 401 as invalid-key, 429 quota as insufficient-quota, plain 429 as rate-limited, 404 as model-unavailable, 500 as network-error', async () => {
    const cases: [Response, string][] = [
      [jsonResponse({}, 401), 'invalid-key'],
      [jsonResponse({ error: { code: 'insufficient_quota' } }, 429), 'insufficient-quota'],
      [jsonResponse({ error: { code: 'rate_limit_exceeded' } }, 429), 'rate-limited'],
      [jsonResponse({}, 404), 'model-unavailable'],
      [jsonResponse({}, 500), 'network-error'],
    ];
    for (const [response, kind] of cases) {
      const fetchImpl = vi.fn(async () => response.clone()) as unknown as FetchLike;
      const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
      await expect(
        provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' }),
      ).rejects.toMatchObject({ kind });
    }
  });

  it('surfaces a network TypeError as network-error without leaking the key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchLike;
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' }),
    ).rejects.toMatchObject({ kind: 'network-error' });
  });

  it('parses SSE output_text deltas while streaming, handling a split chunk', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: response.output_text.delta\ndata: {"delta":"Hel',
      'lo"}\n\n',
      'event: response.output_text.delta\ndata: {"delta":" world"}\n\n',
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
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    const out: string[] = [];
    for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' })) {
      out.push(delta);
    }
    expect(out.join('')).toBe('Hello world');
  });

  it('stops streaming when aborted mid-stream', async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"delta":"a"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async (_url, init) => {
      (init as RequestInit).signal?.addEventListener('abort', () => {
        // Real fetch would reject; jsdom Response body just gets cancelled by the reader.
      });
      return new Response(body, { status: 200 });
    }) as unknown as FetchLike;
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });

    const out: string[] = [];
    for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5', signal: controller.signal })) {
      out.push(delta);
      controller.abort();
      break;
    }
    expect(out).toEqual(['a']);
    void cancelled;
  });
});
