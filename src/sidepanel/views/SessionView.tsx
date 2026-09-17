import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ApprovalRequest } from '../../core/policy';
import type { AgentSession, ActivityEntry, PlanStep, SessionBlocker } from '../../core/session/types';
import type { PanelState } from '../../core/view/state';
import { Button, Callout, ConfirmDialog, SourceLink, StatusMarker, Track, TrackItem } from '../../ui/components';
import { cn } from '../../ui/components/cn';
import type { MotionCommand } from '../bridge';

/**
 * The session view: one coherent command centre for a single AgentSession
 * (VISION §6, §18), not a set of mini-apps. Everything here is a read of
 * `state.activeSession` plus narrow session commands — the view holds no
 * state of its own about what Motion is doing.
 */

export interface SessionViewProps {
  state: PanelState;
  session: AgentSession;
  send: (command: MotionCommand) => void;
  onBack: () => void;
  now: Date;
}

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function statusLabel(status: AgentSession['status']): string {
  switch (status) {
    case 'active': return 'Active';
    case 'working': return 'Working';
    case 'waiting': return 'Waiting on you';
    case 'paused': return 'Paused';
    case 'completed': return 'Completed';
    case 'archived': return 'Archived';
  }
}

function SessionHeader({ state, session, onBack }: { state: PanelState; session: AgentSession; onBack: () => void }) {
  const due = session.taskId ? state.tasks.find((task) => task.id === session.taskId)?.due.iso ?? null : null;
  return (
    <header className="grid gap-2">
      <Button variant="quiet" onClick={onBack} className="justify-self-start">
        <span aria-hidden="true">←</span>&nbsp;Sessions
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="text-lg font-medium text-balance">{session.title}</h1>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
            state.ai.cloud ? 'border border-attention text-attention' : 'border border-edge text-ink-muted',
          )}
        >
          AI · {state.ai.displayName}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span>{statusLabel(session.status)}</span>
        {due ? <time dateTime={due}>{dateLabel(due)}</time> : null}
      </div>
    </header>
  );
}

function ConversationLog({ session, streaming }: { session: AgentSession; streaming: PanelState['streaming'] }) {
  const isStreaming = streaming?.sessionId === session.id;
  return (
    <section aria-label="Conversation" className="grid gap-3">
      <ol role="log" aria-live="polite" className="grid gap-3">
        {session.conversation.map((entry) =>
          entry.role === 'student' ? (
            <li key={entry.id} className="ml-8 justify-self-end rounded bg-sunken px-3 py-2 text-sm text-ink whitespace-pre-wrap break-words">
              <span className="sr-only">You: </span>
              {entry.text}
            </li>
          ) : (
            <li key={entry.id} className="text-sm text-ink whitespace-pre-wrap break-words">
              <span className="sr-only">Motion: </span>
              {entry.text}
            </li>
          ),
        )}
        {isStreaming ? (
          <li className="text-sm text-ink whitespace-pre-wrap break-words" aria-label="Motion is responding">
            <span className="sr-only">Motion: </span>
            {streaming.text}
          </li>
        ) : null}
      </ol>
    </section>
  );
}

const STEP_STATE = { pending: 'pending', active: 'active', done: 'done', blocked: 'blocked', skipped: 'skipped', failed: 'failed' } as const;

function PlanStepItem({ step }: { step: PlanStep }) {
  return (
    <TrackItem state={STEP_STATE[step.status]} title={step.title}>
      {step.rationale ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-ink-muted">Why</summary>
          <p className="mt-1 text-xs text-ink-muted text-pretty">{step.rationale}</p>
        </details>
      ) : null}
    </TrackItem>
  );
}

function PlanSection({ session }: { session: AgentSession }) {
  if (session.plan.steps.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="plan-title">
      <h2 className="text-md font-medium" id="plan-title">Plan</h2>
      <Track label="Plan">
        {session.plan.steps.map((step) => <PlanStepItem key={step.id} step={step} />)}
      </Track>
    </section>
  );
}

function activityMarker(kind: ActivityEntry['kind']): 'done' | 'blocked' | 'pending' | 'failed' {
  if (kind === 'result') return 'done';
  if (kind === 'blocker') return 'blocked';
  if (kind === 'user-override') return 'pending';
  return 'pending';
}

