/** Bounded length so a runaway task title cannot blow out list/tab UI. */
export const SESSION_TITLE_MAX_LENGTH = 60;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Builds a session title such as "CP363 · Assignment 2" (VISION §4).
 *
 * When there is no course code, falls back to the bare goal/task title so a
 * session started before a course is resolved still gets a readable title.
 */
export function sessionTitle(
  courseCode: string | null | undefined,
  taskTitleOrGoal: string,
  maxLength: number = SESSION_TITLE_MAX_LENGTH,
): string {
  const goal = taskTitleOrGoal.trim();
  const code = courseCode?.trim();
  if (!code) return truncate(goal, maxLength);

  const prefix = `${code} · `;
  if (prefix.length >= maxLength) return truncate(prefix.trimEnd(), maxLength);
  return prefix + truncate(goal, maxLength - prefix.length);
}
