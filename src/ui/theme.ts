/**
 * The token values, mirrored in TypeScript so they can be asserted in tests.
 * `tokens.css` is the runtime source of truth; `tokens.contrast.test.ts` proves
 * the two agree, so this table cannot drift without a test failure.
 */
export interface Palette {
  paper: string;
  surface: string;
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
  paper: '#f4f6f8',
  surface: '#ffffff',
  ink: '#16202a',
  inkMuted: '#54646f',
  rule: '#d3dbe2',
  edge: '#798996',
  signal: '#24487a',
  onSignal: '#ffffff',
  attention: '#8a4b08',
  danger: '#a4231b',
  done: '#1f6146',
};

export const darkPalette: Palette = {
  paper: '#101519',
  surface: '#182027',
  ink: '#e6ebef',
  inkMuted: '#9dacb8',
  rule: '#2b3640',
  edge: '#6b7b88',
  signal: '#9cc0ff',
  onSignal: '#0b1017',
  attention: '#f2b25c',
  danger: '#ff9e96',
  done: '#7bd3ac',
};

export const palettes = { light: lightPalette, dark: darkPalette } as const;
