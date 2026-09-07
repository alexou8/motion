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

/** Opens a set of course resources in a Motion-owned tab group. */
export function openSourcesCapability(tabs: TabsCapability): StepCapability {
  return {
    action: 'open-tab',

    async execute(context: StepContext): Promise<StepOutcome> {
      const urls = requireUrls(context.step.input, 'urls');
      if (urls.length === 0) return { kind: 'skipped', reason: 'No sources to open.' };

      const opened: number[] = [];
      const visited: string[] = [];
      for (const [index, url] of urls.entries()) {
        const operationId = `${context.intentKey}:${index}`;
        const tab = await tabs.open(url, operationId);
        opened.push(tab.tabId);
        visited.push(url);
      }

      const title = groupTitle([
        typeof context.step.input['courseCode'] === 'string'
          ? context.step.input['courseCode']
          : null,
        typeof context.step.input['label'] === 'string' ? context.step.input['label'] : null,
      ]);
      const groupId = await tabs.ensureGroup({ title, color: 'blue' }, opened);

      return {
        kind: 'done',
        result: `Opened ${opened.length} page${opened.length === 1 ? '' : 's'} in "${title}".`,
        sourcesVisited: visited,
        evidence: { groupId, tabIds: opened },
      };
    },

    /**
     * After a restart, find out whether the tabs were actually opened before
     * doing it again. Tabs Motion opened carry their operation id in the URL,
     * which survives the worker dying; a stored tab id would not.
     */
    async reconcile(context: StepContext): Promise<StepOutcome | null> {
      const urls = requireUrls(context.step.input, 'urls');
      const found: number[] = [];
      const visited: string[] = [];
      for (const [index, url] of urls.entries()) {
        const existing = await tabs.findByOperation(`${context.intentKey}:${index}`);
        if (existing) {
          found.push(existing.tabId);
          visited.push(url);
        }
      }
      if (found.length === 0) return null; // it never happened; safe to run
      return {
        kind: 'done',
        result: `Recovered ${found.length} page${found.length === 1 ? '' : 's'} opened earlier.`,
        sourcesVisited: visited,
        evidence: { tabIds: found },
      };
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
