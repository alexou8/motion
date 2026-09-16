import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SourceLink, StatusMarker } from './components';

/**
 * Pure component-level tests for `src/ui/components`. Application-level flows
 * (connection views, sessions, approvals) live in `src/sidepanel/App.test.tsx`
 * — this file stays about the design-system primitives themselves.
 */

it.each(['done', 'active', 'pending', 'skipped', 'blocked', 'failed'] as const)('gives %s markers a text alternative', (markerState) => {
  render(<StatusMarker state={markerState} />);
  expect(screen.getByRole('img')).toHaveAccessibleName();
});

describe('SourceLink', () => {
  it('does not render a non-https source link', () => {
    render(<SourceLink href="http://lms.example.test/course" pageTitle="Insecure source" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders an https source link with its page title and origin', () => {
    render(<SourceLink href="https://lms.example.test/course" pageTitle="Synthetic source" />);
    const link = screen.getByRole('link', { name: /Synthetic source.*lms\.example\.test/ });
    expect(link).toHaveAttribute('href', 'https://lms.example.test/course');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
