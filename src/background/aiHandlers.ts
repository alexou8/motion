import { z } from 'zod';
import { curatedModelsFor, isSupportedTextModel } from '@/core/ai/models';
import { PROVIDER_IDS, aiPreferencesSchema, type AIPreferences } from '@/core/ai/preferences';
import { ProviderError, type ProviderAvailability, type ProviderCapabilities, type ProviderId, type ProviderStatus } from '@/core/ai/types';
import {
  acceptCloudDisclosureSchema,
  aiStatusResultSchema,
  deleteLocalDataSchema,
  forgetProviderKeySchema,
  keychainStatusResultSchema,
  keychainStatusSchema,
  listProviderModelsSchema,
  providerModelListResultSchema,
  setAiPreferencesSchema,
  setProviderKeySchema,
  testProviderSchema,
} from '@/core/messaging/sessionContracts';
import { deleteDatabase as deleteMotionDatabase } from '@/core/storage/db';
import { supportedHosts } from '@/core/adapters';
import { createProvider, type RegistryDeps } from '@/platform/ai/registry';
import type { FetchLike } from '@/platform/ai/http';
import { ChromePreferencesStore, type PreferencesStore } from '@/platform/ai/preferencesStore';
import { HybridSecretStore, SessionSecretStore, type SecretStore, type StorageArea } from '@/platform/ai/secrets';
import { NativeKeychainAdapter, type KeychainVault } from '@/platform/ai/keychain';
import { getInferencePort } from './inferencePort';
import { DOCUMENT_LIFECYCLE_KEY, DOCUMENT_LIFECYCLE_LOCK } from './documents';
import { withLock } from '@/platform/locks';
import {
  providerBlockerFromError,
  providerDisplayNames,
  providerOrigins,
  assertCurrentProviderConsent,
  guardedProviderFetch,
  type PermissionsCheck,
} from './providers';
import { abortCloudRequests, registerCloudRequest, releaseCloudRequest } from './cloudRequests';

const aiMessageSchema = z.discriminatedUnion('type', [
  aiStatusResultInputSchema(),
  keychainStatusSchema,
  listProviderModelsSchema,
  setProviderKeySchema,
  forgetProviderKeySchema,
  testProviderSchema,
  setAiPreferencesSchema,
  acceptCloudDisclosureSchema,
  deleteLocalDataSchema,
]);

// `ai-status` has no payload, but keeping its schema local makes this handler
// independently safe when it is called without the outer message router.
function aiStatusResultInputSchema() {
  return z.object({ type: z.literal('ai-status') });
}

const LMS_PERMISSION_ORIGINS = supportedHosts.map((host) => `https://${host}/*`);
const PROVIDER_AVAILABILITY_TIMEOUT_MS = 5_500;

type AiMessage = z.infer<typeof aiMessageSchema>;

interface ClearableStorageArea extends StorageArea {
  clear?(): Promise<void>;
}

export interface AiHandlerDeps {
  preferencesStore?: PreferencesStore;
  secrets?: SecretStore;
  localStorage?: StorageArea;
  sessionStorage?: ClearableStorageArea;
  keychain?: KeychainVault;
  permissions?: PermissionsCheck;
  fetchImpl?: FetchLike;
  deleteDatabase?: () => Promise<void>;
  /** Clears every scheduled alarm; defaults to `chrome.alarms.clearAll`. */
  clearAlarms?: () => Promise<void>;
  /** Clears every open Motion notification; defaults to `chrome.notifications`. */
  clearNotifications?: () => Promise<void>;
}

interface HandlerContext {
  preferences: PreferencesStore;
  secrets: SecretStore;
  local: StorageArea;
  session: ClearableStorageArea;
  permissions: PermissionsCheck;
  fetchImpl?: FetchLike;
  deleteDatabase: () => Promise<void>;
  clearAlarms: () => Promise<void>;
  clearNotifications: () => Promise<void>;
  keychain: KeychainVault;
}

function contextFor(deps: AiHandlerDeps): HandlerContext {
  const session = deps.sessionStorage ?? (chrome.storage.session as unknown as ClearableStorageArea);
  const local = deps.localStorage ?? (chrome.storage.local as unknown as StorageArea);
  const keychain = deps.keychain ?? new NativeKeychainAdapter();
  return {
    preferences: deps.preferencesStore ?? new ChromePreferencesStore(local),
    secrets: deps.secrets ?? new HybridSecretStore({ session: new SessionSecretStore(session), localStorage: local, vault: keychain }),
    local,
    session,
    permissions: deps.permissions ?? defaultPermissions(),
    keychain,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    deleteDatabase: deps.deleteDatabase ?? (() => deleteMotionDatabase()),
    clearAlarms: deps.clearAlarms ?? defaultClearAlarms,
    clearNotifications: deps.clearNotifications ?? defaultClearNotifications,
  };
}

