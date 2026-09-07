import type { Requirement } from '../domain';

/**
 * Compares a student's own draft against the requirements extracted from the
 * assignment, and reports what looks unaddressed.
 *
 * This is a reading aid, not a grader. It works on the student's text, which
 * they wrote and supplied, and it never rewrites it — the output is a list of
 * things to go and look at. It deliberately reports "no evidence found" rather
 * than "missing", because the check is lexical and a student can satisfy a
 * requirement in words this cannot match.
 */

export type Coverage = 'addressed' | 'partial' | 'no-evidence';

export interface RequirementFinding {
  requirementId: string;
  requirement: string;
  coverage: Coverage;
  /** The strongest matching sentence from the draft, when there is one. */
  evidence: string | null;
  /** Why the checker reached this conclusion, in the student's terms. */
  explanation: string;
}

export interface DraftStats {
  words: number;
  sentences: number;
  paragraphs: number;
}

export interface DraftReview {
  stats: DraftStats;
  findings: RequirementFinding[];
  /** Constraints Motion could check numerically, e.g. a word count. */
  constraintChecks: ConstraintCheck[];
}

export interface ConstraintCheck {
  label: string;
  satisfied: boolean | null;
  detail: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do', 'does', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'its', 'must', 'need', 'not', 'of', 'on', 'or', 'should',
  'that', 'the', 'their', 'this', 'to', 'use', 'using', 'was', 'were', 'will', 'with', 'you',
  'your', 'ensure', 'include', 'make', 'sure', 'provide', 'at', 'least', 'each', 'all', 'any',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function describeDraft(draft: string): DraftStats {
  const words = draft.split(/\s+/).filter(Boolean).length;
  return {
    words,
    sentences: splitSentences(draft).length,
    paragraphs: draft.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).length,
  };
}

/**
 * Numeric constraints stated in a requirement, which can be checked exactly
 * rather than guessed at. Only reported when the requirement actually states
 * one — an invented word count would be worse than silence.
 */
export function checkConstraints(requirements: Requirement[], stats: DraftStats): ConstraintCheck[] {
  const checks: ConstraintCheck[] = [];

  for (const requirement of requirements) {
    const wordRange =
      /\b(?:at least|minimum(?: of)?|no fewer than)\s+(\d{2,5})\s*words?\b/i.exec(requirement.text);
    if (wordRange?.[1]) {
      const minimum = Number(wordRange[1]);
      checks.push({
        label: `At least ${minimum} words`,
        satisfied: stats.words >= minimum,
        detail:
          stats.words >= minimum
            ? `Your draft has ${stats.words} words.`
            : `Your draft has ${stats.words} words, ${minimum - stats.words} short.`,
      });
      continue;
    }

    const maximum =
      /\b(?:no more than|at most|maximum(?: of)?|under)\s+(\d{2,5})\s*words?\b/i.exec(
        requirement.text,
      );
    if (maximum?.[1]) {
      const limit = Number(maximum[1]);
      checks.push({
        label: `At most ${limit} words`,
        satisfied: stats.words <= limit,
        detail:
          stats.words <= limit
            ? `Your draft has ${stats.words} words.`
            : `Your draft has ${stats.words} words, ${stats.words - limit} over.`,
      });
    }
  }

  return checks;
}

/**
 * @param draft the student's own text, supplied by them
 * @param requirements what the assignment asks for
 */
export function reviewDraft(draft: string, requirements: Requirement[]): DraftReview {
  const stats = describeDraft(draft);
  const draftSentences = splitSentences(draft);
  const sentenceTokens = draftSentences.map((sentence) => new Set(tokens(sentence)));

  const findings: RequirementFinding[] = requirements.map((requirement) => {
    const needed = tokens(requirement.text);
    if (needed.length === 0) {
      return {
        requirementId: requirement.id,
        requirement: requirement.text,
        coverage: 'no-evidence' as const,
        evidence: null,
        explanation: 'Motion could not tell what to look for in this one — check it yourself.',
      };
    }

    let bestScore = 0;
    let bestIndex = -1;
    sentenceTokens.forEach((present, index) => {
      const hits = needed.filter((word) => present.has(word)).length;
      const score = hits / needed.length;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    const evidence = bestIndex >= 0 ? (draftSentences[bestIndex] ?? null) : null;

    if (bestScore >= 0.6) {
      return {
        requirementId: requirement.id,
        requirement: requirement.text,
        coverage: 'addressed' as const,
        evidence,
        explanation: 'Your draft covers most of the terms this asks for.',
      };
    }
    if (bestScore >= 0.3) {
      return {
        requirementId: requirement.id,
        requirement: requirement.text,
        coverage: 'partial' as const,
        evidence,
        explanation: 'Some of this appears in your draft, but not all of it. Worth a second look.',
      };
    }
    return {
      requirementId: requirement.id,
      requirement: requirement.text,
      coverage: 'no-evidence' as const,
      evidence: null,
      explanation:
        'Motion found nothing in your draft matching this. It may still be covered in different words — this check only compares wording.',
    };
  });

  return { stats, findings, constraintChecks: checkConstraints(requirements, stats) };
}

/** A short, honest summary for the panel header. */
export function summarize(review: DraftReview): string {
  const missing = review.findings.filter((f) => f.coverage === 'no-evidence').length;
  const partial = review.findings.filter((f) => f.coverage === 'partial').length;
  if (review.findings.length === 0) return 'No requirements to check against yet.';
  if (missing === 0 && partial === 0) return 'Every requirement appears somewhere in your draft.';
  const parts: string[] = [];
  if (missing > 0) parts.push(`${missing} with no match`);
  if (partial > 0) parts.push(`${partial} only partly covered`);
  return `${parts.join(', ')}. This compares wording only — check them yourself.`;
}
