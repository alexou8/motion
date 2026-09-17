import { describe, expect, it } from 'vitest';
import {
  MAX_FILL_VALUE_LENGTH,
  clickActionSchema,
  fillActionSchema,
  snapshotResultSchema,
} from './contracts';

describe('actor contracts', () => {
  it('rejects a click request carrying a forged selector field', () => {
    const result = clickActionSchema.safeParse({
      type: 'click',
      snapshotId: 'snap-1',
      handle: 'e1',
      selector: '#submit-button',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a fill request carrying a forged script field', () => {
    const result = fillActionSchema.safeParse({
      type: 'fill',
      snapshotId: 'snap-1',
      handle: 'e1',
      value: 'hello',
      script: 'alert(1)',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a fill request carrying a forged url field', () => {
    const result = fillActionSchema.safeParse({
      type: 'fill',
      snapshotId: 'snap-1',
      handle: 'e1',
      value: 'hello',
      url: 'https://evil.example.com',
    });
    expect(result.success).toBe(false);
  });

  it('bounds fill values to 20k characters', () => {
    const tooLong = 'a'.repeat(MAX_FILL_VALUE_LENGTH + 1);
    const overLimit = fillActionSchema.safeParse({ type: 'fill', snapshotId: 'snap-1', handle: 'e1', value: tooLong });
    expect(overLimit.success).toBe(false);

    const atLimit = fillActionSchema.safeParse({
      type: 'fill',
      snapshotId: 'snap-1',
      handle: 'e1',
      value: 'a'.repeat(MAX_FILL_VALUE_LENGTH),
    });
    expect(atLimit.success).toBe(true);
  });

  it('caps a snapshot result at 150 elements', () => {
    const elements = Array.from({ length: 151 }, (_, i) => ({
      handle: `e${i}`,
      role: 'button' as const,
      tag: 'button',
      label: 'x',
      disabled: false,
    }));
    const result = snapshotResultSchema.safeParse({ snapshotId: 's1', url: 'https://school.brightspace.com/', elements });
    expect(result.success).toBe(false);
  });
});
