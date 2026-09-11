import { useState, useSyncExternalStore } from 'react';
import { EMPTY_PANEL_STATE, type PanelState } from '../core/view/state';
import { cn } from '../ui/components/cn';
import { sendCommand, type MotionBridge } from './bridge';
import {
  Composer,
  Conversation,
  CourseworkView,
  IdleView,
  PermissionNeededView,
  RestrictedView,
  SignedOutView,
  UnsupportedView,
  useChat,
  WorkingPanel,
  WorkspaceView,
} from './views';

export interface AppProps {
  bridge: MotionBridge;
  now?: Date;
  className?: string;
}

/** Page kinds where drafting and a requirements checklist are meaningful. */
const CARRIES_COURSEWORK = new Set(['assignment', 'discussion-topic', 'content-topic']);

type Task = 'workspace' | 'checklist' | 'review';

const TASKS: { id: Task; label: string }[] = [
  // Not "Prepare workspace": that is the action inside the view it opens, and
  // two buttons with one name would be ambiguous to a screen reader.
  { id: 'workspace', label: 'Workspace' },
  { id: 'checklist', label: 'Checklist' },
  { id: 'review', label: 'Draft review' },
];

function usePanelState(bridge: MotionBridge): PanelState {
  return useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
}

/**
 * Motion's mark: a short track with one active marker — the product's single
 * visual device, reduced to a glyph. Motion's own; it imitates no other product.
 */
function MotionMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5 text-signal" fill="none">
      <path d="M10 2.5v15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="6" r="2.25" fill="currentColor" />
      <circle cx="10" cy="13.5" r="2.75" fill="var(--color-paper)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-sm text-ink-muted hover:bg-sunken hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function PanelHeader({ state, onNewChat, canReset, onSettings }: { state: PanelState; onNewChat: () => void; canReset: boolean; onSettings: () => void }) {
  return (
    <header className="sticky top-0 z-sticky border-b border-rule bg-paper px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MotionMark />
          <p className="font-serif text-lg font-semibold">Motion</p>
          {state.connection === 'supported' ? (
            <span className="truncate text-xs text-ink-muted">Coursework workspace</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="New chat" onClick={onNewChat} disabled={!canReset}>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13.5 8.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4M11 2.5l2.5 2.5L8 10.5H5.5V8Z" />
            </svg>
          </IconButton>
          <IconButton label="Settings" onClick={onSettings}>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" />
              <circle cx="11" cy="4.5" r="1.5" />
              <circle cx="5" cy="11.5" r="1.5" />
            </svg>
          </IconButton>
        </div>
      </div>
    </header>
  );
}

/**
 * Motion's own task actions, as a row of buttons. Each opens its destination
 * view below; the coursework view stays mounted while hidden so a checklist
 * already built is not lost by looking at the workspace.
 */
function Tasks({ bridge, title }: { bridge: MotionBridge; title: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const coursework = task === 'checklist' || task === 'review';

  return (
    <section aria-labelledby="tasks-title" className="grid gap-4">
      <h2 id="tasks-title" className="sr-only">Tasks</h2>
      <div role="group" aria-label="Tasks" className="flex flex-wrap gap-2">
        {TASKS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={task === option.id}
            onClick={() => setTask(task === option.id ? null : option.id)}
            className={cn(
              'min-h-8 rounded-full border px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              task === option.id
                ? 'border-signal bg-sunken font-medium text-ink'
                : 'border-edge bg-surface text-ink hover:bg-sunken',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {task === 'workspace' ? <WorkspaceView bridge={bridge} /> : null}
      <div hidden={!coursework}>
        <CourseworkView bridge={bridge} title={title} />
      </div>
    </section>
  );
}

function ConnectionContent({ state, bridge, now }: { state: PanelState; bridge: MotionBridge; now: Date }) {
  const send = (command: Parameters<typeof sendCommand>[1]) => sendCommand(bridge, command);
  switch (state.connection) {
    case 'idle': return <IdleView state={state} send={send} />;
    case 'unsupported': return <UnsupportedView state={state} send={send} />;
    case 'permission-needed': return <PermissionNeededView state={state} send={send} />;
    case 'restricted': return <RestrictedView state={state} send={send} />;
    case 'signed-out': return <SignedOutView state={state} send={send} />;
    case 'supported':
      return (
        <>
          {/* Coursework tasks appear only where they make sense: on a page that
              actually carries an assignment or a discussion prompt. On a grades
              or calendar page they would be noise. */}
          {CARRIES_COURSEWORK.has(state.page.pageType ?? '') ? (
            <Tasks bridge={bridge} title={state.page.title || 'Coursework'} />
          ) : null}
          <WorkingPanel state={state} send={send} now={now} />
        </>
      );
  }
}

export function App({ bridge, now = new Date(), className }: AppProps) {
  const state = usePanelState(bridge);
  const chat = useChat(bridge, state);

  return (
    <div className={cn('flex min-h-dvh flex-col bg-paper font-sans text-ink', className)}>
      <PanelHeader
        state={state}
        onNewChat={chat.reset}
        canReset={chat.turns.length > 0 && !chat.pending}
        onSettings={() => sendCommand(bridge, { type: 'open-settings' })}
      />
      <main className="mx-auto grid w-full max-w-lg flex-1 content-start gap-6 px-4 py-5" id="main-content">
        <ConnectionContent state={state} bridge={bridge} now={now} />
        {/* Hidden, not forgotten, beside a graded attempt: earlier answers about
            course material do not belong next to an assessment. */}
        {state.connection === 'restricted' ? null : <Conversation turns={chat.turns} pending={chat.pending} />}
      </main>
      <footer className="sticky bottom-0 z-sticky border-t border-rule bg-paper px-4 py-3">
        <div className="mx-auto w-full max-w-lg">
          <Composer bridge={bridge} state={state} pending={chat.pending} onAsk={(question) => void chat.ask(question)} />
        </div>
      </footer>
    </div>
  );
}

export { EMPTY_PANEL_STATE };
