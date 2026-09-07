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
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
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
