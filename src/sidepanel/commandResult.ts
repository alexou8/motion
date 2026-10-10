import { z } from 'zod';
import type { UiCommandResult } from './bridge';

const workerResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({
    ok: z.literal(false),
    code: z.string().optional(),
    error: z.string().optional(),
    recoverable: z.boolean().optional(),
  }),
]);

export function toUiCommandResult<T = undefined>(
  raw: unknown,
  parser?: (value: unknown) => T | null,
): UiCommandResult<T> {
  const envelope = workerResponseSchema.safeParse(raw);
  if (!envelope.success)
    return {
      ok: false,
      code: 'transport-malformed-response',
      message: 'Motion received an invalid response from its background worker. Try again.',
    };
  if (!envelope.data.ok) {
    // An older worker can reject a newly added command after only the panel
    // files have refreshed. Its Zod command list cannot help a student recover.
    if (/^Malformed message: Invalid discriminator value\b/.test(envelope.data.error ?? ''))
      return {
        ok: false,
        code: 'extension-refresh-required',
        message:
          "Motion could not understand this request. Reload Motion in your browser's Extensions page, then refresh the course page and try again.",
        recoverable: true,
      };
    return {
      ok: false,
      code: envelope.data.code ?? 'command-refused',
      message: envelope.data.error ?? 'Motion could not complete that action. Try again.',
      ...(envelope.data.recoverable === undefined
        ? {}
        : { recoverable: envelope.data.recoverable }),
    };
  }
  // A transport success only says the worker answered. Commands also carry
  // explicit domain no-ops (closed workspace tab, terminal session, declined
  // extraction). Do not clear UI feedback or report success for those results.
  const result = envelope.data.result;
  if (typeof result === 'object' && result !== null) {
    const domain = result as {
      updated?: unknown;
      requested?: unknown;
      session?: unknown;
      refusal?: unknown;
      reason?: unknown;
      message?: unknown;
    };
    const refusal =
      typeof domain.refusal === 'object' && domain.refusal !== null
        ? (domain.refusal as { message?: unknown }).message
        : undefined;
    // A tab that predates the install has no content script; the worker
    // names that with a reason code and a readable message.
    if (domain.requested === false && domain.reason === 'content-script-missing')
      return {
        ok: false,
        code: 'content-script-missing',
        message:
          typeof domain.message === 'string' && domain.message
            ? domain.message
            : 'Reload this tab so Motion can read it.',
        recoverable: true,
      };
    const message =
      typeof refusal === 'string'
        ? refusal
        : typeof domain.reason === 'string'
          ? domain.reason
          : 'Motion could not complete that action. Try again.';
    if (
      domain.updated === false ||
      domain.requested === false ||
      domain.session === null ||
      typeof refusal === 'string'
    )
      return { ok: false, code: 'command-refused', message };
  }
  if (parser) {
    const parsed = parser(envelope.data.result);
    return parsed === null
      ? {
          ok: false,
          code: 'transport-invalid-result',
          message: 'Motion received an invalid result. Refresh and try again.',
        }
      : { ok: true, data: parsed };
  }
  return { ok: true };
}
