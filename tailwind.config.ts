import type { Config } from 'tailwindcss';

/**
 * Tailwind reads Motion's design tokens rather than defining its own palette,
 * so `src/ui/tokens.css` stays the single source of truth and the contrast test
 * that guards it cannot be bypassed by a utility class.
 */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--color-paper)',
        surface: 'var(--color-surface)',
        sunken: 'var(--color-surface-sunken)',
        ink: 'var(--color-ink)',
        'ink-muted': 'var(--color-ink-muted)',
        rule: 'var(--color-rule)',
        edge: 'var(--color-edge)',
        signal: 'var(--color-signal)',
        'on-signal': 'var(--color-on-signal)',
        attention: 'var(--color-attention)',
        danger: 'var(--color-danger)',
        done: 'var(--color-done)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        xs: ['var(--text-xs)', { lineHeight: '1.45' }],
        sm: ['var(--text-sm)', { lineHeight: 'var(--leading-body)' }],
        md: ['var(--text-md)', { lineHeight: '1.4' }],
        lg: ['var(--text-lg)', { lineHeight: 'var(--leading-tight)' }],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
      },
      zIndex: {
        base: 'var(--z-base)',
        sticky: 'var(--z-sticky)',
        overlay: 'var(--z-overlay)',
        dialog: 'var(--z-dialog)',
      },
    },
  },
  plugins: [],
} satisfies Config;
