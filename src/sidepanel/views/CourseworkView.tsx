import { useState } from 'react';
import type { CourseTask, TaskKind } from '../../core/domain';
import type { PanelState } from '../../core/view/state';
import {
  filterCoursework,
  isActiveTask,
  isUndatedMaterial,
  type CourseworkFilters,
} from '../../core/view/coursework';
import { taskNeedsReview } from '../../core/view/deadlines';
import { Button, SourceLink, Track, TrackItem, type MarkerState } from '../../ui/components';
import type { MotionCommand } from '../bridge';

const KINDS: { value: TaskKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All items' },
  { value: 'assignment', label: 'Assignments' },
  { value: 'quiz', label: 'Quizzes' },
  { value: 'content', label: 'Materials' },
  { value: 'discussion', label: 'Discussions' },
  { value: 'other', label: 'Other' },
];
const KIND_LABELS: Record<TaskKind, string> = {
  assignment: 'Assignment',
  quiz: 'Quiz',
  content: 'Material',
  discussion: 'Discussion',
  other: 'Coursework',
};
const STATUS_LABELS: Record<CourseTask['status'], string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  submitted: 'Submitted',
  graded: 'Graded',
  archived: 'Archived',
};
const INITIAL_FILTERS: CourseworkFilters = {
  query: '',
  courseId: 'all',
  kind: 'all',
  status: 'active',
};
const PAGE_SIZE = 40;

function taskState(task: CourseTask): MarkerState {
  if (!isActiveTask(task)) return 'done';
  if (taskNeedsReview(task)) return 'blocked';
  return task.status === 'in-progress' ? 'active' : 'pending';
}

function DueLabel({ task }: { task: CourseTask }) {
  if (isUndatedMaterial(task)) return <span>No deadline</span>;
  if (!task.due.iso) return <span className="text-attention">Date needs review</span>;
  const label = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(task.due.iso));
  return (
    <span>
      Due <time dateTime={task.due.iso}>{label}</time>
      {taskNeedsReview(task) ? ' · Date needs review' : ''}
    </span>
  );
}

