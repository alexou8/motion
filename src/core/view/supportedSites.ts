import { supportedHosts } from '../adapters';

/**
 * Student-facing description of where Motion works, derived from the adapter
 * registry so the copy cannot drift from the hosts Motion actually reads.
 * Wildcard patterns are Brightspace's own domains; exact hosts are
 * institution deployments.
 */
export function supportedSitesSentence(hosts: readonly string[] = supportedHosts): string {
  const domains = hosts.filter((host) => host.startsWith('*.'));
  const institutions = hosts.filter((host) => !host.startsWith('*.'));
  const parts = [...domains];
  if (institutions.length > 0)
    parts.push(`institution deployments such as ${institutions.join(', ')}`);
  if (parts.length === 0) return 'Motion works on Brightspace course sites.';
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts.at(-1)}`;
  return `Motion works on Brightspace course sites: ${list}.`;
}

export const OPEN_COURSE_GUIDANCE = 'Open your Brightspace course, then reopen Motion.';
