import type { ActRequest, SnapshotResult } from '@/core/actor/contracts';
import { deriveRequirements, toRequirements } from '@/core/assist';
import type { AIProvider } from '@/core/ai/types';
import { buildLayeredPrompt } from '@/core/ai/prompt';
import { buildStepContext } from '@/core/agent/context';
import { validateDestination, type DestinationProvenance } from '@/core/agent/destination';
import {
  checklistSchema,
  courseSchema,
  courseTaskSchema,
  noteSchema,
  type PageContent,
} from '@/core/domain';
import { deriveLinksFromPage } from '@/core/graph';
import { evaluateAssessmentContext, tierOf, type ActionType } from '@/core/policy';
import { supportedHosts } from '@/core/adapters';
import type { AgentSession } from '@/core/session';
import { openDatabase } from '@/core/storage/db';
import { courseLinkRepository, sessionRepository, updateSession as updateStoredSession } from '@/core/storage/repositories';
import { Repository } from '@/core/storage/repository';
import { STORE } from '@/core/storage/schema';
import type { StepCapability, StepContext, StepOutcome } from '@/core/workflows';
import { ChromePreferencesStore } from '@/platform/ai/preferencesStore';
import { SessionSecretStore } from '@/platform/ai/secrets';
import { ChromeTabs, groupTitle, isOpenableUrl, type TabsCapability } from '@/platform/tabs';
import { actInContentScript, askContentScript, snapshotContentScript } from './contentBridge';
import {
  providerBlockerFromError,
  resolveSessionProvider,
  type ProviderResolution,
} from './providers';

const SNAPSHOTS_KEY = 'motion.snapshots';
const OBSERVATION_PREFIX = 'observation:';
type Input = Record<string, unknown>;

export interface CapabilityServices {
  tabs: TabsCapability;
  askContent: (tabId: number) => Promise<PageContent | null>;
  snapshot: (tabId: number) => Promise<SnapshotResult | null>;
  act: (tabId: number, request: ActRequest, consequentialCapability?: boolean, showOnPagePointer?: boolean) => Promise<{ ok: boolean; message?: string } | null>;
  resolveProvider: () => Promise<ProviderResolution>;
  now: () => Date;
}

function defaults(tabs: TabsCapability): CapabilityServices {
  return {
    tabs,
    askContent: askContentScript,
    snapshot: snapshotContentScript,
    act: actInContentScript,
    resolveProvider: () =>
      resolveSessionProvider({
        preferencesStore: new ChromePreferencesStore(),
        secrets: new SessionSecretStore(),
      }),
    now: () => new Date(),
  };
}

function requireString(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`Step is missing required input "${key}".`);
  return value;
}

function requireTabId(input: Input): number {
  const value = input['tabId'];
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new Error('Step requires a valid tabId.');
  return value as number;
}

function requireUrls(input: Input): string[] {
  const raw = input['urls'] ?? (typeof input['url'] === 'string' ? [input['url']] : undefined);
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((url) => typeof url !== 'string'))
    throw new Error('Step requires one or more URLs.');
  const urls = raw as string[];
  if (urls.some((url) => !isOpenableUrl(url)))
    throw new Error('Motion only opens secure HTTPS URLs.');
  return urls;
}