function ActivitySection({ session }: { session: AgentSession }) {
  if (session.activity.length === 0) return null;
  const recent = [...session.activity].slice(-20).reverse();
  return (
    <details className="grid gap-2">
      <summary className="cursor-pointer text-md font-medium text-ink">Activity</summary>
      <ol className="mt-2 grid gap-2">
        {recent.map((entry) => (
          <li key={entry.id} className="flex items-start gap-2 text-sm">
            <StatusMarker state={activityMarker(entry.kind)} label={entry.kind} />
            <div className="min-w-0">
              <p className="text-ink text-pretty">{entry.summary}</p>
              {entry.sourceUrl ? <SourceLink className="mt-1" href={entry.sourceUrl} pageTitle="" /> : null}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function WorkspaceSection({ session, send }: { session: AgentSession; send: (command: MotionCommand) => void }) {
  const { ownedTabIds, adoptedTabIds } = session.workspace;
  const total = ownedTabIds.length + adoptedTabIds.length;
  return (
    <section className="grid gap-2" aria-labelledby="workspace-title">
      <h2 className="text-md font-medium" id="workspace-title">
        Workspace · {total} {total === 1 ? 'tab' : 'tabs'}
      </h2>
      <div className="grid gap-2 text-sm">
        {ownedTabIds.map((tabId) => (
          <div key={`owned-${tabId}`} className="flex items-center justify-between gap-2 rounded border border-rule bg-surface px-3 py-2">
            <span>Motion tab · #{tabId}</span>
          </div>
        ))}
        {adoptedTabIds.map((tabId) => (
          <div key={`adopted-${tabId}`} className="flex items-center justify-between gap-2 rounded border border-rule bg-surface px-3 py-2">
            <span>Your tab · #{tabId}</span>
            <Button variant="quiet" onClick={() => send({ type: 'session-tab', sessionId: session.id, tabId, op: 'release' })}>
              Release
            </Button>
          </div>
        ))}
      </div>
      <div>
        <Button variant="secondary" onClick={() => send({ type: 'session-adopt-current-tab', sessionId: session.id })}>
          Add this tab
        </Button>
      </div>
    </section>
  );
}

function SourcesSection({ session, send }: { session: AgentSession; send: (command: MotionCommand) => void }) {
  if (session.context.sources.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="sources-title">
      <h2 className="text-md font-medium" id="sources-title">Sources</h2>
      <ul className="grid gap-2">
        {session.context.sources.map((source) => (
          <li key={source.url} className="flex items-center justify-between gap-2 rounded border border-rule bg-surface px-3 py-2 text-sm">
            <SourceLink href={source.url} pageTitle={source.title} />
            <label className="flex shrink-0 items-center gap-1 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={source.excluded}
                onChange={(event) => send({ type: 'session-source', sessionId: session.id, url: source.url, excluded: event.target.checked })}
              />
              Don't use
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArtifactsSection({ session }: { session: AgentSession }) {
  if (session.artifacts.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="artifacts-title">
      <h2 className="text-md font-medium" id="artifacts-title">Artifacts</h2>
      <ul className="grid gap-2">
        {session.artifacts.map((artifact) => (
          <li key={artifact.id}>
            <details className="rounded border border-rule bg-surface px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                {artifact.title} <span className="font-normal text-ink-muted">· {artifact.kind}</span>
              </summary>
              <p className="mt-2 text-xs text-ink-muted">
                Created {dateLabel(artifact.createdAt)}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function blockerAction(blocker: SessionBlocker, send: (command: MotionCommand) => void, now: Date): { label: string; onClick: () => void } | null {
  if (blocker.kind === 'permission') return { label: 'Allow access', onClick: () => send({ type: 'request-permission' }) };
  if (blocker.kind === 'provider' || blocker.kind === 'error') return { label: 'Reconnect', onClick: () => send({ type: 'open-settings' }) };
  if (blocker.kind === 'rate-limit' && blocker.retryAt) {
    const seconds = Math.max(0, Math.round((new Date(blocker.retryAt).getTime() - now.getTime()) / 1000));
    return { label: `Retrying in ${seconds}s`, onClick: () => undefined };
  }
  return null;
}

function BlockerItem({ blocker, send, now }: { blocker: SessionBlocker; send: (command: MotionCommand) => void; now: Date }) {
  const action = blockerAction(blocker, send, now);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-attention bg-surface px-3 py-2 text-sm">
      <span className="text-ink text-pretty">{blocker.message}</span>
      {action ? (
        <Button variant="secondary" onClick={action.onClick} disabled={blocker.kind === 'rate-limit'}>
          {action.label}
        </Button>
      ) : null}
    </li>
  );
}

function safePayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return 'The payload could not be displayed because it is not serializable.';
  }
}

/**
 * Configurable-tier approval renders as an inline card (Allow once / Deny).
 * Fresh-confirmation tier (or high risk) renders as a native `<dialog>` with
 * the exact summary/target/effect and an expiry countdown, and NEVER offers
 * an "always allow" — there is no such control for this tier anywhere in the
 * product (ARCH D5).
 */
function ApprovalItem({ approval, send, now }: { approval: ApprovalRequest; send: (command: MotionCommand) => void; now: Date }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const fresh = approval.tier === 'fresh-confirmation' || (!approval.tier && approval.risk === 'high');
  const expired = approval.status === 'expired' || (approval.expiresAt !== null && new Date(approval.expiresAt).getTime() <= now.getTime());
  const decide = (approved: boolean) => {
    send({ type: 'decide-approval', approvalId: approval.id, approved });
    setDialogOpen(false);
  };

  if (expired) {
    return (
      <li className="rounded border border-rule bg-surface px-3 py-2 text-sm text-ink-muted">
        {approval.summary} — expired. Ask again to continue.
      </li>
    );
  }

  if (fresh) {
    return (
      <li>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-attention bg-surface px-3 py-2 text-sm">
          <span className="text-ink text-pretty">{approval.summary}</span>
          <Button variant="danger" onClick={() => setDialogOpen(true)}>
            Review
          </Button>
        </div>
        <ConfirmDialog
          open={dialogOpen}
          title={approval.summary}
          confirmLabel="Confirm"
          expiry={approval.expiresAt}
          onOpenChange={setDialogOpen}
          onConfirm={() => decide(true)}
        >
          <p>Target: {approval.target}</p>
          <p className="mt-2">Effect: {approval.effect}</p>
          <pre className="mt-2 max-h-32 overflow-auto rounded-sm bg-sunken p-2 text-xs text-ink">{safePayload(approval.payload)}</pre>
        </ConfirmDialog>
      </li>
    );
  }

  return (
    <li className="grid gap-2 rounded border border-attention bg-surface px-3 py-2 text-sm">
      <span className="text-ink text-pretty">{approval.summary}</span>
      <span className="text-xs text-ink-muted text-pretty">{approval.target} — {approval.effect}</span>
      <div className="flex gap-2">
        <Button variant="quiet" onClick={() => decide(false)}>Deny</Button>
        <Button variant="primary" onClick={() => decide(true)}>Allow once</Button>
      </div>
    </li>
  );
}

function NeedsYouSection({ state, session, send, now }: { state: PanelState; session: AgentSession; send: (command: MotionCommand) => void; now: Date }) {
  const approvals = state.approvals.filter((approval) => session.workflowIds.includes(approval.workflowId) && approval.status === 'pending');
  if (session.blockers.length === 0 && approvals.length === 0) return null;

  return (
    <section className="grid gap-2 border-2 border-attention bg-surface p-3" aria-labelledby="needs-you-title">
      <p className="text-xs font-medium text-attention" id="needs-you-title">Needs you</p>
      <ul className="grid gap-2">
        {session.blockers.map((blocker) => <BlockerItem key={blocker.id} blocker={blocker} send={send} now={now} />)}
        {approvals.map((approval) => <ApprovalItem key={approval.id} approval={approval} send={send} now={now} />)}
      </ul>
    </section>
  );
}

function currentStepTitle(session: AgentSession): string | null {
  return session.plan.steps.find((step) => step.id === session.plan.currentStepId)?.title ?? null;
}

function SessionComposer({ state, session, send }: { state: PanelState; session: AgentSession; send: (command: MotionCommand) => void }) {
  const [draft, setDraft] = useState('');
  const isStreaming = state.streaming?.sessionId === session.id;
  const isPaused = session.status === 'paused';
  const isWorking = session.status === 'working';

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    send({ type: 'session-message', sessionId: session.id, text: trimmed, tabId: null });
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  const step = currentStepTitle(session);
  const statusLine = isStreaming
    ? null
    : isWorking
      ? step
        ? `Working on: ${step}`
        : state.ai.cloud
          ? `Waiting for ${state.ai.displayName}…`
          : 'Working…'
      : session.blockers[0]?.message ?? null;

  return (
    <div className="grid gap-2">
      {statusLine ? (
        <p aria-live="polite" className="text-xs text-ink-muted text-pretty">
          {statusLine}
        </p>
      ) : null}
      <form onSubmit={submit} className="grid gap-2" aria-label="Send a message">
        <div className="flex min-w-0 items-end gap-2 rounded border border-edge bg-surface p-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
          <label htmlFor="session-composer" className="sr-only">Message Motion</label>
          <textarea
            id="session-composer"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Motion"
            className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 text-sm text-ink placeholder:text-ink-muted focus:outline-none"
          />
          <Button type="submit" variant="primary" disabled={draft.trim().length === 0}>
            Send
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {isStreaming ? (
            <Button variant="danger" onClick={() => send({ type: 'session-command', sessionId: session.id, command: 'stop-generation' })}>
              Stop
            </Button>
          ) : null}
          {isPaused ? (
            <Button variant="secondary" onClick={() => send({ type: 'session-command', sessionId: session.id, command: 'resume' })}>
              Resume
            </Button>
          ) : (
            <Button variant="quiet" onClick={() => send({ type: 'session-command', sessionId: session.id, command: 'pause' })}>
              Pause
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

export function SessionView({ state, session, send, onBack, now }: SessionViewProps) {
  return (
    <div className="grid gap-6">
      <SessionHeader state={state} session={session} onBack={onBack} />
      {state.corruptedRecords > 0 ? (
        <Callout variant="warning" title="Some information needs review">
          {state.corruptedRecords} saved record{state.corruptedRecords === 1 ? '' : 's'} could not be read.
        </Callout>
      ) : null}
      <NeedsYouSection state={state} session={session} send={send} now={now} />
      <ConversationLog session={session} streaming={state.streaming} />
      <PlanSection session={session} />
      <ActivitySection session={session} />
      <WorkspaceSection session={session} send={send} />
      <SourcesSection session={session} send={send} />
      <ArtifactsSection session={session} />
      <SessionComposer state={state} session={session} send={send} />
    </div>
  );
}
