import { useId } from 'react';
import type { Coverage, DraftReview, RequirementFinding } from '../../core/assist';
import { summarize } from '../../core/assist';
import { StatusMarker } from '../../ui/components';
import { cn } from '../../ui/components/cn';

export interface ReviewBeforeSubmitProps {
  review: DraftReview;
  summary?: string;
  className?: string;
}

function coverageMarker(coverage: Coverage): 'done' | 'active' | 'pending' {
  if (coverage === 'addressed') return 'done';
  if (coverage === 'partial') return 'active';
  return 'pending';
}

function coverageLabel(coverage: Coverage): string {
  if (coverage === 'addressed') return 'Addressed';
  if (coverage === 'partial') return 'Partial';
  return 'No evidence';
}

function findingCopy(finding: RequirementFinding): string {
  if (finding.coverage === 'no-evidence') {
    return 'Motion compared wording only. Check this requirement yourself.';
  }
  return finding.explanation;
}

function Finding({ finding }: { finding: RequirementFinding }) {
  return (
    <li className="grid gap-2 border-b border-rule pb-3 last:border-b-0 last:pb-0">
      <div className="flex items-start gap-2">
        <StatusMarker label={coverageLabel(finding.coverage)} state={coverageMarker(finding.coverage)} />
        <p className="min-w-0 text-sm font-medium text-ink text-pretty">{coverageLabel(finding.coverage)}</p>
      </div>
      <p className="text-sm text-ink text-pretty">{finding.requirement}</p>
      {finding.evidence ? (
        <p className="border-l-2 border-rule pl-3 text-sm text-ink-muted text-pretty">
          Evidence: “{finding.evidence}”
        </p>
      ) : null}
      <p className="text-xs text-ink-muted text-pretty">{findingCopy(finding)}</p>
    </li>
  );
}

export function ReviewBeforeSubmit({ review, summary, className }: ReviewBeforeSubmitProps) {
  const instanceId = useId();
  const reviewTitleId = `${instanceId}-review-title`;
  const coverageTitleId = `${instanceId}-coverage-title`;
  const constraintsTitleId = `${instanceId}-constraints-title`;
  const studentControlTitleId = `${instanceId}-student-control-title`;

  return (
    <section className={cn('grid gap-5', className)} aria-labelledby={reviewTitleId}>
      <div>
        <h1 className="text-lg font-medium text-balance" id={reviewTitleId}>
          Review before you hand it in
        </h1>
        <p className="mt-1 text-sm text-ink-muted text-pretty">{summary ?? summarize(review)}</p>
        <p className="mt-2 text-xs text-ink-muted">
          <span className="figure">{review.stats.words}</span> words · <span className="figure">{review.stats.sentences}</span> sentences · <span className="figure">{review.stats.paragraphs}</span> paragraphs
        </p>
      </div>

      <section className="grid gap-3" aria-labelledby={coverageTitleId}>
        <h2 className="text-md font-medium text-balance" id={coverageTitleId}>Requirement coverage</h2>
        {review.findings.length > 0 ? (
          <ul className="grid gap-3 rounded border border-rule bg-surface p-3">
            {review.findings.map((finding) => <Finding finding={finding} key={finding.requirementId} />)}
          </ul>
        ) : (
          <p className="rounded border border-rule bg-surface p-3 text-sm text-ink-muted text-pretty">No requirements were provided for this review.</p>
        )}
      </section>

      {review.constraintChecks.length > 0 ? (
        <section className="grid gap-3" aria-labelledby={constraintsTitleId}>
          <h2 className="text-md font-medium text-balance" id={constraintsTitleId}>Constraint checks</h2>
          <ul className="grid gap-2">
            {review.constraintChecks.map((check) => (
              <li className="flex items-start gap-2 rounded border border-rule bg-surface p-3 text-sm" key={`${check.label}-${check.detail}`}>
                <StatusMarker
                  label={check.satisfied === true ? 'Pass' : check.satisfied === false ? 'Needs attention' : 'Not checked'}
                  state={check.satisfied === true ? 'done' : check.satisfied === false ? 'blocked' : 'pending'}
                />
                <span className="min-w-0 text-pretty"><strong className="font-medium">{check.label}:</strong> {check.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <aside className="grid gap-1 border-l-4 border-signal bg-surface px-3 py-2" aria-labelledby={studentControlTitleId}>
        <h2 className="font-medium text-balance" id={studentControlTitleId}>You're submitting this yourself</h2>
        <p className="text-sm text-ink-muted text-pretty">Motion has not submitted anything. You submit it in your LMS.</p>
      </aside>
    </section>
  );
}
