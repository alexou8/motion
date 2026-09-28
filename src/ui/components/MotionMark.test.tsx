import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MotionMark } from './MotionMark';

describe('MotionMark', () => {
  it('uses the canonical continuous M as a decorative semantic-color mark', () => {
    const { container } = render(<MotionMark className="size-5" />);
    expect(container.firstChild).toHaveClass('motion-brand-mark', 'size-5');
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    const css = readFileSync('src/ui/brand.css', 'utf8');
    expect(css).toContain('../assets/brand/motion-mark.svg');
    const mark = readFileSync('src/assets/brand/motion-mark.svg', 'utf8');
    expect(mark).toContain('M2 17V3l8 10 8-10v14');
  });
});
