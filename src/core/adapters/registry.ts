import { d2lAdapter } from './d2l';
import type { LearningPlatformAdapter } from './types';

export const adapters: readonly LearningPlatformAdapter[] = [d2lAdapter];

function displayHostPattern(pattern: RegExp): string {
  const subdomainPattern = pattern.source.match(/^\(\^\|\\\.\)(.+)\$$/);
  if (subdomainPattern?.[1]) return `*.${subdomainPattern[1].replace(/\\\./g, '.')}`;
  const exactPattern = pattern.source.match(/^\^(.+)\$$/);
  if (exactPattern?.[1]) return exactPattern[1].replace(/\\\./g, '.');
  return pattern.source;
}

export const supportedHosts: readonly string[] = Array.from(
  new Set(adapters.flatMap((adapter) => adapter.hostPatterns.map(displayHostPattern))),
);

export function resolveAdapter(url: string): LearningPlatformAdapter | null {
  return adapters.find((adapter) => adapter.matchesHost(url)) ?? null;
}

export function getSupportedHosts(): readonly string[] {
  return supportedHosts;
}
