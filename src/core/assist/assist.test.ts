import { describe, expect, it } from 'vitest';
import { deriveRequirements, toRequirements } from './requirements';
import { checkConstraints, describeDraft, reviewDraft, summarize } from './draftReview';
import type { Requirement } from '../domain';

const SOURCE = {
  url: 'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101',
  pageTitle: 'Assignment 2',
  pageType: 'assignment',
  capturedAt: '2026-03-02T12:00:00.000Z',
};

let counter = 0;
const newId = () => `req-${++counter}`;

describe('deriving requirements from instructions', () => {
  it('picks up obligations, constraints and marking criteria', () => {
    const derived = deriveRequirements([
      { kind: 'paragraph', text: 'This assignment explores normalization.' },
      { kind: 'list-item', text: 'You must cite at least 5 peer-reviewed sources in APA format.' },
      { kind: 'list-item', text: 'Submissions should be 1500-2000 words.' },
      { kind: 'table-cell', text: 'Analysis depth — worth 40 marks' },
    ]);

    const kinds = derived.map((d) => d.kind);
    expect(kinds).toContain('constraint');
    expect(kinds).toContain('criterion');
    expect(derived.map((d) => d.text)).toContain(
      'You must cite at least 5 peer-reviewed sources in APA format.',
    );
  });

  it('leaves out prose that states no requirement', () => {
    const derived = deriveRequirements([
      { kind: 'paragraph', text: 'Welcome to week six. The library is open until nine.' },
    ]);
    expect(derived).toHaveLength(0);
  });

  it('ignores headings, which are labels rather than instructions', () => {
    const derived = deriveRequirements([{ kind: 'heading', text: 'You must read this section' }]);
    expect(derived).toHaveLength(0);
  });

  it('keeps a bullet whole rather than splitting it into fragments', () => {
    const derived = deriveRequirements([
      { kind: 'list-item', text: 'Cite at least 5 sources. Use APA formatting.' },
    ]);
    expect(derived).toHaveLength(1);
    expect(derived[0]?.text).toBe('Cite at least 5 sources. Use APA formatting.');
  });

  it('splits a paragraph into separate requirements', () => {
    const derived = deriveRequirements([
      {
        kind: 'paragraph',
        text: 'You must submit a PDF. The report should include a bibliography.',
      },
    ]);
    expect(derived.length).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates a requirement repeated on the page', () => {
    const derived = deriveRequirements([
      { kind: 'list-item', text: 'You must cite at least 5 sources.' },
      { kind: 'table-cell', text: 'You must cite at least 5 sources.' },
    ]);
    expect(derived).toHaveLength(1);
  });

  it('classifies a marking statement as a criterion even when it says "must"', () => {
    const derived = deriveRequirements([
      { kind: 'table-cell', text: 'Argument must be supported — worth 20 marks' },
    ]);
    expect(derived[0]?.kind).toBe('criterion');
  });

  it('attaches provenance so every item traces back to the instructions', () => {
    const derived = deriveRequirements([
      { kind: 'list-item', text: 'You must include a bibliography.' },
    ]);
    const requirements = toRequirements(derived, SOURCE, newId);

    expect(requirements[0]?.provenance.sourceUrl).toBe(SOURCE.url);
    expect(requirements[0]?.provenance.strategy).toBe('requirement:obligation');
    expect(requirements[0]?.done).toBe(false);
    expect(requirements[0]?.manual).toBe(false);
  });
});

function requirement(text: string, id = newId()): Requirement {
  return {
    id,
    text,
    done: false,
    manual: false,
    provenance: {
      sourceUrl: SOURCE.url,
      pageTitle: SOURCE.pageTitle,
      platformId: 'd2l',
      pageType: SOURCE.pageType,
      capturedAt: SOURCE.capturedAt,
      extractionVersion: 1,
    },
  };
}

describe('describing a draft', () => {
  it('counts words, sentences and paragraphs', () => {
    const stats = describeDraft('One two three. Four five.\n\nSecond paragraph here.');
    expect(stats.words).toBe(8);
    expect(stats.sentences).toBe(3);
    expect(stats.paragraphs).toBe(2);
  });

  it('handles an empty draft without dividing by zero', () => {
    expect(describeDraft('')).toEqual({ words: 0, sentences: 0, paragraphs: 0 });
  });
});

describe('checking numeric constraints exactly', () => {
  it('reports a draft under a stated minimum', () => {
    const checks = checkConstraints([requirement('Submissions must be at least 1500 words.')], {
      words: 900,
      sentences: 40,
      paragraphs: 6,
    });
    expect(checks[0]?.satisfied).toBe(false);
    expect(checks[0]?.detail).toContain('600 short');
  });

  it('reports a draft over a stated maximum', () => {
    const checks = checkConstraints([requirement('Use no more than 500 words.')], {
      words: 640,
      sentences: 30,
      paragraphs: 4,
    });
    expect(checks[0]?.satisfied).toBe(false);
    expect(checks[0]?.detail).toContain('140 over');
  });

  it('reports nothing when the requirement states no number', () => {
    const checks = checkConstraints([requirement('Write clearly and cite your sources.')], {
      words: 100,
      sentences: 5,
      paragraphs: 1,
    });
    expect(checks).toHaveLength(0);
  });
});

describe('reviewing a draft against requirements', () => {
  const requirements = [
    requirement('You must discuss functional dependencies.', 'r1'),
    requirement('Include a normalization example using third normal form.', 'r2'),
    requirement('Cite at least three peer-reviewed sources.', 'r3'),
  ];

  it('finds a requirement the draft clearly addresses', () => {
    const review = reviewDraft(
      'This report will discuss functional dependencies in detail across the schema.',
      requirements,
    );
    const finding = review.findings.find((f) => f.requirementId === 'r1');
    expect(finding?.coverage).toBe('addressed');
    expect(finding?.evidence).toContain('functional dependencies');
  });

  it('reports no evidence rather than declaring something missing', () => {
    const review = reviewDraft('This report discusses functional dependencies.', requirements);
    const finding = review.findings.find((f) => f.requirementId === 'r3');
    expect(finding?.coverage).toBe('no-evidence');
    // The wording matters: the check is lexical and must not overclaim.
    expect(finding?.explanation).toMatch(/different words|compares wording/i);
  });

  it('never rewrites or returns the draft as its own output', () => {
    const draft = 'My own sentence about dependencies.';
    const review = reviewDraft(draft, requirements);
    // Findings quote the draft as evidence but produce no replacement prose.
    for (const finding of review.findings) {
      expect(finding).not.toHaveProperty('suggestedText');
      expect(finding).not.toHaveProperty('rewrite');
    }
  });

  it('returns a finding for every requirement, in order', () => {
    const review = reviewDraft('Anything at all.', requirements);
    expect(review.findings.map((f) => f.requirementId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('summarizes honestly and flags the limits of the check', () => {
    const review = reviewDraft('Nothing relevant here.', requirements);
    const summary = summarize(review);
    expect(summary).toMatch(/no match/i);
    expect(summary).toMatch(/compares wording only/i);
  });

  it('says so plainly when there is nothing to check against', () => {
    expect(summarize(reviewDraft('Some text', []))).toMatch(/no requirements/i);
  });

  it('handles an empty draft without throwing', () => {
    const review = reviewDraft('', requirements);
    expect(review.findings.every((f) => f.coverage === 'no-evidence')).toBe(true);
    expect(review.stats.words).toBe(0);
  });
});
