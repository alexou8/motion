/**
 * `npm run lint` is a documented check in AGENTS.md, but the repository shipped
 * no ESLint configuration, so the command exited 2 without linting anything.
 * This is the configuration that command always assumed.
 */
module.exports = {
  root: true,
  env: { browser: true, es2023: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2023, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-undef': 'off',
  },
  ignorePatterns: ['dist', 'node_modules'],
  overrides: [
    {
      files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
