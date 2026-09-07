import type { Checklist, Requirement } from '../../core/domain';
import { Button, SourceLink, StatusMarker, Track } from '../../ui/components';
import { cn } from '../../ui/components/cn';
import type { MotionCommand } from '../bridge';

export interface ChecklistViewProps {
  checklist: Checklist | null;
  send: (command: MotionCommand) => void | Promise<void>;
  building?: boolean;
  className?: string;
}

function requirementKind(requirement: Requirement): string {
  const kind = requirement.provenance.strategy?.replace(/^requirement:/, '');
  return kind || 'requirement';
}

function requirementKindLabel(requirement: Requirement): string {
  const kind = requirementKind(requirement);
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function ChecklistItem({
  checklistId,
  requirement,
  onToggle,
}: {
  checklistId: string;
  requirement: Requirement;
  onToggle: (requirement: Requirement, done: boolean) => void;
}) {
  const checkboxId = `requirement-${checklistId}-${requirement.id}`;

  return (
    <li className="motion-track-item">
      <StatusMarker state={requirement.done ? 'done' : 'pending'} label={requirement.done ? 'Done' : 'Pending'} />
      <div className="min-w-0 pb-4">
        <label className="flex min-h-6 items-start gap-2 text-sm text-ink" htmlFor={checkboxId}>
          <input
            checked={requirement.done}
            className="mt-1 size-4 shrink-0 accent-signal"
            id={checkboxId}
            onChange={(event) => onToggle(requirement, event.target.checked)}
            type="checkbox"
          />
          <span className="text-pretty">{requirement.text}</span>
        </label>
        <p className="mt-2 text-xs text-ink-muted">Kind: {requirementKindLabel(requirement)}</p>
        <SourceLink
          className="mt-1"
          href={requirement.provenance.sourceUrl}
          pageTitle={requirement.provenance.pageTitle}
        />
      </div>
    </li>
  );
}

export function ChecklistView({ checklist, send, building = false, className }: ChecklistViewProps) {
  const items = checklist?.items ?? [];

  if (!checklist || items.length === 0) {
    return (
      <section className={cn('grid gap-3 rounded border border-rule bg-surface p-4', className)} aria-labelledby="checklist-empty-title">
        <div>
          <h1 className="text-lg font-medium text-balance" id="checklist-empty-title">
            Assignment checklist
          </h1>
          <p className="mt-1 text-sm text-ink-muted text-pretty">
            Motion found nothing stated as a requirement on this page. Open the assignment instructions or another course page and try again.
          </p>
        </div>
        <div>
          <Button disabled={building} onClick={() => send({ type: 'build-checklist' })} variant="primary">
            {building ? 'Building checklist' : 'Build from a different page'}
          </Button>
        </div>
      </section>
    );
  }

  const currentChecklist = checklist;

  return (
    <section className={cn('grid gap-3', className)} aria-labelledby="checklist-title">
      <div>
        <h1 className="text-lg font-medium text-balance" id="checklist-title">
          {checklist?.title || 'Assignment checklist'}
        </h1>
        <p className="mt-1 text-sm text-ink-muted text-pretty">
          Each item came from the assignment instructions. Check the source when you need the original wording.
        </p>
      </div>
      <Track label="Assignment requirements">
        {items.map((requirement) => (
          <ChecklistItem
            checklistId={currentChecklist.id}
            key={requirement.id}
            onToggle={(item, done) => send({
              type: 'toggle-requirement',
              checklistId: currentChecklist.id,
              requirementId: item.id,
              done,
            })}
            requirement={requirement}
          />
        ))}
      </Track>
    </section>
  );
}
