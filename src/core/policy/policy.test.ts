import { describe, expect, it } from 'vitest';
import {
  actionTypeSchema,
  approvalRequestSchema,
  approvalExpiry,
  evaluateAssessmentContext,
  HIGH_RISK_TTL_MS,
  isApprovalUsable,
  isImplemented,
  isProhibited,
  requiresApproval,
  riskOf,
  type ActionType,
  type ApprovalRequest,
} from './index';

const NOW = new Date('2026-03-02T12:00:00.000Z');

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return approvalRequestSchema.parse({
    id: 'a1',
    workflowId: 'w1',
    stepId: 's1',
    action: 'post-discussion',
    risk: 'high',
    summary: 'Post your draft reply to the Week 6 discussion.',
    target: 'CP363 · Week 6 discussion',
    effect: 'Your reply becomes visible to your class. Motion cannot delete it afterwards.',
    reversible: false,
    status: 'approved',
    requestedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + HIGH_RISK_TTL_MS).toISOString(),
    ...overrides,
  });
}

describe('risk classification', () => {
  it('classifies every declared action', () => {
    for (const action of actionTypeSchema.options) {
      expect(['low', 'medium', 'high']).toContain(riskOf(action));
    }
  });

  it('requires approval for everything that is not low risk', () => {
    for (const action of actionTypeSchema.options) {
      expect(requiresApproval(action)).toBe(riskOf(action) !== 'low');
    }
  });

  it('treats reading a page and taking notes as low risk', () => {
    expect(riskOf('read-page')).toBe('low');
    expect(riskOf('create-note')).toBe('low');
    expect(requiresApproval('read-page')).toBe(false);
  });
});

describe('academic-integrity boundary', () => {
  it.each<ActionType>(['submit-assignment', 'act-in-graded-quiz', 'modify-course-data'])(
    'refuses %s outright',
    (action) => {
      expect(isProhibited(action)).toBe(true);
      expect(isImplemented(action)).toBe(false);
    },
  );

  it('every prohibited action is also classified high risk', () => {
    for (const action of actionTypeSchema.options) {
      if (isProhibited(action)) expect(riskOf(action)).toBe('high');
    }
  });

  it('refuses a prohibited action even when an approval record says approved', () => {
    const forged = approval({ action: 'submit-assignment', status: 'approved', expiresAt: null });
    const result = isApprovalUsable(forged, NOW);
    expect(result.usable).toBe(false);
    if (!result.usable) expect(result.reason).toMatch(/not something Motion performs/i);
  });
});

describe('approval expiry', () => {
  it('gives high-risk approvals a short window and leaves medium-risk open', () => {
    expect(approvalExpiry('post-discussion', NOW)).toBe(
      new Date(NOW.getTime() + HIGH_RISK_TTL_MS).toISOString(),
    );
    expect(approvalExpiry('create-checklist', NOW)).toBeNull();
  });

  it('accepts an approval inside its window', () => {
    expect(isApprovalUsable(approval(), NOW).usable).toBe(true);
  });

  it('rejects a stale high-risk approval replayed after a restart', () => {
    const later = new Date(NOW.getTime() + HIGH_RISK_TTL_MS + 1);
    const result = isApprovalUsable(approval(), later);
    expect(result.usable).toBe(false);
    if (!result.usable) expect(result.reason).toMatch(/expired/i);
  });

  it.each(['pending', 'denied', 'expired'] as const)('rejects a %s approval', (status) => {
    expect(isApprovalUsable(approval({ status }), NOW).usable).toBe(false);
  });
});

describe('restricted mode on graded assessments', () => {
  it('restricts a known quiz-attempt page type', () => {
    const result = evaluateAssessmentContext({
      pageType: 'quiz-attempt',
      url: 'https://example.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=12345',
    });
    expect(result.restricted).toBe(true);
    expect(result.allowedActions).toEqual(['read-page']);
    expect(result.reason).not.toBe('');
  });

  it.each([
    'https://mylearningspace.wlu.ca/d2l/lms/quizzing/user/attempt/quiz_attempt.d2l?ou=9',
    'https://lms.example.edu/courses/9/take-exam',
    'https://lms.example.edu/proctored/session/4',
  ])('restricts an unrecognised route that looks like an attempt: %s', (url) => {
    expect(evaluateAssessmentContext({ pageType: 'unsupported', url }).restricted).toBe(true);
  });

  it('restricts when the page text reads like a timed assessment', () => {
    const result = evaluateAssessmentContext({
      pageType: 'unsupported',
      url: 'https://lms.example.edu/some/opaque/path',
      visibleText: 'Time remaining: 42:10 — Question 3 of 20',
    });
    expect(result.restricted).toBe(true);
  });

  it('does not restrict ordinary coursework pages', () => {
    const result = evaluateAssessmentContext({
      pageType: 'assignment',
      url: 'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?db=77&ou=12345',
      visibleText: 'Submit your design document. Due Oct 14, 2025 11:59 PM.',
    });
    expect(result.restricted).toBe(false);
  });

  it('does not mistake a quiz list for an attempt in progress', () => {
    expect(
      evaluateAssessmentContext({
        pageType: 'quiz-list',
        url: 'https://mylearningspace.wlu.ca/d2l/lms/quizzing/user/quizzes_list.d2l?ou=12345',
      }).restricted,
    ).toBe(false);
  });
});
