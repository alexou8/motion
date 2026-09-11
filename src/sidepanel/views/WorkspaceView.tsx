import { useState } from 'react';
import type { MotionBridge } from '../bridge';
import { Button, Callout } from '../../ui/components';

/**
 * Starts "Prepare workspace": the assignment and its linked readings, opened in
 * a tab group Motion owns. Progress is shown by the workflow card like any other
 * background work; this view only asks, and says plainly when Motion declined.
 */

interface PrepareResult {
  workflowId: string | null;
  reused?: boolean;
  reason?: string;
}

export interface WorkspaceViewProps {
  bridge: MotionBridge;
}

export function WorkspaceView({ bridge }: WorkspaceViewProps) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PrepareResult | null>(null);

  const prepare = async () => {
    setPending(true);
    setResult(null);
    const response = bridge.request
      ? await bridge.request<PrepareResult>({ type: 'prepare-workspace' })
      : null;
    setResult(response ?? { workflowId: null, reason: 'Motion could not prepare a workspace.' });
    setPending(false);
  };

  return (
    <section className="grid gap-3" aria-labelledby="workspace-title">
      <div>
        <h2 className="text-md font-medium" id="workspace-title">
          Workspace
        </h2>
        <p className="mt-1 text-sm text-ink-muted text-pretty">
          Opens this assignment and its linked readings in a Motion tab group. Motion only opens
          and reads those tabs; it never clicks, types, or submits anything.
        </p>
      </div>
      <div aria-live="polite">
        {result?.reason ? <Callout variant="info">{result.reason}</Callout> : null}
        {result?.reused ? (
          <Callout variant="info">This workspace is already open.</Callout>
        ) : null}
      </div>
      <Button variant="primary" disabled={pending} onClick={() => void prepare()}>
        {pending ? 'Preparing workspace…' : 'Prepare workspace'}
      </Button>
    </section>
  );
}
