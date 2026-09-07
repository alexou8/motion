import { describe, expect, it } from 'vitest';
import manifestExport from '../../manifest.config';
import { adapters, supportedHosts } from './registry';

/**
 * CRXJS types the export as a union that also allows a Promise or a function.
 * Ours is a plain object, so narrow it once here rather than at every use.
 */
interface ManifestShape {
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
  content_security_policy?: { extension_pages?: string };
  action?: Record<string, unknown>;
  icons?: Record<string, string>;
}
const manifest = manifestExport as ManifestShape;

/**
 * The manifest and the adapter registry are maintained separately: one is a
 * permission grant, the other is code that expects to run. If they drift,
 * Motion either ships an adapter for a host it cannot read (silently broken) or
 * requests access to a host it has no reason to touch (an unjustifiable
 * permission in a store review). These tests tie them together.
 */

function hostsFromPatterns(patterns: string[] | undefined): string[] {
  return (patterns ?? []).map((pattern) =>
    pattern.replace(/^https:\/\//, '').replace(/\/\*$/, ''),
  );
}

describe('manifest and adapter registry agree', () => {
  const declaredHosts = hostsFromPatterns(manifest.host_permissions);
  const contentScriptHosts = hostsFromPatterns(
    (manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? []),
  );

  it('declares a host permission for every host an adapter claims', () => {
    for (const host of supportedHosts) {
      expect(declaredHosts).toContain(host);
    }
  });

  it('injects a content script everywhere it holds host permission', () => {
    expect(new Set(contentScriptHosts)).toEqual(new Set(declaredHosts));
  });

  it('requests no host permission that no adapter claims', () => {
    for (const host of declaredHosts) {
      expect(supportedHosts).toContain(host);
    }
  });

  it('only ever requests HTTPS hosts', () => {
    for (const pattern of manifest.host_permissions ?? []) {
      expect(pattern.startsWith('https://')).toBe(true);
    }
  });
});

describe('permission hygiene', () => {
  it('does not request activeTab, which does not work from a side panel', () => {
    expect(manifest.permissions ?? []).not.toContain('activeTab');
  });

  it('does not declare externally_connectable, so no web page can message us', () => {
    expect(manifest).not.toHaveProperty('externally_connectable');
  });

  it('requests tabs, without which tab.url is silently undefined', () => {
    expect(manifest.permissions ?? []).toContain('tabs');
  });

  it('sets a content security policy that forbids remote script', () => {
    const csp = manifest.content_security_policy?.extension_pages;
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|https:/);
  });

  it('declares no default_popup, which would break the side-panel open behaviour', () => {
    expect(manifest.action ?? {}).not.toHaveProperty('default_popup');
  });

  it('references only icon files that exist', async () => {
    const { existsSync } = await import('node:fs');
    const icons = Object.values(manifest.icons ?? {});
    expect(icons.length).toBeGreaterThan(0);
    for (const path of icons) {
      expect(existsSync(path), `${path} is referenced by the manifest but missing`).toBe(true);
    }
  });
});

describe('adapter registry', () => {
  it('registers at least one adapter and resolves its own hosts', () => {
    expect(adapters.length).toBeGreaterThan(0);
    for (const adapter of adapters) {
      expect(adapter.hostPatterns.length).toBeGreaterThan(0);
    }
  });

  it('includes MyLearningSpace, an institution D2L deployment', () => {
    expect(supportedHosts).toContain('mylearningspace.wlu.ca');
  });
});
