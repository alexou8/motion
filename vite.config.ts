import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath, URL } from 'node:url';
import manifest from './src/manifest.config';

/**
 * Build config for the extension.
 *
 * CRXJS reads the hand-authored manifest and wires the entry points from it, so
 * the manifest stays the source of truth for what ships rather than being
 * generated from the file layout (see docs/adr/0001-build-tooling.md).
 */
// Only the provider-stream e2e build points this at a local server (see
// `E2E_PROVIDER_BASE_URL` in src/platform/ai/http.ts); every other build,
// including production, gets '' and the fixed api.openai.com endpoints.
const e2eProviderBaseUrl =
  process.env.MOTION_E2E_PROVIDER_HOSTS === '1' ? (process.env.MOTION_E2E_PROVIDER_BASE_URL ?? 'http://127.0.0.1:8934') : '';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    __MOTION_PROVIDER_BASE_URL__: JSON.stringify(e2eProviderBaseUrl),
  },
  build: {
    target: 'es2022',
    // Only the provider-stream e2e build (MOTION_E2E_PROVIDER_HOSTS=1, see
    // src/manifest.config.ts) ever points this elsewhere, so the production
    // build's output directory is unaffected.
    outDir: process.env.MOTION_BUILD_OUTDIR ?? 'dist',
    emptyOutDir: true,
    // No remote code is permitted in a Chrome extension, and inlining assets
    // as data URLs keeps the CSP surface simple.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Stable, readable names so a store reviewer can map a bundle back to
        // its source, and so a diff of dist/ is meaningful between builds.
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    // CRXJS needs a stable port for its HMR client during development.
    port: 5173,
    strictPort: true,
  },
});
