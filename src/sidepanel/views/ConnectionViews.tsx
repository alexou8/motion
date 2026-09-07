import type { PanelState } from '../../core/view/state';
import { Button, Callout, EmptyState } from '../../ui/components';
import type { MotionCommand } from '../bridge';

interface ConnectionViewProps {
  state: PanelState;
  send: (command: MotionCommand) => void;
}

function pageName(state: PanelState): string {
  return state.page.title || 'This page';
}

export function IdleView({ send }: ConnectionViewProps) {
  return (
    <EmptyState title="Motion organizes coursework" actionLabel="Read a course page" onAction={() => send({ type: 'read-page', url: null })}>
      Open a course page to see deadlines with their sources, keep notes, and watch background work as it progresses.
    </EmptyState>
  );
}

export function UnsupportedView({ state, send }: ConnectionViewProps) {
  return (
    <section className="grid gap-4" aria-labelledby="unsupported-title">
      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">Unsupported page</p>
        <h1 className="text-lg font-medium text-balance" id="unsupported-title">
          {pageName(state)}
        </h1>
      </div>
      <p className="text-sm text-ink-muted text-pretty">
        Motion cannot read coursework from this page yet. You can still keep a note or read the page yourself.
      </p>
      <div>
        <Button variant="secondary" onClick={() => send({ type: 'create-note', pageUrl: state.page.url })}>
          Add a note
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
        This page is on a supported type of site, but the browser has not granted Motion access to it. The page will stay unchanged until you choose to allow access.
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