async function defaultClearAlarms(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.alarms?.clearAll) return;
  await chrome.alarms.clearAll();
}

/** Every notification this extension has open belongs to Motion. */
async function defaultClearNotifications(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.notifications?.getAll || !chrome.notifications.clear) return;
  const open = await new Promise<object>((resolve) => chrome.notifications.getAll((notifications) => resolve(notifications)));
  await Promise.all(Object.keys(open).map((id) => new Promise<void>((resolve) => chrome.notifications.clear(id, () => resolve()))));
}

function defaultPermissions(): PermissionsCheck {
  return {
    async contains(details) {
      if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
      return chrome.permissions.contains(details);
    },
  };
}

function registryDeps(providerId: ProviderId, ctx: HandlerContext): RegistryDeps {
  return {
    secrets: ctx.secrets,
    chromeLocal: getInferencePort,
    fetchImpl: guardedProviderFetch(providerId, { preferencesStore: ctx.preferences,
      permissions: ctx.permissions, ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) }, false),
  };
}

function providerFor(providerId: ProviderId, ctx: HandlerContext) {
  return createProvider(providerId, registryDeps(providerId, ctx));
}

function isProviderStatus(value: string): value is ProviderStatus {
  return [
    'available',
    'downloadable',
    'downloading',
    'unavailable',
    'not-configured',
    'needs-document-context',
    'needs-permission',
    'invalid-key',
    'rate-limited',
    'insufficient-quota',
    'network-error',
    'model-unavailable',
  ].includes(value);
}

/**
 * Bounds a provider call. `onTimeout` aborts the underlying request so a
 * timed-out call does not keep running (and spending) in the background.
 */
async function bounded<T>(run: () => Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new ProviderError('timeout', 'The provider did not respond in time.'));
    }, PROVIDER_AVAILABILITY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function availabilityFromError(error: unknown, providerId: ProviderId): ProviderAvailability {
  const blocker = providerBlockerFromError(error, providerDisplayNames[providerId]);
  const status = error instanceof Error && 'kind' in error && typeof error.kind === 'string' && isProviderStatus(error.kind)
    ? error.kind
    : 'network-error';
  return {
    status,
    message: blocker.message,
    ...(blocker.retryAt !== undefined ? { retryAfterMs: Math.max(0, blocker.retryAt - Date.now()) } : {}),
  };
}

async function providerAvailability(providerId: ProviderId, ctx: HandlerContext): Promise<ProviderAvailability> {
  try {
    return await bounded(() => providerFor(providerId, ctx).availability());
  } catch (error) {
    return availabilityFromError(error, providerId);
  }
}

async function providerCapabilities(providerId: ProviderId, ctx: HandlerContext): Promise<ProviderCapabilities> {
  const fallback: ProviderCapabilities = {
    streaming: false,
    cancellation: false,
    backgroundExecution: false,
    cloud: providerId !== 'chrome-local',
    requiresKey: providerId !== 'chrome-local',
    structuredOutput: false,
  };
  try {
    return await bounded(() => providerFor(providerId, ctx).capabilities());
  } catch {
    return fallback;
  }
}

async function diagnosticFor(providerId: ProviderId, preferences: AIPreferences, ctx: HandlerContext) {
  const cloud = providerId !== 'chrome-local';
  const [availability, capabilities, configured, keyStorage] = await Promise.all([
    providerAvailability(providerId, ctx),
    providerCapabilities(providerId, ctx),
    cloud ? ctx.secrets.has(providerId) : Promise.resolve(true),
    cloud && ctx.secrets.storageFor ? ctx.secrets.storageFor(providerId) : Promise.resolve('session' as const),
  ]);
  return {
    providerId,
    displayName: providerDisplayNames[providerId],
    cloud,
    configured,
    status: availability.status,
    message: availability.message,
    ...(availability.retryAfterMs !== undefined ? { retryAfterMs: availability.retryAfterMs } : {}),
    backgroundExecution: capabilities.backgroundExecution,
    disclosureAccepted: !cloud || preferences.cloudDisclosureAccepted.includes(providerId),
    keyStorage,
  };
}

