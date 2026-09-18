import { useCallback, useEffect, useState } from 'react';
import { supportedHosts } from '@/core/adapters';
import { aiStatusResultSchema, type AiStatusResult, type ProviderDiagnostic } from '@/core/messaging/sessionContracts';
import { CONFIGURABLE_ACTION_IDS, type ConfigurableActionId } from '@/core/ai/preferences';
import { curatedModelsFor } from '@/core/ai/models';
import type { ProviderId } from '@/core/ai/types';
import {
  DEFAULT_REMINDER_PREFERENCES,
  loadReminderPreferences,
  REMINDER_KINDS,
  REMINDER_OFFSETS,
  updateReminderPreferences,
  type ReminderOffset,
  type ReminderPreferences,
  type ReminderStorageArea,
} from '@/core/reminders';

/**
 * Settings: AI, browser access, agent behaviour, privacy, and about.
 *
 * A raw API key crosses exactly one boundary — this page's key input to the
 * worker, inside `set-provider-key` — and is never held in React state
 * longer than the submit, never logged, and never echoed back by any
 * worker response (ARCH D3).
 */

interface Grant {
  origin: string;
  builtIn: boolean;
}

type Section = 'ai' | 'browser' | 'behaviour' | 'reminders' | 'privacy' | 'about';
const sections: Array<{ id: Section; label: string }> = [
  { id: 'ai', label: 'AI' },
  { id: 'browser', label: 'Browser access' },
  { id: 'behaviour', label: 'Agent behaviour' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'privacy', label: 'Privacy & data' },
  { id: 'about', label: 'About' },
];
const card = 'rounded border border-rule bg-surface p-5';
const focus =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
function sectionFromHash(): Section {
  const id = window.location.hash.slice(1) as Section;
  return sections.some((s) => s.id === id) ? id : 'ai';
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  'chrome-local': "Chrome's built-in model",
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};
const PROVIDER_ORIGINS: Partial<Record<ProviderId, string>> = {
  openai: 'https://api.openai.com/*',
  anthropic: 'https://api.anthropic.com/*',
};

const ACTION_LABELS: Record<ConfigurableActionId, string> = {
  'edit-draft': 'Edit a draft in place',
  'fill-form-field': 'Fill in a form field',
  'select-option': 'Choose an option in a form',
  'toggle-control': 'Toggle a control on a page',
  'save-remote-draft': 'Save a draft in your LMS',
  'prepare-upload': 'Prepare a file for you to upload',
  'prepare-discussion-response': 'Prepare a discussion reply for you to review',
  'add-calendar-event': 'Add an event to your calendar',
  'prepare-message': 'Prepare a message for you to review',
  'click-element': 'Click a non-consequential control',
};

async function ask(message: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response ?? { ok: false, error: 'The background worker did not respond.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Message failed' };
  }
}

