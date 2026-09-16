import { describe, expect, it } from 'vitest';
import { agentTurn } from './definitions';

const valid = {
  sessionId: 'session-1',
  turnSeq: 4,
  steps: [{ id: 't4-0', title: 'Read assignment', action: 'read-page', input: { tabId: 10 } }],
};

describe('agent-turn definition', () => {
  it('preserves guarded, concrete steps', () => {
    expect(agentTurn.plan(valid)).toEqual(valid.steps);
  });

  it.each([
    { ...valid, steps: [{ ...valid.steps[0], id: 'step-1' }] },
    { ...valid, steps: [{ ...valid.steps[0], action: 'run-script' }] },
    { ...valid, steps: [{ ...valid.steps[0], input: [] }] },
    {
      ...valid,
      steps: [
        {
          id: 't4-0',
          title: 'Submit synthetic assignment?',
          action: 'submit-assignment',
          input: { tabId: 10 },
        },
      ],
    },
    { ...valid, sessionId: '' },
    { ...valid, turnSeq: 1.5 },
  ])('rejects malformed plan data', (params) => {
    expect(() => agentTurn.plan(params)).toThrow();
  });
});
