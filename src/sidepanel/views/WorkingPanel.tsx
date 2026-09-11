import { useState } from 'react';
import type { ApprovalRequest } from '../../core/policy';
import type { PanelState } from '../../core/view/state';
import { isStale } from '../../core/view/state';
import type { CourseTask } from '../../core/domain';
import type { Workflow, WorkflowStep } from '../../core/workflows';
import {
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  SkeletonRow,
  SourceLink,
  Track,
  TrackItem,
  type MarkerState,
} from '../../ui/components';
import type { MotionCommand } from '../bridge';

interface WorkingPanelProps {
  state: PanelState;
  send: (command: MotionCommand) => void;
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

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function taskMarker(status: CourseTask['status']): MarkerState {
  if (status === 'graded' || status === 'submitted') return 'done';
  if (status === 'in-progress') return 'active';
  if (status === 'archived') return 'skipped';
  return 'pending';
}

function confidenceNeedsReview(confidence: CourseTask['due']['confidence']): boolean {
  return confidence === 'medium' || confidence === 'low';
}

function safePayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return 'The payload could not be displayed because it is not serializable.';
  }
}

function ApprovalCard({ approval, send }: { approval: ApprovalRequest; send: (command: MotionCommand) => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const highRisk = approval.risk === 'high';
  const decide = (approved: boolean) => {
    send({ type: 'decide-approval', approvalId: approval.id, approved });
    setDialogOpen(false);
  };

  return (
    <article className="grid gap-3 border-b border-rule pb-4 last:border-b-0 last:pb-0" aria-labelledby={`approval-${approval.id}`}>
      <div>
        <h3 className="text-md font-medium text-balance" id={`approval-${approval.id}`}>
          {approval.summary}
        </h3>
        <p className="mt-1 text-xs text-ink-muted">{highRisk ? 'High-risk approval' : `${approval.risk} risk approval`}</p>
      </div>
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="font-medium text-ink">Target</dt>
          <dd className="text-ink-muted text-pretty">{approval.target}</dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Effect</dt>
          <dd className="text-ink-muted text-pretty">{approval.effect}</dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Reversible</dt>
          <dd className="text-ink-muted">{approval.reversible ? 'Yes' : 'No'}</dd>
        </div>
      </dl>
      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">Exact payload</p>
        <pre className="max-h-40 overflow-auto rounded-sm bg-sunken p-2 text-xs text-ink">{safePayload(approval.payload)}</pre>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="quiet" onClick={() => decide(false)}>
          Deny
        </Button>
        {highRisk ? (
          <Button variant="danger" onClick={() => setDialogOpen(true)}>
            Approve
          </Button>
        ) : (
          <Button variant="primary" onClick={() => decide(true)}>
            Approve
          </Button>
        )}
      </div>
      {highRisk ? (
        <ConfirmDialog
          open={dialogOpen}
          title="Approve this action?"
          confirmLabel="Approve"
          expiry={approval.expiresAt}
          onOpenChange={setDialogOpen}
          onConfirm={() => decide(true)}
        >
          <p>{approval.summary}</p>
          <p className="mt-2">This affects {approval.target}. It is {approval.reversible ? 'reversible' : 'not reversible'}.</p>
        </ConfirmDialog>
      ) : null}
    </article>
  );
}

function ApprovalSection({ approvals, send }: { approvals: ApprovalRequest[]; send: (command: MotionCommand) => void }) {
  const waiting = approvals.filter((approval) => approval.status === 'pending');
  if (waiting.length === 0) return null;

  return (
    <section className="grid gap-4 border-2 border-attention bg-surface p-4" aria-labelledby="approvals-title">
      <div>
        <p className="mb-1 text-xs font-medium text-attention">Motion needs you</p>
        <h2 className="text-lg font-medium text-balance" id="approvals-title">
          Approvals waiting
        </h2>
      </div>
      <div className="grid gap-4">
        {waiting.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} send={send} />
        ))}
      </div>
    </section>
  );
}

function ContextSection({ state, now }: { state: PanelState; now: Date }) {
  const stale = isStale(state.page.observedAt, now);
  return (
    <section className="grid gap-2" aria-labelledby="context-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-md font-medium" id="context-title">
          Where you are
        </h2>
        {stale ? <span className="rounded-sm border border-attention px-2 py-1 text-xs text-attention">Stale read</span> : null}
      </div>
      <div className="rounded border border-rule bg-surface p-3">
        <p className="text-md font-medium text-balance">{state.course?.name || 'Course not identified'}</p>
        {state.course?.code ? <p className="text-xs text-ink-muted">{state.course.code}</p> : null}
        <p className="mt-2 text-sm text-ink-muted text-pretty">{state.page.title || 'Current page'}</p>
        {state.page.pageType ? <p className="text-xs text-ink-muted">{state.page.pageType.replaceAll('-', ' ')}</p> : null}
      </div>
    </section>
  );
}

