import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Unit tests always exercise the production allowlist (the fixed
  // api.openai.com / api.anthropic.com endpoints) — see
  // src/platform/ai/http.ts `E2E_PROVIDER_BASE_URL`.
  define: {
    __MOTION_PROVIDER_BASE_URL__: JSON.stringify(''),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
