import { useCallback, useEffect, useRef, useState } from 'react';
import { MotionMark } from '@/ui/components';
import {
  OPEN_COURSE_GUIDANCE,
  popupActionsFor,
  supportedSitesSentence,
  type PopupAction,
  type PopupLauncherState,
} from '@/core/view';
import { createPopupBridge, type PopupBridge } from './runtimeBridge';

const labels: Record<PopupAction, string> = {
  'open-motion': 'Open Motion',
  'start-workspace': 'Start workspace',
  'continue-session': 'Continue workspace',
  'read-current-page': 'Read this page',
  'scan-deadlines': 'Find deadlines',
};

function contextCopy(state: PopupLauncherState): string {
  if (state.connection === 'restricted') return 'Motion will not read or act inside this active assessment.';
  if (state.connection === 'unsupported' || state.connection === 'idle')
    return `${supportedSitesSentence()} ${OPEN_COURSE_GUIDANCE}`;
  if (state.connection === 'signed-out') return 'Sign in to Brightspace, then reopen Motion to work with this page.';
  if (state.connection === 'permission-needed') return 'Motion needs browser access for this Brightspace site before it can work with the page.';
  return state.courseLabel ? `${state.courseLabel} · ${state.title || 'Coursework'}` : state.title || 'Supported course page';
}

export function PopupApp({ bridge }: { bridge?: PopupBridge }) {
  const defaultBridge = useRef<PopupBridge | null>(null);
  if (!defaultBridge.current) defaultBridge.current = createPopupBridge();
  const popupBridge = bridge ?? defaultBridge.current;
  const [state, setState] = useState<PopupLauncherState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<PopupAction | 'settings' | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(() => {
    setLoadError(null);
    void popupBridge
      .getContext()
      .then((result) => {
        if (result.ok && result.data) setState(result.data);
        else setLoadError(result.ok ? 'Motion received no page context.' : result.message);
      })
      .catch(() => setLoadError('Motion could not reach its background worker.'));
  }, [popupBridge]);

  useEffect(load, [load]);

  /**
   * Opens the side panel without page context, so a worker failure never
   * strands the student in the popup. Called synchronously in the click.
   */
  const openPanelOnly = () => {
    const windowId = popupBridge.windowId?.() ?? null;
    if (windowId === null) {
      setNotice('Motion could not find this window. Click the Motion toolbar icon again.');
      return;
    }
    setNotice(null);
    chrome.sidePanel
      .open({ windowId })
      .then(() => window.close())
      .catch(() => setNotice('Motion could not open the side panel. Try again.'));
  };

  const run = (action: PopupAction) => {
    if (!state || busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setNotice(null);
    // Chrome requires this direct user-gesture call. Do it before awaiting the
    // worker command; an action failure deliberately leaves this popup open.
    const panelOpening = chrome.sidePanel.open({ windowId: state.windowId });
    void (async () => {
      try {
        await panelOpening;
      } catch {
        setBusy(null);
        inFlight.current = false;
        setNotice('Motion could not open the side panel. Try again.');
        return;
      }
      try {
        const result = await popupBridge.run(action, state);
        setBusy(null);
        inFlight.current = false;
        if (!result.ok) {
          setNotice(result.message);
          return;
        }
        window.close();
      } catch {
        setBusy(null);
        inFlight.current = false;
        setNotice('Motion could not complete that action. Try again.');
      }
    })();
  };

  const openSettings = () => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setBusy('settings');
    setNotice(null);
    void popupBridge.openSettings()
      .then((result) => {
        setBusy(null);
        inFlight.current = false;
        if (result.ok) window.close();
        else setNotice(result.message);
      })
      .catch(() => {
        setBusy(null);
        inFlight.current = false;
        setNotice('Motion could not open Settings. Try again.');
      });
  };

  return (
    <main className="w-80 bg-paper p-4 font-sans text-ink" aria-labelledby="motion-popup-title">
      <header className="flex items-center gap-2 border-b border-rule pb-3">
        <MotionMark className="size-5 text-signal" />
        <h1 className="font-serif text-lg font-semibold" id="motion-popup-title">Motion</h1>
      </header>
      {state ? (
        <>
          <p className="mt-3 text-sm text-ink text-pretty">{contextCopy(state)}</p>
          <div className="mt-4 grid gap-2">
            {popupActionsFor(state).map((action, index) => (
              <button
                key={action}
                type="button"
                disabled={busy !== null}
                onClick={() => run(action)}
                className={`min-h-10 rounded-sm px-3 py-2 text-left text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60 ${index === 0 ? 'bg-signal text-paper hover:bg-signal/90' : 'border border-edge bg-surface text-ink hover:bg-sunken'}`}
              >
                {busy === action ? `${labels[action]}…` : labels[action]}
              </button>
            ))}
          </div>
        </>
      ) : loadError ? (
        <div className="mt-3 grid gap-2">
          <p className="text-sm text-ink text-pretty" role="alert">
            Motion could not load this page’s context. {loadError}
          </p>
          <div className="grid gap-2">
            <button
              type="button"
              onClick={openPanelOnly}
              className="min-h-10 rounded-sm bg-signal px-3 py-2 text-left text-sm font-medium text-paper hover:bg-signal/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {labels['open-motion']}
            </button>
            <button
              type="button"
              onClick={load}
              className="min-h-10 rounded-sm border border-edge bg-surface px-3 py-2 text-left text-sm font-medium text-ink hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Retry
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink-muted">Loading page context…</p>
      )}
      {notice ? <p className="mt-3 text-sm text-danger" role="alert">{notice}</p> : null}
      <button type="button" className="mt-4 text-sm text-ink-muted underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" disabled={busy !== null} onClick={openSettings}>
        {busy === 'settings' ? 'Opening Settings…' : 'Settings'}
      </button>
    </main>
  );
}
