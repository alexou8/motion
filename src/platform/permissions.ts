/**
 * Optional host permissions.
 *
 * `chrome.permissions.request()` needs a live user gesture, and the gesture is
 * gone after the first `await`. That has two consequences the rest of the code
 * must respect:
 *
 *   1. The request has to be the FIRST thing in the message listener that
 *      handles the click — no database read, no lookup, nothing awaited before.
 *   2. A workflow parked waiting for permission can never acquire it on its
 *      own later. Permission is obtained through this gateway, driven by the
 *      student's click, and the workflow resumes only once the answer is known.
 *
 * See docs/THREAT_MODEL.md T10.
 */

export interface PermissionsCapability {
  has(origin: string): Promise<boolean>;
  /** MUST be called synchronously from a gesture-carrying message. */
  request(origin: string): Promise<boolean>;
  revoke(origin: string): Promise<boolean>;
  granted(): Promise<string[]>;
}

/** Turns a page URL into the narrowest origin pattern that covers it. */
export function originPatternFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return `https://${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export class ChromePermissions implements PermissionsCapability {
  async has(origin: string): Promise<boolean> {
    return chrome.permissions.contains({ origins: [origin] });
  }

  /**
   * Note the absence of `await` before the call: this function must be invoked
   * as the first statement of the gesture-carrying listener, and it must not
   * itself await anything beforehand.
   */
  request(origin: string): Promise<boolean> {
    return chrome.permissions.request({ origins: [origin] });
  }

  async revoke(origin: string): Promise<boolean> {
    return chrome.permissions.remove({ origins: [origin] });
  }

  /** The full list, so the options page can show exactly what Motion can read. */
  async granted(): Promise<string[]> {
    const all = await chrome.permissions.getAll();
    return all.origins ?? [];
  }
}
