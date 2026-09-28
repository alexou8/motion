import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { z } from 'zod';
import type { CourseTask } from '../../core/domain';
import type { PanelState, SessionSummary } from '../../core/view/state';
import { isStale } from '../../core/view/state';
import { groupByWeek, type DeadlineWeekGroup } from '../../core/view';
import {
  Button,
  EmptyState,
  SourceLink,
  Track,
  TrackItem,
  type MarkerState,
} from '../../ui/components';
import type { MotionCommand } from '../bridge';
import {
  IdleView,
  PermissionNeededView,
  RestrictedView,
  SignedOutView,
  UnsupportedView,
} from './ConnectionViews';

/**
 * Home: the session command centre when no session is open (VISION §6, §18).
 *
 * One coherent screen, not a set of mini-apps — a composer to start or
 * continue work, the sessions already in flight, and the deadlines that make
 * "what's next" answerable without opening any of them.
 */

interface HomeProps {
  state: PanelState;
  send: (command: MotionCommand) => void | Promise<boolean>;
  onOpenSession: (sessionId: string) => void;
  now: Date;
}

function relativeDue(iso: string | null, now: Date): string {
  if (!iso) return 'Date not parsed';
  const due = new Date(iso);
  const difference = due.getTime() - now.getTime();
  const days = Math.round(difference / 86_400_000);
  if (Math.abs(difference) < 86_400_000 && now.toDateString() === due.toDateString())
    return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return 'Due yesterday';
  if (days > 1) return `Due in ${days} days`;
  if (days < -1) return `${Math.abs(days)} days overdue`;
  return `Due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

const MOVED_CUE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const deadlineViewSchema = z.enum(['list', 'week']);
const DEADLINE_VIEW_KEY = 'motion.deadlines.view';

function deadlineViewPreference(): 'list' | 'week' {
  return 'list';
}

function useDeadlineView(): ['list' | 'week', (view: 'list' | 'week') => void] {
  const [view, setView] = useState(deadlineViewPreference);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    let active = true;
    void chrome.storage.local
      .get(DEADLINE_VIEW_KEY)
      .then((stored) => {
        const parsed = deadlineViewSchema.safeParse(stored[DEADLINE_VIEW_KEY]);
        if (active && parsed.success) setView(parsed.data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const select = (next: 'list' | 'week') => {
    setView(next);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      void chrome.storage.local.set({ [DEADLINE_VIEW_KEY]: next }).catch(() => undefined);
    }
  };
  return [view, select];
}

function dueDateLabel(iso: string | null, timeZone: string | undefined): string {
  if (!iso) return 'an unparsed date';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

function isRecentlyMoved(task: CourseTask, now: Date): boolean {
  if (!task.dueChangedAt) return false;
  const changedAt = new Date(task.dueChangedAt).getTime();
  return (
    Number.isFinite(changedAt) &&
    now.getTime() >= changedAt &&
    now.getTime() - changedAt <= MOVED_CUE_DURATION_MS
  );
}

function taskMarker(
  task: CourseTask,
  bucket: 'today' | 'upcoming' | 'overdue' | 'needsReview',
): MarkerState {
  if (bucket === 'overdue') return 'blocked';
  if (bucket === 'needsReview') return 'pending';
  return task.status === 'in-progress' ? 'active' : 'pending';
}

function needsReviewReason(task: CourseTask): string {
  if (task.due.iso === null) return "Motion could not parse a date from this page's text.";
  if (task.due.timeAssumed) return 'A time was assumed; the page only stated a date.';
  if (task.due.zoneEvidence === 'assumed-local')
    return 'The page did not state a time zone, so Motion assumed yours.';
  return 'Motion is not confident in this date.';
}

function DeadlineItem({
  task,
  bucket,
  now,
}: {
  task: CourseTask;
  bucket: 'today' | 'upcoming' | 'overdue' | 'needsReview';
  now: Date;
}) {
  const movedFrom = task.dueHistory.at(-1);
  const dueConflict = task.dueConflict;
  return (
    <TrackItem state={taskMarker(task, bucket)} title={task.title}>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-ink-muted">
        <span>{relativeDue(task.due.iso, now)}</span>
        {bucket === 'needsReview' ? (
          <span className="font-medium text-attention">Needs review</span>
        ) : null}
        {movedFrom && isRecentlyMoved(task, now) ? (
          <span className="rounded-full border border-danger px-2 py-0.5 text-xs font-medium text-danger">
            Moved
          </span>
        ) : null}
      </div>
      {movedFrom && isRecentlyMoved(task, now) ? (
        <p className="mt-1 text-xs text-danger">
          Moved from{' '}
          <del aria-label={`Previously due ${dueDateLabel(movedFrom.iso, task.due.timeZone)}`}>
            {dueDateLabel(movedFrom.iso, task.due.timeZone)}
          </del>
        </p>
      ) : null}
      {dueConflict ? (
        <p className="mt-1 text-xs font-medium text-attention">
          Learn changed this date to {dueDateLabel(dueConflict.observed.iso, task.due.timeZone)};
          you set {dueDateLabel(task.due.iso, task.due.timeZone)}. Needs review.
        </p>
      ) : null}
      {bucket === 'needsReview' ? (
        <>
          <p className="mt-1 text-xs text-attention text-pretty">{needsReviewReason(task)}</p>
          {task.due.raw ? (
            <p className="mt-1 text-xs text-attention text-pretty">Source text: {task.due.raw}</p>
          ) : null}
        </>
      ) : null}
      <SourceLink
        className="mt-2"
        href={task.provenance.sourceUrl}
        pageTitle={task.provenance.pageTitle}
      />
    </TrackItem>
  );
}

const BUCKET_LABELS = {
  today: 'Today',
  upcoming: 'Upcoming',
  overdue: 'Overdue',
  needsReview: 'Needs review',
} as const;

function DeadlineSummary({
  state,
  tasks,
  now,
}: {
  state: PanelState;
  tasks: CourseTask[];
  now: Date;
}) {
  if (tasks.length === 0) return null;
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.courseId, (counts.get(task.courseId) ?? 0) + 1);
  const knownCourses = state.course ? [...state.courses, state.course] : state.courses;
  const names = new Map(knownCourses.map((course) => [course.id, course.code ?? course.name]));
  const observedAt = tasks
    .map((task) => task.due.lastObservedAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
  const updated = observedAt ? relativeUpdatedAt(observedAt, now) : null;
  return (
    <div className="grid gap-1 text-sm text-ink-muted">
      <p>
        {tasks.length} {tasks.length === 1 ? 'deadline' : 'deadlines'} across {counts.size}{' '}
        {counts.size === 1 ? 'course' : 'courses'}
      </p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Deadline count by course">
        {[...counts.entries()].map(([courseId, count]) => (
          <li key={courseId}>
            {names.get(courseId) ?? 'Unknown course'} · {count}
          </li>
        ))}
      </ul>
      {updated ? <p className="text-xs">Updated {updated}</p> : null}
    </div>
  );
}

function DiscoveryControls({
  state,
  send,
  now,
}: {
  state: PanelState;
  send: (command: MotionCommand) => void;
  now: Date;
}) {
  const discovery = state.discovery;
  if (state.connection !== 'supported' || !discovery.host) return null;
  if (discovery.optedIn === null)
    return (
      <section
        className="grid gap-2 rounded border border-edge bg-surface p-3"
        aria-labelledby="scan-prompt"
      >
        <h3 className="text-sm font-medium" id="scan-prompt">
          Find deadlines across your courses?
        </h3>
        <p className="text-xs text-ink-muted">
          Motion can read deadline data from Learn while you are on {new URL(discovery.host).host}.
          It stays in this browser.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="primary"
            onClick={() =>
              send({ type: 'set-deadline-discovery-opt-in', host: discovery.host!, enabled: true })
            }
          >
            Enable scanning
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              send({ type: 'set-deadline-discovery-opt-in', host: discovery.host!, enabled: false })
            }
          >
            Not now
          </Button>
        </div>
      </section>
    );
  return (
    <section className="grid gap-2" aria-label="Course deadline scanning">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={discovery.optedIn}
          onChange={(event) =>
            send({
              type: 'set-deadline-discovery-opt-in',
              host: discovery.host!,
              enabled: event.target.checked,
            })
          }
        />{' '}
        <span>Scan my courses for deadlines while I’m on {new URL(discovery.host).host}</span>
      </label>
      {discovery.optedIn ? (
        <Button
          type="button"
          variant="secondary"
          disabled={discovery.busy}
          onClick={() => send({ type: 'scan-all-courses' })}
        >
          {discovery.busy ? 'Scanning courses…' : 'Scan all courses'}
        </Button>
      ) : null}
      <p className="text-xs text-ink-muted" aria-live="polite">
        {discovery.blocker ??
          (discovery.result
            ? `Found ${discovery.result.deadlines} deadlines across ${discovery.result.courses} courses. Updated ${relativeUpdatedAt(discovery.result.updatedAt, now)}.`
            : '')}
      </p>
    </section>
  );
}

function relativeUpdatedAt(value: string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function DeadlineSections({
  state,
  now,
  send,
}: {
  state: PanelState;
  now: Date;
  send: (command: MotionCommand) => void;
}) {
  const [view, setView] = useDeadlineView();
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const buckets = (['today', 'overdue', 'needsReview', 'upcoming'] as const)
    .map((bucket) => ({
      bucket,
      tasks: state.deadlines[bucket].map((id) => byId.get(id)).filter((t): t is CourseTask => !!t),
    }))
    .filter((section) => section.tasks.length > 0);

  const activeTasks = state.tasks.filter(
    (task) => !['submitted', 'graded', 'archived'].includes(task.status) && !task.archived,
  );
  if (buckets.length === 0 && activeTasks.length === 0) return null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const weeks = groupByWeek(activeTasks, now, timeZone);

  return (
    <section className="grid gap-5" aria-labelledby="deadlines-title">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-md font-medium" id="deadlines-title">
          Deadlines
        </h2>
        <div
          className="flex rounded border border-edge p-0.5"
          role="group"
          aria-label="Deadline view"
        >
          <button
            type="button"
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
            className="rounded px-2 py-1 text-xs font-medium aria-pressed:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            List
          </button>
          <button
            type="button"
            aria-pressed={view === 'week'}
            onClick={() => setView('week')}
            className="rounded px-2 py-1 text-xs font-medium aria-pressed:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Week
          </button>
        </div>
      </div>
      <DeadlineSummary state={state} tasks={activeTasks} now={now} />
      <DiscoveryControls state={state} send={send} now={now} />
      {view === 'list'
        ? buckets.map(({ bucket, tasks }) => (
            <div key={bucket} className="grid gap-2">
              <h3 className="text-sm font-medium text-ink-muted">{BUCKET_LABELS[bucket]}</h3>
              <Track label={BUCKET_LABELS[bucket]}>
                {tasks.map((task) => (
                  <DeadlineItem key={task.id} task={task} bucket={bucket} now={now} />
                ))}
              </Track>
            </div>
          ))
        : weeks.map((week) => <WeekSection key={week.key} week={week} now={now} />)}
    </section>
  );
}

function WeekSection({ week, now }: { week: DeadlineWeekGroup; now: Date }) {
  // Week grouping is temporal, not a confidence verdict. In particular, a
  // normal deadline beyond next week belongs to the Later section without
  // acquiring the review warning used by the list's Needs review bucket.
  const bucket =
    week.key === 'thisWeek' ? 'today' : week.key === 'overdue' ? 'overdue' : 'upcoming';
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-medium text-ink-muted">
        {week.label} · {week.count}
      </h3>
      <Track label={week.label}>
        {week.tasks.map((task) => (
          <DeadlineItem key={task.id} task={task} bucket={bucket} now={now} />
        ))}
      </Track>
    </div>
  );
}

function statusLabel(status: SessionSummary['status']): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'working':
      return 'Working';
    case 'waiting':
      return 'Waiting on you';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'archived':
      return 'Archived';
  }
}

function SessionListItem({
  session,
  onOpen,
}: {
  session: SessionSummary;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className="flex w-full min-w-0 flex-col gap-1 rounded border border-rule bg-surface px-3 py-2 text-left hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-ink">{session.title}</span>
          {session.needsYou > 0 ? (
            <span className="shrink-0 rounded-full bg-attention px-2 py-0.5 text-xs font-medium text-on-signal">
              Needs you · {session.needsYou}
            </span>
          ) : null}
        </span>
        <span className="text-xs text-ink-muted">
          {statusLabel(session.status)}
          {session.currentStepTitle ? ` · ${session.currentStepTitle}` : ''}
        </span>
      </button>
    </li>
  );
}

function SessionList({
  sessions,
  onOpen,
}: {
  sessions: SessionSummary[];
  onOpen: (id: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="sessions-title">
      <h2 className="text-md font-medium" id="sessions-title">
        Sessions
      </h2>
      <ul className="grid gap-2">
        {sessions.map((session) => (
          <SessionListItem key={session.id} session={session} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

/** Suggestions derived from the current page and known deadlines. */
function suggestions(state: PanelState): string[] {
  const list: string[] = [];
  if (
    state.connection === 'supported' &&
    state.page.title &&
    ['assignment', 'discussion-topic', 'content-topic'].includes(state.page.pageType ?? '')
  ) {
    list.push(`Work on ${state.page.title}`);
  }
  if (state.deadlines.today.length > 0 || state.deadlines.upcoming.length > 0) {
    list.push("What's due this week?");
  }
  if (state.deadlines.overdue.length > 0 || state.deadlines.needsReview.length > 0) {
    list.push('Have I missed anything?');
  }
  return list.slice(0, 3);
}

function PageContextLine({ state }: { state: PanelState }) {
  if (state.connection !== 'supported') return null;
  return (
    <p className="text-sm text-ink-muted text-pretty">
      {state.course?.name ? `${state.course.name} · ` : ''}
      {state.page.title || 'Current page'}
      {isStale(state.page.observedAt, new Date()) ? ' (stale read)' : ''}
    </p>
  );
}

function HomeComposer({
  onStart,
  disabled,
}: {
  onStart: (goal: string) => void | Promise<boolean>;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const canSend = !disabled && !sending && draft.trim().length > 0;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    if (sending) return;
    const submittedText = draft.trim();
    setSending(true);
    try {
      const started = await onStart(submittedText);
      if (started !== false)
        setDraft((current) => (current.trim() === submittedText ? '' : current));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <form onSubmit={submit} className="grid gap-2" aria-label="Start or continue work">
      <label htmlFor="home-composer" className="text-sm font-medium text-ink">
        What do you want to work on?
      </label>
      <div className="flex min-w-0 items-end gap-2 rounded border border-edge bg-surface p-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
        <textarea
          id="home-composer"
          rows={2}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Work on Assignment 2, what's due this week…"
          className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 text-sm text-ink placeholder:text-ink-muted focus:outline-none disabled:cursor-not-allowed"
        />
        <Button type="submit" variant="primary" disabled={!canSend}>
          {sending ? 'Starting…' : 'Start'}
        </Button>
      </div>
    </form>
  );
}

export function Home({ state, send, onOpenSession, now }: HomeProps) {
  const start = (goal: string) => send({ type: 'session-create', goal, tabId: null });

  if (state.connection === 'restricted') return <RestrictedView state={state} send={send} />;
  if (state.connection === 'idle') return <IdleView state={state} send={send} />;
  if (state.connection === 'unsupported') return <UnsupportedView state={state} send={send} />;
  if (state.connection === 'permission-needed')
    return <PermissionNeededView state={state} send={send} />;
  if (state.connection === 'signed-out') return <SignedOutView state={state} send={send} />;

  const hints = suggestions(state);

  return (
    <div className="grid gap-6">
      <PageContextLine state={state} />
      <HomeComposer onStart={start} disabled={false} />
      <DiscoveryControls state={state} send={send} now={now} />
      {hints.length > 0 ? (
        <div role="group" aria-label="Suggestions" className="flex flex-wrap gap-2">
          {hints.map((hint) => (
            <button
              key={hint}
              type="button"
              onClick={() => start(hint)}
              className="min-h-8 rounded-full border border-edge bg-surface px-3 py-1 text-sm text-ink hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {hint}
            </button>
          ))}
        </div>
      ) : null}
      {state.sessions.length === 0 && state.tasks.length === 0 ? (
        <EmptyState
          title="Motion organizes coursework"
          actionLabel="Read this page"
          onAction={() => send({ type: 'read-page', url: state.page.url })}
        >
          Ask Motion to work on something above, or read this page to see its deadlines here.
        </EmptyState>
      ) : (
        <>
          <SessionList sessions={state.sessions} onOpen={onOpenSession} />
          <DeadlineSections state={state} now={now} send={send} />
        </>
      )}
    </div>
  );
}
