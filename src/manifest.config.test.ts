import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression for SOL findings on the provider-stream browser check: the
 * extra host permission (a local `http://127.0.0.1` origin the provider
 * stream e2e check redirects OpenAI traffic to — Playwright's `context.route`
 * cannot intercept fetches made by the MV3 service worker, see
 * src/platform/ai/http.ts `E2E_PROVIDER_BASE_URL`) must exist ONLY in the
 * test-only `dist-e2e-provider` build (`npm run build:e2e-provider-hosts`),
 * gated by `MOTION_E2E_PROVIDER_HOSTS`, and never in the manifest Motion
 * actually ships to students or the Chrome Web Store.
 */
describe('manifest.config production build', () => {
  const originalHostsEnv = process.env.MOTION_E2E_PROVIDER_HOSTS;
  const originalBaseUrlEnv = process.env.MOTION_E2E_PROVIDER_BASE_URL;

  afterEach(() => {
    if (originalHostsEnv === undefined) delete process.env.MOTION_E2E_PROVIDER_HOSTS;
    else process.env.MOTION_E2E_PROVIDER_HOSTS = originalHostsEnv;
    if (originalBaseUrlEnv === undefined) delete process.env.MOTION_E2E_PROVIDER_BASE_URL;
    else process.env.MOTION_E2E_PROVIDER_BASE_URL = originalBaseUrlEnv;
    vi.resetModules();
  });

  it('does not declare the OpenAI API host permission, or any non-https host, by default', async () => {
    delete process.env.MOTION_E2E_PROVIDER_HOSTS;
    delete process.env.MOTION_E2E_PROVIDER_BASE_URL;
    vi.resetModules();
    const { default: manifest } = await import('./manifest.config');
    const resolved = await manifest;
    const hostPermissions = (resolved as { host_permissions?: string[] }).host_permissions ?? [];
    expect(hostPermissions).not.toContain('https://api.openai.com/*');
    expect(hostPermissions.every((host) => host.startsWith('https://'))).toBe(true);
  });

  it('only adds the local provider-stream host permission when the e2e provider flag is set', async () => {
    process.env.MOTION_E2E_PROVIDER_HOSTS = '1';
    process.env.MOTION_E2E_PROVIDER_BASE_URL = 'http://127.0.0.1:8934';
    vi.resetModules();
    const { default: manifest } = await import('./manifest.config');
    const resolved = await manifest;
    const hostPermissions = (resolved as { host_permissions?: string[] }).host_permissions ?? [];
    expect(hostPermissions).toContain('http://127.0.0.1:8934/*');
    expect(hostPermissions).not.toContain('https://api.openai.com/*');
  });
});
