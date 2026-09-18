import { describe, expect, it } from 'vitest';
import { popupActionsFor, popupLauncherStateSchema } from './popup';

const base = popupLauncherStateSchema.parse({
  tabId: 3,
  windowId: 1,
  connection: 'supported',
  title: 'Synthetic assignment',
  courseLabel: 'TEST 101',
  relevantSessionId: null,
  relevantSessionTitle: null,
});

describe('popup quick actions', () => {
  it('starts a workspace only on a supported page with no relevant session', () => {
    expect(popupActionsFor(base)).toEqual(['start-workspace', 'open-motion', 'read-current-page']);
  });

  it('continues the existing workspace instead of duplicating actions', () => {
    expect(popupActionsFor({ ...base, relevantSessionId: 'session-1', relevantSessionTitle: 'Synthetic assignment' }))
      .toEqual(['continue-session', 'open-motion', 'read-current-page']);
  });

  it.each(['unsupported', 'restricted', 'signed-out', 'permission-needed', 'idle'] as const)(
    'keeps browser actions out of %s context',
    (connection) => {
      expect(popupActionsFor({ ...base, connection })).toEqual(['open-motion']);
    },
  );
});