function requireSessionId(context: StepContext): string {
  const sessionId = context.workflow.params['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    throw new Error('This step is not associated with a Motion session.');
  return sessionId;
}

async function sessionFor(
  context: StepContext,
): Promise<{ value: AgentSession }> {
  const db = await openDatabase();
  const sessions = sessionRepository(db);
  const value = await sessions.get(requireSessionId(context));
  if (!value) throw new Error('Motion could not find this session.');
  return { value };
}

async function updateSession(
  context: StepContext,
  fn: (session: AgentSession) => AgentSession | null,
): Promise<AgentSession | null> {
  const db = await openDatabase();
  return updateStoredSession(db, requireSessionId(context), fn);
}

function destinationProvenance(input: Input): DestinationProvenance | undefined {
  const value = input['destinationProvenance'];
  return value === 'observed-link' || value === 'd2l-route' ? value : undefined;
}

function observedRelation(input: Input, url: string): import('@/core/graph').CourseLinkRelation | undefined {
  const single = input['observedRelation'];
  if (typeof single === 'string') return single as import('@/core/graph').CourseLinkRelation;
  const many = input['observedRelations'];
  if (typeof many === 'object' && many !== null && typeof (many as Record<string, unknown>)[url] === 'string')
    return (many as Record<string, unknown>)[url] as import('@/core/graph').CourseLinkRelation;
  return undefined;
}

function sessionDestinationAllowed(url: string, input: Input): boolean {
  return validateDestination(
    url,
    supportedHosts,
    destinationProvenance(input),
    observedRelation(input, url),
  ).ok;
}

function workspaceHas(session: AgentSession, tabId: number): boolean {
  const workspace = session.workspace;
  return (
    !workspace.releasedTabIds.includes(tabId) &&
    (workspace.ownedTabIds.includes(tabId) || workspace.adoptedTabIds.includes(tabId))
  );
}

function workspaceTitle(session: AgentSession): string {
  return groupTitle([session.title]);
}

async function isRestricted(tabId: number, content?: PageContent): Promise<boolean> {
  const key = `${OBSERVATION_PREFIX}${tabId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  if (
    typeof stored === 'object' &&
    stored !== null &&
    (stored as { restricted?: unknown }).restricted === true
  )
    return true;
  return content
    ? evaluateAssessmentContext({
        pageType: content.pageType,
        url: content.url,
        pageTitle: content.title,
        visibleText: content.text.slice(0, 4_000),
      }).restricted
    : false;
}

function sourceKind(content: PageContent): AgentSession['context']['sources'][number]['kind'] {
  if (/\brubric\b/i.test(content.title)) return 'rubric';
  if (content.pageType === 'assignment') return 'instructions';
  if (content.pageType === 'discussion-topic') return 'discussion';
  if (content.pageType === 'content-module' || content.pageType === 'content-topic')
    return 'module';
  return 'other';
}

function openTabCapability(services: CapabilityServices): StepCapability {
  const execute = async (context: StepContext): Promise<StepOutcome> => {
    const urls = requireUrls(context.step.input);
    // Persisted pre-session workflows remain supported during the migration.
    // They retain their original ownership model; agent-turns always supply a
    // session id and take the stricter session workspace path below.
    if (typeof context.workflow.params['sessionId'] !== 'string') {
      return openSourcesCapability(services.tabs).execute(context);
    }
    const { value: session } = await sessionFor(context);
    if (urls.some((url) => !sessionDestinationAllowed(url, context.step.input)))
      return { kind: 'blocked', reason: 'Motion will only open a known safe LMS destination.' };
    const tabIds: number[] = [];
    for (const [index, url] of urls.entries()) {
      if (!(await context.stillCurrent()))
        return { kind: 'skipped', reason: 'Stopped before opening the next tab.' };
      tabIds.push((await services.tabs.open(url, `${context.intentKey}:${index}`)).tabId);
    }
    if (!(await context.stillCurrent()))
      return { kind: 'skipped', reason: 'Stopped before grouping tabs.' };
    const groupId = await services.tabs.ensureGroup(
      { title: workspaceTitle(session), color: 'blue' },
      tabIds,
    );
    const sessionKey = await services.tabs.sessionKey();
    await updateSession(context, (current) => ({
      ...current,
      updatedAt: services.now().toISOString(),
      workspace: {
        ...current.workspace,
        groupId,
        groupTitle: workspaceTitle(current),
        sessionKey,
        ownedTabIds: [...new Set([...current.workspace.ownedTabIds, ...tabIds])],
      },
    }));
    return {
      kind: 'done',
      result: `Opened ${tabIds.length} page${tabIds.length === 1 ? '' : 's'} in ${workspaceTitle(session)}.`,
      sourcesVisited: urls,
      evidence: { groupId, tabIds, sessionKey },
    };
  };
  return {
    action: 'open-tab',
    execute,
    async reconcile(context) {
      const urls = requireUrls(context.step.input);
      const existing = await Promise.all(
        urls.map((_, index) => services.tabs.findByOperation(`${context.intentKey}:${index}`)),
      );
      return existing.some(Boolean) ? execute(context) : null;
    },
  };
}

function createTabGroupCapability(services: CapabilityServices): StepCapability {
  return {
    action: 'create-tab-group',
    async execute(context) {
      const { value: session } = await sessionFor(context);
      const tabIds = session.workspace.ownedTabIds.filter(
        (id) => !session.workspace.releasedTabIds.includes(id),
      );
      if (tabIds.length === 0)
        return { kind: 'skipped', reason: 'There are no Motion-owned tabs to group.' };
      const groupId = await services.tabs.ensureGroup(
        { title: workspaceTitle(session), color: 'blue' },
        tabIds,
      );
      await updateSession(context, (current) => ({
        ...current,
        updatedAt: services.now().toISOString(),
        workspace: { ...current.workspace, groupId, groupTitle: workspaceTitle(current) },
      }));
      return {
        kind: 'done',
        result: `Created the ${workspaceTitle(session)} workspace.`,
        evidence: { groupId, tabIds },
      };
    },
  };
}

function navigateOwnedTabCapability(services: CapabilityServices): StepCapability {
  const capability: StepCapability = {
    action: 'navigate-owned-tab',
    async execute(context) {
      const tabId = requireTabId(context.step.input);
      const url = requireString(context.step.input, 'url');
      if (!isOpenableUrl(url) || !sessionDestinationAllowed(url, context.step.input))
        return { kind: 'blocked', reason: 'Motion only navigates to secure HTTPS pages.' };
      const { value: session } = await sessionFor(context);
      if (
        !session.workspace.ownedTabIds.includes(tabId) ||
        session.workspace.releasedTabIds.includes(tabId)
      )
        return {
          kind: 'blocked',
          reason: 'Motion only navigates tabs it opened for this workspace.',
        };
      await services.tabs.navigateOwned(tabId, url, context.intentKey);
      return {
        kind: 'done',
        result: 'Navigated the Motion-owned workspace tab.',
        sourcesVisited: [url],
      };
    },
    async reconcile(context) {
      const tabId = requireTabId(context.step.input);
      const url = requireString(context.step.input, 'url');
      const tab = await services.tabs.get(tabId);
      return tab?.url === url
        ? { kind: 'done', result: 'The Motion-owned tab is already at the requested page.', sourcesVisited: [url] }
        : null;
    },
  };
  return capability;
}

function readPageCapability(services: CapabilityServices): StepCapability {
  return {
    action: 'read-page',
    async execute(context) {
      if (typeof context.workflow.params['sessionId'] !== 'string') {
        const url = requireString(context.step.input, 'url');
        return isOpenableUrl(url)
          ? {
              kind: 'done',
              result: 'Read the page Motion already had open.',
              sourcesVisited: [url],
            }
          : { kind: 'blocked', reason: 'That page is not a secure URL.' };
      }
      const { value: initialSession } = await sessionFor(context);
      let tabId: number;
      if (typeof context.step.input['tabId'] === 'number') {
        tabId = requireTabId(context.step.input);
      } else {
        const url = requireString(context.step.input, 'url');
        if (!sessionDestinationAllowed(url, context.step.input))
          return { kind: 'blocked', reason: 'Motion will only read a known safe LMS destination.' };
        const owned = initialSession.workspace.ownedTabIds.filter(
          (id) => !initialSession.workspace.releasedTabIds.includes(id),
        );
        const existing = await Promise.all(owned.map(async (id) => ({ id, tab: await services.tabs.get(id) })));
        tabId = existing.find(({ tab }) => tab?.url === url)?.id ?? -1;
        if (tabId < 0) {
          const opened = await services.tabs.open(url, `${context.intentKey}:read`);
          tabId = opened.tabId;
          const groupId = await services.tabs.groupInto(
            initialSession.workspace.groupId,
            [tabId],
            { title: workspaceTitle(initialSession), color: 'blue' },
          );
          const sessionKey = await services.tabs.sessionKey();
          await updateSession(context, (current) => ({
            ...current,
            updatedAt: services.now().toISOString(),
            workspace: {
              ...current.workspace,
              groupId,
              groupTitle: workspaceTitle(current),
              sessionKey,
              ownedTabIds: [...new Set([...current.workspace.ownedTabIds, tabId])],
            },
          }));
        }
      }
      const liveContent = await services.askContent(tabId);
      if (!liveContent)
        return { kind: 'blocked', reason: 'Motion could not verify that the current page is outside a restricted assessment.' };
      if (await isRestricted(tabId, liveContent))
        return {
          kind: 'skipped',
          reason: 'Motion did not store anything from this restricted assessment page.',
        };
      const content = liveContent;
      if (await isRestricted(tabId, content))
        return {
          kind: 'skipped',
          reason: 'Motion did not store anything from this restricted assessment page.',
        };
      const { value: session } = await sessionFor(context);
      const db = await openDatabase();
      const course = session.courseId
        ? await new Repository(db, STORE.courses, courseSchema).get(session.courseId)
        : null;
      const task = session.taskId
        ? await new Repository(db, STORE.tasks, courseTaskSchema).get(session.taskId)
        : null;
      if (course)
        await courseLinkRepository(db).putMany(
          deriveLinksFromPage(content, course, task, services.now().toISOString()),
        );
      const source = {
        url: content.url,
        title: content.title,
        kind: sourceKind(content),
        excluded: false,
        provenance: content.url,
        excerpt: content.text.slice(0, 8_000),
      };
      await updateSession(context, (current) => ({
        ...current,
        updatedAt: services.now().toISOString(),
        context: {
          ...current.context,
          sources: current.context.sources.some((item) => item.url === source.url)
            ? current.context.sources.map((item) => item.url === source.url ? { ...item, ...source, excluded: item.excluded } : item)
            : [...current.context.sources, source],
        },
      }));
      return {
        kind: 'done',
        result: 'Read the page and added it to this session’s context.',
        sourcesVisited: [content.url],
      };
    },
  };
}

function snapshotCapability(services: CapabilityServices): StepCapability {
  return {
    action: 'inspect-tab',
    async execute(context) {
      const tabId = requireTabId(context.step.input);
      const { value: session } = await sessionFor(context);
      if (!workspaceHas(session, tabId))
        return { kind: 'blocked', reason: 'That tab is outside this Motion workspace.' };
      // Storage is only a hint. Re-read the live page immediately before
      // capturing controls so a navigation race cannot persist an attempt.
      const liveContent = await services.askContent(tabId);
      if (!liveContent)
        return { kind: 'blocked', reason: 'Motion could not verify that the current page is outside a restricted assessment.' };
      if (await isRestricted(tabId, liveContent))
        return {
          kind: 'skipped',
          reason: 'Motion does not inspect controls in a restricted assessment.',
        };
      const snapshot = await services.snapshot(tabId);
      if (!snapshot) return { kind: 'blocked', reason: 'Motion could not inspect page controls.' };
      // The content script's verdict and capture are atomic, but the tab may
      // still have navigated between our live-content read above and this
      // snapshot call. Require the snapshot to name the page we just
      // verified before trusting (or storing) anything it captured.
      if (snapshot.url !== liveContent.url)
        return { kind: 'blocked', reason: 'The page changed while Motion was inspecting it. Try again.' };
      if (snapshot.restricted)
        return {
          kind: 'skipped',
          reason: 'Motion does not inspect controls in a restricted assessment.',
        };
      const stored = (await chrome.storage.session.get(SNAPSHOTS_KEY))[SNAPSHOTS_KEY];
      const snapshots =
        typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
      await chrome.storage.session.set({ [SNAPSHOTS_KEY]: { ...snapshots, [tabId]: snapshot } });
      return {
        kind: 'done',
        result: `Captured ${snapshot.elements.length} page controls.`,
        sourcesVisited: [snapshot.url],
        evidence: { snapshotId: snapshot.snapshotId, tabId },
      };
    },
  };
}

type ActorAction = Extract<
  ActionType,
  | 'fill-form-field'
  | 'select-option'
  | 'toggle-control'
  | 'click-element'
  | 'save-remote-draft'
  | 'submit-assignment'
  | 'post-discussion'
  | 'prepare-discussion-response'
  | 'scroll-to'
  | 'focus-element'
>;
function actorCapability(action: ActorAction, services: CapabilityServices): StepCapability {
  return {
    action,
    async execute(context) {
      const tabId = requireTabId(context.step.input);
      const snapshotId = requireString(context.step.input, 'snapshotId');
      const handle = requireString(context.step.input, 'handle');
      const { value: session } = await sessionFor(context);
      if (!workspaceHas(session, tabId))
        return { kind: 'blocked', reason: 'Motion only acts inside this session’s workspace.' };
      if (await isRestricted(tabId))
        return { kind: 'blocked', reason: 'Motion will not act in a restricted assessment.' };
      // The page/approval checks above await browser state. The workflow can
      // be paused or cancelled during either wait, so re-check ownership at
      // the last possible point before the remote DOM effect.
      if (!(await context.stillCurrent()))
        return { kind: 'skipped', reason: 'Stopped before acting on the page.' };
      const request: ActRequest =
        action === 'fill-form-field' ||
        (action === 'prepare-discussion-response' && typeof context.step.input['text'] === 'string')
          ? {
              type: 'fill',
              snapshotId,
              handle,
              value: requireString(
                context.step.input,
                action === 'fill-form-field' ? 'value' : 'text',
              ),
            }
          : action === 'select-option'
            ? {
                type: 'select',
                snapshotId,
                handle,
                value: requireString(context.step.input, 'value'),
              }
            : action === 'toggle-control'
              ? {
                  type: 'toggle',
                  snapshotId,
                  handle,
                  checked: context.step.input['checked'] === true,
                }
              : action === 'scroll-to'
                ? { type: 'scrollTo', snapshotId, handle }
                : action === 'focus-element'
                  ? { type: 'focus', snapshotId, handle }
              : { type: 'click', snapshotId, handle };
      // Resolve the visual preference only after all policy, ownership, and
      // freshness checks have passed. It changes presentation, never authority.
      const showOnPagePointer = (await new ChromePreferencesStore().get()).showOnPagePointer;
      const result = await services.act(
        tabId,
        request,
        tierOf(action) === 'fresh-confirmation' && Boolean(context.step.consumedApprovalId),
        showOnPagePointer,
      );
      if (!result?.ok)
        return {
          kind: 'blocked',
          reason: result?.message ?? 'Motion could not complete that page action.',
        };
      return { kind: 'done', result: 'Completed the approved page action.' };
    },
    async reconcile() {
      // DOM writes and clicks have no durable, target-bound browser marker.
      // Never replay them after a worker restart; the student can explicitly
      // retry after inspecting the page.
      return { kind: 'blocked', reason: 'Motion will not replay an interrupted page action automatically. Review the page and retry it.' };
    },
  };
}

function providerCapability(
  action: Extract<ActionType, 'generate-draft' | 'summarize' | 'analyze-rubric'>,
  services: CapabilityServices,
): StepCapability {
  return {
    action,
    async execute(context) {
      const request =
        typeof context.step.input['direction'] === 'string'
          ? context.step.input['direction']
          : typeof context.step.input['text'] === 'string'
            ? context.step.input['text']
            : context.step.title;
      if (request.trim() === '') throw new Error('This AI step needs a specific request.');
      const { value: session } = await sessionFor(context);
      const db = await openDatabase();
      const notes = (await new Repository(db, STORE.notes, noteSchema).all()).records;
      const prompt = buildLayeredPrompt({
        systemPolicy: 'You are Motion. Help the student understand and prepare coursework. Do not claim to have completed work the student has not reviewed.',
        userGoal: request,
        // A session title/goal can originate on an LMS page. Trusted state is
        // deliberately limited to Motion-issued identity and state; all
        // student/page-derived metadata stays inside the fenced context.
        trustedState: `Session id: ${session.id} (status: ${session.status})`,
        untrusted: [
          ...buildStepContext(session, notes),
          { label: 'session metadata', text: `Title: ${session.title}\nGoal: ${session.goal}` },
        ],
      });
      const resolved = await services.resolveProvider();
      if (resolved.kind === 'blocked') return { kind: 'blocked', reason: resolved.blocker.message };
      try {
        const output = await generate(resolved.provider, resolved.model, request, prompt);
        const now = services.now().toISOString();
        const noteId = crypto.randomUUID();
        await new Repository(db, STORE.notes, noteSchema).put({
          id: noteId,
          courseId: session.courseId,
          taskId: session.taskId,
          title: context.step.title,
          tags: [],
          blocks: [
            {
              id: crypto.randomUUID(),
              origin: 'generated',
              text: output,
              generatedBy: resolved.providerId,
              createdAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        });
        await updateSession(context, (current) => ({
          ...current,
          updatedAt: now,
          artifacts: [
            ...current.artifacts,
            {
              id: crypto.randomUUID(),
              kind: action === 'generate-draft' ? 'draft' : 'summary',
              refId: noteId,
              title: context.step.title,
              createdAt: now,
            },
          ],
        }));
        return {
          kind: 'done',
          result: `Created a ${action === 'generate-draft' ? 'draft' : 'note'} with ${resolved.displayName}.`,
        };
      } catch (error) {
        return {
          kind: 'blocked',
          reason: providerBlockerFromError(error, resolved.displayName).message,
        };
      }
    },
  };
}

async function generate(provider: AIProvider, model: string, request: string, prompt: string): Promise<string> {
  return provider.generate({
    system: prompt,
    messages: [{ role: 'user', content: request }],
    model,
  });
}

function checklistCapability(services: CapabilityServices): StepCapability {
  return {
    action: 'create-checklist',
    async execute(context) {
      let tabId: number;
      if (typeof context.step.input['tabId'] === 'number') {
        tabId = requireTabId(context.step.input);
      } else {
        const url = requireString(context.step.input, 'url');
        if (!sessionDestinationAllowed(url, context.step.input))
          return { kind: 'blocked', reason: 'Motion will only read a known safe LMS destination.' };
        const { value: initialSession } = await sessionFor(context);
        const existing = await Promise.all(initialSession.workspace.ownedTabIds
          .filter((id) => !initialSession.workspace.releasedTabIds.includes(id))
          .map(async (id) => ({ id, tab: await services.tabs.get(id) })));
        tabId = existing.find(({ tab }) => tab?.url === url)?.id ?? -1;
        if (tabId < 0) {
          const opened = await services.tabs.open(url, `${context.intentKey}:checklist`);
          tabId = opened.tabId;
          const groupId = await services.tabs.groupInto(initialSession.workspace.groupId, [tabId], {
            title: workspaceTitle(initialSession), color: 'blue',
          });
          const sessionKey = await services.tabs.sessionKey();
          await updateSession(context, (current) => ({
            ...current,
            updatedAt: services.now().toISOString(),
            workspace: {
              ...current.workspace, groupId, groupTitle: workspaceTitle(current), sessionKey,
              ownedTabIds: [...new Set([...current.workspace.ownedTabIds, tabId])],
            },
          }));
        }
      }
      if (await isRestricted(tabId))
        return { kind: 'skipped', reason: 'Motion did not read a restricted assessment.' };
      const content = await services.askContent(tabId);
      if (!content || (await isRestricted(tabId, content)))
        return { kind: 'blocked', reason: 'Motion could not read assignment instructions.' };
      const requirements = deriveRequirements(content.instructionBlocks);
      if (requirements.length === 0)
        return {
          kind: 'skipped',
          reason: 'Motion could not find stated requirements on this page.',
        };
      const { value: session } = await sessionFor(context);
      const now = services.now().toISOString();
      const id = crypto.randomUUID();
      const db = await openDatabase();
      await new Repository(db, STORE.checklists, checklistSchema).put({
        id,
        courseId: session.courseId ?? 'unassigned',
        taskId: session.taskId,
        title: `${content.title || 'Assignment'} checklist`,
        items: toRequirements(
          requirements,
          {
            url: content.url,
            pageTitle: content.title,
            pageType: content.pageType,
            capturedAt: content.capturedAt,
          },
          () => crypto.randomUUID(),
        ),
        createdAt: now,
        updatedAt: now,
      });
      await updateSession(context, (current) => ({
        ...current,
        updatedAt: now,
        artifacts: [
          ...current.artifacts,
          {
            id: crypto.randomUUID(),
            kind: 'checklist',
            refId: id,
            title: `${content.title || 'Assignment'} checklist`,
            createdAt: now,
          },
        ],
      }));
      return {
        kind: 'done',
        result: `Created a checklist with ${requirements.length} requirements.`,
        sourcesVisited: [content.url],
      };
    },
  };
}

function noteCapability(services: CapabilityServices): StepCapability {
  return {
    action: 'create-note',
    async execute(context) {
      const title = requireString(context.step.input, 'title');
      const text = requireString(context.step.input, 'text');
      const { value: session } = await sessionFor(context);
      const now = services.now().toISOString();
      const id = crypto.randomUUID();
      const db = await openDatabase();
      await new Repository(db, STORE.notes, noteSchema).put({
        id,
        courseId: session.courseId,
        taskId: session.taskId,
        title,
        tags: [],
        blocks: [{ id: crypto.randomUUID(), origin: 'student', text, createdAt: now }],
        createdAt: now,
        updatedAt: now,
      });
      await updateSession(context, (current) => ({
        ...current,
        updatedAt: now,
        artifacts: [
          ...current.artifacts,
          { id: crypto.randomUUID(), kind: 'note', refId: id, title, createdAt: now },
        ],
      }));
      return { kind: 'done', result: `Saved “${title}”.` };
    },
  };
}

function deadlinesCapability(): StepCapability {
  return {
    action: 'extract-deadlines',
    async execute(context) {
      const range = requireString(context.step.input, 'range');
      if (!['today', 'week', 'overdue', 'all'].includes(range))
        throw new Error('Deadline range is invalid.');
      const { value: session } = await sessionFor(context);
      const db = await openDatabase();
      const tasks = new Repository(db, STORE.tasks, courseTaskSchema);
      const found = session.courseId
        ? (await tasks.byIndex('byCourse', session.courseId)).records
        : (await tasks.all()).records;
      return {
        kind: 'done',
        result: `Found ${found.length} deadline${found.length === 1 ? '' : 's'} in this session’s course.`,
      };
    },
  };
}

function gatherMaterialCapability(): StepCapability {
  return {
    action: 'gather-material',
    async execute(context) {
      const { value: session } = await sessionFor(context);
      const taskId =
        typeof context.step.input['taskId'] === 'string'
          ? context.step.input['taskId']
          : session.taskId;
      if (!taskId)
        return { kind: 'blocked', reason: 'Choose an assignment before gathering its resources.' };
      const db = await openDatabase();
      const links = (await courseLinkRepository(db).byIndex('byTask', taskId)).records;
      const urls = links.flatMap((link) =>
        typeof link.to.url === 'string' && isOpenableUrl(link.to.url) ? [link.to.url] : [],
      );
      return urls.length === 0
        ? { kind: 'skipped', reason: 'Motion has no observed resources for this assignment yet.' }
        : {
            kind: 'done',
            result: `Found ${urls.length} observed resource${urls.length === 1 ? '' : 's'} for this assignment.`,
            sourcesVisited: urls,
          };
    },
  };
}

/** The closed worker capability set; there is deliberately no generic DOM or scripting operation. */
export function buildCapabilities(
  tabs: TabsCapability = new ChromeTabs(),
  overrides: Partial<CapabilityServices> = {},
): StepCapability[] {
  const services = { ...defaults(tabs), ...overrides, tabs: overrides.tabs ?? tabs };
  return [
    readPageCapability(services),
    openTabCapability(services),
    createTabGroupCapability(services),
    navigateOwnedTabCapability(services),
    gatherMaterialCapability(),
    snapshotCapability(services),
    actorCapability('scroll-to', services),
    actorCapability('focus-element', services),
    actorCapability('fill-form-field', services),
    actorCapability('select-option', services),
    actorCapability('toggle-control', services),
    actorCapability('click-element', services),
    actorCapability('save-remote-draft', services),
    actorCapability('submit-assignment', services),
    actorCapability('post-discussion', services),
    actorCapability('prepare-discussion-response', services),
    providerCapability('generate-draft', services),
    providerCapability('summarize', services),
    providerCapability('analyze-rubric', services),
    checklistCapability(services),
    noteCapability(services),
    deadlinesCapability(),
  ];
}

/** Compatibility export for the original workspace workflow. */
export function openSourcesCapability(tabs: TabsCapability): StepCapability {
  const execute = async (context: StepContext): Promise<StepOutcome> => {
    const urls = requireUrls(context.step.input);
    const tabIds: number[] = [];
    for (const [index, url] of urls.entries()) {
      if (!(await context.stillCurrent()))
        return { kind: 'skipped', reason: 'Stopped before finishing.' };
      tabIds.push((await tabs.open(url, `${context.intentKey}:${index}`)).tabId);
    }
    if (!(await context.stillCurrent()))
      return { kind: 'skipped', reason: 'Stopped before finishing.' };
    const courseCode =
      typeof context.step.input['courseCode'] === 'string'
        ? context.step.input['courseCode']
        : null;
    const label =
      typeof context.step.input['label'] === 'string' ? context.step.input['label'] : null;
    const title = groupTitle([courseCode, label]);
    const groupId = await tabs.ensureGroup({ title, color: 'blue' }, tabIds);
    return {
      kind: 'done',
      result: `Opened ${tabIds.length} page${tabIds.length === 1 ? '' : 's'} in "${title}".`,
      sourcesVisited: urls,
      evidence: { groupId, tabIds, sessionKey: await tabs.sessionKey() },
    };
  };
  return {
    action: 'open-tab',
    execute,
    async reconcile(context) {
      const urls = requireUrls(context.step.input);
      return (
        await Promise.all(
          urls.map((_, index) => tabs.findByOperation(`${context.intentKey}:${index}`)),
        )
      ).some(Boolean)
        ? execute(context)
        : null;
    },
  };
}
