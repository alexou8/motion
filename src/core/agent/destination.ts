import { d2lAdapter } from '../adapters';
import { evaluateAssessmentContext } from '../policy';

export type DestinationProvenance = 'observed-link' | 'd2l-route';

/**
 * Allows only a known D2L route or a page link Motion observed. Assessment
 * attempts are rejected before Chrome can request them.
 */
export function validateDestination(
  url: string,
  lmsOrigins: readonly string[],
  provenance?: DestinationProvenance,
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'destination is not a valid URL' };
  }
  const hostAllowed = lmsOrigins.some((origin) => {
    const hostPattern = origin.replace(/^https:\/\//, '');
    if (hostPattern.startsWith('*.')) return parsed.hostname.endsWith(hostPattern.slice(1));
    if (!origin.includes('://')) return parsed.hostname === hostPattern;
    try { return parsed.origin === new URL(origin).origin; } catch { return false; }
  });
  if (parsed.protocol !== 'https:' || !hostAllowed)
    return { ok: false, reason: 'destination is not an HTTPS page on this LMS' };

  const pageType = d2lAdapter.classifyUrl(parsed.toString());
  if (evaluateAssessmentContext({ pageType: pageType ?? 'unsupported', url: parsed.toString() }).restricted)
    return { ok: false, reason: 'Motion will not open a graded or timed assessment attempt' };
  if (pageType || provenance === 'observed-link') return { ok: true };
  return { ok: false, reason: 'destination is not a known D2L route or an observed page link' };
}
