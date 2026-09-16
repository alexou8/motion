import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CourseTask } from '../../core/domain';
import type { PanelState, SessionSummary } from '../../core/view/state';
import { isStale } from '../../core/view/state';
import { Button, EmptyState, SourceLink, Track, TrackItem, type MarkerState } from '../../ui/components';
import type { MotionCommand } from '../bridge';
import { IdleView, PermissionNeededView, RestrictedView, SignedOutView, UnsupportedView } from './ConnectionViews';

/**
 * Home: the session command centre when no session is open (VISION §6, §18).
 *
 * One coherent screen, not a set of mini-apps — a composer to start or
 * continue work, the sessions already in flight, and the deadlines that make
 * "what's next" answerable without opening any of them.
 */

interface HomeProps {
  state: PanelState;
  send: (command: MotionCommand) => void;
  onOpenSession: (sessionId: string) => void;
  now: Date;
}

function relativeDue(iso: string | null, now: Date): string {
  if (!iso) return 'Date not parsed';
  const due = new Date(iso);
  const difference = due.getTime() - now.getTime();
  const days = Math.round(difference / 86_400_000);
  if (Math.abs(difference) < 86_400_000 && now.toDateString() === due.toDateString()) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return 'Due yesterday';
  if (days > 1) return `Due in ${days} days`;
  if (days < -1) return `${Math.abs(days)} days overdue`;
  return `Due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function confidenceNeedsReview(confidence: CourseTask['due']['confidence']): boolean {
  return confidence === 'medium' || confidence === 'low';
}

function taskMarker(task: CourseTask, bucket: 'today' | 'upcoming' | 'overdue' | 'needsReview'): MarkerState {
  if (bucket === 'overdue') return 'blocked';
  if (bucket === 'needsReview') return 'pending';
  return task.status === 'in-progress' ? 'active' : 'pending';
}

function needsReviewReason(task: CourseTask): string {
  if (task.due.iso === null) return "Motion could not parse a date from this page's text.";
  if (task.due.timeAssumed) return 'A time was assumed; the page only stated a date.';
  if (task.due.zoneEvidence === 'assumed-local') return "The page did not state a time zone, so Motion assumed yours.";
  return 'Motion is not confident in this date.';
}

function DeadlineItem({ task, bucket, now }: { task: CourseTask; bucket: 'today' | 'upcoming' | 'overdue' | 'needsReview'; now: Date }) {
  return (
    <TrackItem state={taskMarker(task, bucket)} title={task.title}>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-ink-muted">
        <span>{relativeDue(task.due.iso, now)}</span>
        {confidenceNeedsReview(task.due.confidence) ? <span className="font-medium text-attention">Needs review</span> : null}
      </div>
      {bucket === 'needsReview' ? (
        <>
          <p className="mt-1 text-xs text-attention text-pretty">{needsReviewReason(task)}</p>
          {task.due.raw ? <p className="mt-1 text-xs text-attention text-pretty">Source text: {task.due.raw}</p> : null}
        </>
      ) : null}
      <SourceLink className="mt-2" href={task.provenance.sourceUrl} pageTitle={task.provenance.pageTitle} />
    </TrackItem>
  );
}

const BUCKET_LABELS = { today: 'Today', upcoming: 'Upcoming', overdue: 'Overdue', needsReview: 'Needs review' } as const;

function DeadlineSections({ state, now }: { state: PanelState; now: Date }) {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const buckets = (['today', 'overdue', 'needsReview', 'upcoming'] as const)
    .map((bucket) => ({ bucket, tasks: state.deadlines[bucket].map((id) => byId.get(id)).filter((t): t is CourseTask => !!t) }))
    .filter((section) => section.tasks.length > 0);

  if (buckets.length === 0) return null;

  return (
    <section className="grid gap-5" aria-labelledby="deadlines-title">
      <h2 className="text-md font-medium" id="deadlines-title">Deadlines</h2>
      {buckets.map(({ bucket, tasks }) => (
        <div key={bucket} className="grid gap-2">
          <h3 className="text-sm font-medium text-ink-muted">{BUCKET_LABELS[bucket]}</h3>
          <Track label={BUCKET_LABELS[bucket]}>
            {tasks.map((task) => <DeadlineItem key={task.id} task={task} bucket={bucket} now={now} />)}
          </Track>
        </div>
      ))}
    </section>
  );
}

function statusLabel(status: SessionSummary['status']): string {
  switch (status) {
    case 'active': return 'Active';
    case 'working': return 'Working';
    case 'waiting': return 'Waiting on you';
    case 'paused': return 'Paused';
    case 'completed': return 'Completed';
    case 'archived': return 'Archived';
  }
}

function SessionListItem({ session, onOpen }: { session: SessionSummary; onOpen: (id: string) => void }) {
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

function SessionList({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  if (sessions.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="sessions-title">
      <h2 className="text-md font-medium" id="sessions-title">Sessions</h2>
      <ul className="grid gap-2">
        {sessions.map((session) => <SessionListItem key={session.id} session={session} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}

/** Suggestions derived from the current page and known deadlines. */
function suggestions(state: PanelState): string[] {
  const list: string[] = [];
  if (state.connection === 'supported' && state.page.title && ['assignment', 'discussion-topic', 'content-topic'].includes(state.page.pageType ?? '')) {
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

function HomeComposer({ onStart, disabled }: { onStart: (goal: string) => void; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const canSend = !disabled && draft.trim().length > 0;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onStart(draft.trim());
    setDraft('');
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
          Start
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
  if (state.connection === 'permission-needed') return <PermissionNeededView state={state} send={send} />;
  if (state.connection === 'signed-out') return <SignedOutView state={state} send={send} />;

  const hints = suggestions(state);

  return (
    <div className="grid gap-6">
      <PageContextLine state={state} />
      <HomeComposer onStart={start} disabled={false} />
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
        <EmptyState title="Motion organizes coursework" actionLabel="Read this page" onAction={() => send({ type: 'read-page', url: state.page.url })}>
          Ask Motion to work on something above, or read this page to see its deadlines here.
        </EmptyState>
      ) : (
        <>
          <SessionList sessions={state.sessions} onOpen={onOpenSession} />
          <DeadlineSections state={state} now={now} />
        </>
      )}
    </div>
  );
}
