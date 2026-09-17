import { describe, expect, it } from 'vitest';
import { validateDestination } from './destination';

const ORIGINS = ['https://school.brightspace.com'];

describe('validateDestination', () => {
  it('rejects an unknown observed route even on a supported LMS host', () => {
    expect(validateDestination(
      'https://school.brightspace.com/d2l/logout', ORIGINS, 'observed-link', 'related',
    )).toMatchObject({ ok: false });
  });

  it('allows a route the adapter itself classifies as readable', () => {
    expect(validateDestination(
      'https://school.brightspace.com/d2l/le/content/363/viewContent/12/View', ORIGINS,
    )).toEqual({ ok: true });
  });

  // D-DEST-2 / SOL-10: `derive.ts` computes `observedRelation` from
  // page-controlled anchor text (a regex over the label). A hostile page can
  // label a `/d2l/logout` anchor "Rubric" so `derive.ts` tags it
  // `has-rubric`, a relation this module used to treat as authorization for
  // an otherwise-unclassified route. Regression: that must never grant
  // access, no matter which "safe" relation label is attached.
  it('never authorizes an unclassified route from a label-derived relation, however safe-looking', () => {
    for (const relation of ['has-rubric', 'has-instructions', 'has-reading', 'has-module', 'has-discussion'] as const) {
      expect(validateDestination(
        'https://school.brightspace.com/d2l/logout', ORIGINS, 'observed-link', relation,
      )).toEqual({ ok: false, reason: 'destination is not a route the adapter classifies as readable' });
    }
  });

  it('never authorizes an arbitrary unclassified same-origin path via a safe relation label', () => {
    expect(validateDestination(
      'https://school.brightspace.com/custom/reading', ORIGINS, 'observed-link', 'has-reading',
    )).toEqual({ ok: false, reason: 'destination is not a route the adapter classifies as readable' });
  });
});
