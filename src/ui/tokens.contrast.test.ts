import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrastRatio } from './contrast';
import { palettes, type Palette } from './theme';

/** WCAG 2.2: 4.5:1 for body text, 3:1 for non-text UI boundaries. */
const TEXT_MIN = 4.5;
const UI_MIN = 3;

describe.each(Object.entries(palettes))('%s palette meets WCAG AA', (_name, palette: Palette) => {
  const textPairs: [string, string, string][] = [
    ['ink on paper', palette.ink, palette.paper],
    ['ink on surface', palette.ink, palette.surface],
    ['muted ink on paper', palette.inkMuted, palette.paper],
    ['muted ink on surface', palette.inkMuted, palette.surface],
    // The composer, the student's chat turns and selected nav rows sit on the
    // sunken fill, so text there is held to the same bar.
    ['ink on sunken', palette.ink, palette.sunken],
    ['muted ink on sunken', palette.inkMuted, palette.sunken],
    ['signal on paper', palette.signal, palette.paper],
    ['signal on surface', palette.signal, palette.surface],
    ['danger on surface', palette.danger, palette.surface],
    ['attention on paper', palette.attention, palette.paper],
    ['danger on paper', palette.danger, palette.paper],
    ['done on paper', palette.done, palette.paper],
    ['text on a signal fill', palette.onSignal, palette.signal],
  ];

  it.each(textPairs)('%s clears %d:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  // `edge` carries meaning (input borders, the progress track, state markers)
  // so it is held to 1.4.11. `rule` is a decorative hairline and is exempt.
  const uiPairs: [string, string, string][] = [
    ['edge on paper', palette.edge, palette.paper],
    ['edge on surface', palette.edge, palette.surface],
    ['focus ring on paper', palette.signal, palette.paper],
    ['focus ring on surface', palette.signal, palette.surface],
  ];

  it.each(uiPairs)('%s clears %d:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(UI_MIN);
  });
});

describe('tokens.css agrees with the TypeScript palette', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/ui/tokens.css'), 'utf8');

  // Every hex the palette claims must actually appear in the stylesheet, so the
  // contrast proof above cannot pass while the shipped CSS says something else.
  it.each(Object.entries(palettes))('%s values all appear in tokens.css', (_name, palette) => {
    for (const value of Object.values(palette)) {
      expect(css.toLowerCase()).toContain(value.toLowerCase());
    }
  });
});
