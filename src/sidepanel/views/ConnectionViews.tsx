import type { PanelState } from '../../core/view/state';
import { Button, Callout } from '../../ui/components';
import { OPEN_COURSE_GUIDANCE, supportedSitesSentence } from '../../core/view/supportedSites';
import type { MotionCommand } from '../bridge';

interface ConnectionViewProps {
  state: PanelState;
  send: (command: MotionCommand) => void;
}

function pageName(state: PanelState): string {
  return state.page.title || 'This page';
}

/**
 * What a new student needs on any tab Motion cannot work with: where Motion
 * works, and the one thing to do next. No page action is offered here — on a
 * tab Motion does not read, a note or a read would only fail.
 */
function SupportedSitesGuidance({ send }: Pick<ConnectionViewProps, 'send'>) {
  return (
    <div className="grid gap-2 text-sm text-ink-muted text-pretty">
      <p>{supportedSitesSentence()}</p>
      <p className="font-medium text-ink">{OPEN_COURSE_GUIDANCE}</p>
      <p>
        <button
          type="button"
          onClick={() => send({ type: 'open-settings' })}
          className="text-signal underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Open settings
        </button>
      </p>
    </div>
  );
}

export function IdleView({ send }: ConnectionViewProps) {
  return (
    <section className="grid gap-3 rounded border border-rule bg-surface p-4" aria-labelledby="idle-title">
      <h2 className="text-md font-medium text-balance" id="idle-title">
        Motion organizes coursework
      </h2>
      <p className="text-sm text-ink-muted text-pretty">
        On a course page, Motion shows deadlines with their sources, keeps notes, and tracks
        background work as it progresses.
      </p>
      <SupportedSitesGuidance send={send} />
    </section>
  );
}

export function UnsupportedView({ state, send }: ConnectionViewProps) {
  return (
    <section className="grid gap-4" aria-labelledby="unsupported-title">
      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">Not a Brightspace page</p>
        <h1 className="text-lg font-medium text-balance" id="unsupported-title">
          {pageName(state)}
        </h1>
      </div>
      <p className="text-sm text-ink-muted text-pretty">
        Motion cannot read coursework from this page.
      </p>
      <SupportedSitesGuidance send={send} />
    </section>
  );
}

/**
 * A supported, permitted tab that has never reported to the worker: it was
 * open before Motion was installed, so Chrome never injected the content
 * script. Only a reload fixes that.
 */
export function ReloadTabView({ state, send }: ConnectionViewProps) {
  return (
    <section className="grid gap-4" aria-labelledby="reload-title">
      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">Brightspace page</p>
        <h1 className="text-lg font-medium text-balance" id="reload-title">
          Reload this tab so Motion can read it
        </h1>
      </div>
      <p className="text-sm text-ink-muted text-pretty">
        {pageName(state)} was open before Motion was installed, so Motion cannot see it yet.
        Reloading keeps you on the same page.
      </p>
      <div>
        <Button variant="primary" onClick={() => send({ type: 'reload-tab' })}>
          Reload tab
        </Button>
      </div>
    </section>
  );
}

export function SignedOutView({ state, send }: ConnectionViewProps) {
  return (
    <section className="grid gap-4" aria-labelledby="signed-out-title">
      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">Signed out</p>
        <h1 className="text-lg font-medium text-balance" id="signed-out-title">
          Your Brightspace session has ended
        </h1>
      </div>
      <Callout variant="warning" title="Sign in to continue">
        <p>
          Brightspace sent this tab to its sign-in page, so there is no coursework on it to read. Sign in
          again in the tab, then ask Motion to read the page.
        </p>
      </Callout>
      <p className="text-sm text-ink-muted text-pretty">
        Deadlines and notes Motion already saved are unaffected and stay available.
      </p>
      <div>
        <Button variant="primary" onClick={() => send({ type: 'read-page', url: state.page.url })}>
          Read the page again
        </Button>
      </div>
    </section>
  );
}

export function PermissionNeededView({ state, send }: ConnectionViewProps) {
  return (
    <section className="grid gap-4" aria-labelledby="permission-title">
      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">Permission needed</p>
        <h1 className="text-lg font-medium text-balance" id="permission-title">
          Let Motion read {pageName(state)}
        </h1>
      </div>
      <Callout variant="warning" title="Motion needs you">
        This page is on a Brightspace site, but the browser has not granted Motion access to it. The page will stay unchanged until you choose to allow access.
      </Callout>
      <div>
        <Button variant="primary" onClick={() => send({ type: 'request-permission' })}>
          Request page permission
        </Button>
      </div>
    </section>
  );
}

/**
 * Restricted mode deliberately offers NO action that touches this page — not
 * reading it, not capturing a note from it.
 *
 * Capturing text during a graded attempt is the exact behaviour the policy
 * exists to prevent, so the button must not be there to click. The content
 * script already refuses to extract here, but a UI that invites the attempt and
 * silently does nothing teaches the student the wrong thing about the product.
 * The honest move is to say what Motion will not do, and why.
 */
export function RestrictedView({ state }: ConnectionViewProps) {
  return (
    <section className="grid gap-4" aria-labelledby="restricted-title">
      <div>
        <h1 className="text-lg font-medium text-balance" id="restricted-title">
          Restricted mode
        </h1>
        <p className="mt-1 text-sm text-ink-muted text-pretty">{pageName(state)}</p>
      </div>
      <Callout variant="restricted" title="Motion is standing back">
        <p className="font-medium">
          {state.page.restrictionReason || 'This page looks like a graded attempt.'}
        </p>
        <p className="mt-2">
          Motion will not read this page, capture from it, or draft anything here. Nothing on it is
          being stored.
        </p>
      </Callout>
      <div className="text-sm text-ink-muted">
        <p className="font-medium text-ink">What you can still do</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-pretty">
          <li>Open Motion on another tab to review notes you made earlier.</li>
          <li>Check your deadlines for this course from the course home page.</li>
        </ul>
        <p className="mt-3 text-pretty">
          If this is not an assessment, Motion will pick the page up again once you navigate away
          and back.
        </p>
      </div>
    </section>
  );
}
