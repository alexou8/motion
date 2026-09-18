import { z } from 'zod';
import { PROVIDER_IDS, CONFIGURABLE_ACTION_IDS } from '../ai/preferences';

/**
 * Messages between the extension UI (side panel, settings) and the service
 * worker for AgentSessions, AI providers, and credentials.
 *
 * Every one of these is `extension-ui` only: a content script reports what it
 * saw and nothing more, so it can never start a session, steer the agent, or
 * touch a credential.
 *
 * Credential rule: a raw API key crosses exactly one boundary — settings page
 * to worker, inside `set-provider-key` — and no response, state snapshot, or
 * log ever carries it or any fragment of it back.
 */

const CLOUD_PROVIDER_IDS = ['openai', 'anthropic'] as const;

export const sessionCreateSchema = z.object({
  type: z.literal('session-create'),
  /** What the student asked for in their own words, e.g. "Work on Assignment 2". */
  goal: z.string().trim().min(1).max(500),
  /** The tab the student was looking at, for course/task resolution. */
  tabId: z.number().int().nonnegative().nullable().default(null),
});

/** A conversational turn inside a session: commands and questions alike. */
export const sessionMessageSchema = z.object({
  type: z.literal('session-message'),
  sessionId: z.string().min(1),
  text: z.string().trim().min(1).max(4_000),
  tabId: z.number().int().nonnegative().nullable().default(null),
});

export const sessionCommandSchema = z.object({
  type: z.literal('session-command'),
  sessionId: z.string().min(1),
  command: z.enum(['pause', 'resume', 'cancel', 'archive', 'retry-model', 'stop-generation']),
});

/** Which session the panel shows. Null returns to the session list. */
export const sessionSelectSchema = z.object({
  type: z.literal('session-select'),
  sessionId: z.string().min(1).nullable(),
});

/** "Don't use that source" / undo. */
export const sessionSourceSchema = z.object({
  type: z.literal('session-source'),
  sessionId: z.string().min(1),
  url: z.string().url(),
  excluded: z.boolean(),
});

/** Adopt a student tab into the workspace, or release a tab from it. */
export const sessionTabSchema = z.object({
  type: z.literal('session-tab'),
  sessionId: z.string().min(1),
  tabId: z.number().int().nonnegative(),
  op: z.enum(['adopt', 'release', 'focus']),
});

/** Provider diagnostics for settings and the session header. */
export const aiStatusSchema = z.object({ type: z.literal('ai-status') });

export const setProviderKeySchema = z.object({
  type: z.literal('set-provider-key'),
  providerId: z.enum(CLOUD_PROVIDER_IDS),
  /** Bounded and whitespace-free; the worker never echoes it. */
  key: z.string().trim().min(8).max(400).regex(/^\S+$/),
});

export const forgetProviderKeySchema = z.object({
  type: z.literal('forget-provider-key'),
  providerId: z.enum(CLOUD_PROVIDER_IDS),
});

export const testProviderSchema = z.object({
  type: z.literal('test-provider'),
  providerId: z.enum(PROVIDER_IDS),
});

export const setAiPreferencesSchema = z.object({
  type: z.literal('set-ai-preferences'),
  providerId: z.enum(PROVIDER_IDS).optional(),
  model: z.string().min(1).max(100).optional(),
  autoOpenRelatedTabs: z.boolean().optional(),
  showOnPagePointer: z.boolean().optional(),
  allowedConfigurableActions: z.array(z.enum(CONFIGURABLE_ACTION_IDS)).optional(),
});

/** The student read and accepted "This provider processes the content you send using its cloud service." */
export const acceptCloudDisclosureSchema = z.object({
  type: z.literal('accept-cloud-disclosure'),
  providerId: z.enum(CLOUD_PROVIDER_IDS),
  accepted: z.boolean(),
});

/** Deletes all local Motion data (IndexedDB stores, preferences, session secrets). */
export const deleteLocalDataSchema = z.object({
  type: z.literal('delete-local-data'),
  confirm: z.literal('DELETE'),
});

export const SESSION_MESSAGE_SCHEMAS = [
  sessionCreateSchema,
  sessionMessageSchema,
  sessionCommandSchema,
  sessionSelectSchema,
  sessionSourceSchema,
  sessionTabSchema,
  aiStatusSchema,
  setProviderKeySchema,
  forgetProviderKeySchema,
  testProviderSchema,
  setAiPreferencesSchema,
  acceptCloudDisclosureSchema,
  deleteLocalDataSchema,
] as const;

export const SESSION_MESSAGE_TYPES = [
  'session-create',
  'session-message',
  'session-command',
  'session-select',
  'session-source',
  'session-tab',
  'ai-status',
  'set-provider-key',
  'forget-provider-key',
  'test-provider',
  'set-ai-preferences',
  'accept-cloud-disclosure',
  'delete-local-data',
] as const;

/* ---------------- worker -> UI response shapes ---------------- */

export const providerDiagnosticSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  displayName: z.string(),
  cloud: z.boolean(),
  /** Session-only credential present. Never the key or any part of it. */
  configured: z.boolean(),
  status: z.string(),
  message: z.string(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  backgroundExecution: z.boolean(),
  disclosureAccepted: z.boolean(),
});
export type ProviderDiagnostic = z.infer<typeof providerDiagnosticSchema>;

export const aiStatusResultSchema = z.object({
  selected: z.enum(PROVIDER_IDS),
  model: z.string(),
  /** Student-readable model choices for the selected provider. */
  models: z.array(z.object({ id: z.string(), label: z.string(), recommended: z.boolean() })),
  providers: z.array(providerDiagnosticSchema),
  autoOpenRelatedTabs: z.boolean(),
  showOnPagePointer: z.boolean(),
  allowedConfigurableActions: z.array(z.enum(CONFIGURABLE_ACTION_IDS)),
  lmsAccess: z.array(z.object({ origin: z.string(), granted: z.boolean() })),
});
export type AiStatusResult = z.infer<typeof aiStatusResultSchema>;
