import { redactSecrets } from '@/core/ai/redact';
import { SessionSecretStore } from '@/platform/ai/secrets';

const PROVIDER_IDS = ['openai', 'anthropic', 'chrome-local'];

/** Reads current session-only secrets without exposing their values. */
export async function knownSecrets(): Promise<string[]> {
  const store = new SessionSecretStore();
  const values = await Promise.all(PROVIDER_IDS.map((id) => store.get(id)));
  return values.filter((value): value is string => value !== null && value.length > 0);
}

/** Logs a redacted diagnostic without serializing arbitrary payloads. */
export async function warn(context: string, error?: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  const message = detail === undefined ? context : `${context} — ${detail}`;
  let secrets: string[] = [];
  try {
    secrets = await knownSecrets();
  } catch {
    // Pattern redaction still protects common key formats if storage is unavailable.
  }
  console.warn(redactSecrets(message, secrets));
}
