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

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/responses') {
      responseCount += 1;
      const event = (delta) => `event: response.output_text.delta\ndata: ${JSON.stringify({ delta })}\n\n`;

      if (responseCount === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Two separate writes (with a tick between them) so the SSE parser
        // genuinely has to accumulate across two distinct network events
        // rather than getting the whole payload in one chunk.
        res.write(event('{"reply":"Stream'));
        setImmediate(() => {
          res.write(event('ed from OpenAI","plan":[]}'));
          res.end();
        });
        return;
      }

      // Second (and any later) request: hold it open indefinitely — the test
      // sends Stop and expects the client to abort this in-flight request.
      secondRequestSeen = true;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      req.on('aborted', () => {
        secondRequestAborted = true;
      });
      res.on('close', () => {
        if (!res.writableEnded) secondRequestAborted = true;
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
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
