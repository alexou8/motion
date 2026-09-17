import { describe, expect, it } from 'vitest';
import {
  actionTypeSchema,
  approvalRequestSchema,
  approvalExpiry,
  classifyElementConsequence,
  evaluateAssessmentContext,
  FRESH_APPROVAL_TTL_MS,
  isApprovalUsable,
  isImplemented,
  isProhibited,
  policyDecision,
  requiresApproval,
  riskOf,
  targetDigest,
  tierOf,
  type ActionType,
  type ApprovalRequest,
  type PolicyTier,
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
    expiresAt: new Date(NOW.getTime() + FRESH_APPROVAL_TTL_MS).toISOString(),
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
  it.each<ActionType>(['act-in-graded-quiz'])('refuses %s outright', (action) => {
    expect(isProhibited(action)).toBe(true);
    expect(isImplemented(action)).toBe(false);
  });

  it('every statically prohibited action is also classified high risk', () => {
    for (const action of actionTypeSchema.options) {
      if (isProhibited(action)) expect(riskOf(action)).toBe('high');
    }
  });

  it('refuses a prohibited action even when an approval record says approved', () => {
    const forged = approval({ action: 'act-in-graded-quiz', status: 'approved', expiresAt: null });
    const result = isApprovalUsable(forged, NOW);
    expect(result.usable).toBe(false);
    if (!result.usable) expect(result.reason).toMatch(/not something Motion performs/i);
  });

  it('submitting assessed work is no longer statically prohibited, but requires fresh confirmation', () => {
    expect(isProhibited('submit-assignment')).toBe(false);
    expect(tierOf('submit-assignment')).toBe('fresh-confirmation');
  });
});

describe('tier table', () => {
  it('classifies every declared action into exactly one tier', () => {
    const valid: PolicyTier[] = ['automatic', 'configurable', 'fresh-confirmation', 'forbidden'];
    for (const action of actionTypeSchema.options) {
      expect(valid).toContain(tierOf(action));
    }
  });

  it('maps tiers to legacy risk levels consistently', () => {
    for (const action of actionTypeSchema.options) {
      const tier = tierOf(action);
      const risk = riskOf(action);
      if (tier === 'automatic') expect(risk).toBe('low');
      if (tier === 'configurable') expect(risk).toBe('medium');
      if (tier === 'fresh-confirmation' || tier === 'forbidden') expect(risk).toBe('high');
    }
  });

  it.each<ActionType>([
    'read-page',
    'inspect-tab',
    'create-note',
    'extract-deadlines',
    'extract-requirements',
    'create-checklist',
    'open-tab',
    'create-tab-group',
    'navigate-owned-tab',
    'gather-material',
    'generate-draft',
    'analyze-rubric',
    'summarize',
    'organize-local-data',
    'scroll-to',
    'focus-element',
  ])('classifies %s as automatic', (action) => {
    expect(tierOf(action)).toBe('automatic');
  });

  it.each<ActionType>([
    'edit-draft',
    'fill-form-field',
    'select-option',
    'toggle-control',
    'save-remote-draft',
    'prepare-upload',
    'prepare-discussion-response',
    'add-calendar-event',
    'prepare-message',
    'click-element',
  ])('classifies %s as configurable', (action) => {
    expect(tierOf(action)).toBe('configurable');
  });

  it.each<ActionType>([
    'upload-file',
    'post-discussion',
    'send-message',
    'send-message-to-instructor',
    'finalize-remote-draft',
    'submit-assignment',
    'overwrite-remote-content',
    'modify-course-data',
  ])('classifies %s as fresh-confirmation', (action) => {
    expect(tierOf(action)).toBe('fresh-confirmation');
  });

  it('classifies act-in-graded-quiz as forbidden', () => {
    expect(tierOf('act-in-graded-quiz')).toBe('forbidden');
  });
});

