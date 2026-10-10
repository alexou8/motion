import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ApprovalRequest } from '../../core/policy';
import type {
  AgentSession,
  ActivityEntry,
  PlanStep,
  SessionBlocker,
} from '../../core/session/types';
import type { PanelState, WorkspaceTabSummary } from '../../core/view/state';
import {
  Button,
  Callout,
  ConfirmDialog,
  SourceLink,
  StatusMarker,
  Track,
  TrackItem,
} from '../../ui/components';
import { cn } from '../../ui/components/cn';
import { useNow } from '../../ui/useNow';
import type { MotionCommand } from '../bridge';

/** Mirrors `sessionMessageSchema`'s cap so a long paste is stopped in the field. */
export const MESSAGE_MAX_LENGTH = 4_000;
const MESSAGE_COUNT_THRESHOLD = 3_600;

/**
 * The session view: one coherent command centre for a single AgentSession
 * (VISION §6, §18), not a set of mini-apps. Everything here is a read of
 * `state.activeSession` plus narrow session commands — the view holds no
 * state of its own about what Motion is doing.
 */

export interface SessionViewProps {
  state: PanelState;
  session: AgentSession;
  send: (command: MotionCommand) => void | Promise<boolean>;
  onBack: () => void;
  now: Date;
}

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function statusLabel(status: AgentSession['status']): string {
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

function partialJsonString(text: string, start: number): { value: string; end: number; complete: boolean } | null {
  if (text[start] !== '"') return null;
  let value = '';
  for (let index = start + 1; index < text.length;) {
    const char = text[index];
    if (char === '"') return { value, end: index + 1, complete: true };
    if (char === '\\') {
      const escape = text[index + 1];
      if (escape === undefined) return { value, end: text.length, complete: false };
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (Object.hasOwn(simple, escape)) {
        value += simple[escape];
        index += 2;
      } else if (escape === 'u') {
        const digits = text.slice(index + 2, index + 6);
        if (digits.length < 4 && /^[\da-f]*$/i.test(digits)) return { value, end: text.length, complete: false };
        if (!/^[\da-f]{4}$/i.test(digits)) return { value, end: index, complete: false };
        value += String.fromCharCode(Number.parseInt(digits, 16));
        index += 6;
      } else {
        return { value, end: index, complete: false };
      }
      continue;
    }
    if (char === undefined || char.charCodeAt(0) < 0x20) return { value, end: index, complete: false };
    value += char;
    index += 1;
  }
  return { value, end: text.length, complete: false };
}

function skipJsonValue(text: string, start: number): number | null {
  if (text[start] === '"') {
    const parsed = partialJsonString(text, start);
    return parsed?.complete ? parsed.end : null;
  }
  const stack: string[] = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const parsed = partialJsonString(text, index);
      if (!parsed?.complete) return null;
      index = parsed.end - 1;
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      if (stack.length === 0) return index;
      if (stack.pop() !== char) return null;
    } else if (stack.length === 0 && (char === ',' || /\s/.test(char ?? ''))) {
      return index;
    }
  }
  return stack.length === 0 ? text.length : null;
}

function partialReply(text: string): string | null {
  let index = text.search(/\S/);
  if (index < 0 || text[index] !== '{') return null;
  index += 1;
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (text[index] === '}') return null;
    const key = partialJsonString(text, index);
    if (!key?.complete) return null;
    index = key.end;
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (text[index] !== ':') return null;
    index += 1;
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (key.value === 'reply') return partialJsonString(text, index)?.value ?? null;
    const end = skipJsonValue(text, index);
    if (end === null) return null;
    index = end;
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (text[index] !== ',') return null;
    index += 1;
  }
  return null;
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
            state.ai.cloud
              ? 'border border-attention text-attention'
              : 'border border-edge text-ink-muted',
          )}
        >
          AI · {state.ai.displayName}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span>{statusLabel(session.status)}</span>
        {due ? <time dateTime={due}>{dateLabel(due)}</time> : null}
        {session.agent.model ? <span>Model · {session.agent.model}</span> : null}
      </div>
    </header>
  );
}

