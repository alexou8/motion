/**
 * Deterministic control intents (VISION §6), matched against the student's
 * text before any model call. These exist so the phrases students actually
 * use for basic control — pause, stop, "what's left" — never depend on a
 * model being available, never cost a token, and can never be talked out of
 * firing by page content (they run on the student's own message only).
 */

export type DeadlineIntentRange = 'week' | 'overdue' | 'all';

export type AgentIntent =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'why' }
  | { type: 'exclude-source'; hint: string | null }
  | { type: 'restart'; hint: string | null }
  | { type: 'deadlines'; range: DeadlineIntentRange }
  | { type: 'open-everything' };

function test(re: RegExp, text: string): boolean {
  return re.test(text);
}

const PAUSE_RE = /\b(pause|hold on|wait a (sec|second|moment)|hang on)\b/i;
const RESUME_RE = /\b(resume|continue( where you left off)?|keep going|carry on|pick (it |this )?up)\b/i;
const STOP_RE = /\b(stop( this)?|cancel( this)?|abort|never ?mind)\b/i;
const WHY_RE = /^why (did|do|does|is|are|would) you\b/i;
const OPEN_EVERYTHING_RE = /\bopen everything( i need)?\b/i;
const RESTART_RE = /\b(start over|restart)\b/i;
const EXCLUDE_SOURCE_RE = /\b(don'?t use (that|this|the)?\s*source|exclude (that|this) source|stop using (that|this) source|ignore (that|this) source)\b/i;

const DEADLINES_WEEK_RE = /\bwhat'?s due this week\b|\bdue this week\b/i;
const DEADLINES_OVERDUE_RE = /\bhave i missed anything\b|\bwhat have i missed\b|\bmissed anything\b|\boverdue\b/i;
const DEADLINES_GENERIC_RE = /\bwhat'?s due\b|\bwhat is due\b|\bcheck what i'?m missing\b|\bdeadlines?\b/i;

function extractHintAfter(text: string, re: RegExp): string | null {
  const match = text.match(re);
  if (!match) return null;
  const rest = text.slice((match.index ?? 0) + match[0].length).trim();
  const cleaned = rest
    .replace(/^(on|for|about)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Returns a typed intent for deterministic control text, or `null` when the
 * message should go to the model as an ordinary goal/message. Order matters:
 * more specific phrases are checked before generic ones (e.g. "start over on
 * section 3" must not also match a looser pattern).
 */
export function detectIntent(rawText: string): AgentIntent | null {
  const text = rawText.trim();
  if (text.length === 0) return null;

  if (test(WHY_RE, text)) return { type: 'why' };

  if (test(OPEN_EVERYTHING_RE, text)) return { type: 'open-everything' };

  if (test(EXCLUDE_SOURCE_RE, text)) {
    return { type: 'exclude-source', hint: extractHintAfter(text, EXCLUDE_SOURCE_RE) };
  }

  if (test(RESTART_RE, text)) {
    return { type: 'restart', hint: extractHintAfter(text, RESTART_RE) };
  }

  if (test(DEADLINES_WEEK_RE, text)) return { type: 'deadlines', range: 'week' };
  if (test(DEADLINES_OVERDUE_RE, text)) return { type: 'deadlines', range: 'overdue' };
  if (test(DEADLINES_GENERIC_RE, text)) return { type: 'deadlines', range: 'all' };

  if (test(PAUSE_RE, text)) return { type: 'pause' };
  if (test(RESUME_RE, text)) return { type: 'resume' };
  if (test(STOP_RE, text)) return { type: 'stop' };

  return null;
}
