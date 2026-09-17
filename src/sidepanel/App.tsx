import { useSyncExternalStore } from 'react';
import { EMPTY_PANEL_STATE, type PanelState } from '../core/view/state';
import { cn } from '../ui/components/cn';
import { sendCommand, type MotionBridge, type MotionCommand } from './bridge';
import { Home, SessionView } from './views';

export interface AppProps {
  bridge: MotionBridge;
  now?: Date;
  className?: string;
}

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

function PanelHeader({ state, onSettings }: { state: PanelState; onSettings: () => void }) {
  return (
    <header className="border-b border-rule bg-paper px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MotionMark />
          <p className="font-serif text-lg font-semibold">Motion</p>
          {state.connection === 'supported' ? (
            <span className="truncate text-xs text-ink-muted">Coursework workspace</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
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

export function App({ bridge, now = new Date(), className }: AppProps) {
  const state = usePanelState(bridge);
  const send = (command: MotionCommand) => sendCommand(bridge, command);
  const openSession = (sessionId: string | null) => send({ type: 'session-select', sessionId });

  return (
    <div className={cn('flex h-dvh flex-col overflow-hidden bg-paper font-sans text-ink', className)}>
      <PanelHeader state={state} onSettings={() => sendCommand(bridge, { type: 'open-settings' })} />
      <main className="min-h-0 flex-1 overflow-y-auto" id="main-content">
        <div className="mx-auto grid w-full max-w-lg content-start gap-6 px-4 py-5">
          {state.activeSession ? (
            <SessionView state={state} session={state.activeSession} send={send} onBack={() => openSession(null)} now={now} />
          ) : (
            <Home state={state} send={send} onOpenSession={(sessionId) => openSession(sessionId)} now={now} />
          )}
        </div>
      </main>
    </div>
  );
}

export { EMPTY_PANEL_STATE };
