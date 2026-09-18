import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MotionMark } from './MotionMark';

describe('MotionMark', () => {
  it('renders the canonical three-part track geometry', () => {
    const { container } = render(<MotionMark />);
    expect(container.querySelector('use')?.getAttribute('href')).toMatch(/#motion-mark$/);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 20 20');
  });
});
