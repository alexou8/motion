import { useCallback, useEffect, useState } from 'react';
import type { Checklist } from '@/core/domain';
import type { DraftReview } from '@/core/assist';
import type { MotionBridge, MotionCommand } from '../bridge';
import { ChecklistView } from './ChecklistView';
import { DraftWorkspace } from './DraftWorkspace';
import { ReviewBeforeSubmit } from './ReviewBeforeSubmit';
import { Callout } from '../../ui/components';

/**
 * Holds the coursework flow together: requirements, then drafting, then the
 * check before the student hands it in.
 *
 * The three are separate views rather than one screen because they are separate
 * decisions — and because a student arriving with a draft already written
 * should not have to walk past a "write it for me" button to get it reviewed.
 */

interface DraftResult {
  draft: string;
  label?: string;
  unsupported?: string[];
  reason?: string;
}

interface ModelStatus {
  availability: string;
  explanation: string;
}

export interface CourseworkViewProps {
  bridge: MotionBridge;
  title: string;
}

export function CourseworkView({ bridge, title }: CourseworkViewProps) {
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [checklistNote, setChecklistNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [review, setReview] = useState<{ review: DraftReview | null; summary: string } | null>(null);
  const [model, setModel] = useState<ModelStatus | undefined>(undefined);
  const [building, setBuilding] = useState(false);
  const [generating, setGenerating] = useState(false);

  const request = useCallback(
    async <T,>(command: MotionCommand): Promise<T | null> =>
      bridge.request ? bridge.request<T>(command) : null,
    [bridge],
  );

  // Ask once whether drafting is possible at all, so the buttons can be honest
  // about it rather than failing when pressed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await request<ModelStatus>({ type: 'model-status' });
      if (!cancelled && status) setModel(status);
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  const send = useCallback(
    async (command: MotionCommand) => {
      switch (command.type) {
        case 'build-checklist': {
          setBuilding(true);
          setChecklistNote(null);
          const result = await request<{
            checklistId: string | null;
            items: number;
            reason?: string;
          }>(command);
          setBuilding(false);
          if (!result?.checklistId) {
            // Say what happened rather than leaving an empty list looking broken.
            setChecklistNote(
              result?.reason ?? 'Motion could not build a checklist from this page.',
            );
            return;
          }
          const stored = await request<Checklist>({ type: 'get-checklist', checklistId: result.checklistId });
          if (stored) setChecklist(stored);
          return;
        }

        case 'toggle-requirement': {
          // Reflect the click immediately; the worker remains the source of
          // truth and the next refresh corrects any disagreement.
          setChecklist((current) =>
            current
              ? {
                  ...current,
                  items: current.items.map((item) =>
                    item.id === command.requirementId ? { ...item, done: command.done } : item,
                  ),
                }
              : current,
          );
          await request(command);
          return;
        }

        case 'compose-draft': {
          setGenerating(true);
          const result = await request<DraftResult>(command);
          setGenerating(false);
          setDraft(result ?? { draft: '', reason: 'Motion could not draft that.' });
          return;
        }

        case 'review-draft': {
          const result = await request<{ review: DraftReview | null; summary: string }>(command);
          if (result) setReview(result);
          return;
        }

        default:
          await bridge.send(command);
      }
    },
    [bridge, request],
  );

  return (
    <div className="grid gap-6">
      <ChecklistView
        checklist={checklist}
        send={(command) => void send(command)}
        building={building}
      />

      {checklistNote ? (
        <Callout variant="info" title="Nothing to put on a checklist">
          <p>{checklistNote}</p>
        </Callout>
      ) : null}

      <DraftWorkspace
        checklistId={checklist?.id ?? ''}
        title={title}
        send={(command) => void send(command)}
        generating={generating}
        {...(model ? { modelStatus: model } : {})}
        result={draft}
      />

      {review?.review ? (
        <ReviewBeforeSubmit review={review.review} summary={review.summary} />
      ) : null}
    </div>
  );
}
