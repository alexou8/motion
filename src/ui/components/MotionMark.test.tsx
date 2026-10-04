import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MotionMark } from './MotionMark';

describe('MotionMark', () => {
  it('uses the canonical purple-and-gold mark without a redundant accessible label', () => {
    const { container } = render(<MotionMark className="size-5" />);
    expect(container.firstChild).toHaveClass('motion-brand-mark', 'size-5');
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    const css = readFileSync('src/ui/brand.css', 'utf8');
    expect(css).toContain('../assets/brand/motion-mark.svg');
    const mark = readFileSync('src/assets/brand/motion-mark.svg', 'utf8');
    expect(mark).toContain('viewBox="0 0 128 128"');
    expect(mark).toContain('#330072');
    expect(mark).toContain('#F2A900');
    expect(css).not.toContain('mask:');
  });
});
