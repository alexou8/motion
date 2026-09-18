import { z } from 'zod';
import { curatedModelsFor } from '@/core/ai/models';
import { PROVIDER_IDS, aiPreferencesSchema, type AIPreferences } from '@/core/ai/preferences';
import type { ProviderAvailability, ProviderCapabilities, ProviderId, ProviderStatus } from '@/core/ai/types';
import {
  acceptCloudDisclosureSchema,
  aiStatusResultSchema,
  deleteLocalDataSchema,
  forgetProviderKeySchema,
  setAiPreferencesSchema,
  setProviderKeySchema,
  testProviderSchema,
} from '@/core/messaging/sessionContracts';
import { deleteDatabase as deleteMotionDatabase } from '@/core/storage/db';
import { supportedHosts } from '@/core/adapters';
import { createProvider, type RegistryDeps } from '@/platform/ai/registry';
import type { FetchLike } from '@/platform/ai/http';
import { ChromePreferencesStore, type PreferencesStore } from '@/platform/ai/preferencesStore';
import { SessionSecretStore, type SecretStore, type StorageArea } from '@/platform/ai/secrets';
import { getInferencePort } from './inferencePort';
import {
  providerBlockerFromError,
  providerDisplayNames,
  type PermissionsCheck,
} from './providers';

const aiMessageSchema = z.discriminatedUnion('type', [
  aiStatusResultInputSchema(),
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
  permissions?: PermissionsCheck;
  fetchImpl?: FetchLike;
  deleteDatabase?: () => Promise<void>;
}

interface HandlerContext {
  preferences: PreferencesStore;
  secrets: SecretStore;
  local: StorageArea;
  session: ClearableStorageArea;
  permissions: PermissionsCheck;
  fetchImpl?: FetchLike;
  deleteDatabase: () => Promise<void>;
}

function contextFor(deps: AiHandlerDeps): HandlerContext {
  const session = deps.sessionStorage ?? (chrome.storage.session as unknown as ClearableStorageArea);
  return {
    preferences: deps.preferencesStore ?? new ChromePreferencesStore(deps.localStorage ?? (chrome.storage.local as unknown as StorageArea)),
    secrets: deps.secrets ?? new SessionSecretStore(session),
    local: deps.localStorage ?? (chrome.storage.local as unknown as StorageArea),
    session,
    permissions: deps.permissions ?? defaultPermissions(),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    deleteDatabase: deps.deleteDatabase ?? (() => deleteMotionDatabase()),
  };
}

function defaultPermissions(): PermissionsCheck {
  return {
    async contains(details) {
      if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
      return chrome.permissions.contains(details);
    },
  };
}

function registryDeps(ctx: HandlerContext): RegistryDeps {
  return {
    secrets: ctx.secrets,
    chromeLocal: getInferencePort,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  };
}

function providerFor(providerId: ProviderId, ctx: HandlerContext) {
  return createProvider(providerId, registryDeps(ctx));
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

async function bounded<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Provider availability timed out.')), PROVIDER_AVAILABILITY_TIMEOUT_MS);
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
  const [availability, capabilities, configured] = await Promise.all([
    providerAvailability(providerId, ctx),
    providerCapabilities(providerId, ctx),
    cloud ? ctx.secrets.has(providerId) : Promise.resolve(true),
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

async function handleSetProviderKey(message: Extract<AiMessage, { type: 'set-provider-key' }>, ctx: HandlerContext) {
  await ctx.secrets.set(message.providerId, message.key);
  const availability = await providerAvailability(message.providerId, ctx);
  return { configured: true, availability };
}

async function handleForgetProviderKey(message: Extract<AiMessage, { type: 'forget-provider-key' }>, ctx: HandlerContext) {
  await ctx.secrets.forget(message.providerId);
  return { configured: false };
}

async function handleTestProvider(message: Extract<AiMessage, { type: 'test-provider' }>, ctx: HandlerContext) {
  const provider = providerFor(message.providerId, ctx);
  try {
    const availability = await bounded(() => provider.healthCheck ? provider.healthCheck() : provider.availability());
    return { availability };
  } catch (error) {
    return { availability: availabilityFromError(error, message.providerId) };
  }
}

async function handleSetAiPreferences(message: Extract<AiMessage, { type: 'set-ai-preferences' }>, ctx: HandlerContext) {
  const { type: _type, ...patch } = message;
  const next = await ctx.preferences.update(patch);
  return { preferences: aiPreferencesSchema.parse(next) };
}

async function handleAcceptCloudDisclosure(message: Extract<AiMessage, { type: 'accept-cloud-disclosure' }>, ctx: HandlerContext) {
  const current = await ctx.preferences.get();
  const accepted = new Set(current.cloudDisclosureAccepted);
  if (message.accepted) accepted.add(message.providerId);
  else accepted.delete(message.providerId);
  const next = await ctx.preferences.update({ cloudDisclosureAccepted: [...accepted] });
  return { providerId: message.providerId, accepted: next.cloudDisclosureAccepted.includes(message.providerId) };
}

async function clearStorageArea(area: ClearableStorageArea): Promise<void> {
  if (area.clear) {
    await area.clear();
    return;
  }
  const values = await area.get(null);
  const keys = Object.keys(values);
  if (keys.length > 0) await area.remove(keys);
}

async function handleDeleteLocalData(ctx: HandlerContext) {
  const localValues = await ctx.local.get(null);
  const motionKeys = Object.keys(localValues).filter((key) => key.startsWith('motion.'));
  const results = await Promise.allSettled([
    ctx.deleteDatabase(),
    motionKeys.length > 0 ? ctx.local.remove(motionKeys) : Promise.resolve(),
    clearStorageArea(ctx.session),
  ]);
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Motion could not delete all local data. Close other Motion pages and try again.');
  }
  return { deleted: true };
}

/** Handles the seven AI/settings messages; callers still authorize the sender separately. */
export async function handleAiMessage(raw: unknown, deps: AiHandlerDeps = {}): Promise<unknown> {
  const parsed = aiMessageSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Malformed AI/settings message.');
  const ctx = contextFor(deps);
  switch (parsed.data.type) {
    case 'ai-status': return handleAiStatus(ctx);
    case 'set-provider-key': return handleSetProviderKey(parsed.data, ctx);
    case 'forget-provider-key': return handleForgetProviderKey(parsed.data, ctx);
    case 'test-provider': return handleTestProvider(parsed.data, ctx);
    case 'set-ai-preferences': return handleSetAiPreferences(parsed.data, ctx);
    case 'accept-cloud-disclosure': return handleAcceptCloudDisclosure(parsed.data, ctx);
    case 'delete-local-data': return handleDeleteLocalData(ctx);
  }
}
