import type { StepCapability, StepContext, StepOutcome } from '@/core/workflows';
import { ChromeTabs, groupTitle, isOpenableUrl, type TabsCapability } from '@/platform/tabs';

/**
 * The closed set of things a workflow may actually do.
 *
 * This is the second enforcement point for the academic-integrity boundary.
 * Blocking prohibited action *names* is worthless if a workflow can reach a
 * generic "run this script" or "navigate to this URL" primitive, so no such
 * primitive exists: every capability is concrete and validates its own
 * parameters (docs/THREAT_MODEL.md T5).
 */

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Step is missing required input "${key}"`);
  }
  return value;
}

function requireUrls(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new Error(`Step input "${key}" must be a list of URLs`);
  const urls = value.filter((entry): entry is string => typeof entry === 'string');
  const rejected = urls.filter((url) => !isOpenableUrl(url));
  if (rejected.length > 0) {
    // A URL harvested from a page is attacker-influenced; refuse loudly rather
    // than silently skipping, so the student learns the page was odd.
    throw new Error(`Refusing ${rejected.length} link(s) that are not https`);
  }
  return urls;
}

function optionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' ? value : null;
}

/** Opens a set of course resources in a Motion-owned tab group. */
export function openSourcesCapability(tabs: TabsCapability): StepCapability {
  /**
   * Safe to run more than once under the same intent key: `tabs.open` finds a
   * tab already carrying its operation id instead of opening another, and
   * `ensureGroup` only adds what is missing. That is what lets a restart finish
   * a half-done step rather than either repeating it or abandoning it.
   */
  const openAndGroup = async (context: StepContext): Promise<StepOutcome> => {
    const urls = requireUrls(context.step.input, 'urls');
    if (urls.length === 0) return { kind: 'skipped', reason: 'No sources to open.' };

    // Checked before every effect, not only at commit: a student who closes
    // the workspace mid-way means "stop opening tabs", and a rejected commit
    // alone would let the rest of the list open anyway. The result of a stopped
    // run is discarded by the engine, since its lease is gone.
    const stopped: StepOutcome = { kind: 'skipped', reason: 'Stopped before finishing.' };

    const opened: number[] = [];
    for (const [index, url] of urls.entries()) {
      if (!(await context.stillCurrent())) return stopped;
      const tab = await tabs.open(url, `${context.intentKey}:${index}`);
      opened.push(tab.tabId);
    }
    if (!(await context.stillCurrent())) return stopped;

    const title = groupTitle([
      optionalString(context.step.input, 'courseCode'),
      optionalString(context.step.input, 'label'),
    ]);
    const groupId = await tabs.ensureGroup({ title, color: 'blue' }, opened);

    return {
      kind: 'done',
      result: `Opened ${opened.length} page${opened.length === 1 ? '' : 's'} in "${title}".`,
      sourcesVisited: urls,
      // The record of which tabs Motion owns, and in which browser session
      // those ids mean anything (src/core/workspace/ownership.ts).
      evidence: { groupId, tabIds: opened, sessionKey: await tabs.sessionKey() },
    };
  };

  return {
    action: 'open-tab',

    execute: openAndGroup,

    /**
     * After a restart, find out whether the tabs were actually opened before
     * doing it again. Tabs Motion opened carry their operation id in the URL,
     * which survives the worker dying; a stored tab id would not.
     *
     * Finding some is not the same as finishing: the worker may have died
     * between opening the tabs and grouping them, or halfway through the list.
     * So the step is completed under the *original* key — found tabs are
     * reused, missing ones opened, and all of them grouped.
     */
    async reconcile(context: StepContext): Promise<StepOutcome | null> {
      const urls = requireUrls(context.step.input, 'urls');
      for (const index of urls.keys()) {
        if (await tabs.findByOperation(`${context.intentKey}:${index}`)) {
          return openAndGroup(context);
        }
      }
      return null; // it never happened; safe to run
    },
  };
}

/**
 * Reading is deliberately not a browser action: the content script has already
 * observed the page, so this step consumes what was reported rather than
 * reaching into a tab itself.
 */
export function readPageCapability(): StepCapability {
  return {
    action: 'read-page',
    async execute(context: StepContext): Promise<StepOutcome> {
      const url = requireString(context.step.input, 'url');
      if (!isOpenableUrl(url)) return { kind: 'blocked', reason: 'That page is not a secure URL.' };
      return { kind: 'done', result: 'Read the page Motion already had open.', sourcesVisited: [url] };
    },
  };
}

export function buildCapabilities(tabs: TabsCapability = new ChromeTabs()): StepCapability[] {
  return [readPageCapability(), openSourcesCapability(tabs)];
}