function DeadlineItem({ task, now }: { task: CourseTask; now: Date }) {
  const review = confidenceNeedsReview(task.due.confidence);
  return (
    <TrackItem state={taskMarker(task.status)} title={task.title}>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-ink-muted">
        <span>{relativeDue(task.due.iso, now)}</span>
        {task.weight !== null ? <span><span className="font-mono tabular-nums">{task.weight}%</span> weight</span> : null}
        {review ? <span className="font-medium text-attention">Needs review</span> : null}
      </div>
      {task.due.iso ? <time className="mt-1 block font-mono text-xs tabular-nums text-ink-muted" dateTime={task.due.iso}>{dateLabel(task.due.iso)}</time> : null}
      {review ? <p className="mt-1 text-xs text-attention text-pretty">Source text: {task.due.raw}</p> : null}
      <SourceLink className="mt-2" href={task.provenance.sourceUrl} pageTitle={task.provenance.pageTitle} />
    </TrackItem>
  );
}

function DeadlinesSection({ state, send, now }: WorkingPanelProps) {
  if (state.tasks.length === 0 && !state.busy) {
    return (
      <section className="grid gap-3" aria-labelledby="deadlines-title">
        <h2 className="text-md font-medium" id="deadlines-title">Upcoming deadlines</h2>
        <EmptyState title="No deadlines saved" actionLabel="Read this page" onAction={() => send({ type: 'read-page', url: state.page.url })}>
          Motion has not found a deadline on this page yet.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="grid gap-3" aria-labelledby="deadlines-title">
      <h2 className="text-md font-medium" id="deadlines-title">Upcoming deadlines</h2>
      {state.tasks.length > 0 ? (
        <Track label="Upcoming deadlines">
          {state.tasks.map((task) => <DeadlineItem key={task.id} task={task} now={now} />)}
        </Track>
      ) : null}
    </section>
  );
}

function workflowMarker(step: WorkflowStep): MarkerState {
  if (step.status === 'done') return 'done';
  if (step.status === 'running') return 'active';
  if (step.status === 'skipped') return 'skipped';
  if (step.status === 'blocked' || step.status === 'awaiting-permission' || step.status === 'awaiting-approval') return 'blocked';
  if (step.status === 'failed') return 'failed';
  return 'pending';
}

function workflowStatusCopy(status: Workflow['status']): string {
  switch (status) {
    case 'queued': return 'Queued. Motion will start when the worker is ready.';
    case 'running': return 'Running now.';
    case 'awaiting-permission': return 'Waiting for page permission.';
    case 'awaiting-approval': return 'Waiting for your approval.';
    case 'retry-scheduled': return 'Retrying after a failed step.';
    case 'paused': return 'Paused. Resume when you are ready.';
    case 'blocked': return 'Blocked. Resolve the issue before resuming.';
    case 'failed': return 'Failed. Review the error and retry if the step is safe to run again.';
    case 'cancelled': return 'Cancelled. No further steps will run.';
    case 'completed': return 'Completed.';
  }
}

function stepStatusCopy(step: WorkflowStep): string {
  switch (step.status) {
    case 'pending': return 'Pending.';
    case 'running': return 'Running now.';
    case 'awaiting-permission': return 'Waiting for page permission.';
    case 'awaiting-approval': return 'Waiting for your approval.';
    case 'done': return 'Done.';
    case 'skipped': return 'Skipped.';
    case 'blocked': return 'Blocked. Resolve the issue before resuming.';
    case 'failed': return `Failed. ${step.error || 'Review the error and retry if the step is safe to run again.'}`;
  }
}

function WorkflowControls({ workflow, send }: { workflow: Workflow; send: (command: MotionCommand) => void }) {
  const command = (value: 'pause' | 'resume' | 'retry' | 'cancel') => send({ type: 'workflow-command', workflowId: workflow.id, command: value });
  const terminal = workflow.status === 'completed' || workflow.status === 'cancelled';
  return (
    <div className="flex flex-wrap gap-2">
      {workflow.status === 'paused' ? <Button variant="primary" onClick={() => command('resume')}>Resume workflow</Button> : null}
      {workflow.status === 'failed' ? <Button variant="secondary" onClick={() => command('retry')}>Retry workflow</Button> : null}
      {workflow.status !== 'paused' && workflow.status !== 'failed' && !terminal ? <Button variant="secondary" onClick={() => command('pause')}>Pause workflow</Button> : null}
      {!terminal ? <Button variant="danger" onClick={() => command('cancel')}>Cancel workflow</Button> : null}
      {workflow.definitionId === 'prepare-workspace' && workflow.status !== 'cancelled' ? <Button variant="secondary" onClick={() => send({ type: 'close-workspace', workflowId: workflow.id })}>Close workspace</Button> : null}
    </div>
  );
}

function WorkflowCard({ workflow, send }: { workflow: Workflow; send: (command: MotionCommand) => void }) {
  return (
    <article className="grid gap-3 border border-rule bg-surface p-3" aria-labelledby={`workflow-${workflow.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-md font-medium text-balance" id={`workflow-${workflow.id}`}>{workflow.title}</h3>
        <span className="text-xs text-ink-muted">{workflow.status.replaceAll('-', ' ')}</span>
      </div>
      <p className="text-sm text-ink-muted text-pretty">{workflowStatusCopy(workflow.status)}</p>
      {workflow.warnings.map((warning) => <p className="text-xs text-attention text-pretty" key={warning}>Warning: {warning}</p>)}
      <Track label={`${workflow.title} progress`}>
        {workflow.steps.map((step) => (
          <TrackItem key={step.id} state={workflowMarker(step)} title={step.title}>
            <p className="mt-1 text-sm text-ink-muted text-pretty">{stepStatusCopy(step)}</p>
            {step.result ? <p className="mt-1 text-xs text-ink-muted text-pretty">Result: {step.result}</p> : null}
            {step.error && step.status !== 'failed' ? <p className="mt-1 text-xs text-danger text-pretty">Error: {step.error}</p> : null}
          </TrackItem>
        ))}
      </Track>
      <WorkflowControls workflow={workflow} send={send} />
    </article>
  );
}

function WorkflowsSection({ state, send }: { state: PanelState; send: (command: MotionCommand) => void }) {
  return (
    <section className="grid gap-3" aria-labelledby="workflows-title">
      <h2 className="text-md font-medium" id="workflows-title">Active workflows</h2>
      {state.workflows.length === 0 ? (
        <EmptyState title="No workflows are running" actionLabel="Read this page" onAction={() => send({ type: 'read-page', url: state.page.url })}>
          Motion will show each step here when background work starts.
        </EmptyState>
      ) : (
        <div className="grid gap-3">
          {state.workflows.map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow} send={send} />)}
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {state.workflows.map((workflow) => `${workflow.title}: ${workflowStatusCopy(workflow.status)}`).join(' ')}
      </div>
    </section>
  );
}

function LoadingRows() {
  return (
    <section className="grid gap-2" aria-busy="true" aria-label="Loading coursework">
      <SkeletonRow label="Loading deadline" />
      <SkeletonRow label="Loading workflow" />
    </section>
  );
}

export function WorkingPanel({ state, send, now }: WorkingPanelProps) {
  const offline = state.page.warnings.some((warning) => /offline|network|connection/i.test(warning));
  const partial = state.page.warnings.length > 0 || state.corruptedRecords > 0;

  return (
    <div className="grid gap-6">
      {state.busy ? <Callout variant="info" title="Updating Motion">Motion is reading the current page. Existing information stays available while it works.</Callout> : null}
      {offline ? <Callout variant="info" title="Offline">The page connection is unavailable. Motion is showing the last saved information and will try again when the connection returns.</Callout> : null}
      {partial ? (
        <Callout variant="warning" title="Some information needs review">
          {state.corruptedRecords > 0 ? `${state.corruptedRecords} saved record${state.corruptedRecords === 1 ? '' : 's'} could not be read. ` : ''}
          {state.page.warnings.length > 0 ? state.page.warnings.join(' ') : 'The remaining information is still available.'}
        </Callout>
      ) : null}
      <ApprovalSection approvals={state.approvals} send={send} />
      <ContextSection state={state} now={now} />
      {state.busy && state.tasks.length === 0 && state.workflows.length === 0 ? <LoadingRows /> : null}
      <DeadlinesSection state={state} send={send} now={now} />
      <WorkflowsSection state={state} send={send} />
    </div>
  );
}
