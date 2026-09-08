import { ALLOWED_SENDERS, maySend, messageSchema, type Message, type SenderRole } from './contracts';

/**
 * The facts about a message's origin that the *browser* asserts, as opposed to
 * anything the message payload claims. Modelled as a plain interface so the
 * authorization rules stay pure and testable without a Chrome runtime.
 */
export interface SenderFacts {
  /** `sender.id` -- the extension that sent it. */
  extensionId?: string | undefined;
  /** Our own runtime id, to compare against. */
  runtimeId: string;
  /** `sender.tab?.id` -- present only for content scripts. */
  tabId?: number | undefined;
  /** `sender.url` / `sender.tab.url` -- the real page, not a claimed one. */
  senderUrl?: string | undefined;
  /** `sender.frameId` -- 0 is the main frame. */
  frameId?: number | undefined;
}

export type AuthorizationResult =
  | { ok: true; message: Message; role: SenderRole; tabId?: number }
  | { ok: false; reason: string };

export interface AuthorizationPolicy {
  /** Whether a content script on this URL may report to the worker. */
  isSupportedHost(url: string): boolean;
  /** e.g. `chrome-extension://<id>` -- used to recognise our own pages. */
  extensionOrigin: string;
}

/**
 * The role comes from browser-asserted facts, never from what the message says
 * about itself.
 *
 * The extension origin is checked first, because "carries a tab" does not mean
 * "is a content script": an options page, or the panel opened in a tab, is an
 * extension page *with* a tab id. Chrome sets `sender.url` for a content script
 * to the page it runs in, and a web page can never be served from
 * `chrome-extension://<our id>`, so this ordering recognises our own pages
 * without giving a hostile page a way to claim the role.
 */
function inferRole(facts: SenderFacts, extensionOrigin: string): SenderRole | null {
  if (facts.senderUrl && facts.senderUrl.startsWith(`${extensionOrigin}/`)) return 'extension-ui';
  if (facts.tabId !== undefined) return 'content-script';
  return null;
}

/**
 * Decide whether to act on an inbound message.
 *
 * Order matters: identity, then role, then shape, then the payload's own
 * claims. Passing schema validation proves only that a message is well-formed;
 * this is the step that decides whether it is *allowed*.
 */
export function authorizeMessage(
  raw: unknown,
  facts: SenderFacts,
  policy: AuthorizationPolicy,
): AuthorizationResult {
  // 1. It must come from this extension. Anything else is not ours to trust.
  if (!facts.extensionId || facts.extensionId !== facts.runtimeId) {
    return { ok: false, reason: 'Message did not originate from this extension.' };
  }

  // 2. Establish the role from browser-asserted facts, never from the payload.
  const role = inferRole(facts, policy.extensionOrigin);
  if (!role) return { ok: false, reason: 'Could not establish the sender role.' };

  // 3. Shape.
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `Malformed message: ${parsed.error.issues[0]?.message ?? ''}` };
  }
  const message = parsed.data;

  // 4. May this role send this message at all?
  if (!maySend(message.type, role)) {
    return {
      ok: false,
      reason: `A ${role} may not send "${message.type}" (allowed: ${ALLOWED_SENDERS[
        message.type
      ].join(', ')}).`,
    };
  }

  // 5. Content scripts get extra scrutiny: they live in a hostile document.
  if (role === 'content-script') {
    if (facts.frameId !== undefined && facts.frameId !== 0) {
      return { ok: false, reason: 'Only the main frame may report page observations.' };
    }
    if (!facts.senderUrl) {
      return { ok: false, reason: 'Sender URL missing; cannot verify the page.' };
    }

    let senderOrigin: string;
    try {
      const senderUrl = new URL(facts.senderUrl);
      if (senderUrl.protocol !== 'https:') {
        return { ok: false, reason: 'Page observations are only accepted over HTTPS.' };
      }
      senderOrigin = senderUrl.origin;
    } catch {
      return { ok: false, reason: 'Sender URL is not a valid URL.' };
    }

    if (!policy.isSupportedHost(facts.senderUrl)) {
      return { ok: false, reason: 'Page is not on a host Motion supports.' };
    }

    // 6. A payload URL must match the page the browser says sent it, so a
    //    compromised page cannot attribute its content to another course.
    if ('url' in message) {
      let claimedOrigin: string;
      try {
        claimedOrigin = new URL(message.url).origin;
      } catch {
        return { ok: false, reason: 'Claimed URL is not a valid URL.' };
      }
      if (claimedOrigin !== senderOrigin) {
        return { ok: false, reason: 'Claimed URL does not match the sending page.' };
      }
    }
  }

  return facts.tabId === undefined
    ? { ok: true, message, role }
    : { ok: true, message, role, tabId: facts.tabId };
}
