import type { Course, CourseTask, TaskKind } from '../domain';

export function isActiveTask(task: CourseTask): boolean {
  return !task.archived && !['submitted', 'graded', 'archived'].includes(task.status);
}

/** A lecture without date evidence is a resource, not a failed date parse. */
export function isUndatedMaterial(task: CourseTask): boolean {
  return (
    task.kind === 'content' && task.due.iso === null && !task.due.raw.trim() && !task.dueConflict
  );
}

export interface CourseworkFilters {
  query: string;
  courseId: string;
  kind: TaskKind | 'all';
  status: 'active' | 'completed' | 'all';
}

export function filterCoursework(
  tasks: CourseTask[],
  courses: Course[],
  filters: CourseworkFilters,
): CourseTask[] {
  const courseNames = new Map(
    courses.map((course) => [course.id, `${course.name} ${course.code ?? ''}`]),
  );
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return tasks
    .filter((task) => {
      if (task.archived || task.status === 'archived') return false;
      if (filters.courseId !== 'all' && task.courseId !== filters.courseId) return false;
      if (filters.kind !== 'all' && task.kind !== filters.kind) return false;
      if (filters.status === 'active' && !isActiveTask(task)) return false;
      if (filters.status === 'completed' && isActiveTask(task)) return false;
      const haystack = `${task.title} ${courseNames.get(task.courseId) ?? ''}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => {
      if (a.due.iso && !b.due.iso) return -1;
      if (!a.due.iso && b.due.iso) return 1;
      return (
        (a.due.iso ?? '').localeCompare(b.due.iso ?? '') ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id)
      );
    });
}
