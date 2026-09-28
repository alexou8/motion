import {
  policyDecision,
  tierOf,
  classifyElementConsequence,
  type ActionType,
  type PolicyDecisionResult,
} from '../policy';
import type { StepPlan } from '../workflows/types';
import { actionForTool, type ToolCall } from './tools';
import type { RefTables } from './refs';
import { resolveCourseNav } from '../adapters';
import { validateDestination, type DestinationProvenance } from './destination';
import type { CourseLinkRelation } from '../graph';

/**
 * Resolves a model tool call to a concrete, policy-checked step (VISION §8,
 * §10, §21; ARCH D5/D7).
 *
 * Two different kinds of failure are kept distinct on purpose:
 *
 *   - `{kind:'rejected'}` — a *structural* problem: an unknown ref, a resolved
 *     URL that isn't https/same-origin, a tab outside the workspace, a stale
 *     handle, an out-of-bounds value. These never reach the policy engine at
 *     all, because there is nothing valid to charge a decision against.
 *   - `{kind:'ok', decision}` — the call resolved to something real, and
 *     `decision` (from `policyDecision`) says whether it may run now
 *     (`allow`), needs approval (`needs-approval` / `needs-fresh-approval`),
 *     or is refused by policy (`forbid`, e.g. a restricted assessment tab).
 *     Callers must still check `decision.decision` before executing.
 */

export interface GuardContext {
  /** Whether the *target* tab (by tabRef) is currently a restricted assessment context. */
  assessmentRestrictedByTabRef: Record<string, boolean>;
  allowedConfigurable: ReadonlySet<ActionType>;
  /** Origins the model is allowed to navigate to / whose links may be opened. */
  lmsOrigins: readonly string[];
  /** This turn's sequence number, for stable step ids `t<turnSeq>-<index>`. */
  turnSeq: number;
  /** Session task, used only to resolve semantic assignment actions. */
  activeTaskId?: string | null;
}

export type GuardResult =
  | { kind: 'ok'; step: StepPlan; decision: PolicyDecisionResult }
  | { kind: 'rejected'; reason: string };

function stepId(ctx: GuardContext, index: number): string {
  return `t${ctx.turnSeq}-${index}`;
}

/**
 * Actions still permitted on a tab Motion currently considers a restricted
 * assessment context (VISION §11): reading, and the two actor-level
 * no-op-ish navigation aids (scrolling/focusing an element already on the
 * page). Everything else — even a configurable action like filling a field —
 * is forbidden there, full stop, regardless of approvals.
 */
const ALLOWED_IN_RESTRICTED_TAB: ReadonlySet<ActionType> = new Set<ActionType>([
  'read-page',
  'scroll-to',
  'focus-element',
]);

function destination(
  url: string,
  ctx: GuardContext,
  provenance: DestinationProvenance,
  observedRelation?: CourseLinkRelation,
): { ok: true } | { ok: false; reason: string } {
  return validateDestination(url, ctx.lmsOrigins, provenance, observedRelation);
}

function resourceUrls(refs: RefTables, taskId: string | undefined, kinds: readonly string[]): string[] {
  const urls = new Set<string>();
  if (taskId && kinds.includes('has-instructions')) {
    const taskUrl = refs.taskByRef.get(taskId)?.provenance.sourceUrl;
    if (taskUrl) urls.add(taskUrl);
  }
  for (const link of refs.linkByRef.values()) {
    if (taskId && link.taskId !== taskId && link.from.id !== taskId) continue;
    if (!kinds.includes(link.relation) || link.userOverride?.state === 'rejected') continue;
    if (link.to.url) urls.add(link.to.url);
  }
  return [...urls];
}

function sourceUrl(refs: RefTables, kind: 'instructions' | 'rubric'): string | undefined {
  return [...refs.sourceByRef.values()].find((source) => source.kind === kind)?.url;
}

