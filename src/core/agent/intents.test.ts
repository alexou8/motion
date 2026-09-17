import { describe, expect, it } from 'vitest';
import { detectIntent } from './intents';

describe('detectIntent', () => {
  it('detects pause', () => {
    expect(detectIntent('Pause.')).toEqual({ type: 'pause' });
  });

  it('detects resume / continue where you left off', () => {
    expect(detectIntent('Continue where you left off.')).toEqual({ type: 'resume' });
  });

  it('detects stop', () => {
    expect(detectIntent('Stop.')).toEqual({ type: 'stop' });
  });

  it('detects why, answered from session activity with no model call', () => {
    expect(detectIntent('Why did you open this page?')).toEqual({ type: 'why' });
  });

  it('detects exclude source', () => {
    const result = detectIntent("Don't use that source.");
    expect(result?.type).toBe('exclude-source');
  });

  it('detects restart with a section hint', () => {
    const result = detectIntent('Start over on section 3.');
    expect(result).toEqual({ type: 'restart', hint: 'section 3' });
  });

  it('detects "what\'s due this week?"', () => {
    expect(detectIntent("What's due this week?")).toEqual({ type: 'deadlines', range: 'week' });
  });

  it('detects "have I missed anything?"', () => {
    expect(detectIntent('Have I missed anything?')).toEqual({ type: 'deadlines', range: 'overdue' });
  });

  it('detects "open everything I need for this lab"', () => {
    expect(detectIntent('Open everything I need for this lab.')).toEqual({ type: 'open-everything' });
  });

  it('detects "check what I\'m missing this week" as a deadlines intent', () => {
    const result = detectIntent("Check what I'm missing this week.");
    expect(result?.type).toBe('deadlines');
  });

  it('returns null for an ordinary goal/message', () => {
    expect(detectIntent('Work on Assignment 2.')).toBeNull();
    expect(detectIntent('Use the course material to help draft this discussion response.')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(detectIntent('   ')).toBeNull();
  });
});