export function App(): JSX.Element {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [section, setSection] = useState<Section>(sectionFromHash);
  const [ai, setAi] = useState<AiStatusResult | null>(null);

  const loadGrants = useCallback(async () => {
    const all = await chrome.permissions.getAll();
    setGrants(
      (all.origins ?? []).map((origin) => ({
        origin,
        builtIn: supportedHosts.some((host) => origin.includes(host.replace('*.', ''))),
      })),
    );
  }, []);

  const loadAiStatus = useCallback(async () => {
    const response = await ask({ type: 'ai-status' });
    if (!response.ok) return;
    const parsed = aiStatusResultSchema.safeParse(response.result);
    setAi(parsed.success ? parsed.data : null);
  }, []);

  useEffect(() => {
    void loadGrants();
    void loadAiStatus();
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [loadGrants, loadAiStatus]);

  const select = (id: Section) => {
    window.location.hash = id;
    setSection(id);
  };
  const revoke = useCallback(
    async (origin: string) => {
      const removed = await chrome.permissions.remove({ origins: [origin] });
      setStatus(
        removed
          ? `Motion can no longer read ${origin}.`
          : `${origin} is built in and cannot be removed here. Remove Motion to revoke it.`,
      );
      await loadGrants();
    },
    [loadGrants],
  );
  const grant = useCallback(
    async (origin: string) => {
      const granted = await chrome.permissions.request({ origins: [origin] });
      setStatus(granted ? `Motion can now read ${origin}.` : `Access to ${origin} was not granted.`);
      await loadGrants();
    },
    [loadGrants],
  );
  const deleteEverything = useCallback(async () => {
    let outcome: 'success' | 'error' | 'blocked' = 'success';
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('motion');
      request.onsuccess = () => resolve();
      request.onerror = () => {
        outcome = 'error';
        resolve();
      };
      request.onblocked = () => {
        outcome = 'blocked';
        resolve();
      };
    });
    await chrome.storage.session.clear();
    await chrome.storage.local.clear();
    setConfirmingDelete(false);
    await ask({ type: 'delete-local-data', confirm: 'DELETE' });
    setStatus(
      outcome === 'success'
        ? 'Deleted every course, task, note and workflow Motion had stored.'
        : outcome === 'blocked'
          ? 'Motion could not delete its database because another Motion page is open. Close the side panel and try again. Session and local storage were deleted.'
          : 'Motion could not delete its database. Session and local storage were deleted, but stored database data may remain.',
    );
  }, []);
  const version = chrome.runtime.getManifest().version;
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-ink">
      <header className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-medium">Settings</h1>
        <span className="text-sm text-ink-muted">Motion {version}</span>
      </header>
      <div className="mt-8 grid gap-8 md:grid-cols-[12rem_1fr]">
        <nav aria-label="Settings sections" className="flex flex-wrap gap-1 md:block md:space-y-1">
          {sections.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? 'page' : undefined}
              onClick={() => select(id)}
              className={`min-h-[24px] rounded px-3 py-2 text-left text-sm ${focus} ${section === id ? 'bg-sunken text-ink font-medium' : 'text-ink-muted hover:bg-sunken'}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {section === 'ai' && <AISection ai={ai} refresh={loadAiStatus} setStatus={setStatus} />}
          {section === 'browser' && <BrowserAccess grants={grants} revoke={revoke} grant={grant} />}
          {section === 'behaviour' && <AgentBehaviour ai={ai} setStatus={setStatus} refresh={loadAiStatus} />}
          {section === 'reminders' && <ReminderSection setStatus={setStatus} />}
          {section === 'privacy' && (
            <Privacy
              confirming={confirmingDelete}
              setConfirming={setConfirmingDelete}
              deleteEverything={deleteEverything}
            />
          )}
          {section === 'about' && <About version={version} ai={ai} />}
          <p role="status" aria-live="polite" className="mt-8 text-sm text-ink-muted">
            {status}
          </p>
        </div>
      </div>
    </main>
  );
}

const REMINDER_LABELS: Record<ReminderOffset, string> = {
  '2d': '2 days before',
  morning: 'Morning of',
  '2h': '2 hours before',
};

const REMINDER_KIND_LABELS: Record<string, string> = {
  assignment: 'Assignments',
  quiz: 'Quizzes',
  discussion: 'Discussions',
  other: 'Other',
};

function ReminderSection({ setStatus }: { setStatus: (s: string) => void }) {
  const [preferences, setPreferences] = useState<ReminderPreferences | null>(null);
  const storage = chrome.storage.local as unknown as ReminderStorageArea;

  useEffect(() => {
    let mounted = true;
    void loadReminderPreferences(storage).then((loaded) => {
      if (mounted) setPreferences(loaded);
    }).catch(() => {
      if (mounted) setPreferences(DEFAULT_REMINDER_PREFERENCES);
    });
    return () => { mounted = false; };
  }, [storage]);

  const save = async (patch: Partial<ReminderPreferences>, message: string) => {
    try {
      const next = await updateReminderPreferences(patch, storage);
      setPreferences(next);
      setStatus(message);
    } catch {
      setStatus('Could not save reminder settings. Please try again.');
    }
  };

  if (!preferences) {
    return <p className="text-sm text-ink-muted">Loading reminder settings…</p>;
  }

  const toggleOffset = (kind: string, offset: ReminderOffset, enabled: boolean) => {
    const fallback = preferences.offsets.other ?? DEFAULT_REMINDER_PREFERENCES.offsets.other;
    if (!fallback) return;
    const current = preferences.offsets[kind] ?? fallback;
    void save({
      offsets: {
        ...preferences.offsets,
        [kind]: {
          '2d': current['2d'] ?? false,
          morning: current.morning ?? false,
          '2h': current['2h'] ?? false,
          [offset]: enabled,
        },
      },
    }, 'Reminder settings saved.');
  };

  const updateQuietHour = (field: 'start' | 'end', value: string) => {
    void save({ quietHours: { ...preferences.quietHours, [field]: value } }, 'Quiet hours saved.');
  };

  const sendTestReminder = async () => {
    if (!chrome.notifications?.create) {
      setStatus('Notifications are not available in this browser.');
      return;
    }
    try {
      await chrome.notifications.create(`motion-test-reminder-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'src/assets/icons/icon-128.png',
        title: 'Motion test reminder',
        message: 'Reminders are enabled and ready to notify you.',
      });
      setStatus('Test reminder sent.');
    } catch {
      setStatus('Could not send a test reminder. Please try again.');
    }
  };

  return (
    <section aria-labelledby="reminders-heading">
      <h2 id="reminders-heading" className="font-serif text-lg">Reminders</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Reminders are off until you opt in. Motion reads only the deadlines already found in this
        browser and never scans or reminds inside a graded, timed or proctored attempt.
      </p>
      <div className={`${card} mt-4 grid gap-5`}>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            aria-label="Send deadline reminders"
            checked={preferences.enabled}
            onChange={(event) => void save({ enabled: event.target.checked }, event.target.checked ? 'Reminders enabled.' : 'Reminders disabled.')}
          />
          <span className="text-sm">
            <span className="font-medium">Send deadline reminders</span>
            <span className="block text-ink-muted">You can change these settings at any time.</span>
          </span>
        </label>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-sm">
            <caption className="mb-2 text-left font-medium">Reminder timing by item type</caption>
            <thead>
              <tr className="border-b border-rule text-ink-muted">
                <th scope="col" className="py-2 pr-4 font-medium">Item type</th>
                {REMINDER_OFFSETS.map((offset) => (
                  <th key={offset} scope="col" className="px-2 py-2 text-center font-medium">{REMINDER_LABELS[offset]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {REMINDER_KINDS.map((kind) => {
                const fallback = preferences.offsets.other ?? DEFAULT_REMINDER_PREFERENCES.offsets.other;
                if (!fallback) return null;
                const settings = preferences.offsets[kind] ?? fallback;
                return (
                  <tr key={kind} className="border-b border-rule last:border-0">
                    <th scope="row" className="py-2 pr-4 font-medium">{REMINDER_KIND_LABELS[kind]}</th>
                    {REMINDER_OFFSETS.map((offset) => {
                      const id = `reminder-${kind}-${offset}`;
                      return (
                        <td key={offset} className="px-2 py-2 text-center">
                          <input
                            id={id}
                            type="checkbox"
                            checked={settings[offset]}
                            aria-label={`${REMINDER_KIND_LABELS[kind]}: ${REMINDER_LABELS[offset]}`}
                            onChange={(event) => toggleOffset(kind, offset, event.target.checked)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <fieldset className="grid gap-3">
          <legend className="text-sm font-medium">Quiet hours</legend>
          <p className="text-sm text-ink-muted">A reminder that lands during quiet hours moves to the end of quiet hours. If that is after the due time, it is skipped.</p>
          <div className="flex flex-wrap gap-4">
            <label className="grid gap-1 text-sm" htmlFor="quiet-hours-start">
              <span>Start</span>
              <input id="quiet-hours-start" type="time" value={preferences.quietHours.start} onChange={(event) => updateQuietHour('start', event.target.value)} className={`min-h-6 rounded-sm border border-edge bg-surface px-2 py-1 ${focus}`} />
            </label>
            <label className="grid gap-1 text-sm" htmlFor="quiet-hours-end">
              <span>End</span>
              <input id="quiet-hours-end" type="time" value={preferences.quietHours.end} onChange={(event) => updateQuietHour('end', event.target.value)} className={`min-h-6 rounded-sm border border-edge bg-surface px-2 py-1 ${focus}`} />
            </label>
          </div>
        </fieldset>

        <button type="button" onClick={() => void sendTestReminder()} className={`w-fit min-h-[24px] rounded border border-edge px-3 py-1 text-sm hover:bg-sunken ${focus}`}>
          Send a test reminder
        </button>
      </div>
    </section>
  );
}

function statusCopy(diagnostic: ProviderDiagnostic | undefined): string {
  if (!diagnostic) return 'Unknown';
  return diagnostic.message || diagnostic.status;
}

function ProviderCard({
  diagnostic,
  ai,
  setStatus,
  refresh,
}: {
  diagnostic: ProviderDiagnostic;
  ai: AiStatusResult;
  setStatus: (s: string) => void;
  refresh: () => Promise<void>;
}) {
  const providerId = diagnostic.providerId;
  const isCloud = diagnostic.cloud;
  const isSelected = ai.selected === providerId;
  const [key, setKey] = useState('');
  const [disclosure, setDisclosure] = useState(diagnostic.disclosureAccepted);
  const [testing, setTesting] = useState(false);
  const models = curatedModelsFor(providerId);

  const selectProvider = async () => {
    if (isCloud) {
      if (!disclosure) {
        setStatus('Accept the cloud-processing disclosure before selecting this provider.');
        return;
      }
      // Must run inside the click gesture: `chrome.permissions.request`
      // loses the user-activation state at the first `await` otherwise
      // (docs/THREAT_MODEL.md T10).
      const origin = PROVIDER_ORIGINS[providerId];
      if (origin) await chrome.permissions.request({ origins: [origin] });
    }
    await ask({ type: 'set-ai-preferences', providerId });
    await refresh();
  };

  const acceptDisclosure = async (accepted: boolean) => {
    setDisclosure(accepted);
    await ask({ type: 'accept-cloud-disclosure', providerId, accepted });
    await refresh();
  };

  const saveKey = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = key;
    // Cleared before the async call resolves and regardless of outcome — a
    // key never lingers in this component's state past the submit.
    setKey('');
    if (value.trim().length < 8) {
      setStatus('That key looks too short to be valid.');
      return;
    }
    await ask({ type: 'set-provider-key', providerId, key: value });
    await refresh();
    setStatus(`${PROVIDER_LABELS[providerId]} key saved for this browser session.`);
  };

  const forgetKey = async () => {
    await ask({ type: 'forget-provider-key', providerId });
    await refresh();
    setStatus(`${PROVIDER_LABELS[providerId]} key forgotten.`);
  };

  const testConnection = async () => {
    setTesting(true);
    const response = await ask({ type: 'test-provider', providerId });
    setTesting(false);
    setStatus(
      response.ok ? `${PROVIDER_LABELS[providerId]} connection test succeeded.` : `${PROVIDER_LABELS[providerId]} connection test failed.`,
    );
  };

  const selectModel = async (model: string) => {
    await ask({ type: 'set-ai-preferences', providerId, model });
    await refresh();
  };

  return (
    <div className={`${card} grid gap-3`}>
      <label className="flex items-start gap-2">
        <input
          type="radio"
          name="provider"
          checked={isSelected}
          onChange={() => void selectProvider()}
          className="mt-1"
        />
        <span>
          <span className="text-md font-medium">{PROVIDER_LABELS[providerId]}</span>
          <span className="block text-sm text-ink-muted">{statusCopy(diagnostic)}</span>
        </span>
      </label>

      {isCloud ? (
        <>
          <label className="flex items-start gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={disclosure}
              onChange={(event) => void acceptDisclosure(event.target.checked)}
            />
            <span>This provider processes the content you send using its cloud service.</span>
          </label>
          <form onSubmit={(event) => void saveKey(event)} className="grid gap-2">
            <label className="text-sm font-medium" htmlFor={`${providerId}-key`}>
              API key
            </label>
            <input
              id={`${providerId}-key`}
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              className={`min-h-6 rounded-sm border border-edge bg-surface px-2 py-2 text-sm ${focus}`}
            />
            <p className="text-xs text-ink-muted">Key storage: Session only — you&apos;ll re-enter it after restarting the browser.</p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={`min-h-[24px] rounded border border-edge px-3 py-1 text-sm hover:bg-sunken ${focus}`}>
                Save for this browser session
              </button>
              <button
                type="button"
                onClick={() => void testConnection()}
                disabled={testing}
                className={`min-h-[24px] rounded border border-edge px-3 py-1 text-sm hover:bg-sunken ${focus}`}
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button
                type="button"
                onClick={() => void forgetKey()}
                className={`min-h-[24px] rounded border border-edge px-3 py-1 text-sm hover:bg-sunken ${focus}`}
              >
                Forget key
              </button>
            </div>
          </form>
        </>
      ) : null}

      {isSelected ? (
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Model</span>
          <select
            defaultValue={ai.model}
            onChange={(event) => void selectModel(event.target.value)}
            className={`min-h-6 rounded-sm border border-edge bg-surface px-2 py-1 ${focus}`}
          >
            <option value="recommended">Recommended</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function AISection({ ai, refresh, setStatus }: { ai: AiStatusResult | null; refresh: () => Promise<void>; setStatus: (s: string) => void }) {
  return (
    <section aria-labelledby="ai-heading">
      <h2 id="ai-heading" className="font-serif text-lg">
        AI
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Choose which model Motion uses. Chrome&apos;s built-in model runs on this device; OpenAI and
        Anthropic send what you ask about to their cloud service.
      </p>
      <div className="mt-4 grid gap-4">
        {ai ? (
          ai.providers.map((diagnostic) => (
            <ProviderCard key={diagnostic.providerId} diagnostic={diagnostic} ai={ai} setStatus={setStatus} refresh={refresh} />
          ))
        ) : (
          <p className="text-sm text-ink-muted">Loading provider status…</p>
        )}
      </div>
    </section>
  );
}

function BrowserAccess({ grants, revoke, grant }: { grants: Grant[]; revoke: (origin: string) => void; grant: (origin: string) => void }) {
  return (
    <section aria-labelledby="browser-heading">
      <h2 id="browser-heading" className="font-serif text-lg">
        Browser access
      </h2>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Authorized LMS hosts</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Motion only reads pages on these sites, and only while you have them open. It never
          collects browsing outside them.
        </p>
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {grants.length === 0 && (
            <li className="py-3 text-sm text-ink-muted">
              No site access granted yet. Motion asks when you first open a course page.
            </li>
          )}
          {grants.map((entry) => (
            <li key={entry.origin} className="flex items-center justify-between gap-4 py-3">
              <span className="font-mono text-sm">{entry.origin}</span>
              <button
                type="button"
                onClick={() => revoke(entry.origin)}
                className={`min-h-[24px] rounded border border-edge px-3 py-1 text-sm hover:bg-sunken ${focus}`}
              >
                Remove access
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => grant('https://mylearningspace.wlu.ca/*')}
            className={`min-h-[24px] rounded border border-edge px-3 py-1 text-sm hover:bg-sunken ${focus}`}
          >
            Grant access
          </button>
        </div>
      </div>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Safety boundaries</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
          <li>Never answer or act inside a graded, timed or proctored attempt.</li>
          <li>Supported submission, posting, uploading and sending actions require a fresh confirmation for the exact target and effect every time.</li>
          <li>Motion never uses a saved setting as approval for a consequential action.</li>
        </ul>
      </div>
    </section>
  );
}

function AgentBehaviour({ ai, setStatus, refresh }: { ai: AiStatusResult | null; setStatus: (s: string) => void; refresh: () => Promise<void> }) {
  const toggleAction = async (id: ConfigurableActionId, allowed: boolean) => {
    if (!ai) return;
    const next = allowed
      ? [...ai.allowedConfigurableActions, id]
      : ai.allowedConfigurableActions.filter((a) => a !== id);
    await ask({ type: 'set-ai-preferences', allowedConfigurableActions: next });
    await refresh();
    setStatus(`${ACTION_LABELS[id]} is now ${allowed ? 'automatic' : 'asked every time'}.`);
  };

  const toggleAutoOpen = async (value: boolean) => {
    await ask({ type: 'set-ai-preferences', autoOpenRelatedTabs: value });
    await refresh();
  };

  const toggleOnPagePointer = async (value: boolean) => {
    const response = await ask({ type: 'set-ai-preferences', showOnPagePointer: value });
    if (!response.ok) {
      setStatus(`Motion could not save the on-page pointer setting. ${response.error ?? 'Try again.'}`);
      return;
    }
    await refresh();
    setStatus(`Motion’s on-page pointer is ${value ? 'on' : 'off'}.`);
  };

  return (
    <section aria-labelledby="behaviour-heading">
      <h2 id="behaviour-heading" className="font-serif text-lg">
        Agent behaviour
      </h2>
      <div className={`${card} mt-4`}>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={ai?.autoOpenRelatedTabs ?? false}
            onChange={(event) => void toggleAutoOpen(event.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium">Automatically open related tabs</span>
            <span className="block text-ink-muted">Opens linked readings and rubrics in a Motion-owned tab group when a session starts.</span>
          </span>
        </label>
      </div>
      <div className={`${card} mt-4`}>
        <div className="flex items-start gap-2">
          <input
            id="show-on-page-pointer"
            type="checkbox"
            checked={ai?.showOnPagePointer ?? true}
            onChange={(event) => void toggleOnPagePointer(event.target.checked)}
            aria-describedby="show-on-page-pointer-description"
          />
          <span className="text-sm">
            <label className="font-medium" htmlFor="show-on-page-pointer">Show Motion on-page pointer</label>
            <span id="show-on-page-pointer-description" className="block text-ink-muted">Shows where Motion is about to act. It does not change what Motion is allowed to do.</span>
          </span>
        </div>
      </div>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Actions Motion can take automatically</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Each is off until you turn it on, and asks for your approval every time until then.
        </p>
        <ul className="mt-3 grid gap-2">
          {CONFIGURABLE_ACTION_IDS.map((id) => (
            <li key={id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                id={`action-${id}`}
                checked={ai?.allowedConfigurableActions.includes(id) ?? false}
                onChange={(event) => void toggleAction(id, event.target.checked)}
              />
              <label htmlFor={`action-${id}`}>{ACTION_LABELS[id]}</label>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-ink-muted">
          Submitting, posting, uploading and sending always require a fresh confirmation for the
          exact target and effect, no matter what is turned on here.
        </p>
      </div>
    </section>
  );
}

function Privacy({
  confirming,
  setConfirming,
  deleteEverything,
}: {
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  deleteEverything: () => void;
}) {
  return (
    <section aria-labelledby="data-heading">
      <h2 id="data-heading" className="font-serif text-lg">
        Privacy &amp; data
      </h2>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">What is stored locally</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Everything Motion stores stays in this browser: courses, deadlines, notes, checklists,
          sessions, and workflows. There is no account and no server, so this stored database is
          not uploaded and nothing syncs between devices. A selected cloud provider receives only
          the bounded request described below.
        </p>
        <p className="mt-2 text-sm text-ink-muted">
          Stored data is protected by your browser profile. It is not separately encrypted, so
          anyone who can use this signed-in profile can read it.
        </p>
      </div>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">What is sent to a cloud provider</h3>
        <p className="mt-1 text-sm text-ink-muted">
          If you choose OpenAI or Anthropic, Motion sends your message, session plan/state labels,
          relevant notes, and bounded excerpts from pages read for this session to that provider
          to generate a response. Each source excerpt is at most 8,000 characters and each request
          is at most 24,000 characters; sources you excluded are omitted. Nothing is sent unless
          you have accepted that provider&apos;s disclosure and selected it. Chrome&apos;s built-in model
          never sends anything off this device.
        </p>
      </div>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Delete your data</h3>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={`mt-4 min-h-[24px] rounded border border-danger px-3 py-1.5 text-sm text-danger hover:bg-sunken ${focus}`}
          >
            Delete all Motion data
          </button>
        ) : (
          <div className="mt-4 rounded border border-danger p-4">
            <p className="text-sm">
              This permanently deletes every course, deadline, note, checklist, session and
              workflow Motion has stored, and forgets any saved API keys. It cannot be undone, and
              it does not touch anything in your LMS.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={deleteEverything}
                className={`min-h-[24px] rounded border border-danger bg-surface px-3 py-1.5 text-sm font-medium text-danger ${focus}`}
              >
                Delete everything
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className={`min-h-[24px] rounded border border-edge px-3 py-1.5 text-sm ${focus}`}
              >
                Keep my data
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function diagnosticFor(ai: AiStatusResult | null, id: ProviderId): ProviderDiagnostic | undefined {
  return ai?.providers.find((p) => p.providerId === id);
}

function About({ version, ai }: { version: string; ai: AiStatusResult | null }) {
  const rows: { label: string; value: string }[] = [
    { label: "Chrome built-in AI", value: statusCopy(diagnosticFor(ai, 'chrome-local')) },
    { label: 'Background local AI', value: diagnosticFor(ai, 'chrome-local')?.backgroundExecution ? 'Supported' : 'Unsupported' },
    { label: 'OpenAI', value: statusCopy(diagnosticFor(ai, 'openai')) },
    { label: 'Anthropic', value: statusCopy(diagnosticFor(ai, 'anthropic')) },
    { label: 'D2L access', value: ai?.lmsAccess.some((a) => a.granted) ? 'Granted' : 'Not granted' },
  ];
  return (
    <section aria-labelledby="about-heading">
      <h2 id="about-heading" className="font-serif text-lg">
        About
      </h2>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Motion {version}</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Motion helps you organise coursework on supported learning sites. Supported LMS: D2L
          Brightspace. Everything it stores stays in this browser — there is no account and no
          server.
        </p>
      </div>
      <div className={`${card} mt-4`}>
        <h3 className="text-md font-medium">Diagnostics</h3>
        <table className="mt-3 w-full text-left text-sm">
          <thead>
            <tr className="text-ink-muted">
              <th scope="col" className="py-1 pr-4 font-medium">Capability</th>
              <th scope="col" className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-rule">
                <td className="py-2 pr-4">{row.label}</td>
                <td className="py-2">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