async function handleAiStatus(ctx: HandlerContext) {
  const preferences = await ctx.preferences.get();
  const providers = await Promise.all(PROVIDER_IDS.map((id) => diagnosticFor(id, preferences, ctx)));
  const lmsAccess = await Promise.all(
    LMS_PERMISSION_ORIGINS.map(async (origin) => ({
      origin,
      granted: await ctx.permissions.contains({ origins: [origin] }),
    })),
  );
  const result = {
    selected: preferences.providerId,
    model: preferences.model,
    models: curatedModelsFor(preferences.providerId).map((model) => ({
      ...model,
      recommended: model.id === curatedModelsFor(preferences.providerId)[0]?.id,
    })),
    providers,
    autoOpenRelatedTabs: preferences.autoOpenRelatedTabs,
    showOnPagePointer: preferences.showOnPagePointer,
    allowedConfigurableActions: preferences.allowedConfigurableActions,
    lmsAccess,
  };
  return aiStatusResultSchema.parse(result);
}

async function handleListProviderModels(
  message: Extract<AiMessage, { type: 'list-provider-models' }>,
  ctx: HandlerContext,
) {
  const preferences = await ctx.preferences.get();
  const providerId = message.providerId;
  const displayName = providerDisplayNames[providerId];
  if (!preferences.cloudDisclosureAccepted.includes(providerId)) {
    throw new Error(`Accept the ${displayName} cloud-processing disclosure before refreshing models.`);
  }
  const origin = providerOrigins[providerId];
  if (!origin || !await ctx.permissions.contains({ origins: [origin] })) {
    throw new Error(`Grant Motion permission to reach ${displayName} before refreshing models.`);
  }
  if (!await ctx.secrets.has(providerId)) {
    throw new Error(`Add a ${displayName} API key for this browser session before refreshing models.`);
  }

  const requestKey = `models:${crypto.randomUUID()}`;
  const controller = registerCloudRequest(requestKey, providerId);
  try {
    const provider = providerFor(providerId, ctx);
    const listed = provider.listModels
      ? await bounded(() => provider.listModels!({ signal: controller.signal }), () => controller.abort())
      : [];
    const models = [...new Set(listed.filter((id) => isSupportedTextModel(providerId, id)))];
    return providerModelListResultSchema.parse({ providerId, models, source: 'account' });
  } catch (error) {
    // A malformed or oversized listing leaves the provider itself fine, so the
    // named curated choices stay available (labelled `fallback`). Anything
    // else (rejected key, quota, timeout, outage) is surfaced with its own
    // plain-language message rather than hidden behind the curated list.
    if (!(error instanceof ProviderError) || error.kind === 'bad-response' || error.kind === 'cancelled') {
      return providerModelListResultSchema.parse({
        providerId,
        models: curatedModelsFor(providerId).map((model) => model.id),
        source: 'fallback',
      });
    }
    throw new Error(providerBlockerFromError(error, displayName).message);
  } finally {
    releaseCloudRequest(requestKey, controller);
  }
}

/** Makes a real, bounded request for the provider; the timeout aborts it. */
async function providerHealth(providerId: ProviderId, ctx: HandlerContext): Promise<ProviderAvailability> {
  const requestKey = `health:${crypto.randomUUID()}`;
  const controller = registerCloudRequest(requestKey, providerId);
  const provider = providerFor(providerId, ctx);
  try {
    return await bounded(
      () => provider.healthCheck ? provider.healthCheck({ signal: controller.signal }) : provider.availability(),
      () => controller.abort(),
    );
  } catch (error) {
    return availabilityFromError(error, providerId);
  } finally {
    releaseCloudRequest(requestKey, controller);
  }
}

async function handleSetProviderKey(message: Extract<AiMessage, { type: 'set-provider-key' }>, ctx: HandlerContext) {
  await ctx.secrets.set(message.providerId, message.key, message.storage);
  // The key stays saved either way. Verify it with a real request so a typo is
  // reported now, but only once the disclosure and host permission that allow
  // contacting the provider are in place; until then say it is saved, not verified.
  try {
    await assertCurrentProviderConsent(message.providerId, { preferencesStore: ctx.preferences, permissions: ctx.permissions }, false);
  } catch {
    const saved = await providerAvailability(message.providerId, ctx);
    return {
      configured: true,
      availability: saved.status === 'available'
        ? { status: 'available' as const, message: `${providerDisplayNames[message.providerId]} key saved. Motion checks it once you accept the disclosure and grant access.` }
        : saved,
    };
  }
  return { configured: true, availability: await providerHealth(message.providerId, ctx) };
}

async function handleForgetProviderKey(message: Extract<AiMessage, { type: 'forget-provider-key' }>, ctx: HandlerContext) {
  abortCloudRequests(message.providerId);
  await ctx.secrets.forget(message.providerId);
  return { configured: false };
}

async function handleKeychainStatus(message: Extract<AiMessage, { type: 'keychain-status' }>, ctx: HandlerContext) {
  return keychainStatusResultSchema.parse(await ctx.keychain.status(message.providerId));
}

