import { useId, useRef, useState } from 'react';
import { GENERATED_LABEL, type DraftKind } from '../../core/assist';
import { Button, Callout, Field } from '../../ui/components';
import { cn } from '../../ui/components/cn';
import type { MotionCommand } from '../bridge';

export interface ModelStatus {
  availability: 'available' | 'downloadable' | 'downloading' | 'unavailable' | string;
  explanation: string;
}

export interface DraftResult {
  draft: string;
  label?: string;
  unsupported?: string[];
  kind?: DraftKind;
}

export type ComposeDraftHandler = (
  command: Extract<MotionCommand, { type: 'compose-draft' }>,
  signal: AbortSignal,
) => DraftResult | void | Promise<DraftResult | void>;

export interface DraftWorkspaceProps {
  checklistId: string;
  title: string;
  send: (command: MotionCommand) => void | Promise<void>;
  modelStatus?: ModelStatus;
  result?: DraftResult | null;
  existingDraft?: string;
  studentDirection?: string;
  generating?: boolean;
  error?: string | null;
  onCompose?: ComposeDraftHandler;
  onCancel?: () => void;
  className?: string;
}

const DRAFT_ACTIONS: { kind: DraftKind; label: string }[] = [
  { kind: 'outline', label: 'Write an outline' },
  { kind: 'full-draft', label: 'Write a first draft' },
  { kind: 'section', label: 'Write a section' },
  { kind: 'discussion-reply', label: 'Write a discussion reply' },
  { kind: 'revision', label: 'Revise this draft' },
];

const DEFAULT_MODEL_STATUS: ModelStatus = { availability: 'available', explanation: '' };

function actionLabel(kind: DraftKind): string {
  return DRAFT_ACTIONS.find((action) => action.kind === kind)?.label ?? 'Write a draft';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Drafting failed. Your text is still in the editor.';
}

