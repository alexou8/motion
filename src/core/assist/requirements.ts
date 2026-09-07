import { EXTRACTION_VERSION, type Provenance, type Requirement } from '../domain';

/**
 * Turns assignment instructions into a checklist a student can work through.
 *
 * Deterministic, not model-driven: a student needs to trust that every item
 * came from something the instructor actually wrote, which is why each
 * requirement keeps the sentence it was derived from and where on the page it
 * appeared. A generated "requirement" the instructor never set would be worse
 * than no checklist at all.
 */

/** Phrasing instructors use when stating an obligation. */
const OBLIGATION =
  /\b(must|should|need to|required to|are required|is required|make sure|ensure|be sure to|do not|don't|avoid|include|submit|cite|reference|use|provide|explain|describe|discuss|analyse|analyze|compare|justify|show your work|attach|upload|name your file)\b/i;

/** Phrasing that states a measurable constraint. */
const CONSTRAINT =
  /\b(\d+\s*(?:-|to|–)?\s*\d*\s*(?:words?|pages?|paragraphs?|slides?|minutes?|sources?|references?|citations?)|at least|at most|no more than|no fewer than|maximum|minimum|word count|page limit|double[- ]spaced|single[- ]spaced|\d+\s*pt\b|APA|MLA|Chicago|IEEE|Harvard)\b/i;

/** Phrasing that signals a marking criterion rather than an instruction. */
const CRITERION = /\b(marks?|points?|worth|weight(?:ed|ing)?|grade[ds]?|rubric|criteria|out of)\b/i;

export type RequirementKind = 'obligation' | 'constraint' | 'criterion';

export interface DerivedRequirement {
  text: string;
  kind: RequirementKind;
  /** Where in the source this came from, for the student to verify. */
  sourceExcerpt: string;
}

function classify(text: string): RequirementKind | null {
  // Order matters: a sentence about marks is a criterion even when it also
  // contains "must", because that is how a student needs it grouped.
  if (CRITERION.test(text)) return 'criterion';
  if (CONSTRAINT.test(text)) return 'constraint';
  if (OBLIGATION.test(text)) return 'obligation';
  return null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Splits on sentence ends without breaking on "e.g." or a decimal. */
function sentences(text: string): string[] {
  return text
    .split(/(?<![A-Z][a-z]\.)(?<=[.!?])\s+(?=[A-Z])/)
    .map(normalize)
    .filter(Boolean);
}

const MIN_LENGTH = 12;
const MAX_LENGTH = 320;

/**
 * Pull requirement-shaped statements out of instruction text.
 *
 * Deliberately conservative about what it keeps: a checklist with three real
 * items a student trusts is more useful than twenty containing navigation
 * chrome. Anything not clearly an obligation, constraint or criterion is
 * dropped rather than guessed at.
 */
export function deriveRequirements(
  blocks: { text: string; kind: 'list-item' | 'table-cell' | 'paragraph' | 'heading' }[],
  limit = 40,
): DerivedRequirement[] {
  const found: DerivedRequirement[] = [];
  const seen = new Set<string>();

  const consider = (candidate: string, source: string) => {
    const text = normalize(candidate);
    if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return;
    const kind = classify(text);
    if (!kind) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ text, kind, sourceExcerpt: normalize(source).slice(0, MAX_LENGTH) });
  };

  for (const block of blocks) {
    if (found.length >= limit) break;
    if (block.kind === 'heading') continue;

    if (block.kind === 'list-item' || block.kind === 'table-cell') {
      // A bullet or a rubric cell is already one unit of meaning; splitting it
      // into sentences would fragment "Cite at least 5 sources. Use APA."
      consider(block.text, block.text);
      continue;
    }

    for (const sentence of sentences(block.text)) {
      consider(sentence, block.text);
      if (found.length >= limit) break;
    }
  }

  return found.slice(0, limit);
}

/** Builds storable checklist items with provenance attached. */
export function toRequirements(
  derived: DerivedRequirement[],
  source: { url: string; pageTitle: string; pageType: string; capturedAt: string },
  newId: () => string,
): Requirement[] {
  return derived.map((item) => {
    const provenance: Provenance = {
      sourceUrl: source.url,
      pageTitle: source.pageTitle,
      platformId: 'd2l',
      pageType: source.pageType,
      capturedAt: source.capturedAt,
      extractionVersion: EXTRACTION_VERSION,
      strategy: `requirement:${item.kind}`,
    };
    return { id: newId(), text: item.text, done: false, provenance, manual: false };
  });
}