function courseNavSource(refs: RefTables): string | undefined {
  return refs.tabByRef.values().next().value?.url
    ?? refs.sourceByRef.values().next().value?.url
    ?? refs.linkByRef.values().next().value?.provenance.sourceUrl;
}

function friendlyTitle(call: ToolCall): string {
  switch (call.tool) {
    case 'open_assignment_resources':
      return 'Open assignment resources';
    case 'open_course_page':
      return `Open course ${call.page} page`;
    case 'open_link':
      return 'Open link';
    case 'read_page':
      return 'Read page';
    case 'read_assignment_instructions':
      return 'Read assignment instructions';
    case 'read_rubric':
      return 'Read rubric';
    case 'build_checklist':
      return 'Build checklist';
    case 'create_note':
      return `Create note: ${call.title}`;
    case 'draft':
      return `Draft (${call.kind})`;
    case 'review_draft':
      return 'Review draft against rubric';
    case 'summarize_sources':
      return 'Summarize sources';
    case 'list_deadlines':
      return `List deadlines (${call.range})`;
    case 'snapshot_tab':
      return 'Look at page elements';
    case 'scroll_to':
      return 'Scroll to element';
    case 'focus_element':
      return 'Focus element';
    case 'fill_field':
      return 'Fill field';
    case 'select_option':
      return 'Select option';
    case 'toggle_control':
      return 'Toggle control';
    case 'click':
      return 'Click element';
    case 'save_discussion_draft':
      return 'Save discussion draft';
    case 'submit_assignment':
      return 'Submit assignment';
    case 'post_discussion':
      return 'Post discussion reply';
  }
}

function decide(
  action: ActionType,
  ctx: GuardContext,
  restricted: boolean,
): PolicyDecisionResult {
  const effectivelyRestricted = restricted && !ALLOWED_IN_RESTRICTED_TAB.has(action);
  return policyDecision({
    action,
    assessmentRestricted: effectivelyRestricted,
    allowedConfigurable: ctx.allowedConfigurable,
  });
}

