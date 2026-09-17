/**
 * Secret redaction (ARCH D3 / VISION §16).
 *
 * Applied to every error message and log line that touches provider HTTP —
 * both a pattern-based pass (catches keys we didn't know about, e.g. echoed
 * back by a provider's error body) and a known-secrets pass (catches a key
 * even if its shape doesn't match a known provider pattern).
 */

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /x-api-key["':\s]+[A-Za-z0-9._-]{10,}/gi,
];

/**
 * Replaces any known secret value, and anything matching a provider key
 * shape, with `[redacted]`. Safe to call on arbitrary text — never throws.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}