export function CourseworkView({
  state,
  send,
}: {
  state: PanelState;
  send: (command: MotionCommand) => void | Promise<boolean>;
}) {
  const [filters, setFilters] = useState<CourseworkFilters>(INITIAL_FILTERS);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const courses = state.course
    ? [...state.courses.filter((course) => course.id !== state.course!.id), state.course]
    : state.courses;
  const courseNames = new Map(courses.map((course) => [course.id, course.code ?? course.name]));
  const tasks = state.tasks.filter((task) => !task.archived && task.status !== 'archived');
  const active = tasks.filter(isActiveTask);
  const results = filterCoursework(tasks, courses, filters);
  const filtered =
    filters.query !== '' ||
    filters.courseId !== 'all' ||
    filters.kind !== 'all' ||
    filters.status !== 'active';
  const update = (next: Partial<CourseworkFilters>) => {
    setFilters((current) => ({ ...current, ...next }));
    setLimit(PAGE_SIZE);
  };
  const reset = () => {
    setFilters(INITIAL_FILTERS);
    setLimit(PAGE_SIZE);
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <h1 className="font-serif text-xl font-semibold">Your coursework</h1>
        <p className="text-sm text-ink-muted">Assignments, quizzes and materials, together.</p>
      </div>
      <dl className="motion-coursework-summary">
        <div>
          <dt>Active</dt>
          <dd>{active.length}</dd>
        </div>
        <div>
          <dt>Date needs review</dt>
          <dd>{active.filter(taskNeedsReview).length}</dd>
        </div>
        <div>
          <dt>Materials</dt>
          <dd>{tasks.filter((task) => task.kind === 'content').length}</dd>
        </div>
      </dl>
      <p className="text-xs text-ink-muted">
        {state.connection === 'supported'
          ? 'Saved from pages Motion has read. Open a content module and read it to track its lectures and slides.'
          : 'Showing saved coursework. Open a supported course page to read new items or refresh deadlines.'}
      </p>
      {tasks.length === 0 ? (
        <div className="grid gap-3 border-t border-rule pt-4">
          <h2 className="text-md font-medium">Start with a course page</h2>
          <p className="text-sm text-ink-muted">
            Read an assignment, quiz list or content module. Its items will stay here when you
            switch tabs.
          </p>
          {state.connection === 'supported' ? (
            <Button
              type="button"
              variant="primary"
              disabled={state.busy}
              onClick={() => send({ type: 'read-page', url: state.page.url })}
            >
              {state.busy ? 'Reading page…' : 'Read this page'}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <label htmlFor="coursework-search" className="text-sm font-medium">
                Search coursework
              </label>
              <input
                id="coursework-search"
                type="search"
                value={filters.query}
                onChange={(event) => update({ query: event.target.value })}
                placeholder="Title or course name"
                className="motion-coursework-input"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1 min-w-0">
                <label htmlFor="coursework-course" className="text-xs font-medium">
                  Course
                </label>
                <select
                  id="coursework-course"
                  value={filters.courseId}
                  onChange={(event) => update({ courseId: event.target.value })}
                  className="motion-coursework-input"
                >
                  <option value="all">All courses</option>
                  {[...new Set(tasks.map((task) => task.courseId))].map((id) => (
                    <option value={id} key={id}>
                      {courseNames.get(id) ?? 'Unknown course'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1 min-w-0">
                <label htmlFor="coursework-status" className="text-xs font-medium">
                  Status
                </label>
                <select
                  id="coursework-status"
                  value={filters.status}
                  onChange={(event) =>
                    update({ status: event.target.value as CourseworkFilters['status'] })
                  }
                  className="motion-coursework-input"
                >
                  <option value="active">Active</option>
                  <option value="completed">Submitted / graded</option>
                  <option value="all">All statuses</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Coursework type">
              {KINDS.map((kind) => (
                <button
                  key={kind.value}
                  type="button"
                  aria-pressed={filters.kind === kind.value}
                  onClick={() => update({ kind: kind.value })}
                  className="motion-coursework-filter"
                >
                  {kind.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3">
            <h2 className="text-sm font-medium">Saved items</h2>
            <p role="status" aria-atomic="true" className="text-xs text-ink-muted">
              {results.length} {results.length === 1 ? 'item' : 'items'}
              {results.length > limit ? ` · Showing ${limit}` : ''}
            </p>
            {filtered ? (
              <Button type="button" variant="quiet" onClick={reset}>
                Reset filters
              </Button>
            ) : null}
          </div>
          {results.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No coursework matches these filters. Try another course or reset the filters.
            </p>
          ) : (
            <Track label="Coursework">
              {results.slice(0, limit).map((task) => (
                <TrackItem
                  key={task.id}
                  state={taskState(task)}
                  markerLabel={STATUS_LABELS[task.status]}
                  title={task.title}
                >
                  <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                    <span>{courseNames.get(task.courseId) ?? 'Unknown course'}</span>
                    <span>{KIND_LABELS[task.kind]}</span>
                    <span>{STATUS_LABELS[task.status]}</span>
                  </p>
                  <p className="mt-1 text-sm text-ink-muted">
                    <DueLabel task={task} />
                  </p>
                  {task.dueConflict ? (
                    <p className="mt-1 text-xs text-attention">
                      The LMS date differs from your correction. Check the source before planning.
                    </p>
                  ) : null}
                  {taskNeedsReview(task) && task.due.raw ? (
                    <p className="mt-1 text-xs text-attention break-words">
                      Source text: {task.due.raw}
                    </p>
                  ) : null}
                  <SourceLink
                    className="mt-2"
                    href={task.provenance.sourceUrl}
                    pageTitle={task.provenance.pageTitle}
                  />
                </TrackItem>
              ))}
            </Track>
          )}
          {results.length > limit ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
            >
              Show more coursework
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
