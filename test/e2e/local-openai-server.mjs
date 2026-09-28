/**
 * A real HTTP server bound to 127.0.0.1, standing in for `api.openai.com` in
 * `test/e2e/provider-stream.mjs`.
 *
 * Why not `context.route`: Playwright's `context.route` intercepts fetches
 * made from pages/frames it controls, but Motion's provider request is made
 * from the MV3 *service worker* (src/platform/ai/openai.ts, invoked via
 * src/background/sessions.ts / modelTurn.ts). Confirmed by direct testing:
 * `context.route('https://api.openai.com/v1/responses', ...)` never fires
 * for that request, `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` only
 * adds requestfinished/requestfailed *observability* events for the SW (it
 * does not add SW routing/fulfillment), and Playwright's `newCDPSession`
 * only accepts a Page or Frame, not a ServiceWorker — there's no supported
 * way to attach `Fetch.enable` to the SW target from the public API.
 *
 * So instead of interception, this runs a real local server and the
 * `MOTION_E2E_PROVIDER_HOSTS=1` build (see src/platform/ai/http.ts
 * `E2E_PROVIDER_BASE_URL`, set only in that build via `define` in
 * vite.config.ts) points OpenAI's base URL at it — a real network round trip
 * to a real local socket, never reaching the actual OpenAI API. The
 * production build (`npm run build`) never sets that env var, so its
 * endpoints stay the fixed `https://api.openai.com/*` (see
 * src/manifest.config.test.ts and src/platform/ai/http.test.ts).
 */
import http from 'node:http';

export async function startLocalOpenAIServer({ port }) {
  let responseCount = 0;
  let secondRequestAborted = false;
  let secondRequestSeen = false;
  const requestedModels = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.4-nano', 'gpt-5', 'whisper-1', 'text-embedding-3-small'].map((id) => ({ id })) }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/responses') {
      let requestBody = '';
      req.on('data', (chunk) => { requestBody += chunk; });
      req.on('end', () => {
        const body = JSON.parse(requestBody);
        requestedModels.push(body.model);
        // Mirror the real Responses JSON-mode input requirement. Policy in
        // `instructions` alone does not satisfy this API validation.
        if (body.text?.format?.type === 'json_object' &&
            !body.input.some((message) => /json/i.test(message.content))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', param: 'input' } }));
          return;
        }
        responseCount += 1;
        const event = (delta) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`;

        if (responseCount === 1) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          // Two separate writes (with a tick between them) so the SSE parser
          // genuinely has to accumulate across two distinct network events
          // rather than getting the whole payload in one chunk.
          res.write(event('{"reply":"Stream'));
          setImmediate(() => {
            res.write(event('ed from OpenAI","plan":[]}'));
            res.write('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
            res.end();
          });
          return;
        }

        if (responseCount >= 3) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          if (responseCount === 6) {
            res.write(event('{"reply":"Recovered after provider failure","plan":[]}'));
            res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
            return;
          }
          // Even valid agent JSON must not be committed before the provider
          // confirms completion. The error contains synthetic private text
          // that must never reach the student's history or a diagnostic.
          res.write(event('{"reply":"UNCONFIRMED_PROVIDER_REPLY","plan":[]}'));
          if (responseCount === 3) {
            res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"SYNTHETIC_PRIVATE_PROVIDER_ERROR"}}}\n\n');
          } else if (responseCount === 4) {
            res.write('event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n');
          }
          res.end();
          return;
        }

        // Second request: hold it open indefinitely — the test
        // sends Stop and expects the client to abort this in-flight request.
        secondRequestSeen = true;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(event('{"reply":"'));
        req.on('aborted', () => {
          secondRequestAborted = true;
        });
        res.on('close', () => {
          if (!res.writableEnded) secondRequestAborted = true;
        });
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });

  return {
    url: `http://127.0.0.1:${port}`,
    get responseCount() {
      return responseCount;
    },
    get secondRequestSeen() {
      return secondRequestSeen;
    },
    get secondRequestAborted() {
      return secondRequestAborted;
    },
    get requestedModels() {
      return [...requestedModels];
    },
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
