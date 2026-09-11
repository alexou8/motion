import { useSyncExternalStore } from 'react';
import { EMPTY_PANEL_STATE, type PanelState } from '../core/view/state';
import { cn } from '../ui/components/cn';
import { sendCommand, type MotionBridge } from './bridge';
import {
  CourseworkView,
  IdleView,
  PermissionNeededView,
  RestrictedView,
  SignedOutView,
  UnsupportedView,
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

function usePanelState(bridge: MotionBridge): PanelState {
  return useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
}

function PanelHeader({ state }: { state: PanelState }) {
  return (
    <header className="sticky top-0 z-sticky border-b border-rule bg-paper px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-lg font-medium">Motion</p>
        {state.connection === 'supported' ? <span className="text-xs text-ink-muted">Coursework workspace</span> : null}
      </div>
    </header>
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
          <WorkingPanel state={state} send={send} now={now} />
          {/* Coursework assistance appears only where it makes sense: on a page
              that actually carries an assignment or a discussion prompt. On a
              grades or calendar page it would be noise. */}
          {CARRIES_COURSEWORK.has(state.page.pageType ?? '') ? (
            <><WorkspaceView bridge={bridge} /><CourseworkView bridge={bridge} title={state.page.title || 'Coursework'} /></>
          ) : null}
        </>
      );
  }
}

export function App({ bridge, now = new Date(), className }: AppProps) {
  const state = usePanelState(bridge);

  return (
    <div className={cn('min-h-dvh bg-paper font-sans text-ink', className)}>
      <PanelHeader state={state} />
      <main className="mx-auto grid w-full max-w-lg gap-6 px-4 py-5" id="main-content">
        <ConnectionContent state={state} bridge={bridge} now={now} />
      </main>
    </div>
  );
}

export { EMPTY_PANEL_STATE };
