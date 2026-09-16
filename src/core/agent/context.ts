import type { UntrustedItem } from '../ai/prompt';
import type { Note } from '../domain';
import type { AgentSession } from '../session';

const DEFAULT_MAX_CHARS = 24_000;

function take(text: string, remaining: number): string {
  return text.length <= remaining ? text : text.slice(0, remaining);
}

/**
 * Selects bounded, provenance-labelled session material for a model step.
 * Page and note text remains untrusted even though Motion stored it locally:
 * both can contain instructions authored by someone other than the student.
 */
export function buildStepContext(
  session: AgentSession,
  notes: readonly Note[],
  options: { maxChars?: number } = {},
): UntrustedItem[] {
  let remaining = options.maxChars ?? DEFAULT_MAX_CHARS;
  const context: UntrustedItem[] = [];

  for (const source of session.context.sources) {
    if (source.excluded || source.excerpt.trim() === '' || remaining <= 0) continue;
    const text = take(source.excerpt, remaining);
    context.push({
      label: `source: ${source.title || source.url} (${source.provenance || source.url})`,
      text,
    });
    remaining -= text.length;
  }

  for (const note of notes) {
    if (remaining <= 0) break;
    if (note.courseId !== session.courseId) continue;
    if (session.taskId && note.taskId && note.taskId !== session.taskId) continue;
    const text = note.blocks.map((block) => block.text).filter(Boolean).join('\n');
    if (text.trim() === '') continue;
    const bounded = take(text, remaining);
    context.push({ label: `note: ${note.title}`, text: bounded });
    remaining -= bounded.length;
  }

  return context;
}