async function handleTestProvider(message: Extract<AiMessage, { type: 'test-provider' }>, ctx: HandlerContext) {
  await assertCurrentProviderConsent(message.providerId, { preferencesStore: ctx.preferences, permissions: ctx.permissions }, false);
  return { availability: await providerHealth(message.providerId, ctx) };
}

async function handleSetAiPreferences(message: Extract<AiMessage, { type: 'set-ai-preferences' }>, ctx: HandlerContext) {
  const { type: _type, ...patch } = message;
  const previous = await ctx.preferences.get();
  const next = await ctx.preferences.update(patch);
  if (previous.providerId !== next.providerId) abortCloudRequests(previous.providerId);
  return { preferences: aiPreferencesSchema.parse(next) };
}

async function handleAcceptCloudDisclosure(message: Extract<AiMessage, { type: 'accept-cloud-disclosure' }>, ctx: HandlerContext) {
  const current = await ctx.preferences.get();
  const accepted = new Set(current.cloudDisclosureAccepted);
  if (message.accepted) accepted.add(message.providerId);
  else accepted.delete(message.providerId);
  const next = await ctx.preferences.update({ cloudDisclosureAccepted: [...accepted] });
  if (!message.accepted) abortCloudRequests(message.providerId);
  return { providerId: message.providerId, accepted: next.cloudDisclosureAccepted.includes(message.providerId) };
}

async function handleDeleteLocalData(ctx: HandlerContext) {
  return withLock(DOCUMENT_LIFECYCLE_LOCK, () => deleteLocalDataUnderLock(ctx));
}
async function deleteLocalDataUnderLock(ctx: HandlerContext) {
  abortCloudRequests();
  // Remove remembered OS-vault entries before clearing the metadata that says
  // which providers opted in. A failure leaves the local data intact so the
  // student can retry rather than receiving a false deletion confirmation.
  for (const providerId of ['openai', 'anthropic'] as const) await ctx.secrets.forget(providerId);
  // Preserve only a content-free revocation marker while clearing session
  // storage. Imports begun before deletion must not recreate the library.
  const lifecycle = { epoch: crypto.randomUUID(), deleting: true };
  await ctx.session.set({ [DOCUMENT_LIFECYCLE_KEY]: lifecycle });
  const localValues = await ctx.local.get(null);
  const motionKeys = Object.keys(localValues).filter((key) => key.startsWith('motion.'));
  // Alarms first: one firing mid-delete would otherwise post a reminder
  // notification for data that is already gone.
  const scheduled = await Promise.allSettled([ctx.clearAlarms(), ctx.clearNotifications()]);
  const results = await Promise.allSettled([
    ...scheduled.map((outcome) => (outcome.status === 'rejected' ? Promise.reject(outcome.reason) : Promise.resolve())),
    ctx.deleteDatabase(),
    motionKeys.length > 0 ? ctx.local.remove(motionKeys) : Promise.resolve(),
    (async () => {
      const sessionValues = await ctx.session.get(null);
      const sessionKeys = Object.keys(sessionValues).filter((key) => key !== DOCUMENT_LIFECYCLE_KEY);
      if (sessionKeys.length > 0) await ctx.session.remove(sessionKeys);
    })(),
  ]);
  if (results.some((result) => result.status === 'rejected')) {
    await ctx.session.set({ [DOCUMENT_LIFECYCLE_KEY]: { ...lifecycle, deleting: false } });
    throw new Error('Motion could not delete all local data. Close other Motion pages and try again.');
  }
  await ctx.session.set({ [DOCUMENT_LIFECYCLE_KEY]: { ...lifecycle, deleting: false } });
  return { deleted: true };
}

/** Handles AI/settings messages; callers still authorize the sender separately. */
export async function handleAiMessage(raw: unknown, deps: AiHandlerDeps = {}): Promise<unknown> {
  const parsed = aiMessageSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Malformed AI/settings message.');
  const ctx = contextFor(deps);
  switch (parsed.data.type) {
    case 'ai-status': return handleAiStatus(ctx);
    case 'keychain-status': return handleKeychainStatus(parsed.data, ctx);
    case 'list-provider-models': return handleListProviderModels(parsed.data, ctx);
    case 'set-provider-key': return handleSetProviderKey(parsed.data, ctx);
    case 'forget-provider-key': return handleForgetProviderKey(parsed.data, ctx);
    case 'test-provider': return handleTestProvider(parsed.data, ctx);
    case 'set-ai-preferences': return handleSetAiPreferences(parsed.data, ctx);
    case 'accept-cloud-disclosure': return handleAcceptCloudDisclosure(parsed.data, ctx);
    case 'delete-local-data': return handleDeleteLocalData(ctx);
  }
}
