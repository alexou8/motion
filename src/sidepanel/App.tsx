import { useEffect, useRef, useSyncExternalStore } from 'react';
import { EMPTY_PANEL_STATE, type PanelState } from '../core/view/state';
import { cn } from '../ui/components/cn';
import { MotionMark } from '../ui/components';
import { motionCommandSchema, type MotionBridge, type MotionCommand } from './bridge';
import { useState } from 'react';
import { Home, SessionView } from './views';
import { CourseworkView } from './views/CourseworkView';
import { LibraryView } from './views/LibraryView';

export interface AppProps {
  bridge: MotionBridge;
  now?: Date;
  className?: string;
}

function usePanelState(bridge: MotionBridge): PanelState {
  return useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
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

function PanelHeader({ state, onSettings }: { state: PanelState; onSettings: () => void }) {
  return (
    <header className="border-b border-rule bg-paper px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MotionMark className="size-6 text-signal" />
          <p className="font-serif text-lg font-semibold">Motion</p>
          {state.connection === 'supported' ? (
            <span className="truncate text-xs text-ink-muted">Coursework workspace</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Settings" onClick={onSettings}>
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
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

export function App({ bridge, now = new Date(), className }: AppProps) {
  const state = usePanelState(bridge);
  const [view, setView] = useState<'workspace' | 'coursework' | 'library'>('workspace');
  const main = useRef<HTMLElement>(null);
  const restricted = state.connection === 'restricted';
  const screen = restricted ? 'restricted' : (state.activeSession?.id ?? view);
  const previousScreen = useRef(screen);
  useEffect(() => {
    if (previousScreen.current !== screen) {
      main.current?.focus();
      if (main.current) main.current.scrollTop = 0;
      previousScreen.current = screen;
    }
  }, [screen]);
  const [feedback, setFeedback] = useState<{ kind: 'pending' | 'error'; text: string } | null>(
    null,
  );
  const send = async (command: MotionCommand): Promise<boolean> => {
    const parsed = motionCommandSchema.parse(command);
    const label = commandLabel(parsed);
    setFeedback({ kind: 'pending', text: `${label}…` });
    try {
      const result = await bridge.send(parsed);
      if (isFailedCommandResult(result)) throw new Error(result.message);
      setFeedback(null);
      return true;
    } catch (error) {
      setFeedback({
        kind: 'error',
        text:
          error instanceof Error && error.message
            ? error.message
            : `${label} could not be completed.`,
      });
      return false;
    }
  };
  const openSession = (sessionId: string | null) => send({ type: 'session-select', sessionId });

  return (
    <div
      className={cn('flex h-dvh flex-col overflow-hidden bg-paper font-sans text-ink', className)}
    >
      <a href="#main-content" className="motion-skip-link">
        Skip to content
      </a>
      <PanelHeader state={state} onSettings={() => void send({ type: 'open-settings' })} />
      {!restricted && !state.activeSession ? (
        <nav className="motion-panel-nav" aria-label="Workspace">
          <button
            type="button"
            aria-current={view === 'workspace' ? 'page' : undefined}
            onClick={() => setView('workspace')}
          >
            Workspace
          </button>
          <button
            type="button"
            aria-current={view === 'library' ? 'page' : undefined}
            onClick={() => setView('library')}
          >
            Library
          </button>
          <button
            type="button"
            aria-current={view === 'coursework' ? 'page' : undefined}
            onClick={() => setView('coursework')}
          >
            Coursework{' '}
            <span className="font-mono text-xs">
              {state.tasks.filter((task) => !task.archived && task.status !== 'archived').length}
            </span>
          </button>
        </nav>
      ) : null}
      <main ref={main} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto" id="main-content">
        <div className="mx-auto grid w-full max-w-lg content-start gap-6 px-4 py-5">
          {feedback ? (
            <p
              className={cn(
                'motion-command-feedback',
                feedback.kind === 'error'
                  ? 'motion-command-feedback-error'
                  : 'motion-command-feedback-pending',
              )}
              role={feedback.kind === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {feedback.text}
            </p>
          ) : null}
          {!restricted && state.page.warnings.length > 0 ? (
            <aside
              className="border-l-2 border-attention pl-3 text-xs text-attention"
              aria-label="Page read notices"
            >
              {state.page.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </aside>
          ) : null}
          {restricted ? (
            <Home
              state={state}
              send={send}
              onOpenSession={(sessionId) => openSession(sessionId)}
              now={now}
            />
          ) : state.activeSession ? (
            <SessionView
              state={state}
              session={state.activeSession}
              send={send}
              onBack={() => openSession(null)}
              now={now}
            />
          ) : view === 'coursework' ? (
            <CourseworkView state={state} send={send} />
          ) : view === 'library' ? (
            <LibraryView state={state} bridge={bridge} />
          ) : (
            <Home
              state={state}
              send={send}
              onOpenSession={(sessionId) => openSession(sessionId)}
              now={now}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function commandLabel(command: MotionCommand): string {
  if (command.type === 'session-message') return 'Sending message';
  if (command.type === 'session-command')
    return command.command === 'stop-generation'
      ? 'Stopping response'
      : command.command === 'pause'
        ? 'Pausing work'
        : 'Resuming work';
  if (command.type === 'session-tab' && command.op === 'release') return 'Releasing tab';
  if (command.type === 'session-adopt-current-tab') return 'Adding tab';
  if (command.type === 'decide-approval')
    return command.approved ? 'Confirming action' : 'Denying action';
  if (command.type === 'open-settings') return 'Opening settings';
  if (command.type === 'read-page') return 'Reading page';
  if (command.type === 'create-note') return 'Adding note';
  if (command.type === 'scan-all-courses') return 'Scanning courses';
  if (command.type === 'set-deadline-discovery-opt-in')
    return command.enabled ? 'Enabling scanning' : 'Disabling scanning';
  if (command.type === 'session-create') return 'Starting session';
  return 'Updating Motion';
}

function isFailedCommandResult(result: unknown): result is { ok: false; message: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    (result as { ok?: unknown }).ok === false &&
    typeof (result as { message?: unknown }).message === 'string'
  );
}

export { EMPTY_PANEL_STATE };