export function DraftWorkspace({
  checklistId,
  title,
  send,
  modelStatus = DEFAULT_MODEL_STATUS,
  result = null,
  existingDraft = '',
  studentDirection = '',
  generating = false,
  error = null,
  onCompose,
  onCancel,
  className,
}: DraftWorkspaceProps) {
  const instanceId = useId();
  const [draft, setDraft] = useState(existingDraft);
  const [direction, setDirection] = useState(studentDirection);
  const [activeKind, setActiveKind] = useState<DraftKind | null>(result?.kind ?? null);
  const [localResult, setLocalResult] = useState<DraftResult | null>(null);
  const [localGenerating, setLocalGenerating] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const isGenerating = generating || localGenerating;
  const displayedResult = localResult ?? result;
  const available = modelStatus.availability === 'available';
  const draftId = `${instanceId}-draft-text`;
  const directionId = `${instanceId}-draft-direction`;
  const workspaceTitleId = `${instanceId}-workspace-title`;
  const resultTitleId = `${instanceId}-result-title`;
  const unsupportedClaimsTitleId = `${instanceId}-unsupported-claims-title`;

  const generate = async (kind: DraftKind) => {
    setActiveKind(kind);
    setLocalError(null);
    setCopied(false);
    const command: Extract<MotionCommand, { type: 'compose-draft' }> = {
      type: 'compose-draft',
      kind,
      checklistId,
      title,
      ...(draft ? { existingDraft: draft } : {}),
      ...(direction ? { studentDirection: direction } : {}),
    };

    const controller = new AbortController();
    abortRef.current = controller;
    setLocalGenerating(true);
    try {
      if (onCompose) {
        const next = await onCompose(command, controller.signal);
        if (next) setLocalResult({ ...next, kind: next.kind ?? kind });
      } else {
        await send(command);
      }
    } catch (caught) {
      if (!controller.signal.aborted) setLocalError(errorMessage(caught));
    } finally {
      if (!controller.signal.aborted) setLocalGenerating(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLocalGenerating(false);
    onCancel?.();
  };

  const copyDraft = async () => {
    if (!displayedResult) return;
    try {
      await navigator.clipboard?.writeText(displayedResult.draft);
      setCopied(true);
    } catch {
      setLocalError('The draft could not be copied. Select the text and copy it yourself.');
    }
  };

  const displayedError = error ?? localError;
  const unavailableExplanation = modelStatus.explanation || 'Drafting is not available in this browser right now.';

  return (
    <section className={cn('grid gap-5', className)} aria-labelledby={workspaceTitleId}>
      <div>
        <h1 className="text-lg font-medium text-balance" id={workspaceTitleId}>
          Draft workspace
        </h1>
        <p className="mt-1 text-sm text-ink-muted text-pretty">
          Choose what to prepare, then read and edit it in your own voice.
        </p>
      </div>

      {!available ? <Callout title="Drafting is unavailable" variant="info">{unavailableExplanation}</Callout> : null}

      <div className="grid gap-2" aria-label="Draft actions">
        <p className="text-sm font-medium text-ink">Prepare</p>
        <div className="flex flex-wrap gap-2">
          {DRAFT_ACTIONS.map(({ kind, label }) => (
            <Button disabled={!available || isGenerating} key={kind} onClick={() => void generate(kind)} variant="secondary">
              {label}
            </Button>
          ))}
        </div>
      </div>

      <Field htmlFor={directionId} hint="Optional. Motion uses this to shape the draft; it does not replace your requirements." label="What should it focus on?">
        <input
          className="min-h-6 w-full rounded-sm border border-edge bg-surface px-2 py-2 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          id={directionId}
          onChange={(event) => setDirection(event.target.value)}
          placeholder="For example, compare the two case studies"
          value={direction}
        />
      </Field>

      <Field htmlFor={draftId} hint="Paste is available. Your text stays here if drafting fails." label="Your draft">
        <textarea
          className="min-h-40 w-full resize-y rounded-sm border border-edge bg-surface px-2 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-muted focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          id={draftId}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Paste or write your draft here"
          value={draft}
        />
      </Field>

      {isGenerating ? (
        <div aria-live="polite" aria-busy="true" className="grid gap-2 rounded border border-signal bg-surface p-3">
          <p className="text-sm font-medium">Preparing {activeKind ? actionLabel(activeKind).toLowerCase() : 'your draft'}.</p>
          <p className="text-sm text-ink-muted text-pretty">Motion is working. Your text remains in the editor.</p>
          <div>
            <Button onClick={cancel} variant="quiet">Cancel</Button>
          </div>
        </div>
      ) : null}

      {displayedError ? <p className="text-sm text-danger" role="alert">{displayedError}</p> : null}

      {displayedResult ? (
        <section className="grid gap-3 border-t border-rule pt-4" aria-labelledby={resultTitleId}>
          <h2 className="text-md font-medium text-balance" id={resultTitleId}>
            {actionLabel(displayedResult.kind ?? activeKind ?? 'full-draft')}
          </h2>
          <p className="rounded border border-attention bg-surface p-3 text-sm text-ink text-pretty">{GENERATED_LABEL}</p>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded border border-rule bg-surface p-3 text-sm leading-relaxed text-ink">
            {displayedResult.draft}
          </pre>
          {displayedResult.unsupported && displayedResult.unsupported.length > 0 ? (
            <section className="grid gap-2" aria-labelledby={unsupportedClaimsTitleId}>
              <h3 className="text-md font-medium text-balance" id={unsupportedClaimsTitleId}>
                Check these before you use them
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink text-pretty">
                {displayedResult.unsupported.map((sentence) => <li key={sentence}>{sentence}</li>)}
              </ul>
            </section>
          ) : null}
          <p className="text-sm text-ink-muted text-pretty">Rewrite this in your own words before you hand it in.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void copyDraft()} variant="secondary">Copy draft</Button>
            {copied ? <span className="text-xs text-ink-muted" role="status">Copied.</span> : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}
