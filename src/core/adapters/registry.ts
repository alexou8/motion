import { d2lAdapter } from './d2l';
import type { LearningPlatformAdapter } from './types';

export const adapters: readonly LearningPlatformAdapter[] = [d2lAdapter];

export const supportedHosts: readonly string[] = ['*.brightspace.com', '*.desire2learn.com', 'mylearningspace.wlu.ca'];

export function resolveAdapter(url: string): LearningPlatformAdapter | null {
  return adapters.find((adapter) => adapter.matchesHost(url)) ?? null;
}

export function getSupportedHosts(): readonly string[] {
  return supportedHosts;
}

export const resolveAdapterForUrl = resolveAdapter;
