import {
  actRequestSchema,
  actorAuthorizationSchema,
  actorPortRequestSchema,
  actorPortResponseSchema,
  actResultSchema,
  snapshotResultSchema,
  type ActRequest,
  type ActResult,
  type SnapshotResult,
} from '@/core/actor/contracts';
import { connectActorPort } from './actorChannel';
import { contentRequestSchema, type ContentRequest } from '@/core/messaging';
import { pageContentSchema, type PageContent } from '@/core/domain';

/** The observer is registered in the top-level document only. */
const MAIN_FRAME_ID = 0;
const CONTENT_SCRIPT_ATTEMPTS = 3;
const CONTENT_SCRIPT_RETRY_MS = 150;
const ACTOR_RESPONSE_TIMEOUT_MS = 10_000;
/**
 * Sends a validated request to the content script's main frame. The content
 * bundle may still be starting immediately after navigation, so a small,
 * bounded retry distinguishes that from a page where Motion is not installed.
 */
export async function sendToContentScript(
  tabId: number,
  message: ContentRequest,
): Promise<unknown> {
  const payload = contentRequestSchema.parse(message);
  let lastError: unknown;
  for (let attempt = 0; attempt < CONTENT_SCRIPT_ATTEMPTS; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload, { frameId: MAIN_FRAME_ID });
    } catch (error) {
      lastError = error;
      if (attempt < CONTENT_SCRIPT_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, CONTENT_SCRIPT_RETRY_MS));
      }
    }
  }
  throw lastError;
}

/** Reads validated page content, or returns null when the observer is unavailable. */
export async function askContentScript(tabId: number): Promise<PageContent | null> {
  try {
    const response = (await sendToContentScript(tabId, { type: 'motion:extract-content' })) as
      { content?: unknown } | undefined;
    const parsed = pageContentSchema.safeParse(response?.content);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Retrieves an opaque, short-lived element snapshot from the browser actor. */
export async function snapshotContentScript(tabId: number): Promise<SnapshotResult | null> {
  try {
    const parsed = snapshotResultSchema.safeParse(
      await sendToContentScript(tabId, { type: 'motion:snapshot' }),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Executes one schema-validated semantic actor request. */
export async function actInContentScript(
  tabId: number,
  request: ActRequest,
  consequentialCapability = false,
  showOnPagePointer = true,
): Promise<ActResult | null> {
  try {
    const parsedRequest = actRequestSchema.parse(request);
    const authorizedRequest = actorPortRequestSchema.parse({
      type: 'motion:act',
      requestId: crypto.randomUUID(),
      request: {
        ...parsedRequest,
        authorization: actorAuthorizationSchema.parse({
          nonce: crypto.randomUUID(),
          ...(consequentialCapability ? { consequentialCapability: crypto.randomUUID() } : {}),
        }),
        // This is worker-resolved preference state, not page or model input.
        // The actor still owns the final restricted-context check.
        showOnPagePointer,
      },
    });
    // D-ACTOR-2 (SOL-1): the worker opens this port itself, fresh per
    // request, toward this tab's content script. Extension pages can also
    // call tabs.connect, so the content script independently verifies the
    // browser-provided sender URL before accepting a port.
    let port: chrome.runtime.Port;
    try {
      port = connectActorPort(tabId);
    } catch {
      return null;
    }
    const rawResult = await new Promise<unknown>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => finish(null), ACTOR_RESPONSE_TIMEOUT_MS);
      const finish = (value: unknown) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        try {
          port.disconnect();
        } catch {
          // already disconnected
        }
        resolve(value);
      };
      const onMessage = (raw: unknown) => {
        const parsed = actorPortResponseSchema.safeParse(raw);
        if (parsed.success && parsed.data.requestId === authorizedRequest.requestId) finish(parsed.data.result);
      };
      const onDisconnect = () => finish(null);
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      try {
        port.postMessage(authorizedRequest);
      } catch {
        finish(null);
      }
    });
    const parsedResult = actResultSchema.safeParse(rawResult);
    return parsedResult.success ? parsedResult.data : null;
  } catch {
    return null;
  }
}
