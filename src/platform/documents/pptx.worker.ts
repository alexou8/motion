import { parsePptx } from './pptx';
import { slideWorkerRequestSchema } from './worker-contracts';

// One document per disposable worker keeps cancellation and resource ownership
// explicit. Untrusted parser details are never sent back as exception strings.
let started = false;
globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (started) return;
  started = true;
  try {
    const request = slideWorkerRequestSchema.parse(event.data);
    globalThis.postMessage({ ok: true, document: parsePptx(request.bytes) });
  } catch {
    globalThis.postMessage({ ok: false, error: 'invalid-document' });
  }
});
