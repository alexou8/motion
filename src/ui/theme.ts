/**
 * The token values, mirrored in TypeScript so they can be asserted in tests.
 * `tokens.css` is the runtime source of truth; `tokens.contrast.test.ts` proves
 * the two agree, so this table cannot drift without a test failure.
 */
export interface Palette {
  paper: string;
  surface: string;
  sunken: string;
  ink: string;
  inkMuted: string;
  rule: string;
  edge: string;
  signal: string;
  onSignal: string;
  attention: string;
  danger: string;
  done: string;
}

export const lightPalette: Palette = {
  paper: '#f8f6f1',
  surface: '#ffffff',
  sunken: '#efece4',
  ink: '#1f1d1a',
  inkMuted: '#5e5950',
  rule: '#e4dfd4',
  edge: '#8a8378',
  signal: '#a8431f',
  onSignal: '#ffffff',
  attention: '#7d5200',
  danger: '#a3261c',
  done: '#2a6340',
};

export const darkPalette: Palette = {
  paper: '#1f1e1c',
  surface: '#2a2926',
  sunken: '#171614',
  ink: '#f1eee7',
  inkMuted: '#b5afa3',
  rule: '#3a3834',
  edge: '#858075',
  signal: '#e58c68',
  onSignal: '#1f1e1c',
  attention: '#e8b75c',
  danger: '#ff9d8e',
  done: '#86cda2',
};

export const palettes = { light: lightPalette, dark: darkPalette } as const;
