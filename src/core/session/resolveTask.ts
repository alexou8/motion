import type { Confidence, Course, CourseTask } from '../domain';

export interface TaskMatch {
  task: CourseTask;
  score: number;
}

export interface TaskResolution {
  /** Best match, or null when nothing scored above the noise floor. */
  task: CourseTask | null;
  confidence: Confidence | 'none';
  /**
   * Other tasks that scored close to the winner, so the caller can ask the
   * student to disambiguate instead of guessing (e.g. two "Assignment 2"s in
   * different courses).
   */
  ambiguous: CourseTask[];
}

const KIND_WORDS = [
  'assignment',
  'lab',
  'quiz',
  'discussion',
  'project',
  'week',
  'module',
  'exercise',
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCourseCode(goal: string): string | null {
  const match = goal.match(/\b[a-zA-Z]{2,5}\s?-?\s?\d{2,4}[a-zA-Z]?\b/);
  if (!match) return null;
  return match[0].replace(/\s|-/g, '').toLowerCase();
}

/** e.g. "assignment 2" -> {kind: 'assignment', number: '2'} */
function extractKindAndNumber(normalizedGoal: string): { kind: string; number: string } | null {
  for (const kind of KIND_WORDS) {
    const match = normalizedGoal.match(new RegExp(`\\b${kind}s?\\s*#?\\s*(\\d+)\\b`));
    if (match) return { kind, number: match[1]! };
  }
  return null;
}

function tokenOverlapScore(goalTokens: Set<string>, title: string): number {
  const titleTokens = new Set(normalize(title).split(' ').filter(Boolean));
  let overlap = 0;
  for (const token of goalTokens) if (titleTokens.has(token)) overlap += 1;
  return overlap;
}

/**
 * Deterministic fuzzy match from a free-text goal ("Assignment 2", "CP363
 * assignment 2", "lab 3") to a task, with no model call. Matches on: a course
 * code if present, a "<kind> <number>" pair if present, and token overlap as
 * a fallback/tiebreak.
 */
export function resolveTaskForGoal(
  goal: string,
  tasks: CourseTask[],
  courses: Course[],
): TaskResolution {
  const normalizedGoal = normalize(goal);
  if (!normalizedGoal) return { task: null, confidence: 'none', ambiguous: [] };

  const courseCode = extractCourseCode(goal);
  const matchedCourse = courseCode
    ? courses.find((c) => c.code && c.code.replace(/[\s-]/g, '').toLowerCase() === courseCode)
    : undefined;

  const pool = matchedCourse ? tasks.filter((t) => t.courseId === matchedCourse.id) : tasks;
  const kindAndNumber = extractKindAndNumber(normalizedGoal);
  const goalTokens = new Set(normalizedGoal.split(' ').filter(Boolean));

  const scored: TaskMatch[] = pool.map((task) => {
    let score = 0;
    const normalizedTitle = normalize(task.title);
    if (kindAndNumber) {
      const titleHasNumber = new RegExp(`\\b${kindAndNumber.number}\\b`).test(normalizedTitle);
      const titleHasKind = normalizedTitle.includes(kindAndNumber.kind);
      if (titleHasNumber && titleHasKind) score += 10;
      else if (titleHasNumber) score += 4;
      else if (titleHasKind) score += 1;
    }
    score += tokenOverlapScore(goalTokens, task.title);
    if (matchedCourse) score += 1; // course already narrowed the pool
    return { task, score };
  });

  const positive = scored.filter((m) => m.score > 0).sort((a, b) => b.score - a.score);
  if (positive.length === 0) return { task: null, confidence: 'none', ambiguous: [] };

  const top = positive[0]!;
  const rivals = positive.filter((m) => m !== top && m.score >= top.score - 1);

  if (rivals.length > 0) {
    return {
      task: null,
      confidence: 'low',
      ambiguous: [top, ...rivals].map((m) => m.task),
    };
  }

  const confidence: Confidence =
    matchedCourse && kindAndNumber && top.score >= 10 ? 'high' : top.score >= 4 ? 'medium' : 'low';
  return { task: top.task, confidence, ambiguous: [] };
}