function ConversationLog({
  session,
  streaming,
}: {
  session: AgentSession;
  streaming: PanelState['streaming'];
}) {
  const isStreaming = streaming?.sessionId === session.id;
  const liveReply = isStreaming ? partialReply(streaming.text) : null;
  // While a reply streams the log is busy, so assistive technology waits and
  // reads the finished turn once instead of re-announcing each partial chunk.
  return (
    <section aria-label="Conversation" className="grid gap-3">
      <ol role="log" aria-live="polite" aria-busy={isStreaming} className="grid gap-3">
        {session.conversation.map((entry) =>
          entry.role === 'student' ? (
            <li
              key={entry.id}
              className="ml-8 justify-self-end rounded bg-sunken px-3 py-2 text-sm text-ink whitespace-pre-wrap break-words"
            >
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
          <li className="text-sm text-ink whitespace-pre-wrap break-words">
            <span className="sr-only">Motion: </span>
            {liveReply || 'Motion is responding…'}
          </li>
        ) : null}
      </ol>
    </section>
  );
}

const STEP_STATE = {
  pending: 'pending',
  active: 'active',
  done: 'done',
  blocked: 'blocked',
  skipped: 'skipped',
  failed: 'failed',
} as const;

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
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-md font-medium" id="plan-title">
          Plan
        </h2>
        <span className="text-xs text-ink-muted">
          {session.plan.steps.filter((step) => step.status === 'done').length}/
          {session.plan.steps.length} complete
        </span>
      </div>
      <Track label="Plan">
        {session.plan.steps.map((step) => (
          <PlanStepItem key={step.id} step={step} />
        ))}
      </Track>
    </section>
  );
}