describe('policyDecision', () => {
  const noneAllowed: ReadonlySet<ActionType> = new Set();

  it('allows automatic actions unconditionally', () => {
    expect(
      policyDecision({ action: 'read-page', assessmentRestricted: false, allowedConfigurable: noneAllowed })
        .decision,
    ).toBe('allow');
  });

  it('gates a configurable action unless the student enabled it', () => {
    expect(
      policyDecision({ action: 'edit-draft', assessmentRestricted: false, allowedConfigurable: noneAllowed })
        .decision,
    ).toBe('needs-approval');
    expect(
      policyDecision({
        action: 'edit-draft',
        assessmentRestricted: false,
        allowedConfigurable: new Set<ActionType>(['edit-draft']),
      }).decision,
    ).toBe('allow');
  });

  it('always requires a fresh approval for fresh-confirmation actions, regardless of settings', () => {
    expect(
      policyDecision({
        action: 'submit-assignment',
        assessmentRestricted: false,
        allowedConfigurable: new Set<ActionType>(['submit-assignment']),
      }).decision,
    ).toBe('needs-fresh-approval');
  });

  it('forbids act-in-graded-quiz statically', () => {
    expect(
      policyDecision({
        action: 'act-in-graded-quiz',
        assessmentRestricted: false,
        allowedConfigurable: noneAllowed,
      }).decision,
    ).toBe('forbid');
  });

  it('forbids any non-read action in a restricted assessment context', () => {
    for (const action of ['fill-form-field', 'click-element', 'submit-assignment'] as const) {
      expect(
        policyDecision({ action, assessmentRestricted: true, allowedConfigurable: noneAllowed }).decision,
      ).toBe('forbid');
    }
  });

  it('still allows reading the page in a restricted assessment context', () => {
    expect(
      policyDecision({ action: 'read-page', assessmentRestricted: true, allowedConfigurable: noneAllowed })
        .decision,
    ).toBe('allow');
  });

  it('a forged allowedConfigurable set cannot unlock a forbidden action', () => {
    const forged = new Set<ActionType>(['act-in-graded-quiz']);
    expect(
      policyDecision({ action: 'act-in-graded-quiz', assessmentRestricted: false, allowedConfigurable: forged })
        .decision,
    ).toBe('forbid');
  });
});

describe('classifyElementConsequence', () => {
  it('classifies unambiguous submit-like labels', () => {
    expect(classifyElementConsequence({ tag: 'button', type: 'submit', label: 'Submit' })).toBe(
      'submit-assignment',
    );
    expect(classifyElementConsequence({ tag: 'button', label: 'Post Reply' })).toBe('post-discussion');
    expect(classifyElementConsequence({ tag: 'button', label: 'Reply' })).toBe('post-discussion');
    expect(classifyElementConsequence({ tag: 'button', label: 'Send' })).toBe('send-message');
    expect(classifyElementConsequence({ tag: 'button', label: 'Send to instructor' })).toBe(
      'send-message-to-instructor',
    );
    expect(classifyElementConsequence({ tag: 'button', label: 'Publish' })).toBe('finalize-remote-draft');
    expect(classifyElementConsequence({ tag: 'button', label: 'Upload' })).toBe('upload-file');
    expect(classifyElementConsequence({ tag: 'button', label: 'Finish' })).toBe('submit-assignment');
  });

  it('treats "Save Draft" as a configurable remote draft save', () => {
    expect(classifyElementConsequence({ tag: 'button', label: 'Save Draft' })).toBe('save-remote-draft');
  });

  it('treats "Save and Close" conservatively as a fresh-confirmation finalize', () => {
    expect(classifyElementConsequence({ tag: 'button', label: 'Save and Close' })).toBe(
      'finalize-remote-draft',
    );
  });

  it('treats an ambiguous submit-shaped control as fresh-confirmation rather than harmless', () => {
    expect(
      classifyElementConsequence({ tag: 'button', type: 'submit', formMethod: 'post', label: 'OK' }),
    ).toBe('finalize-remote-draft');
  });

  it('classifies a control inside a graded attempt as forbidden regardless of label', () => {
    expect(
      classifyElementConsequence({ tag: 'button', label: 'Next Question', inAttempt: true }),
    ).toBe('act-in-graded-quiz');
  });

  it('falls back to click-element for a plain, non-consequential control', () => {
    expect(classifyElementConsequence({ tag: 'button', label: 'Expand details' })).toBe('click-element');
  });

  it('classifies form controls by role', () => {
    expect(classifyElementConsequence({ tag: 'select', label: 'Sort by' })).toBe('select-option');
    expect(classifyElementConsequence({ tag: 'input', type: 'checkbox', label: 'Notify me' })).toBe(
      'toggle-control',
    );
  });
});