export function guardToolCall(call: ToolCall, refs: RefTables, ctx: GuardContext, index = 0): GuardResult {
  const id = stepId(ctx, index);
  const title = friendlyTitle(call);

  const restrictedFor = (tabRef: string) => ctx.assessmentRestrictedByTabRef[tabRef] === true;

  switch (call.tool) {
    case 'open_assignment_resources': {
      let taskId: string | undefined = ctx.activeTaskId ?? undefined;
      if (call.taskRef) {
        const task = refs.resolveTask(call.taskRef);
        if (!task) return { kind: 'rejected', reason: `unknown taskRef "${call.taskRef}"` };
        taskId = task.id;
      }
      const urls = resourceUrls(refs, taskId, ['has-instructions', 'has-rubric', 'has-reading', 'has-module']);
      const relationByUrl = new Map([...refs.linkByRef.values()].map((link) => [link.to.url, link.relation]));
      const safeUrls = urls.filter((url) => destination(url, ctx, 'observed-link', relationByUrl.get(url)).ok);
      if (safeUrls.length === 0)
        return { kind: 'rejected', reason: 'no safe observed instruction, rubric, or reading links are available for this assignment' };
      const action = actionForTool(call.tool);
      return {
        kind: 'ok',
        step: { id, title, action, input: {
          urls: safeUrls,
          destinationProvenance: 'observed-link',
          observedRelations: Object.fromEntries(safeUrls.map((url) => [url, relationByUrl.get(url)])),
        } },
        decision: decide(action, ctx, false),
      };
    }

    case 'open_course_page': {
      const currentUrl = courseNavSource(refs);
      if (!currentUrl) return { kind: 'rejected', reason: 'no observed course page is available to resolve this destination' };
      const nav = resolveCourseNav(currentUrl, { links: [] });
      const url = nav?.[`${call.page}Url` as keyof typeof nav];
      if (!url) return { kind: 'rejected', reason: 'Motion could not resolve that course page' };
      const checked = destination(url, ctx, 'd2l-route');
      if (!checked.ok) return { kind: 'rejected', reason: checked.reason };
      const action = actionForTool(call.tool);
      return {
        kind: 'ok',
        step: { id, title, action, input: { url, destinationProvenance: 'd2l-route' } },
        decision: decide(action, ctx, false),
      };
    }

    case 'open_link': {
      const link = refs.resolveLink(call.linkRef);
      if (!link) return { kind: 'rejected', reason: `unknown linkRef "${call.linkRef}"` };
      const url = link.to.url;
      if (!url) return { kind: 'rejected', reason: 'link has no resolvable URL' };
      const checked = destination(url, ctx, 'observed-link', link.relation);
      if (!checked.ok) return { kind: 'rejected', reason: checked.reason };
      const action = actionForTool(call.tool);
      return {
        kind: 'ok',
        step: { id, title, action, input: { url, destinationProvenance: 'observed-link', observedRelation: link.relation } },
        decision: decide(action, ctx, false),
      };
    }

    case 'read_page':
    case 'snapshot_tab': {
      const tab = refs.resolveTab(call.tabRef);
      if (!tab) return { kind: 'rejected', reason: `unknown or out-of-workspace tabRef "${call.tabRef}"` };
      const action = actionForTool(call.tool);
      return {
        kind: 'ok',
        step: { id, title, action, input: { tabId: tab.tabId, url: tab.url } },
        decision: decide(action, ctx, restrictedFor(call.tabRef)),
      };
    }

    case 'read_assignment_instructions': {
      let tabId: number | undefined;
      if (call.tabRef) {
        const tab = refs.resolveTab(call.tabRef);
        if (!tab) return { kind: 'rejected', reason: `unknown tabRef "${call.tabRef}"` };
        tabId = tab.tabId;
      }
      const action = actionForTool(call.tool);
      const url = tabId === undefined
        ? resourceUrls(refs, ctx.activeTaskId ?? undefined, ['has-instructions'])[0] ?? sourceUrl(refs, 'instructions')
        : undefined;
      if (url) {
        const checked = destination(url, ctx, 'observed-link', 'has-instructions');
        if (!checked.ok) return { kind: 'rejected', reason: checked.reason };
      }
      if (tabId === undefined && !url)
        return { kind: 'rejected', reason: 'no observed assignment instructions are available to read' };
      return {
        kind: 'ok',
        step: { id, title, action, input: tabId === undefined ? { url, destinationProvenance: 'observed-link', observedRelation: 'has-instructions' } : { tabId } },
        decision: decide(action, ctx, call.tabRef ? restrictedFor(call.tabRef) : false),
      };
    }

    case 'read_rubric': {
      let url: string | undefined = sourceUrl(refs, 'rubric');
      if (call.linkRef) {
        const link = refs.resolveLink(call.linkRef);
        if (!link) return { kind: 'rejected', reason: `unknown linkRef "${call.linkRef}"` };
        url = link.to.url;
      }
      if (!url) url = resourceUrls(refs, undefined, ['has-rubric'])[0];
      if (!url) return { kind: 'rejected', reason: 'no observed rubric is available to read' };
      const checked = destination(url, ctx, 'observed-link', 'has-rubric');
      if (!checked.ok) return { kind: 'rejected', reason: checked.reason };
      const action = actionForTool(call.tool);
      return { kind: 'ok', step: { id, title, action, input: { url, destinationProvenance: 'observed-link', observedRelation: 'has-rubric' } }, decision: decide(action, ctx, false) };
    }

    case 'build_checklist': {
      const action = actionForTool(call.tool);
      const url = resourceUrls(refs, ctx.activeTaskId ?? undefined, ['has-instructions'])[0] ?? sourceUrl(refs, 'instructions');
      if (url) {
        const checked = destination(url, ctx, 'observed-link', 'has-instructions');
        if (!checked.ok) return { kind: 'rejected', reason: checked.reason };
      }
      return {
        kind: 'ok',
        step: { id, title, action, input: url ? { url, destinationProvenance: 'observed-link', observedRelation: 'has-instructions' } : {} },
        decision: decide(action, ctx, false),
      };
    }

    case 'summarize_sources': {
      const action = actionForTool(call.tool);
      return { kind: 'ok', step: { id, title, action, input: {} }, decision: decide(action, ctx, false) };
    }

    case 'create_note': {
      const action = actionForTool(call.tool);
      return {
        kind: 'ok',
        step: { id, title, action, input: { title: call.title, text: call.text } },
        decision: decide(action, ctx, false),
      };
    }

    case 'draft': {
      const action = actionForTool(call.tool);
      return {
        kind: 'ok',
        step: { id, title, action, input: { kind: call.kind, direction: call.direction, section: call.section } },
        decision: decide(action, ctx, false),
      };
    }

    case 'review_draft': {
      let noteId: string | undefined;
      if (call.noteRef) {
        const note = refs.resolveNote(call.noteRef);
        if (!note) return { kind: 'rejected', reason: `unknown noteRef "${call.noteRef}"` };
        noteId = note.id;
      }
      const action = actionForTool(call.tool);
      return { kind: 'ok', step: { id, title, action, input: { noteId } }, decision: decide(action, ctx, false) };
    }

    case 'list_deadlines': {
      const action = actionForTool(call.tool);
      return {
        kind: 'ok',
        step: { id, title, action, input: { range: call.range } },
        decision: decide(action, ctx, false),
      };
    }

    case 'fill_field':
    case 'scroll_to':
    case 'focus_element':
    case 'select_option':
    case 'toggle_control':
    case 'save_discussion_draft':
    case 'submit_assignment':
    case 'post_discussion': {
      const tab = refs.resolveTab(call.tabRef);
      if (!tab) return { kind: 'rejected', reason: `unknown or out-of-workspace tabRef "${call.tabRef}"` };
      const descriptor = refs.resolveHandle(call.tabRef, call.handle);
      if (!descriptor) return { kind: 'rejected', reason: `stale or unknown handle "${call.handle}"` };
      const action = actionForTool(call.tool);
      const extra: Record<string, unknown> =
        call.tool === 'fill_field' || call.tool === 'select_option'
          ? { value: call.value }
          : call.tool === 'toggle_control'
            ? { checked: call.checked }
            : call.tool === 'save_discussion_draft'
              ? { text: call.text }
              : call.tool === 'submit_assignment'
                ? { fileLabel: call.fileLabel }
                : {};
      return {
        kind: 'ok',
        step: {
          id,
          title,
          action,
          input: { tabId: tab.tabId, url: tab.url, handle: call.handle, ...extra },
        },
        decision: decide(action, ctx, restrictedFor(call.tabRef)),
      };
    }

    case 'click': {
      const tab = refs.resolveTab(call.tabRef);
      if (!tab) return { kind: 'rejected', reason: `unknown or out-of-workspace tabRef "${call.tabRef}"` };
      const descriptor = refs.resolveHandle(call.tabRef, call.handle);
      if (!descriptor) return { kind: 'rejected', reason: `stale or unknown handle "${call.handle}"` };
      const restricted = restrictedFor(call.tabRef);
      const action = classifyElementConsequence({
        tag: descriptor.tag,
        type: descriptor.type,
        role: descriptor.role,
        label: descriptor.label,
        formMethod: descriptor.formMethod,
        formActionPath: descriptor.formActionPath,
        inAttempt: restricted,
      });
      return {
        kind: 'ok',
        step: {
          id,
          title: `${title}: ${descriptor.label || descriptor.role}`,
          action,
          input: { tabId: tab.tabId, url: tab.url, handle: call.handle },
        },
        decision: decide(action, ctx, restricted),
      };
    }
  }
}

export function tierForTool(tool: ToolCall['tool']) {
  return tierOf(actionForTool(tool));
}