function NowSection({ session }: { session: AgentSession }) {
  const current = currentStepTitle(session);
  return (
    <section
      className="grid gap-1 rounded border border-signal bg-surface px-3 py-2"
      aria-labelledby="now-title"
    >
      <h2 id="now-title" className="text-xs font-medium text-signal">
        Now
      </h2>
      <p className="text-sm text-ink text-pretty">
        {current ? `Focused on ${current}.` : 'Motion is ready for your next instruction.'}
      </p>
      <p className="text-xs text-ink-muted">{statusLabel(session.status)}</p>
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
              {entry.sourceUrl ? (
                <SourceLink className="mt-1" href={entry.sourceUrl} pageTitle="" />
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function WorkspaceTabRow({
  session,
  tab,
  send,
}: {
  session: AgentSession;
  tab: WorkspaceTabSummary;
  send: (command: MotionCommand) => void | Promise<boolean>;
}) {
  const label = tab.title || tab.host || 'Untitled page';
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-rule bg-surface px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">{label}</p>
        <p className="text-xs text-ink-muted">
          {tab.ownership === 'motion' ? 'Motion tab' : 'Your tab'}
          {tab.host ? ` · ${tab.host}` : ''}
          {tab.current ? ' · current' : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!tab.current ? (
          <Button
            variant="quiet"
            onClick={() =>
              send({ type: 'session-tab', sessionId: session.id, tabId: tab.tabId, op: 'focus' })
            }
          >
            Focus
          </Button>
        ) : null}
        {tab.ownership === 'student' ? (
          <Button
            variant="quiet"
            onClick={() =>
              send({ type: 'session-tab', sessionId: session.id, tabId: tab.tabId, op: 'release' })
            }
          >
            Release
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceSection({
  state,
  session,
  send,
}: {
  state: PanelState;
  session: AgentSession;
  send: (command: MotionCommand) => void | Promise<boolean>;
}) {
  // Count the live rows the worker resolved, not the session's stored ids:
  // those still include tabs the student closed or released.
  const tabs = state.workspaceTabs;
  const total = tabs.length;
  return (
    <section className="grid gap-2" aria-labelledby="workspace-title">
      <h2 className="text-md font-medium" id="workspace-title">
        Workspace · {total} {total === 1 ? 'tab' : 'tabs'}
      </h2>
      <p className="text-xs text-ink-muted text-pretty">
        {session.workspace.groupTitle
          ? `Motion is keeping ${session.workspace.groupTitle} together. `
          : ''}
        {currentStepTitle(session)
          ? `Focused on ${currentStepTitle(session)}.`
          : 'Focused on the next step.'}
      </p>
      <div className="grid gap-2 text-sm">
        {tabs.length > 0 ? (
          tabs.map((tab) => (
            <WorkspaceTabRow key={tab.tabId} session={session} tab={tab} send={send} />
          ))
        ) : (
          <p className="text-xs text-ink-muted">
            No workspace tabs open yet. Add this tab to keep it with the session.
          </p>
        )}
      </div>
      <div>
        <Button
          variant="secondary"
          onClick={() => send({ type: 'session-adopt-current-tab', sessionId: session.id })}
        >
          Add this tab
        </Button>
      </div>
    </section>
  );
}

function SourcesSection({
  session,
  send,
}: {
  session: AgentSession;
  send: (command: MotionCommand) => void | Promise<boolean>;
}) {
  if (session.context.sources.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="sources-title">
      <h2 className="text-md font-medium" id="sources-title">
        Sources
      </h2>
      <ul className="grid gap-2">
        {session.context.sources.map((source) => (
          <li
            key={source.url}
            className="flex items-center justify-between gap-2 rounded border border-rule bg-surface px-3 py-2 text-sm"
          >
            <SourceLink href={source.url} pageTitle={source.title} />
            <label className="flex shrink-0 items-center gap-1 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={source.excluded}
                onChange={(event) =>
                  send({
                    type: 'session-source',
                    sessionId: session.id,
                    url: source.url,
                    excluded: event.target.checked,
                  })
                }
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
      <h2 className="text-md font-medium" id="artifacts-title">
        Artifacts
      </h2>
      <ul className="grid gap-2">
        {session.artifacts.map((artifact) => (
          <li key={artifact.id}>
            <details className="rounded border border-rule bg-surface px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                {artifact.title}{' '}
                <span className="font-normal text-ink-muted">· {artifact.kind}</span>
              </summary>
              <p className="mt-2 text-xs text-ink-muted">Created {dateLabel(artifact.createdAt)}</p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The control a blocker offers. The producer says which via `blocker.action`;
 * the kind alone is ambiguous (a `permission` blocker can be a provider
 * setting, not a page grant), so it only picks a safe fallback: settings,
 * never a page-origin permission request.
 */
function blockerAction(
  blocker: SessionBlocker,
  sessionId: string,
  send: (command: MotionCommand) => void,
  now: Date,
): { label: string; onClick: () => void } | null {
  switch (blocker.action) {
    case 'open-ai-settings':
      return { label: 'Open AI settings', onClick: () => send({ type: 'open-settings' }) };
    case 'retry-model':
      return {
        label: 'Retry',
        onClick: () => send({ type: 'session-command', sessionId, command: 'retry-model' }),
      };
    case 'page-permission':
      return { label: 'Allow access', onClick: () => send({ type: 'request-permission' }) };
  }
  if (blocker.kind === 'permission' || blocker.kind === 'provider' || blocker.kind === 'error')
    return { label: 'Open settings', onClick: () => send({ type: 'open-settings' }) };
  if (blocker.kind === 'rate-limit' && blocker.retryAt) {
    const seconds = Math.max(
      0,
      Math.round((new Date(blocker.retryAt).getTime() - now.getTime()) / 1000),
    );
    return { label: `Retrying in ${seconds}s`, onClick: () => undefined };
  }
  return null;
}

function BlockerItem({
  blocker,
  sessionId,
  send,
  now,
}: {
  blocker: SessionBlocker;
  sessionId: string;
  send: (command: MotionCommand) => void | Promise<boolean>;
  now: Date;
}) {
  const countingDown =
    blocker.kind === 'rate-limit' &&
    !!blocker.retryAt &&
    new Date(blocker.retryAt).getTime() > now.getTime();
  // A one-second clock only while a countdown is visible.
  const tick = useNow(1_000, countingDown);
  const current = tick.getTime() > now.getTime() ? tick : now;
  const action = blockerAction(blocker, sessionId, send, current);
  const countdown = blocker.kind === 'rate-limit' && !blocker.action;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-attention bg-surface px-3 py-2 text-sm">
      <span className="text-ink text-pretty">{blocker.message}</span>
      {action ? (
        <Button variant="secondary" onClick={action.onClick} disabled={countdown}>
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
function ApprovalItem({
  approval,
  send,
  now,
}: {
  approval: ApprovalRequest;
  send: (command: MotionCommand) => void | Promise<boolean>;
  now: Date;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const fresh =
    approval.tier === 'fresh-confirmation' || (!approval.tier && approval.risk === 'high');
  const expired =
    approval.status === 'expired' ||
    (approval.expiresAt !== null && new Date(approval.expiresAt).getTime() <= now.getTime());
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
          onDecline={() => decide(false)}
        >
          <p>Target: {approval.target}</p>
          <p className="mt-2">Effect: {approval.effect}</p>
          <pre className="mt-2 max-h-32 overflow-auto rounded-sm bg-sunken p-2 text-xs text-ink">
            {safePayload(approval.payload)}
          </pre>
        </ConfirmDialog>
      </li>
    );
  }

  return (
    <li className="grid gap-2 rounded border border-attention bg-surface px-3 py-2 text-sm">
      <span className="text-ink text-pretty">{approval.summary}</span>
      <span className="text-xs text-ink-muted text-pretty">
        {approval.target} — {approval.effect}
      </span>
      <div className="flex gap-2">
        <Button variant="quiet" onClick={() => decide(false)}>
          Deny
        </Button>
        <Button variant="primary" onClick={() => decide(true)}>
          Allow once
        </Button>
      </div>
    </li>
  );
}

function NeedsYouSection({
  state,
  session,
  send,
  now,
}: {
  state: PanelState;
  session: AgentSession;
  send: (command: MotionCommand) => void | Promise<boolean>;
  now: Date;
}) {
  const approvals = state.approvals.filter(
    (approval) =>
      session.workflowIds.includes(approval.workflowId) && approval.status === 'pending',
  );
  if (session.blockers.length === 0 && approvals.length === 0) return null;

  return (
    <section
      className="grid gap-2 border-2 border-attention bg-surface p-3"
      aria-labelledby="needs-you-title"
    >
      <p className="text-xs font-medium text-attention" id="needs-you-title">
        Needs you
      </p>
      <ul className="grid gap-2">
        {session.blockers.map((blocker) => (
          <BlockerItem
            key={blocker.id}
            blocker={blocker}
            sessionId={session.id}
            send={send}
            now={now}
          />
        ))}
        {approvals.map((approval) => (
          <ApprovalItem key={approval.id} approval={approval} send={send} now={now} />
        ))}
      </ul>
    </section>
  );
}

function currentStepTitle(session: AgentSession): string | null {
  return session.plan.steps.find((step) => step.id === session.plan.currentStepId)?.title ?? null;
}

function SessionComposer({
  state,
  session,
  send,
}: {
  state: PanelState;
  session: AgentSession;
  send: (command: MotionCommand) => void | Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const remaining = MESSAGE_MAX_LENGTH - draft.length;
  const isStreaming = state.streaming?.sessionId === session.id;
  const hasPendingModelRequest = session.pendingModelRequest !== null;
  const isPaused = session.status === 'paused';
  const isWorking = session.status === 'working';
  const canPause = !sending && ['active', 'working', 'waiting'].includes(session.status);
  const canResume = !sending && isPaused;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (sending) return;
    setSending(true);
    try {
      const sent = await send({
        type: 'session-message',
        sessionId: session.id,
        text: trimmed,
        tabId: null,
      });
      if (sent !== false) setDraft((current) => (current.trim() === trimmed ? '' : current));
    } finally {
      setSending(false);
    }
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
      : (session.blockers[0]?.message ?? null);

  return (
    <div className="grid gap-2">
      {statusLine ? (
        <p aria-live="polite" className="text-xs text-ink-muted text-pretty">
          {statusLine}
        </p>
      ) : null}
      <form
        onSubmit={(event) => void submit(event)}
        className="grid gap-2 motion-session-composer"
        aria-label="Send a message"
      >
        <div className="flex min-w-0 items-end gap-2 rounded border border-edge bg-surface p-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
          <label htmlFor="session-composer" className="sr-only">
            Message Motion
          </label>
          <textarea
            id="session-composer"
            rows={2}
            value={draft}
            maxLength={MESSAGE_MAX_LENGTH}
            aria-describedby={
              draft.length >= MESSAGE_COUNT_THRESHOLD ? 'session-composer-count' : undefined
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Motion"
            className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 text-sm text-ink placeholder:text-ink-muted focus:outline-none"
          />
          <Button type="submit" variant="primary" disabled={sending || draft.trim().length === 0}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
        {draft.length >= MESSAGE_COUNT_THRESHOLD ? (
          <p
            id="session-composer-count"
            className={cn('text-xs', remaining === 0 ? 'text-attention' : 'text-ink-muted')}
          >
            {remaining === 0
              ? `Message limit reached (${MESSAGE_MAX_LENGTH.toLocaleString()} characters).`
              : `${remaining.toLocaleString()} characters left`}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {isStreaming || hasPendingModelRequest ? (
            <Button variant="danger" onClick={() => send({ type: 'session-command', sessionId: session.id, command: 'stop-generation' })}>
              Stop
            </Button>
          ) : null}
          {canResume ? (
            <Button
              variant="secondary"
              onClick={() =>
                send({ type: 'session-command', sessionId: session.id, command: 'resume' })
              }
            >
              Resume
            </Button>
          ) : canPause ? (
            <Button
              variant="quiet"
              onClick={() =>
                send({ type: 'session-command', sessionId: session.id, command: 'pause' })
              }
            >
              Pause
            </Button>
          ) : null}
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
          {state.corruptedRecords} saved record{state.corruptedRecords === 1 ? '' : 's'} could not
          be read.
        </Callout>
      ) : null}
      <NowSection session={session} />
      <NeedsYouSection state={state} session={session} send={send} now={now} />
      <ConversationLog session={session} streaming={state.streaming} />
      <PlanSection session={session} />
      <ActivitySection session={session} />
      <WorkspaceSection state={state} session={session} send={send} />
      <SourcesSection session={session} send={send} />
      <ArtifactsSection session={session} />
      <SessionComposer state={state} session={session} send={send} />
    </div>
  );
}
