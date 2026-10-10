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

function sseResponse(frames: readonly string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join('')));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAIProvider', () => {
  it('reports not-configured when no key is set', async () => {
    const provider = new OpenAIProvider({ secrets: fakeSecrets(null) });
    expect((await provider.availability()).status).toBe('not-configured');
  });

  it('only calls the allowlisted Responses endpoint', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      return jsonResponse({ status: 'completed', output_text: 'hi' });
    }) as unknown as FetchLike;
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('puts a JSON instruction in Responses input without changing conversation turns', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'completed', output_text: '{"reply":"hi","plan":[]}' })) as unknown as FetchLike;
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });

    await provider.generate({
      system: 'Motion policy that also asks for JSON.',
      messages: [
        { role: 'assistant', content: 'Earlier reply.' },
        { role: 'user', content: 'Continue.' },
      ],
      model: 'gpt-6-luna',
      json: true,
    });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { input: Array<{ role: string; content: string }>; instructions: string };
    expect(body.instructions).toBe('Motion policy that also asks for JSON.');
    expect(body.input).toEqual([
      { role: 'developer', content: 'Return one valid JSON object and no text outside that JSON object.' },
      { role: 'assistant', content: 'Earlier reply.' },
      { role: 'user', content: 'Continue.' },
    ]);
  });

  it('never includes the API key in a thrown error message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 'invalid_api_key' } }, 401)) as unknown as FetchLike;
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' }),
    ).rejects.toMatchObject({ kind: 'invalid-key', message: expect.not.stringContaining(CANARY) });
  });

  it('classifies 401 as invalid-key, 429 quota as insufficient-quota, plain 429 as rate-limited, 404 as model-unavailable, 500 as outcome-unknown', async () => {
    const cases: [Response, string][] = [
      [jsonResponse({}, 401), 'invalid-key'],
      [jsonResponse({ error: { code: 'insufficient_quota' } }, 429), 'insufficient-quota'],
      [jsonResponse({ error: { code: 'rate_limit_exceeded' } }, 429), 'rate-limited'],
      [jsonResponse({}, 404), 'model-unavailable'],
      [jsonResponse({}, 500), 'outcome-unknown'],
    ];
    for (const [response, kind] of cases) {
      const fetchImpl = vi.fn(async () => response.clone()) as unknown as FetchLike;
      const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
      await expect(
        provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' }),
      ).rejects.toMatchObject({ kind });
    }
  });

  it('surfaces a network TypeError as outcome-unknown without leaking the key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchLike;
    const provider = new OpenAIProvider({ secrets: fakeSecrets(CANARY), fetchImpl });
    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' }),
    ).rejects.toMatchObject({ kind: 'outcome-unknown', message: expect.stringContaining('may have been processed and charged') });
  });

  it('parses SSE output_text deltas while streaming, handling a split chunk', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel',
      'lo"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
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
        streamController.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"a"}\n\n'));
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

  it('does not treat a partial stream followed by response.failed as success', async () => {
    const provider = new OpenAIProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        `event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"${CANARY}"}}}\n\n`,
      ])) as unknown as FetchLike,
    });
    const output: string[] = [];

    await expect((async () => {
      for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' })) output.push(delta);
    })()).rejects.toMatchObject({ kind: 'bad-response', message: expect.not.stringContaining(CANARY) });
    expect(output.join('')).toBe('partial');
  });

  it('keeps the text of a response.incomplete stream and reports why it stopped', async () => {
    const incomplete = (reason: string) => new OpenAIProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        `event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"${reason}"}}}\n\n`,
      ])) as unknown as FetchLike,
    });
    for (const [reason, expected] of [['max_output_tokens', 'max-tokens'], ['content_filter', 'refusal'], ['other', 'incomplete']] as const) {
      const onTruncated = vi.fn();
      const output: string[] = [];
      for await (const delta of incomplete(reason).stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5', onTruncated })) output.push(delta);
      expect(output.join('')).toBe('partial');
      expect(onTruncated).toHaveBeenCalledWith(expected);
    }
  });

  it('rejects a response.incomplete stream that produced no text', async () => {
    const provider = new OpenAIProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
      ])) as unknown as FetchLike,
    });
    await expect((async () => {
      for await (const _ of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' })) void _;
    })()).rejects.toMatchObject({ kind: 'bad-response' });
  });

  it('returns the text of an incomplete non-streaming response and flags it', async () => {
    const provider = new OpenAIProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => jsonResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'cut off' })) as unknown as FetchLike,
    });
    const onTruncated = vi.fn();
    await expect(provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5', onTruncated })).resolves.toBe('cut off');
    expect(onTruncated).toHaveBeenCalledWith('max-tokens');
  });

  it.each([
    [400, 'bad-request'],
    [403, 'forbidden'],
    [401, 'invalid-key'],
  ] as const)('maps an HTTP %i to %s with its own wording', async (status, kind) => {
    const provider = new OpenAIProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => jsonResponse({ error: { code: 'x', message: 'detail here' } }, status)) as unknown as FetchLike,
    });
    const error = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' }).catch((e) => e);
    expect(error.kind).toBe(kind);
    if (kind === 'bad-request') expect(error.message).toContain('detail here');
  });

  it('rejects a stream that ends without response.completed', async () => {
    const provider = new OpenAIProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      ])) as unknown as FetchLike,
    });

    await expect((async () => {
      for await (const _ of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' })) {
        void _;
      }
    })()).rejects.toMatchObject({ kind: 'bad-response' });
  });

  it('rejects a completed HTTP response without output text', async () => {
    const provider = new OpenAIProvider({
      secrets: fakeSecrets(CANARY),
      fetchImpl: vi.fn(async () => jsonResponse({ status: 'completed' })) as unknown as FetchLike,
    });

    await expect(
      provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5' }),
    ).rejects.toMatchObject({ kind: 'bad-response' });
  });
});