describe('targetDigest', () => {
  it('is stable regardless of payload key order', () => {
    const a = targetDigest({ action: 'submit-assignment', target: 't', payload: { x: 1, y: 2 } });
    const b = targetDigest({ action: 'submit-assignment', target: 't', payload: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it('differs when the payload differs (payload A cannot authorize payload B)', () => {
    const a = targetDigest({ action: 'submit-assignment', target: 't', payload: { file: 'A.pdf' } });
    const b = targetDigest({ action: 'submit-assignment', target: 't', payload: { file: 'B.pdf' } });
    expect(a).not.toBe(b);
  });

  it('differs when the target differs', () => {
    const a = targetDigest({ action: 'submit-assignment', target: 't1', payload: {} });
    const b = targetDigest({ action: 'submit-assignment', target: 't2', payload: {} });
    expect(a).not.toBe(b);
  });
});

describe('approval expiry', () => {
  it('gives high-risk approvals a short window and leaves medium-risk open', () => {
    expect(approvalExpiry('post-discussion', NOW)).toBe(
      new Date(NOW.getTime() + FRESH_APPROVAL_TTL_MS).toISOString(),
    );
    expect(approvalExpiry('create-checklist', NOW)).toBeNull();
  });

  it('accepts an approval inside its window', () => {
    expect(isApprovalUsable(approval(), NOW).usable).toBe(true);
  });

  it('rejects a stale high-risk approval replayed after a restart', () => {
    const later = new Date(NOW.getTime() + FRESH_APPROVAL_TTL_MS + 1);
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

/**
 * A quiz list at Laurier contained a quiz named "Test 1 - Requires Respondus
 * LockDown Browser". The phrase matched the "is this an attempt?" text hint and
 * put the whole listing into restricted mode, so the student could not read any
 * of their own quiz dates. The hint is a fallback for a route Motion does not
 * recognise; on a recognised listing the route is the stronger fact.
 */
describe('restricted mode on a listing page', () => {
  const listing = {
    url: 'https://mylearningspace.wlu.ca/d2l/lms/quizzing/user/quizzes_list.d2l?ou=999999',
    pageTitle: 'Quiz List - CS-101-A - Example Course',
    visibleText: 'Test 1 - Requires Respondus LockDown Browser Due on Oct 20, 2026 2:30 PM',
  };

  it('does not restrict a quiz list because a quiz is named after its proctoring tool', () => {
    expect(evaluateAssessmentContext({ pageType: 'quiz-list', ...listing })).toMatchObject({
      restricted: false,
    });
  });

  it('still restricts the attempt itself', () => {
    expect(
      evaluateAssessmentContext({
        pageType: 'quiz-attempt',
        url: 'https://mylearningspace.wlu.ca/d2l/lms/quizzing/user/attempt/201?ou=999999',
        pageTitle: 'Quiz',
        visibleText: 'Question 1 of 10',
      }),
    ).toMatchObject({ restricted: true });
  });

  it('still restricts an attempt served from a route it does not recognise', () => {
    // The case the text hints exist for: an unknown route showing a live attempt.
    expect(
      evaluateAssessmentContext({
        pageType: 'unsupported',
        url: 'https://mylearningspace.wlu.ca/d2l/custom/assessment/run',
        pageTitle: 'Midterm',
        visibleText: 'Time remaining 42:00 — Question 3 of 20',
      }),
    ).toMatchObject({ restricted: true });
  });

  it('still restricts an attempt embedded in a page that renders instructor content', () => {
    // An assignment or content topic can host anything, so it keeps the net.
    for (const pageType of ['assignment', 'content-topic', 'discussion-topic'] as const) {
      expect(
        evaluateAssessmentContext({
          pageType,
          url: 'https://mylearningspace.wlu.ca/d2l/le/content/999999/viewContent/1/View',
          pageTitle: 'Exam',
          visibleText: 'Attempt in progress. Time remaining 10:00',
        }),
      ).toMatchObject({ restricted: true });
    }
  });

  it('still restricts on an attempt-shaped URL whatever the page type says', () => {
    expect(
      evaluateAssessmentContext({
        pageType: 'quiz-list',
        url: 'https://mylearningspace.wlu.ca/d2l/lms/quizzing/user/attempt/201?ou=999999',
        pageTitle: 'Quiz List',
        visibleText: 'nothing unusual here',
      }),
    ).toMatchObject({ restricted: true });
  });
});

describe('approval binding hardening', () => {
  const base = {
    id: 'a1', workflowId: 'w1', stepId: 's1', action: 'submit-assignment' as const, risk: 'high' as const,
    summary: 'Submit', target: 'CP363 Assignment 2', effect: 'Final submission', reversible: false, payload: {},
    status: 'approved' as const, requestedAt: '2026-09-16T12:00:00.000Z', decidedAt: '2026-09-16T12:00:00.000Z',
  };
  const now = new Date('2026-09-16T12:00:30.000Z');
  const binding = { targetDigest: 'abc', stepAttempt: 1 };

  it('rejects a bound check against a record with no digest', () => {
    const r = approvalRequestSchema.parse({ ...base, expiresAt: '2026-09-16T12:02:00.000Z', stepAttempt: 1 });
    expect(isApprovalUsable(r, now, binding).usable).toBe(false);
  });

  it('rejects a bound check against a record with no attempt', () => {
    const r = approvalRequestSchema.parse({ ...base, expiresAt: '2026-09-16T12:02:00.000Z', targetDigest: 'abc' });
    expect(isApprovalUsable(r, now, binding).usable).toBe(false);
  });

  it('rejects a fresh-confirmation approval that has no expiry', () => {
    const r = approvalRequestSchema.parse({ ...base, expiresAt: null, targetDigest: 'abc', stepAttempt: 1 });
    expect(isApprovalUsable(r, now, binding).usable).toBe(false);
  });

  it('accepts a correctly bound, unexpired, unconsumed fresh approval', () => {
    const r = approvalRequestSchema.parse({ ...base, expiresAt: '2026-09-16T12:02:00.000Z', targetDigest: 'abc', stepAttempt: 1 });
    expect(isApprovalUsable(r, now, binding).usable).toBe(true);
  });
});
